import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import {
  ConsolidatedContributionStatus, ConsolidatedItemOutcome, ConsolidatedReceiptStatus,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { ExcludeContributionDto, RecordReceiptDto } from '../dto/receipt.dto';
import { ConsolidatedAccessService } from './consolidated-access.service';
import { CONSOLIDATED_ACTION, ConsolidatedAuditService, RequestContext } from './consolidated-audit.service';
import { ConsolidatedNotifierService } from './consolidated-notifier.service';

/** Receipt may be recorded, and corrected, from any of these. */
const RECEIPTABLE: ConsolidatedContributionStatus[] = [
  ConsolidatedContributionStatus.SUBMITTED,
  ConsolidatedContributionStatus.HANDED_OVER,
  ConsolidatedContributionStatus.RECEIVED,
  ConsolidatedContributionStatus.NOT_RECEIVED,
];

/**
 * Confirming what actually arrived at the collection point.
 *
 * This is the step that turns "a site said it would bring 8 kg" into "8 kg is
 * here" — the listing deliberately keeps both, because a charity is offered
 * verified food, while the site's own record shows what it offered (R18).
 */
@Injectable()
export class ConsolidatedReceiptService {
  private readonly logger = new Logger(ConsolidatedReceiptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConsolidatedAccessService,
    private readonly audit: ConsolidatedAuditService,
    private readonly notifier: ConsolidatedNotifierService,
  ) {}

  private async load(caller: Jwtpayload, contributionId: number) {
    const row = await this.prisma.consolidatedContribution.findUnique({
      where: { id: contributionId },
      include: {
        collection: true,
        site: { select: { name: true, organisationName: true } },
      },
    });
    if (!row || row.collection.organisationId !== caller.orgId) {
      throw new NotFoundException('Contribution not found.');
    }
    return { ...row, siteName: row.site.name ?? row.site.organisationName };
  }

  /**
   * Records Received / Not Received / Adjust Quantity.
   *
   * Verified can be lowered but never raised above what the site submitted:
   * food that is not on the listing has not been declared, so accepting it
   * here would put unlisted food in front of a charity.
   */
  async record(
    caller: Jwtpayload, contributionId: number, dto: RecordReceiptDto, req?: RequestContext,
  ) {
    const contribution = await this.load(caller, contributionId);
    await this.access.assertReceiver(caller, contribution.collection.groupId);

    if (!RECEIPTABLE.includes(contribution.status)) {
      throw new ConflictException(
        `Cannot record receipt while this contribution is ${contribution.status.toLowerCase()}.`,
      );
    }

    const ledger = await this.prisma.consolidatedItem.findMany({ where: { contributionId } });
    if (dto.received && ledger.length === 0) {
      throw new ConflictException('This contribution has no food to confirm.');
    }

    const byId = new Map(ledger.map((i) => [i.id, i]));
    const verified = new Map<number, number>();

    for (const entry of dto.items ?? []) {
      const item = byId.get(entry.itemId);
      if (!item) throw new NotFoundException(`Item ${entry.itemId} is not part of this contribution.`);
      if (entry.verifiedQtyKg > item.submittedQtyKg) {
        throw new BadRequestException(
          `More ${item.name} arrived than was listed. Ask the site to update the listing.`,
        );
      }
      verified.set(item.id, entry.verifiedQtyKg);
    }

    const actor = await this.audit.actorFrom(caller, req);
    const now = new Date();

    const result = await this.prisma.$transaction(async (tx) => {
      if (!dto.received) {
        await tx.consolidatedItem.updateMany({
          where: { contributionId },
          data: { verifiedQtyKg: 0, outcome: ConsolidatedItemOutcome.NOT_RECEIVED },
        });
        await tx.consolidatedContribution.update({
          where: { id: contributionId },
          data: {
            status: ConsolidatedContributionStatus.NOT_RECEIVED,
            receiptStatus: ConsolidatedReceiptStatus.NOT_RECEIVED,
            receiptAt: now,
            receiptByUserId: caller.sub,
            receiptNote: dto.note?.trim() ?? null,
          },
        });

        await this.audit.log(tx, actor, {
          organisationId: contribution.collection.organisationId,
          action: CONSOLIDATED_ACTION.CONTRIBUTION_RECEIPT,
          entityType: 'ConsolidatedContribution',
          entityId: contributionId,
          entityLabel: contribution.siteName,
          newValue: { received: false },
          summary: `Nothing received from ${contribution.siteName}.`,
        });

        return { received: false, verifiedTotalKg: 0 };
      }

      let total = 0;
      for (const item of ledger) {
        // No entry means "exactly what was listed arrived".
        const qty = verified.has(item.id) ? verified.get(item.id)! : item.submittedQtyKg;
        total += qty;
        await tx.consolidatedItem.update({
          where: { id: item.id },
          data: {
            verifiedQtyKg: qty,
            outcome: qty === 0 ? ConsolidatedItemOutcome.EXCLUDED : ConsolidatedItemOutcome.PENDING,
          },
        });
      }

      await tx.consolidatedContribution.update({
        where: { id: contributionId },
        data: {
          status: ConsolidatedContributionStatus.RECEIVED,
          receiptStatus: ConsolidatedReceiptStatus.RECEIVED,
          receiptAt: now,
          receiptByUserId: caller.sub,
          receiptNote: dto.note?.trim() ?? null,
        },
      });

      const adjusted = ledger.filter(
        (i) => verified.has(i.id) && verified.get(i.id) !== i.submittedQtyKg,
      ).length;

      await this.audit.log(tx, actor, {
        organisationId: contribution.collection.organisationId,
        action: CONSOLIDATED_ACTION.CONTRIBUTION_RECEIPT,
        entityType: 'ConsolidatedContribution',
        entityId: contributionId,
        entityLabel: contribution.siteName,
        newValue: { received: true, verifiedTotalKg: total, adjustedItems: adjusted },
        summary:
          `Received ${total} kg from ${contribution.siteName}` +
          (adjusted ? ` (${adjusted} item(s) adjusted).` : '.'),
      });

      return { received: true, verifiedTotalKg: total, adjustedItems: adjusted };
    });

    await this.notifier
      .receiptRecorded(contributionId, dto.received)
      .catch((e) => this.logger.warn(e));

    return result;
  }

  /**
   * Drops a contribution from the collection.
   *
   * The row and its listing stay — the site still needs to see what happened
   * to the food it offered — but nothing from it reaches the charity.
   */
  async exclude(
    caller: Jwtpayload, contributionId: number, dto: ExcludeContributionDto, req?: RequestContext,
  ) {
    const contribution = await this.load(caller, contributionId);
    await this.access.assertManager(caller, contribution.collection.groupId);

    if (contribution.status === ConsolidatedContributionStatus.EXCLUDED) {
      return { excluded: true, alreadyDone: true };
    }

    const actor = await this.audit.actorFrom(caller, req);
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.consolidatedContribution.update({
        where: { id: contributionId },
        data: {
          status: ConsolidatedContributionStatus.EXCLUDED,
          excludedAt: now,
          excludedByUserId: caller.sub,
          excludeReason: dto.reason.trim(),
        },
      });
      await tx.consolidatedItem.updateMany({
        where: { contributionId },
        data: { outcome: ConsolidatedItemOutcome.EXCLUDED },
      });

      await this.audit.log(tx, actor, {
        organisationId: contribution.collection.organisationId,
        action: CONSOLIDATED_ACTION.CONTRIBUTION_EXCLUDED,
        entityType: 'ConsolidatedContribution',
        entityId: contributionId,
        entityLabel: contribution.siteName,
        summary: `Excluded ${contribution.siteName}: ${dto.reason.trim()}`,
      });
    });

    // A published collection has to be rebuilt without this food; the caller
    // runs syncMaster, which decides whether the charity must acknowledge it.
    return { excluded: true, alreadyDone: false, needsSync: Boolean(contribution.collection.publishedAt) };
  }
}
