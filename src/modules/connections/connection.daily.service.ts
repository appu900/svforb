import {
  BadRequestException, ConflictException, ForbiddenException, Injectable,
  Logger, NotFoundException,
} from '@nestjs/common';
import {
  ConnectionDayOutcome, ConnectionStatus, ListingStatus, Prisma, SiteRole,
} from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { Jwtpayload } from '../auth/interface/jwt.interface';
import { EnterpriseScopeService } from '../enterprise/services/enterprise-scope.service';
import { ConnectionNotifier } from './connection.notifier';
import { releaseReasonFor, ReleaseTrigger } from './connection.rules';
import {
  collectsOn, isPromptDue, localDateAt, resolveDay,
} from './connection.schedule';
import { AddDailySurplusDto } from './dto/connection.dto';

/**
 * The daily loop: prompt the business, publish today's surplus exclusively to
 * the preferred charity, and fall back to the network when it is not collected.
 *
 * The schedule recurs; the food does not. Nothing is ever listed on a
 * business's behalf — a scheduled day only produces a listing once a human has
 * said what is actually there.
 */
@Injectable()
export class ConnectionDailyService {
  private readonly logger = new Logger(ConnectionDailyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: ConnectionNotifier,
    private readonly scope: EnterpriseScopeService,
  ) {}

  // ─── Sweep 1: prompt the business ──────────────────────────────────────────

  /**
   * Runs every few minutes. Creates the day row and pushes the prompt for any
   * active Connection whose lead time has arrived.
   *
   * A sweep rather than one scheduled job per connection: hundreds of sites on
   * different windows would mean thousands of delayed jobs, and a missed tick
   * here simply catches up on the next one.
   */
  async promptDueCollections(now = new Date()): Promise<number> {
    const connections = await this.prisma.connection.findMany({
      where: { status: ConnectionStatus.ACTIVE },
      include: {
        donorSite: { select: { id: true, timezone: true, name: true, organisationName: true } },
        receiverSite: { select: { id: true, name: true, organisationName: true } },
      },
    });

    let prompted = 0;
    for (const connection of connections) {
      const timezone = connection.donorSite.timezone;
      if (!timezone) {
        this.logger.warn(
          `Connection ${connection.id} skipped — site ${connection.donorSite.id} has no timezone`,
        );
        continue;
      }

      const schedule = { ...connection, timezone };
      const localDate = localDateAt(timezone, now);
      if (!collectsOn(schedule, localDate)) continue;

      const day = resolveDay(schedule, localDate);
      if (!isPromptDue(day, now)) continue;

      try {
        // The unique index on (connectionId, scheduledDate) is what stops the
        // sweep prompting twice for the same day.
        const row = await this.prisma.connectionDay.create({
          data: {
            connectionId: connection.id,
            scheduledDate: day.scheduledDate,
            windowStartAt: day.windowStartAt,
            windowEndAt: day.windowEndAt,
            cutoffAt: day.cutoffAt,
            outcome: ConnectionDayOutcome.PROMPTED,
            promptedAt: now,
          },
        });

        await this.notifier.dailyPrompt({
          connectionId: connection.id,
          connectionDayId: row.id,
          donorSiteId: connection.donorSiteId,
          charityName: connection.receiverSite.name ?? connection.receiverSite.organisationName,
          windowStartMinutes: connection.windowStartMinutes,
          windowEndMinutes: connection.windowEndMinutes,
          windowStartAt: day.windowStartAt,
          windowEndAt: day.windowEndAt,
        });
        prompted++;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue; // already prompted for this day
        }
        this.logger.error(
          `Prompt failed for connection ${connection.id}: ${(err as Error).message}`,
        );
      }
    }

    if (prompted) this.logger.log(`Prompted ${prompted} scheduled collection(s)`);
    return prompted;
  }

  // ─── The business answers ──────────────────────────────────────────────────

  /**
   * Publishes today's surplus, reserved for the preferred charity.
   *
   * Everything but the food comes from the Connection and the site, which is
   * the entire point: the person in the kitchen enters what is left, nothing
   * more.
   */
  async addDailySurplus(caller: Jwtpayload, connectionDayId: number, dto: AddDailySurplusDto) {
    const day = await this.requireDay(connectionDayId);
    await this.assertDonorStaff(caller, day.connection.donorSiteId);

    if (day.outcome !== ConnectionDayOutcome.PROMPTED) {
      throw new ConflictException(
        `Today's collection has already been ${day.outcome.toLowerCase()}.`,
      );
    }
    if (day.connection.status !== ConnectionStatus.ACTIVE) {
      throw new ConflictException('This connection is not active.');
    }

    const site = await this.prisma.site.findUniqueOrThrow({
      where: { id: day.connection.donorSiteId },
    });

    const totalKg = dto.items.reduce((sum, i) => sum + i.quantityKg, 0);
    if (totalKg <= 0) {
      throw new BadRequestException('Enter a quantity greater than zero.');
    }

    const snapshot = await this.scope.snapshotForSite(site.id);

    const listing = await this.prisma.$transaction(async (tx) => {
      const created = await tx.foodListing.create({
        data: {
          siteId: site.id,
          organisationId: site.organisationId,
          totalQtyKg: totalKg,
          remainingQtyKg: totalKg,
          pickupAddress: site.address,
          pickupPostcode: site.postcode,
          pickupLat: site.latitude ?? 0,
          pickupLng: site.longitude ?? 0,
          bestBefore: day.windowEndAt,
          pickupFromTime: day.windowStartAt,
          pickupByTime: day.windowEndAt,
          collectionNotes: dto.collectionNotes ?? site.collectionInstructions,
          status: ListingStatus.ACTIVE,
          // Reserved for the preferred charity until released.
          connectionId: day.connectionId,
          exclusiveToOrgId: day.connection.receiverOrgId,
          exclusiveToSiteId: day.connection.receiverSiteId,
          exclusiveUntil: day.cutoffAt,
          ...snapshot,
          foodItems: {
            create: dto.items.map((i) => ({
              name: i.name,
              totalQtyKg: i.quantityKg,
              remainingQtyKg: i.quantityKg,
              category: i.category ?? null,
            })),
          },
        },
      });

      await tx.connectionDay.update({
        where: { id: day.id },
        data: {
          outcome: ConnectionDayOutcome.PUBLISHED,
          publishedAt: new Date(),
          listingId: created.id,
        },
      });

      return created;
    });

    const summary = dto.items
      .map((i) => `${i.quantityKg}kg ${i.name}`)
      .join(', ');

    // Deliberately not the NEW_LISTING fan-out: nobody else may see this yet.
    await this.notifier.collectionReady({
      connectionId: day.connectionId,
      listingId: listing.id,
      receiverOrgId: day.connection.receiverOrgId,
      receiverSiteId: day.connection.receiverSiteId,
      summary,
      windowStartMinutes: day.connection.windowStartMinutes,
      windowEndMinutes: day.connection.windowEndMinutes,
    });

    this.logger.log(
      `Connection ${day.connectionId} published listing ${listing.id} (${totalKg}kg) exclusive to org ${day.connection.receiverOrgId}`,
    );
    return { message: 'Today’s collection is ready.', listingId: listing.id, totalKg };
  }

  /** The kitchen has nothing today — tell the charity rather than leave them waiting. */
  async declareNoSurplus(caller: Jwtpayload, connectionDayId: number) {
    const day = await this.requireDay(connectionDayId);
    await this.assertDonorStaff(caller, day.connection.donorSiteId);

    if (day.outcome !== ConnectionDayOutcome.PROMPTED) {
      throw new ConflictException('This collection has already been answered.');
    }

    await this.prisma.connectionDay.update({
      where: { id: day.id },
      data: { outcome: ConnectionDayOutcome.NO_SURPLUS, respondedAt: new Date() },
    });

    const donor = await this.prisma.organisation.findUnique({
      where: { id: day.connection.donorOrgId }, select: { name: true },
    });

    await this.notifier.noSurplusToday({
      connectionId: day.connectionId,
      receiverOrgId: day.connection.receiverOrgId,
      receiverSiteId: day.connection.receiverSiteId,
      donorName: donor?.name ?? 'The business',
    });

    return { message: 'The charity has been told there is no collection today.' };
  }

  // ─── Fallback ──────────────────────────────────────────────────────────────

  /** "Can't collect today" — straight to the network. */
  async charityCannotCollect(caller: Jwtpayload, connectionDayId: number) {
    const day = await this.requireDay(connectionDayId);
    if (caller.orgId !== day.connection.receiverOrgId) {
      throw new ForbiddenException('This collection belongs to another organisation.');
    }
    return this.release(day, 'CHARITY_DECLINED');
  }

  /** The business answering the cut-off prompt. */
  async releaseToNetwork(caller: Jwtpayload, connectionDayId: number) {
    const day = await this.requireDay(connectionDayId);
    await this.assertDonorStaff(caller, day.connection.donorSiteId);
    return this.release(day, 'BUSINESS_RELEASED');
  }

  /**
   * Makes an exclusive listing public.
   *
   * Clearing the reservation is what every discovery path keys on, so this is
   * the single point where a listing becomes visible to the network.
   */
  private async release(day: any, trigger: ReleaseTrigger) {
    if (day.outcome !== ConnectionDayOutcome.PUBLISHED || !day.listingId) {
      throw new ConflictException(
        'There is nothing to release — no collection has been published for today.',
      );
    }

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.foodListing.update({
        where: { id: day.listingId },
        data: { releasedAt: now, releasedReason: releaseReasonFor(trigger), exclusiveUntil: null },
      }),
      this.prisma.connectionDay.update({
        where: { id: day.id },
        data: {
          outcome: ConnectionDayOutcome.RELEASED,
          releasedAt: now,
          respondedAt: now,
        },
      }),
    ]);

    await this.notifier.releasedToNetwork({
      connectionId: day.connectionId,
      donorSiteId: day.connection.donorSiteId,
      listingId: day.listingId,
      reason: trigger,
    });

    this.logger.log(
      `Connection day ${day.id} released listing ${day.listingId} (${trigger})`,
    );
    return {
      message: 'Released to nearby charities.',
      listingId: day.listingId,
      reason: trigger,
    };
  }

  // ─── Sweep 2: cut-off and auto-release ─────────────────────────────────────

  /**
   * Chases the business at the cut-off, then releases automatically once the
   * window opens. The second step is the backstop: food must not rot because
   * two people ignored a notification.
   */
  async sweepUnconfirmed(now = new Date()): Promise<{ escalated: number; released: number }> {
    const pending = await this.prisma.connectionDay.findMany({
      where: {
        outcome: ConnectionDayOutcome.PUBLISHED,
        cutoffAt: { lte: now },
        listingId: { not: null },
      },
      include: {
        connection: {
          include: { receiverSite: { select: { name: true, organisationName: true } } },
        },
      },
    });

    let escalated = 0;
    let released = 0;

    for (const day of pending) {
      try {
        if (now >= day.windowStartAt) {
          await this.release(day, 'AUTO_RELEASED');
          released++;
          continue;
        }
        // Between cut-off and window start: ask the business once.
        if (!day.respondedAt) {
          await this.notifier.cutoffEscalation({
            connectionId: day.connectionId,
            connectionDayId: day.id,
            donorSiteId: day.connection.donorSiteId,
            listingId: day.listingId!,
            charityName:
              day.connection.receiverSite.name ??
              day.connection.receiverSite.organisationName,
          });
          await this.prisma.connectionDay.update({
            where: { id: day.id },
            data: { respondedAt: now },
          });
          escalated++;
        }
      } catch (err) {
        this.logger.error(
          `Cut-off sweep failed for day ${day.id}: ${(err as Error).message}`,
        );
      }
    }

    if (escalated || released) {
      this.logger.log(`Cut-off sweep: escalated=${escalated} released=${released}`);
    }
    return { escalated, released };
  }

  /** Days whose window closed without anything happening. */
  async sweepMissed(now = new Date()): Promise<number> {
    const result = await this.prisma.connectionDay.updateMany({
      where: {
        outcome: { in: [ConnectionDayOutcome.PROMPTED] },
        windowEndAt: { lt: now },
      },
      data: { outcome: ConnectionDayOutcome.MISSED },
    });
    if (result.count) this.logger.log(`Marked ${result.count} collection day(s) missed`);
    return result.count;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async requireDay(id: number) {
    const day = await this.prisma.connectionDay.findUnique({
      where: { id },
      include: { connection: true },
    });
    if (!day) throw new NotFoundException('Scheduled collection not found');
    return day;
  }

  private async assertDonorStaff(caller: Jwtpayload, siteId: number) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId }, select: { organisationId: true },
    });
    if (!site || site.organisationId !== caller.orgId) {
      throw new ForbiddenException('That site belongs to another organisation.');
    }
    if (caller.orgRole === 'SUPER_ADMIN') return;

    const access = await this.prisma.siteAccess.findFirst({
      where: {
        userId: caller.sub, siteId,
        siteRole: { in: [SiteRole.SITE_ADMIN, SiteRole.STAFF] },
      },
      select: { id: true },
    });
    if (!access) {
      throw new ForbiddenException('You do not have access to this site.');
    }
  }
}
