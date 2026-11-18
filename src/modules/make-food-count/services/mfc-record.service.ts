import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import {
  FoodListingKind, FoodRecordEventType, FoodRecordStatus, FoodSource, ListingStatus, Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { EnterpriseScopeService } from '../../enterprise/services/enterprise-scope.service';
import {
  isValidSubtype, resolveFitForHumans, taxonomyEntry,
} from '../mfc.constants';
import {
  MfcCreateRecordDto, MfcLineDto, MfcPatchRecordDto, MfcPutLinesDto,
  MfcRecordListQueryDto, MfcSaveRecordDto,
} from '../dto/mfc.dto';
import { MfcAccessService } from './mfc-access.service';
import { deriveLineStatus, type LineOutcome } from './mfc-outcomes';
import { eligibleKg, sumKg, totalsFor, type TotalsLine } from './mfc-totals';

const DEFAULT_PAGE = 25;

/** Listings that still hold food back from the line that produced it. */
const ACTIVE_LISTING: ListingStatus[] = [
  ListingStatus.ACTIVE,
  ListingStatus.PARTIAL,
  ListingStatus.CLAIMED,
];

/**
 * Food records: what a kitchen did not serve.
 *
 * Writes are optimistically locked on `version`, and every material change is
 * written as an event, so any number this feature reports can be replayed and
 * explained rather than simply believed.
 */
@Injectable()
export class MfcRecordService {
  private readonly logger = new Logger(MfcRecordService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: MfcAccessService,
    private readonly scope: EnterpriseScopeService,
  ) {}

  // ─── Create ────────────────────────────────────────────────────────────────

  /**
   * Idempotent on `clientRequestId`: a retried submit returns the first record
   * rather than making a second one. Kitchens record on patchy wifi.
   */
  async create(caller: Jwtpayload, dto: MfcCreateRecordDto) {
    await this.access.assertCanEditSite(caller, dto.siteId);

    const existing = await this.prisma.foodRecord.findUnique({
      where: { clientRequestId: dto.clientRequestId },
    });
    if (existing) {
      if (existing.organisationId !== caller.orgId) {
        throw new ConflictException('That request id has already been used.');
      }
      return this.get(caller, existing.id);
    }

    const snapshot = await this.scope.snapshotForSite(dto.siteId);

    const record = await this.prisma.$transaction(async (tx) => {
      const created = await tx.foodRecord.create({
        data: {
          organisationId: caller.orgId!,
          siteId: dto.siteId,
          createdById: caller.sub,
          updatedById: caller.sub,
          recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : new Date(),
          sources: [...new Set(dto.sources)],
          clientRequestId: dto.clientRequestId,
          ...snapshot,
        },
      });

      await tx.foodRecordEvent.create({
        data: {
          recordId: created.id,
          actorUserId: caller.sub,
          type: FoodRecordEventType.RECORD_CREATED,
          after: { sources: created.sources, recordedAt: created.recordedAt } as Prisma.InputJsonValue,
        },
      });

      return created;
    });

    return this.get(caller, record.id);
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  async list(caller: Jwtpayload, query: MfcRecordListQueryDto) {
    const siteIds = await this.access.resolveSiteFilter(
      caller, query.siteId ? [query.siteId] : undefined,
    );
    // Empty reach returns an empty page rather than an error — a charity simply
    // has nothing here.
    if (siteIds !== null && siteIds.length === 0) {
      return { records: [], nextCursor: null };
    }

    const limit = query.limit ?? DEFAULT_PAGE;
    const records = await this.prisma.foodRecord.findMany({
      where: {
        organisationId: caller.orgId,
        ...(siteIds === null ? {} : { siteId: { in: siteIds } }),
        ...(query.status ? { status: query.status } : {}),
        ...(query.from || query.to
          ? {
              recordedAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
        ...(query.cursor ? { id: { lt: query.cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      include: {
        lines: { where: { deletedAt: null } },
        site: { select: { id: true, name: true, organisationName: true } },
      },
    });

    const page = records.slice(0, limit);
    return {
      records: page.map((r) => ({
        id: r.id,
        siteId: r.siteId,
        siteName: r.site.name ?? r.site.organisationName,
        status: r.status,
        sources: r.sources,
        recordedAt: r.recordedAt,
        version: r.version,
        totals: totalsFor(r.lines as TotalsLine[]),
      })),
      nextCursor: records.length > limit ? page[page.length - 1].id : null,
    };
  }

  /**
   * One record with its live lines, totals, and what has happened to each line
   * since — listed, claimed, collected.
   */
  async get(caller: Jwtpayload, recordId: number) {
    await this.access.assertRecordInReach(caller, recordId);

    const record = await this.prisma.foodRecord.findUniqueOrThrow({
      where: { id: recordId },
      include: {
        site: { select: { id: true, name: true, organisationName: true } },
        lines: { where: { deletedAt: null }, orderBy: { id: 'asc' } },
      },
    });

    const outcomes = await this.lineOutcomes(recordId);
    const totals = totalsFor(record.lines as TotalsLine[]);
    const eligible = eligibleKg(record.lines as TotalsLine[]);

    const lines = record.lines.map((line) => {
      const o = outcomes.get(line.id) ?? this.emptyOutcome();
      const qty = Number(line.qtyKg);
      return {
        id: line.id,
        clientKey: line.clientKey,
        source: line.source,
        category: line.category,
        subtype: line.subtype,
        qtyKg: qty,
        unit: line.unit,
        fitForHumans: line.fitForHumans,
        ...o,
        status: deriveLineStatus({ qtyKg: qty, ...o } as LineOutcome),
        // What is still free to offer: the rest is held by a live listing.
        availableKg: Math.max(0, Number((qty - o.activeListedKg).toFixed(2))),
      };
    });

    const byKind = (kind: FoodListingKind) => {
      const of = lines.filter((l) =>
        kind === FoodListingKind.EDIBLE ? l.fitForHumans : !l.fitForHumans);
      return {
        eligibleKg: kind === FoodListingKind.EDIBLE ? eligible.edibleKg : eligible.nonEdibleKg,
        listedKg: sumKg(of.map((l) => l.listedKg)),
        claimedKg: sumKg(of.map((l) => l.claimedKg)),
        collectedKg: sumKg(of.map((l) => l.collectedKg)),
        availableKg: sumKg(of.map((l) => l.availableKg)),
      };
    };

    return {
      id: record.id,
      siteId: record.siteId,
      siteName: record.site.name ?? record.site.organisationName,
      status: record.status,
      sources: record.sources,
      recordedAt: record.recordedAt,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      totals,
      byKind: {
        EDIBLE: byKind(FoodListingKind.EDIBLE),
        NON_EDIBLE: byKind(FoodListingKind.NON_EDIBLE),
      },
      lines,
    };
  }

  // ─── Update ────────────────────────────────────────────────────────────────

  async patch(caller: Jwtpayload, recordId: number, dto: MfcPatchRecordDto) {
    const record = await this.access.assertRecordInReach(caller, recordId);
    await this.access.assertCanEditSite(caller, record.siteId);

    return this.prisma.$transaction(async (tx) => {
      const before = await this.lockVersion(tx, recordId, dto.version);

      if (dto.sources) {
        const kept = new Set(dto.sources);
        // Dropping a tab must not silently strand the lines recorded under it.
        const orphaned = await tx.foodRecordLine.count({
          where: { recordId, deletedAt: null, source: { notIn: [...kept] as FoodSource[] } },
        });
        if (orphaned > 0) {
          throw new ConflictException({
            code: 'SOURCE_HAS_LINES',
            message: 'Remove the food recorded under that source before turning it off.',
          });
        }
      }

      const updated = await tx.foodRecord.update({
        where: { id: recordId },
        data: {
          sources: dto.sources ? [...new Set(dto.sources)] : undefined,
          recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : undefined,
          updatedById: caller.sub,
          version: { increment: 1 },
        },
      });

      if (dto.sources) {
        await tx.foodRecordEvent.create({
          data: {
            recordId,
            actorUserId: caller.sub,
            type: FoodRecordEventType.SOURCES_CHANGED,
            before: { sources: before.sources } as Prisma.InputJsonValue,
            after: { sources: updated.sources } as Prisma.InputJsonValue,
          },
        });
      }

      return updated;
    }).then(() => this.get(caller, recordId));
  }

  /**
   * Replaces the whole set of lines, diffed by `clientKey`.
   *
   * A full PUT rather than per-line calls, because the app edits a whole screen
   * and a half-applied set would be worse than none. Lines that disappear are
   * soft-deleted, so anything already listed keeps its history.
   */
  async putLines(caller: Jwtpayload, recordId: number, dto: MfcPutLinesDto) {
    const record = await this.access.assertRecordInReach(caller, recordId);
    await this.access.assertCanEditSite(caller, record.siteId);

    const normalised = dto.lines.map((line) => this.normaliseLine(line));
    this.assertUniqueKeys(normalised);

    await this.prisma.$transaction(async (tx) => {
      const current = await this.lockVersion(tx, recordId, dto.version);

      const allowed = new Set(current.sources);
      for (const line of normalised) {
        if (!allowed.has(line.source)) {
          throw new BadRequestException(
            `This record does not include the ${line.source.toLowerCase().replace('_', ' ')} source.`,
          );
        }
      }

      const existing = await tx.foodRecordLine.findMany({ where: { recordId } });
      const byKey = new Map(existing.map((l) => [l.clientKey, l]));
      const outcomes = await this.lineOutcomes(recordId, tx);
      const incoming = new Set(normalised.map((l) => l.clientKey));

      for (const line of normalised) {
        const prior = byKey.get(line.clientKey);

        if (!prior) {
          const created = await tx.foodRecordLine.create({
            data: { recordId, ...line, qtyKg: new Prisma.Decimal(line.qtyKg) },
          });
          await this.event(tx, recordId, created.id, caller.sub,
            FoodRecordEventType.LINE_CREATED, null, line);
          continue;
        }

        // A soft-deleted key coming back is the same row returning, not a new one.
        const outcome = outcomes.get(prior.id) ?? this.emptyOutcome();
        const priorQty = Number(prior.qtyKg);

        if (priorQty !== line.qtyKg) {
          this.assertQtyAllowed(prior.id, line.qtyKg, outcome);
          await this.event(tx, recordId, prior.id, caller.sub,
            FoodRecordEventType.QTY_CHANGED, { qtyKg: priorQty }, { qtyKg: line.qtyKg });
        }
        if (prior.fitForHumans !== line.fitForHumans) {
          this.assertNoActiveLink(prior.id, outcome, 'change whether this food is fit for people');
          await this.event(tx, recordId, prior.id, caller.sub,
            FoodRecordEventType.FIT_CHANGED,
            { fitForHumans: prior.fitForHumans }, { fitForHumans: line.fitForHumans });
        }

        await tx.foodRecordLine.update({
          where: { id: prior.id },
          data: { ...line, qtyKg: new Prisma.Decimal(line.qtyKg), deletedAt: null },
        });
      }

      for (const prior of existing) {
        if (incoming.has(prior.clientKey) || prior.deletedAt) continue;
        const outcome = outcomes.get(prior.id) ?? this.emptyOutcome();
        this.assertNoActiveLink(prior.id, outcome, 'remove this line');

        await tx.foodRecordLine.update({
          where: { id: prior.id },
          data: { deletedAt: new Date() },
        });
        await this.event(tx, recordId, prior.id, caller.sub,
          FoodRecordEventType.LINE_DELETED,
          { qtyKg: Number(prior.qtyKg), category: prior.category }, null);
      }

      await tx.foodRecord.update({
        where: { id: recordId },
        data: { updatedById: caller.sub, version: { increment: 1 } },
      });
    });

    return this.get(caller, recordId);
  }

  /** DRAFT → SAVED. Saving an already-saved record is a no-op, not an error. */
  async save(caller: Jwtpayload, recordId: number, dto: MfcSaveRecordDto) {
    const record = await this.access.assertRecordInReach(caller, recordId);
    await this.access.assertCanEditSite(caller, record.siteId);

    if (record.status === FoodRecordStatus.SAVED) return this.get(caller, recordId);

    await this.prisma.$transaction(async (tx) => {
      await this.lockVersion(tx, recordId, dto.version);
      await tx.foodRecord.update({
        where: { id: recordId },
        data: {
          status: FoodRecordStatus.SAVED,
          updatedById: caller.sub,
          version: { increment: 1 },
        },
      });
      await this.event(tx, recordId, null, caller.sub, FoodRecordEventType.RECORD_SAVED,
        { status: FoodRecordStatus.DRAFT }, { status: FoodRecordStatus.SAVED });
    });

    return this.get(caller, recordId);
  }

  /**
   * Discard a draft the kitchen no longer wants.
   *
   * Only drafts, and only while nothing from them has been listed: a listing
   * (live or past) is part of what the record reports, so that record stays.
   * Lines and events go with the record (cascade).
   */
  async discardDraft(caller: Jwtpayload, recordId: number) {
    const record = await this.access.assertRecordInReach(caller, recordId);
    await this.access.assertCanEditSite(caller, record.siteId);

    if (record.status !== FoodRecordStatus.DRAFT) {
      throw new ConflictException({
        code: 'RECORD_SAVED',
        message: 'Saved records cannot be deleted.',
      });
    }
    const listed = await this.prisma.foodRecordListingLink.count({ where: { recordId } });
    if (listed > 0) {
      throw new ConflictException({
        code: 'RECORD_LISTED',
        message: 'Part of this draft is listed, so it cannot be deleted. Cancel the listing first.',
      });
    }

    await this.prisma.foodRecord.delete({ where: { id: recordId } });
    return { id: recordId, deleted: true };
  }

  /** The audit trail for one record, for the site administrator view. */
  async events(caller: Jwtpayload, recordId: number) {
    await this.access.assertRecordInReach(caller, recordId);
    return this.prisma.foodRecordEvent.findMany({
      where: { recordId },
      orderBy: { createdAt: 'asc' },
      include: {
        actor: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  /**
   * Takes the optimistic lock.
   *
   * Reading the row inside the transaction and comparing the version is what
   * stops two kitchen tablets overwriting each other mid-service.
   */
  private async lockVersion(tx: Prisma.TransactionClient, recordId: number, version: number) {
    const current = await tx.foodRecord.findUniqueOrThrow({ where: { id: recordId } });
    if (current.version !== version) {
      throw new ConflictException({
        code: 'STALE_VERSION',
        message: 'This record changed somewhere else. Reload and try again.',
        currentVersion: current.version,
      });
    }
    return current;
  }

  private normaliseLine(line: MfcLineDto) {
    const entry = taxonomyEntry(line.source, line.category);
    if (!entry) {
      throw new BadRequestException(
        `"${line.category}" is not a food category for that source.`,
      );
    }
    if (!isValidSubtype(entry, line.subtype)) {
      throw new BadRequestException(
        `"${line.subtype}" is not an option under ${entry.label}.`,
      );
    }
    return {
      clientKey: line.clientKey,
      source: line.source,
      category: line.category,
      subtype: line.subtype ?? null,
      qtyKg: line.qtyKg,
      // Never trusted from the client: only Overproduction can be fit.
      fitForHumans: resolveFitForHumans(line.source, entry, line.fitForHumans),
    };
  }

  private assertUniqueKeys(lines: { clientKey: string }[]) {
    const seen = new Set<string>();
    for (const l of lines) {
      if (seen.has(l.clientKey)) {
        throw new BadRequestException(`Duplicate line key "${l.clientKey}".`);
      }
      seen.add(l.clientKey);
    }
  }

  private emptyOutcome() {
    return { listedKg: 0, activeListedKg: 0, claimedKg: 0, collectedKg: 0,
             listingStatuses: [] as ListingStatus[] };
  }

  /**
   * What happened to each line after it was recorded.
   *
   * `listedKg` counts every live listing, while `activeListedKg` counts only
   * those still holding the food — the difference is what a cancelled or
   * expired listing releases back to the line.
   */
  private async lineOutcomes(recordId: number, db: Prisma.TransactionClient | PrismaService = this.prisma) {
    const links = await db.foodRecordListingLink.findMany({
      where: { recordId },
      include: {
        listing: { select: { status: true } },
        foodItem: {
          select: {
            claimItems: {
              select: {
                qtyKg: true,
                claim: { select: { status: true, claimKind: true } },
              },
            },
          },
        },
      },
    });

    const out = new Map<number, ReturnType<MfcRecordService['emptyOutcome']>>();

    for (const link of links) {
      const o = out.get(link.lineId) ?? this.emptyOutcome();
      const listed = Number(link.listedQtyKg);

      if (link.listing.status !== ListingStatus.CANCELLED) o.listedKg += listed;
      if (ACTIVE_LISTING.includes(link.listing.status)) o.activeListedKg += listed;
      o.listingStatuses.push(link.listing.status);

      for (const item of link.foodItem.claimItems) {
        // A consolidated master claim is a presentation layer over the
        // per-site allocations; counting both would double the weight.
        if (item.claim.claimKind === 'CONSOLIDATED_MASTER') continue;
        if (item.claim.status === 'CANCELLED') continue;

        o.claimedKg += item.qtyKg;
        if (item.claim.status === 'COLLECTED') o.collectedKg += item.qtyKg;
      }

      out.set(link.lineId, o);
    }

    for (const [id, o] of out) {
      out.set(id, {
        listedKg: Number(o.listedKg.toFixed(2)),
        activeListedKg: Number(o.activeListedKg.toFixed(2)),
        claimedKg: Number(o.claimedKg.toFixed(2)),
        collectedKg: Number(o.collectedKg.toFixed(2)),
        listingStatuses: [...new Set(o.listingStatuses)],
      });
    }
    return out;
  }

  /** Food already promised to someone cannot be quietly reduced. */
  private assertQtyAllowed(
    lineId: number,
    next: number,
    outcome: ReturnType<MfcRecordService['emptyOutcome']>,
  ) {
    const floor = Math.max(outcome.activeListedKg, outcome.collectedKg);
    if (next < floor) {
      throw new ConflictException({
        code: 'LINE_LISTED',
        lineId,
        listedKg: outcome.activeListedKg,
        message: `${floor} kg of this line is already listed or collected.`,
      });
    }
  }

  private assertNoActiveLink(
    lineId: number,
    outcome: ReturnType<MfcRecordService['emptyOutcome']>,
    action: string,
  ) {
    if (outcome.activeListedKg > 0 || outcome.collectedKg > 0) {
      throw new ConflictException({
        code: 'LINE_LISTED',
        lineId,
        listedKg: outcome.activeListedKg,
        message: `This food has already been listed, so you cannot ${action}.`,
      });
    }
  }

  private event(
    tx: Prisma.TransactionClient,
    recordId: number,
    lineId: number | null,
    actorUserId: number | null,
    type: FoodRecordEventType,
    before: unknown,
    after: unknown,
  ) {
    return tx.foodRecordEvent.create({
      data: {
        recordId,
        lineId,
        actorUserId,
        type,
        before: (before ?? Prisma.DbNull) as Prisma.InputJsonValue,
        after: (after ?? Prisma.DbNull) as Prisma.InputJsonValue,
      },
    });
  }
}
