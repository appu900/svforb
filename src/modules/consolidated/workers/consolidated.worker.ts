import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import {
  ConsolidatedCollectionStatus, ConsolidatedContributionStatus, ConsolidatedItemOutcome,
  ConsolidatedScheduleStatus, ListingStatus,
} from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import {
  CLOSING_REMINDER_MINUTES, CONSOLIDATED_HORIZON_DAYS, ITEM_CHECK_REMINDER_HOURS,
  PICKUP_REMINDER_MINUTES,
} from '../consolidated.constants';
import { CONSOLIDATED_QUEUE } from '../queues/consolidated.queue.service';
import { ConsolidatedCollectionService } from '../services/consolidated-collection.service';
import { ConsolidatedNotifierService } from '../services/consolidated-notifier.service';
import { ConsolidatedScheduleService } from '../services/consolidated-schedule.service';

/** Never move more than this many rows in one pass, so a backlog cannot stall the queue. */
const BATCH = 500;
const MINUTE = 60_000;
const DAY_MS = 86_400_000;

/**
 * Drives collections through their lifecycle on a timer.
 *
 * Every step is guarded by its own stamp column, so running the sweep twice
 * changes nothing the second time. A step that throws is logged and the rest
 * still run — one bad collection must not freeze every other venue.
 */
@Processor(CONSOLIDATED_QUEUE)
export class ConsolidatedWorker extends WorkerHost {
  private readonly logger = new Logger(ConsolidatedWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedules: ConsolidatedScheduleService,
    private readonly collections: ConsolidatedCollectionService,
    private readonly notifier: ConsolidatedNotifierService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const now = new Date();
    const counts: Record<string, number> = {};

    const step = async (name: string, run: () => Promise<number>) => {
      try {
        counts[name] = await run();
      } catch (err) {
        counts[name] = -1;
        this.logger.error(`Sweep step "${name}" failed: ${(err as Error).message}`);
      }
    };

    await step('generated', () => this.generate(now));
    await step('opened', () => this.open(now));
    await step('closingReminders', () => this.closingReminder(now));
    await step('closed', () => this.autoClose(now));
    await step('overdueAlerts', () => this.overdueHandover(now));
    await step('pickupReminders', () => this.pickupReminder(now));
    await step('expired', () => this.expire(now));
    await step('itemCheckReminders', () => this.itemCheckReminder(now));

    const moved = Object.entries(counts).filter(([, n]) => n !== 0);
    if (moved.length) {
      this.logger.log(`${job.name}: ${moved.map(([k, n]) => `${k}=${n}`).join(' ')}`);
    }
  }

  // ─── 1. Keep the horizon filled ────────────────────────────────────────────

  private async generate(now: Date): Promise<number> {
    const horizonEnd = new Date(now.getTime() + CONSOLIDATED_HORIZON_DAYS * DAY_MS);
    const due = await this.prisma.consolidatedSchedule.findMany({
      where: {
        status: ConsolidatedScheduleStatus.ACTIVE,
        OR: [{ generatedUntil: null }, { generatedUntil: { lt: horizonEnd } }],
      },
      select: { id: true },
      take: BATCH,
    });

    let created = 0;
    for (const schedule of due) {
      created += await this.schedules.generate(this.prisma, schedule.id, now);
    }
    return created;
  }

  // ─── 2. Let sites start listing ────────────────────────────────────────────

  private async open(now: Date): Promise<number> {
    const due = await this.prisma.consolidatedCollection.findMany({
      where: { status: ConsolidatedCollectionStatus.SCHEDULED, opensAt: { lte: now } },
      select: { id: true },
      take: BATCH,
    });
    if (!due.length) return 0;

    const result = await this.prisma.consolidatedCollection.updateMany({
      where: { id: { in: due.map((c) => c.id) }, status: ConsolidatedCollectionStatus.SCHEDULED },
      data: { status: ConsolidatedCollectionStatus.OPEN, openedAt: now },
    });

    await this.notifier.collectionsScheduled(due.map((c) => c.id)).catch(() => undefined);
    return result.count;
  }

  // ─── 3. Warn before submissions close ──────────────────────────────────────

  private async closingReminder(now: Date): Promise<number> {
    const threshold = new Date(now.getTime() + CLOSING_REMINDER_MINUTES * MINUTE);
    const due = await this.prisma.consolidatedCollection.findMany({
      where: {
        status: ConsolidatedCollectionStatus.OPEN,
        closingReminderAt: null,
        submissionsCloseAt: { lte: threshold },
      },
      select: { id: true, participatingSiteIds: true },
      take: BATCH,
    });

    let sent = 0;
    for (const collection of due) {
      // Stamp first: a push that fails is better than one sent every 5 minutes.
      await this.prisma.consolidatedCollection.update({
        where: { id: collection.id },
        data: { closingReminderAt: now },
      });

      const contributed = await this.prisma.consolidatedContribution.findMany({
        where: {
          collectionId: collection.id,
          status: { not: ConsolidatedContributionStatus.WITHDRAWN },
        },
        select: { siteId: true },
      });
      const done = new Set(contributed.map((c) => c.siteId));
      const waiting = collection.participatingSiteIds.filter((id) => !done.has(id));

      if (waiting.length) {
        await this.notifier.closingSoon(collection.id, waiting).catch(() => undefined);
        sent += 1;
      }
    }
    return sent;
  }

  // ─── 4. Close on time ──────────────────────────────────────────────────────

  private async autoClose(now: Date): Promise<number> {
    const open = await this.prisma.consolidatedCollection.findMany({
      where: { status: ConsolidatedCollectionStatus.OPEN },
      select: { id: true, submissionsCloseAt: true, reopenedUntil: true, participatingSiteIds: true },
      take: BATCH,
    });

    const due = open.filter((c) => now >= (c.reopenedUntil ?? c.submissionsCloseAt));
    let closed = 0;

    for (const collection of due) {
      await this.prisma.$transaction(async (tx) => {
        await this.collections.createMissingContributions(
          tx, collection.id, collection.participatingSiteIds,
        );
        await tx.consolidatedCollection.updateMany({
          // The status guard makes a concurrent manual close a no-op here.
          where: { id: collection.id, status: ConsolidatedCollectionStatus.OPEN },
          data: {
            status: ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED,
            closedAt: now,
            reopenedUntil: null,
          },
        });
      });
      await this.notifier.collectionClosed(collection.id).catch(() => undefined);
      closed += 1;
    }
    return closed;
  }

  // ─── 5. Chase missing handovers ────────────────────────────────────────────

  private async overdueHandover(now: Date): Promise<number> {
    const due = await this.prisma.consolidatedCollection.findMany({
      where: {
        overdueAlertAt: null,
        handoverEndAt: { lte: now },
        status: {
          in: [ConsolidatedCollectionStatus.OPEN, ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED],
        },
      },
      select: { id: true },
      take: BATCH,
    });

    let sent = 0;
    for (const collection of due) {
      await this.prisma.consolidatedCollection.update({
        where: { id: collection.id },
        data: { overdueAlertAt: now },
      });

      // Submitted but never handed over — the food is still in the kitchen.
      const waiting = await this.prisma.consolidatedContribution.findMany({
        where: { collectionId: collection.id, status: ConsolidatedContributionStatus.SUBMITTED },
        select: { siteId: true },
      });

      if (waiting.length) {
        await this.notifier
          .handoverOverdue(collection.id, [...new Set(waiting.map((w) => w.siteId))])
          .catch(() => undefined);
        sent += 1;
      }
    }
    return sent;
  }

  // ─── 6. Remind the charity ─────────────────────────────────────────────────

  private async pickupReminder(now: Date): Promise<number> {
    const threshold = new Date(now.getTime() + PICKUP_REMINDER_MINUTES * MINUTE);
    const due = await this.prisma.consolidatedCollection.findMany({
      where: {
        status: ConsolidatedCollectionStatus.CLAIMED,
        pickupReminderAt: null,
        pickupStartAt: { lte: threshold },
      },
      select: { id: true, masterListingId: true },
      take: BATCH,
    });

    let sent = 0;
    for (const collection of due) {
      await this.prisma.consolidatedCollection.update({
        where: { id: collection.id },
        data: { pickupReminderAt: now },
      });

      if (!collection.masterListingId) continue;
      const claim = await this.prisma.foodClaim.findFirst({
        where: { listingId: collection.masterListingId, status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (claim) {
        await this.notifier.pickupSoon(collection.id, claim.id).catch(() => undefined);
        sent += 1;
      }
    }
    return sent;
  }

  // ─── 7. Expire what nobody collected ───────────────────────────────────────

  private async expire(now: Date): Promise<number> {
    const due = await this.prisma.consolidatedCollection.findMany({
      where: {
        status: {
          in: [
            ConsolidatedCollectionStatus.OPEN,
            ConsolidatedCollectionStatus.SUBMISSIONS_CLOSED,
            ConsolidatedCollectionStatus.PUBLISHED,
          ],
        },
        pickupEndAt: { lt: now },
      },
      select: { id: true, masterListingId: true },
      take: BATCH,
    });

    for (const collection of due) {
      await this.prisma.$transaction(async (tx) => {
        await tx.consolidatedCollection.update({
          where: { id: collection.id },
          data: { status: ConsolidatedCollectionStatus.EXPIRED, expiredAt: now },
        });

        if (collection.masterListingId) {
          await tx.foodListing.update({
            where: { id: collection.masterListingId },
            data: { status: ListingStatus.EXPIRED },
          });
        }

        // The contribution rows stay — they are the record of what each site
        // offered. Only the listings are marked expired.
        const contributions = await tx.consolidatedContribution.findMany({
          where: {
            collectionId: collection.id,
            listingId: { not: null },
            status: {
              notIn: [
                ConsolidatedContributionStatus.WITHDRAWN,
                ConsolidatedContributionStatus.CANCELLED,
                ConsolidatedContributionStatus.COMPLETED,
              ],
            },
          },
          select: { listingId: true },
        });
        const listingIds = contributions
          .map((c) => c.listingId)
          .filter((id): id is number => id !== null);

        if (listingIds.length) {
          await tx.foodListing.updateMany({
            where: { id: { in: listingIds } },
            data: { status: ListingStatus.EXPIRED },
          });
        }

        await tx.consolidatedItem.updateMany({
          where: { collectionId: collection.id, outcome: ConsolidatedItemOutcome.PENDING },
          data: { outcome: ConsolidatedItemOutcome.NOT_RECEIVED },
        });
      });

      await this.notifier.expired(collection.id).catch(() => undefined);
    }
    return due.length;
  }

  // ─── 8. Chase the item check ───────────────────────────────────────────────

  private async itemCheckReminder(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - ITEM_CHECK_REMINDER_HOURS * 3600_000);
    const due = await this.prisma.consolidatedCollection.findMany({
      where: {
        status: ConsolidatedCollectionStatus.AWAITING_ITEM_CHECK,
        itemCheckReminderAt: null,
        pickupEndAt: { lt: cutoff },
      },
      select: { id: true, masterListingId: true },
      take: BATCH,
    });

    let sent = 0;
    for (const collection of due) {
      await this.prisma.consolidatedCollection.update({
        where: { id: collection.id },
        data: { itemCheckReminderAt: now },
      });

      if (!collection.masterListingId) continue;
      const claim = await this.prisma.foodClaim.findFirst({
        where: { listingId: collection.masterListingId, status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (claim) {
        await this.notifier.itemCheckDue(collection.id, claim.id).catch(() => undefined);
        sent += 1;
      }
    }
    return sent;
  }
}
