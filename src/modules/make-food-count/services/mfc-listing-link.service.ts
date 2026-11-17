import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import {
  AuditArea, FoodListingKind, FoodRecordEventType, ListingStatus, Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { taxonomyEntry } from '../mfc.constants';
import { MfcFoodRecordLinkDto } from '../dto/mfc.dto';
import { MfcAccessService } from './mfc-access.service';

/** Listings that still hold food back from the line that produced it. */
const ACTIVE_LISTING: ListingStatus[] = [
  ListingStatus.ACTIVE,
  ListingStatus.PARTIAL,
  ListingStatus.CLAIMED,
];

/** Namespace for the Idempotency-Key header on listing creation. */
export const MFC_LISTING_SCOPE = 'mfc-listing';

export interface PrefillItem {
  lineId: number;
  name: string;
  category: string;
  subtype: string | null;
  iconKey: string;
  countedKg: number;
  availableKg: number;
}

/**
 * Ties a food record to the listing it becomes.
 *
 * One FoodItem per line, never merged, so a claim's kilograms map back to
 * exactly one recorded line and nothing has to be apportioned afterwards.
 */
@Injectable()
export class MfcListingLinkService {
  private readonly logger = new Logger(MfcListingLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: MfcAccessService,
  ) {}

  // ─── Idempotency ───────────────────────────────────────────────────────────

  /**
   * The listing a previous request with this key already created.
   *
   * Publishing twice because a phone retried would offer a charity food that
   * does not exist, so the key is checked before anything is written.
   */
  async replayedListingId(caller: Jwtpayload, key?: string): Promise<number | null> {
    if (!key) return null;
    const seen = await this.prisma.idempotencyKey.findUnique({ where: { key } });
    if (!seen) return null;
    if (seen.userId !== caller.sub || seen.scope !== MFC_LISTING_SCOPE) {
      throw new ConflictException('That idempotency key has already been used.');
    }
    return seen.resultId ?? null;
  }

  async rememberKey(
    tx: Prisma.TransactionClient, caller: Jwtpayload, key: string | undefined, listingId: number,
  ) {
    if (!key) return;
    await tx.idempotencyKey.upsert({
      where: { key },
      create: { key, userId: caller.sub, scope: MFC_LISTING_SCOPE, resultId: listingId },
      update: { resultId: listingId },
    });
  }

  // ─── Linking ───────────────────────────────────────────────────────────────

  /**
   * Validates and writes the links, inside the listing's own transaction.
   *
   * Everything here must fail the listing too: a listing that offers more than
   * was recorded, or food from another site, is worse than no listing.
   */
  async link(
    tx: Prisma.TransactionClient,
    caller: Jwtpayload,
    dto: MfcFoodRecordLinkDto,
    listing: { id: number; siteId: number },
    createdItems: { id: number; totalQtyKg: number }[],
  ) {
    const record = await tx.foodRecord.findFirst({
      where: { id: dto.recordId, organisationId: caller.orgId },
      include: { lines: { where: { deletedAt: null } } },
    });
    if (!record) throw new NotFoundException('Food record not found');
    await this.access.assertSiteInReach(caller, record.siteId);

    if (record.siteId !== listing.siteId) {
      throw new BadRequestException(
        'The listing and the food record must belong to the same site.',
      );
    }

    const byId = new Map(record.lines.map((l) => [l.id, l]));
    const available = await this.availableByLine(tx, dto.recordId);
    const seenLines = new Set<number>();

    for (const item of dto.items) {
      const line = byId.get(item.lineId);
      if (!line) {
        throw new BadRequestException(`Line ${item.lineId} is not part of that record.`);
      }
      if (seenLines.has(item.lineId)) {
        throw new BadRequestException(`Line ${item.lineId} is listed twice.`);
      }
      seenLines.add(item.lineId);

      // Fit food goes to people; everything else takes the non-edible pathway.
      const expected = line.fitForHumans ? FoodListingKind.EDIBLE : FoodListingKind.NON_EDIBLE;
      if (expected !== dto.kind) {
        throw new BadRequestException(
          line.fitForHumans
            ? 'That food is marked fit for people, so it cannot go on a non-edible listing.'
            : 'That food is not fit for people, so it cannot be offered for donation.',
        );
      }

      const created = createdItems[item.itemIndex];
      if (!created) {
        throw new BadRequestException(`There is no food item at index ${item.itemIndex}.`);
      }

      const free = available.get(item.lineId) ?? Number(line.qtyKg);
      if (created.totalQtyKg > free + 0.001) {
        throw new BadRequestException(
          `Only ${free} kg of that food is still available to list.`,
        );
      }

      await tx.foodRecordListingLink.create({
        data: {
          recordId: dto.recordId,
          lineId: line.id,
          listingId: listing.id,
          foodItemId: created.id,
          kind: dto.kind,
          listedQtyKg: new Prisma.Decimal(created.totalQtyKg),
        },
      });

      await tx.foodRecordEvent.create({
        data: {
          recordId: dto.recordId,
          lineId: line.id,
          actorUserId: caller.sub,
          type: FoodRecordEventType.LISTED,
          after: {
            listingId: listing.id,
            foodItemId: created.id,
            kind: dto.kind,
            listedQtyKg: created.totalQtyKg,
          } as Prisma.InputJsonValue,
        },
      });
    }

    await this.writeAudit(tx, caller, record.organisationId, dto, listing.id, createdItems);
    return { linkedLines: seenLines.size };
  }

  // ─── Prefill ───────────────────────────────────────────────────────────────

  /**
   * What the listing screen should open with.
   *
   * `availableKg` is what is left after any live listing, so opening the screen
   * twice cannot offer the same food twice.
   */
  async prefill(caller: Jwtpayload, recordId: number, kind: FoodListingKind) {
    await this.access.assertRecordInReach(caller, recordId);

    const record = await this.prisma.foodRecord.findUniqueOrThrow({
      where: { id: recordId },
      include: { lines: { where: { deletedAt: null }, orderBy: { id: 'asc' } } },
    });

    const wantFit = kind === FoodListingKind.EDIBLE;
    const available = await this.availableByLine(this.prisma, recordId);

    const items: PrefillItem[] = record.lines
      .filter((line) => line.fitForHumans === wantFit)
      .map((line) => {
        const entry = taxonomyEntry(line.source, line.category);
        const subtype = entry?.subtypes?.find((s) => s.key === line.subtype);
        const qty = Number(line.qtyKg);
        return {
          lineId: line.id,
          // Charity-facing wording, not the kitchen's internal label.
          name: subtype?.listingName ?? entry?.listingName ?? line.category,
          category: line.category,
          subtype: line.subtype,
          iconKey: subtype?.iconKey ?? entry?.listingIconKey ?? 'other',
          countedKg: qty,
          // availableByLine already returns what is free, not what is held.
          availableKg: available.get(line.id) ?? qty,
        };
      })
      // Nothing left to offer is not worth a row on the screen.
      .filter((i) => i.availableKg > 0);

    return {
      recordId,
      kind,
      items,
      totalKg: Number(items.reduce((sum, i) => sum + i.availableKg, 0).toFixed(2)),
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /** Kilograms still free to list, per line id. */
  private async availableByLine(
    db: Prisma.TransactionClient | PrismaService, recordId: number,
  ): Promise<Map<number, number>> {
    const lines = await db.foodRecordLine.findMany({
      where: { recordId, deletedAt: null },
      select: { id: true, qtyKg: true },
    });
    const links = await db.foodRecordListingLink.findMany({
      where: { recordId },
      select: { lineId: true, listedQtyKg: true, listing: { select: { status: true } } },
    });

    const held = new Map<number, number>();
    for (const link of links) {
      // A cancelled or expired listing releases its food back to the line.
      if (!ACTIVE_LISTING.includes(link.listing.status)) continue;
      held.set(link.lineId, (held.get(link.lineId) ?? 0) + Number(link.listedQtyKg));
    }

    const out = new Map<number, number>();
    for (const line of lines) {
      const free = Number(line.qtyKg) - (held.get(line.id) ?? 0);
      out.set(line.id, Math.max(0, Number(free.toFixed(2))));
    }
    return out;
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    caller: Jwtpayload,
    organisationId: number,
    dto: MfcFoodRecordLinkDto,
    listingId: number,
    createdItems: { totalQtyKg: number }[],
  ) {
    try {
      const user = await tx.user.findUnique({
        where: { id: caller.sub },
        select: { firstName: true, lastName: true, email: true },
      });
      const listedKg = dto.items.reduce(
        (sum, i) => sum + (createdItems[i.itemIndex]?.totalQtyKg ?? 0), 0);

      await tx.auditLog.create({
        data: {
          organisationId,
          actorUserId: caller.sub,
          actorName: user ? `${user.firstName} ${user.lastName}`.trim() : caller.email,
          actorEmail: user?.email ?? caller.email,
          area: AuditArea.MAKE_FOOD_COUNT,
          action: 'record.listed',
          entityType: 'FoodRecord',
          entityId: dto.recordId,
          newValue: { listingId, kind: dto.kind, listedKg } as Prisma.InputJsonValue,
          summary: `Listed ${Number(listedKg.toFixed(2))} kg from a food record.`,
        },
      });
    } catch (err) {
      // An audit line must never cost the user their listing.
      this.logger.error(`MFC listing audit failed: ${(err as Error).message}`);
    }
  }
}
