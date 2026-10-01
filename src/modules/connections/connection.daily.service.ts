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
import {
  dayOutcomeWhenListingClosed,
  listingCanBeReleased,
  publishedListingSweepAction,
  releaseReasonFor,
  shouldAutoRelease,
  shouldEscalateToBusiness,
  type ReleaseTrigger,
} from './connection.rules';
import {
  collectsOn, describeSchedule, isBusinessListByDue, isPromptDue,
  LIST_BY_MINUTES, localDateAt, resolveDay, resolveDonorTimezone,
} from './connection.schedule';
import { AddDailySurplusDto, ReleaseDayDto } from './dto/connection.dto';

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
        donorSite: {
          select: {
            id: true,
            timezone: true,
            name: true,
            organisationName: true,
          },
        },
        receiverSite: { select: { id: true, name: true, organisationName: true } },
      },
    });

    let prompted = 0;
    for (const connection of connections) {
      const timezone = resolveDonorTimezone(connection.donorSite.timezone);
      if (!timezone) {
        this.logger.warn(
          `Connection ${connection.id} skipped: donor site ${connection.donorSiteId} has no timezone`,
        );
        continue;
      }

      const schedule = { ...connection, timezone };
      const localDate = localDateAt(timezone, now);
      if (!collectsOn(schedule, localDate)) continue;

      const day = resolveDay(schedule, localDate);
      if (!isPromptDue(day, now)) continue;

      try {
        const row = await this.openDay(connection.id, day);
        if (!row) continue;

        const sent = await this.notifier.dailyPromptOnce({
          connectionId: connection.id,
          connectionDayId: row.id,
          donorSiteId: connection.donorSiteId,
          charityName: connection.receiverSite.name ?? connection.receiverSite.organisationName,
          windowStartMinutes: connection.windowStartMinutes,
          windowEndMinutes: connection.windowEndMinutes,
          windowStartAt: day.windowStartAt,
          windowEndAt: day.windowEndAt,
          cutoffAt: day.cutoffAt,
          donorTimezone: timezone,
        });
        if (sent) prompted++;
      } catch (err) {
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

    if (
      day.outcome !== ConnectionDayOutcome.PROMPTED &&
      day.outcome !== ConnectionDayOutcome.NO_RESPONSE
    ) {
      throw new ConflictException(
        `Today's collection has already been ${day.outcome.toLowerCase()}.`,
      );
    }
    if (new Date() >= day.windowEndAt) {
      throw new ConflictException('Today’s pickup window has already ended.');
    }
    if (day.connection.status !== ConnectionStatus.ACTIVE) {
      throw new ConflictException('This connection is not active.');
    }

    const site = await this.prisma.site.findUniqueOrThrow({
      where: { id: day.connection.donorSiteId },
    });
    const donorTimezone = resolveDonorTimezone(site.timezone) ?? undefined;

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
          needsRefrigeration: Boolean(dto.needsRefrigeration),
          needsFreezer: Boolean(dto.needsFreezer),
          needsAmbient: Boolean(dto.needsAmbient),
          needsHot: Boolean(dto.needsHot),
          needsReheating: Boolean(dto.needsReheating),
          allergens: dto.allergens ?? [],
          photoUrls: dto.photoUrls ?? [],
          isSafeForDonation: true,
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

    // Deliberately not the NEW_LISTING fan-out: nobody else may see this yet.
    await this.notifier.collectionReady({
      connectionId: day.connectionId,
      connectionDayId: day.id,
      listingId: listing.id,
      receiverOrgId: day.connection.receiverOrgId,
      receiverSiteId: day.connection.receiverSiteId,
      donorName: site.name ?? site.organisationName ?? undefined,
      items: dto.items.map((item) => ({ name: item.name, quantityKg: item.quantityKg })),
      windowStartMinutes: day.connection.windowStartMinutes,
      windowEndMinutes: day.connection.windowEndMinutes,
      cutoffAt: day.cutoffAt,
      donorTimezone,
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

    if (
      day.outcome !== ConnectionDayOutcome.PROMPTED &&
      day.outcome !== ConnectionDayOutcome.NO_RESPONSE
    ) {
      throw new ConflictException('This collection has already been answered.');
    }
    if (new Date() >= day.windowEndAt) {
      throw new ConflictException('Today’s pickup window has already ended.');
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
  async releaseToNetwork(caller: Jwtpayload, connectionDayId: number, dto?: ReleaseDayDto) {
    const day = await this.requireDay(connectionDayId);
    await this.assertDonorStaff(caller, day.connection.donorSiteId);
    return this.release(day, 'BUSINESS_RELEASED', dto);
  }

  /**
   * Makes an exclusive listing public.
   *
   * Clearing the reservation is what every discovery path keys on, so this is
   * the single point where a listing becomes visible to the network.
   */
  private parseReleaseWindow(dto?: ReleaseDayDto) {
    if (!dto?.pickupFromTime && !dto?.pickupByTime && !dto?.bestBefore) return {};
    if ((dto.pickupFromTime && !dto.pickupByTime) || (!dto.pickupFromTime && dto.pickupByTime)) {
      throw new BadRequestException('Set both the pickup start and end times.');
    }
    const pickupFromTime = dto.pickupFromTime ? new Date(dto.pickupFromTime) : undefined;
    const pickupByTime = dto.pickupByTime ? new Date(dto.pickupByTime) : undefined;
    if (
      (pickupFromTime && Number.isNaN(pickupFromTime.getTime())) ||
      (pickupByTime && Number.isNaN(pickupByTime.getTime()))
    ) {
      throw new BadRequestException('The pickup window is not a valid time.');
    }
    if (pickupFromTime && pickupByTime && pickupByTime <= pickupFromTime) {
      throw new BadRequestException('Pickup end time must be after pickup start time.');
    }
    if (pickupByTime && pickupByTime.getTime() <= Date.now()) {
      throw new BadRequestException('Choose a pickup window that has not ended yet.');
    }
    let bestBefore = dto.bestBefore ? new Date(dto.bestBefore) : pickupByTime;
    if (bestBefore && Number.isNaN(bestBefore.getTime())) {
      throw new BadRequestException('The best before time is not valid.');
    }
    if (bestBefore && pickupByTime && bestBefore.getTime() < pickupByTime.getTime()) {
      bestBefore = pickupByTime;
    }
    return {
      ...(pickupFromTime ? { pickupFromTime } : {}),
      ...(pickupByTime ? { pickupByTime } : {}),
      ...(bestBefore ? { bestBefore } : {}),
    };
  }

  /** Keep the listing claimable after the reserved window, or nearby never sees it. */
  private publicWindowAfterPickupEnd(
    now: Date,
    listing: { pickupByTime: Date | null; bestBefore: Date | null },
  ) {
    const followOnMs = 4 * 60 * 60 * 1000;
    const pickupByTime =
      listing.pickupByTime && listing.pickupByTime.getTime() > now.getTime()
        ? listing.pickupByTime
        : new Date(now.getTime() + followOnMs);
    const bestBefore =
      listing.bestBefore && listing.bestBefore.getTime() >= pickupByTime.getTime()
        ? listing.bestBefore
        : pickupByTime;
    return { pickupFromTime: now, pickupByTime, bestBefore };
  }

  private async release(day: any, trigger: ReleaseTrigger, dto?: ReleaseDayDto) {
    if (day.outcome !== ConnectionDayOutcome.PUBLISHED || !day.listingId) {
      throw new ConflictException(
        'There is nothing to release — no collection has been published for today.',
      );
    }

    const listing = await this.prisma.foodListing.findUnique({
      where: { id: day.listingId },
      select: { id: true, status: true, releasedAt: true, pickupByTime: true, bestBefore: true },
    });
    if (!listing || !listingCanBeReleased(listing.status)) {
      throw new ConflictException(
        'This listing has already been claimed or is no longer active.',
      );
    }

    const now = new Date();
    const window =
      trigger === 'BUSINESS_RELEASED'
        ? this.parseReleaseWindow(dto)
        : trigger === 'AUTO_RELEASED'
          ? this.publicWindowAfterPickupEnd(now, listing)
          : {};
    await this.prisma.$transaction([
      this.prisma.foodListing.update({
        where: { id: day.listingId },
        data: {
          releasedAt: now,
          releasedReason: releaseReasonFor(trigger),
          exclusiveUntil: null,
          ...window,
        },
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

  /**
   * Decides whether the sweep should leave this PUBLISHED day alone.
   * Claimed ≠ collected: a CLAIMED listing stays PUBLISHED until pickup.
   * Expired/cancelled listings are MISSED so the sweep stops retrying release.
   */
  private async skipOrCloseIfNotReleasable(day: {
    id: number;
    listingId: number | null;
  }): Promise<boolean> {
    if (!day.listingId) return false;
    const listing = await this.prisma.foodListing.findUnique({
      where: { id: day.listingId },
      select: { status: true },
    });
    const action = publishedListingSweepAction(listing?.status);
    if (action === 'try_release') return false;
    if (action === 'await_collection') return true;

    const outcome = dayOutcomeWhenListingClosed(listing?.status);
    if (!outcome) return true;

    await this.prisma.connectionDay.update({
      where: { id: day.id },
      data: { outcome, respondedAt: new Date() },
    });
    this.logger.log(
      `Connection day ${day.id} closed as ${outcome} — listing ${day.listingId} is ${listing?.status ?? 'missing'}`,
    );
    return true;
  }

  // ─── Sweep 2: cut-off and auto-release ─────────────────────────────────────

  /**
   * Reminds the business at cut-off if the charity has not claimed yet.
   * Auto-releases reserved food at the charity confirm-by time, or at pickup
   * end when surplus was listed after that deadline.
   */
  async sweepUnconfirmed(now = new Date()): Promise<{ escalated: number; released: number }> {
    const pending = await this.prisma.connectionDay.findMany({
      where: {
        outcome: ConnectionDayOutcome.PUBLISHED,
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
        if (await this.skipOrCloseIfNotReleasable(day)) {
          continue;
        }
        if (shouldAutoRelease(day, now)) {
          await this.release(day, 'AUTO_RELEASED');
          released++;
          continue;
        }
        if (!day.respondedAt && shouldEscalateToBusiness(day, now)) {
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

  /**
   * Business silence at the 2.5-hour deadline. Marked NO_RESPONSE so it stays
   * distinct from an explicit “no surplus” in reporting, and the charity is told
   * not to wait.
   */
  async sweepMissed(now = new Date()): Promise<number> {
    const due = await this.prisma.connectionDay.findMany({
      where: {
        outcome: ConnectionDayOutcome.PROMPTED,
        windowStartAt: { lte: new Date(now.getTime() + LIST_BY_MINUTES * 60000) },
      },
      include: {
        connection: {
          include: {
            donorSite: {
              select: {
                name: true,
                organisationName: true,
                timezone: true,
              },
            },
            donorOrg: { select: { name: true } },
            receiverSite: { select: { name: true, organisationName: true } },
          },
        },
      },
    });

    let marked = 0;
    for (const day of due) {
      const timezone = resolveDonorTimezone(day.connection.donorSite.timezone);
      if (!timezone) continue;
      const resolved = resolveDay({ ...day.connection, timezone }, day.scheduledDate);
      const aligned = await this.alignPromptedWindow(day, resolved);
      if (!isBusinessListByDue(aligned.windowStartAt, now)) continue;
      try {
        const claimed = await this.prisma.connectionDay.updateMany({
          where: { id: day.id, outcome: ConnectionDayOutcome.PROMPTED, listingId: null },
          data: {
            outcome: ConnectionDayOutcome.NO_RESPONSE,
            respondedAt: now,
          },
        });
        if (!claimed.count) continue;

        const donorName =
          day.connection.donorSite.name ??
          day.connection.donorSite.organisationName ??
          day.connection.donorOrg.name ??
          'The business';
        const reminded = await this.notifier.listByReminder({
          connectionId: day.connectionId,
          connectionDayId: day.id,
          donorSiteId: day.connection.donorSiteId,
          charityName:
            day.connection.receiverSite?.name ??
            day.connection.receiverSite?.organisationName ??
            'your connected charity',
          windowStartMinutes: day.connection.windowStartMinutes,
          windowEndMinutes: day.connection.windowEndMinutes,
          donorTimezone: timezone,
        });
        if (!reminded) {
          await this.prisma.connectionDay.updateMany({
            where: { id: day.id, outcome: ConnectionDayOutcome.NO_RESPONSE, respondedAt: now },
            data: { outcome: ConnectionDayOutcome.PROMPTED, respondedAt: null },
          });
          continue;
        }
        await this.notifier.businessNoResponse({
          connectionId: day.connectionId,
          receiverOrgId: day.connection.receiverOrgId,
          receiverSiteId: day.connection.receiverSiteId,
          donorName,
        });
        marked++;
      } catch (err) {
        this.logger.error(
          `No-response sweep failed for day ${day.id}: ${(err as Error).message}`,
        );
      }
    }

    if (marked) this.logger.log(`Marked ${marked} collection day(s) as no response`);
    return marked;
  }

  // ─── Reading today ─────────────────────────────────────────────────────────

  /**
   * Opens today's day row when the schedule says the kitchen should be asked,
   * then returns every due collection for the Surplus screen.
   */
  async listTodayForSite(caller: Jwtpayload, siteId: number) {
    await this.assertDonorOrg(caller, siteId);

    const connections = await this.prisma.connection.findMany({
      where: { donorSiteId: siteId, status: ConnectionStatus.ACTIVE },
      include: {
        donorSite: {
          select: {
            id: true,
            name: true,
            organisationName: true,
            timezone: true,
          },
        },
        receiverSite: { select: { id: true, name: true, organisationName: true } },
        receiverOrg: { select: { id: true, name: true } },
      },
    });

    const now = new Date();
    const out: any[] = [];

    for (const connection of connections) {
      const timezone = resolveDonorTimezone(connection.donorSite.timezone);
      if (!timezone) continue;

      const schedule = { ...connection, timezone };
      const localDate = localDateAt(timezone, now);
      if (!collectsOn(schedule, localDate)) continue;

      const resolved = resolveDay(schedule, localDate);
      if (!isPromptDue(resolved, now)) continue;

      let day = await this.openDay(connection.id, resolved);
      if (!day) continue;

      const promptedAt = await this.notifier.dailyPromptOnce({
        connectionId: connection.id,
        connectionDayId: day.id,
        donorSiteId: connection.donorSiteId,
        charityName:
          connection.receiverSite.name ?? connection.receiverSite.organisationName,
        windowStartMinutes: connection.windowStartMinutes,
        windowEndMinutes: connection.windowEndMinutes,
        windowStartAt: resolved.windowStartAt,
        windowEndAt: resolved.windowEndAt,
        cutoffAt: resolved.cutoffAt,
        donorTimezone: timezone,
      });
      if (promptedAt) day = { ...day, promptedAt };

      out.push({
        connectionId: connection.id,
        dayId: day.id,
        status: connection.status,
        outcome: day.outcome,
        schedule: describeSchedule(
          connection.daysOfWeek,
          connection.windowStartMinutes,
          connection.windowEndMinutes,
        ),
        donorTimezone: timezone,
        charityName:
          connection.receiverSite.name ?? connection.receiverSite.organisationName,
        donorName:
          connection.donorSite.name ?? connection.donorSite.organisationName,
        donorSiteId: connection.donorSiteId,
        receiverSiteId: connection.receiverSiteId,
        listingId: day.listingId,
        scheduledDate: day.scheduledDate,
        windowStartAt: day.windowStartAt,
        windowEndAt: day.windowEndAt,
        cutoffAt: day.cutoffAt,
        promptedAt: day.promptedAt,
        publishedAt: day.publishedAt,
        respondedAt: day.respondedAt,
        releasedAt: day.releasedAt,
      });
    }

    return out;
  }

  /** Reserved collections the preferred charity can confirm or decline today. */
  async listTodayForCharity(caller: Jwtpayload) {
    if (!caller.orgId) throw new ForbiddenException('Not part of an organisation');

    const now = new Date();
    const days = await this.prisma.connectionDay.findMany({
      where: {
        outcome: {
          in: [ConnectionDayOutcome.PROMPTED, ConnectionDayOutcome.PUBLISHED],
        },
        windowEndAt: { gte: now },
        connection: { receiverOrgId: caller.orgId },
      },
      include: {
        connection: {
          include: {
            donorSite: { select: { id: true, name: true, organisationName: true, timezone: true } },
            donorOrg: { select: { id: true, name: true } },
            receiverSite: { select: { id: true, name: true, organisationName: true } },
          },
        },
      },
      orderBy: { windowStartAt: 'asc' },
    });

    return days.map((day) => ({
      connectionId: day.connectionId,
      dayId: day.id,
      status: day.connection.status,
      outcome: day.outcome,
      schedule: describeSchedule(
        day.connection.daysOfWeek,
        day.connection.windowStartMinutes,
        day.connection.windowEndMinutes,
      ),
      donorTimezone: resolveDonorTimezone(day.connection.donorSite.timezone),
      charityName:
        day.connection.receiverSite.name ??
        day.connection.receiverSite.organisationName,
      donorName:
        day.connection.donorSite.name ??
        day.connection.donorSite.organisationName ??
        day.connection.donorOrg.name,
      donorSiteId: day.connection.donorSiteId,
      receiverSiteId: day.connection.receiverSiteId,
      listingId: day.listingId,
      scheduledDate: day.scheduledDate,
      windowStartAt: day.windowStartAt,
      windowEndAt: day.windowEndAt,
      cutoffAt: day.cutoffAt,
      promptedAt: day.promptedAt,
      publishedAt: day.publishedAt,
      respondedAt: day.respondedAt,
      releasedAt: day.releasedAt,
    }));
  }


  /**
   * Business moves a reserved listing to another connection whose window is
   * still open. Already-claimed and already-public listings are not touched.
   */
  async reassignToConnection(
    caller: Jwtpayload,
    fromDayId: number,
    toConnectionId: number,
  ) {
    const from = await this.requireDay(fromDayId);
    await this.assertDonorStaff(caller, from.connection.donorSiteId);

    if (from.outcome !== ConnectionDayOutcome.PUBLISHED || !from.listingId) {
      throw new ConflictException('There is no reserved listing to move.');
    }
    if (from.connectionId === toConnectionId) {
      throw new BadRequestException('This listing is already reserved for that connection.');
    }

    const listing = await this.prisma.foodListing.findUnique({
      where: { id: from.listingId },
      include: { foodItems: { select: { name: true, totalQtyKg: true } } },
    });
    if (!listing || listing.status !== ListingStatus.ACTIVE) {
      throw new ConflictException(
        'This listing has already been claimed or is no longer active.',
      );
    }
    if (listing.releasedAt) {
      throw new ConflictException('This listing is already on the open network.');
    }

    const target = await this.prisma.connection.findUnique({
      where: { id: toConnectionId },
      include: {
        donorSite: {
          select: {
            timezone: true,
            name: true,
            organisationName: true,
          },
        },
        donorOrg: { select: { name: true } },
        receiverSite: { select: { name: true, organisationName: true } },
      },
    });
    if (!target || target.status !== ConnectionStatus.ACTIVE) {
      throw new ConflictException('That connection is not active.');
    }
    if (target.donorSiteId !== from.connection.donorSiteId) {
      throw new BadRequestException('That connection is for a different site.');
    }

    const timezone = resolveDonorTimezone(target.donorSite.timezone);
    if (!timezone) {
      throw new ConflictException(
        'Set this site’s timezone before moving the collection.',
      );
    }
    const now = new Date();
    const schedule = { ...target, timezone };
    const localDate = localDateAt(timezone, now);
    if (!collectsOn(schedule, localDate)) {
      throw new ConflictException('That charity is not scheduled to collect today.');
    }
    const resolved = resolveDay(schedule, localDate);
    if (now >= resolved.windowEndAt) {
      throw new ConflictException('That charity’s pickup window has already ended.');
    }

    let toDay = await this.prisma.connectionDay.findUnique({
      where: {
        connectionId_scheduledDate: {
          connectionId: target.id,
          scheduledDate: resolved.scheduledDate,
        },
      },
    });
    if (!toDay) {
      try {
        toDay = await this.prisma.connectionDay.create({
          data: {
            connectionId: target.id,
            scheduledDate: resolved.scheduledDate,
            windowStartAt: resolved.windowStartAt,
            windowEndAt: resolved.windowEndAt,
            cutoffAt: resolved.cutoffAt,
            outcome: ConnectionDayOutcome.PROMPTED,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          toDay = await this.prisma.connectionDay.findUnique({
            where: {
              connectionId_scheduledDate: {
                connectionId: target.id,
                scheduledDate: resolved.scheduledDate,
              },
            },
          });
        } else {
          throw err;
        }
      }
    }
    if (!toDay) {
      throw new ConflictException('Could not open that connection’s collection today.');
    }
    if (
      (toDay.outcome !== ConnectionDayOutcome.PROMPTED &&
        toDay.outcome !== ConnectionDayOutcome.NO_RESPONSE) ||
      toDay.listingId
    ) {
      throw new ConflictException('That charity already has a listing today.');
    }

    const nextBestBefore =
      listing.bestBefore && listing.bestBefore.getTime() >= resolved.windowEndAt.getTime()
        ? listing.bestBefore
        : resolved.windowEndAt;

    await this.prisma.$transaction([
      this.prisma.foodListing.update({
        where: { id: listing.id },
        data: {
          connectionId: target.id,
          exclusiveToOrgId: target.receiverOrgId,
          exclusiveToSiteId: target.receiverSiteId,
          exclusiveUntil: resolved.cutoffAt,
          releasedAt: null,
          releasedReason: null,
          pickupFromTime: resolved.windowStartAt,
          pickupByTime: resolved.windowEndAt,
          bestBefore: nextBestBefore,
        },
      }),
      this.prisma.connectionDay.update({
        where: { id: from.id },
        data: {
          outcome: ConnectionDayOutcome.RELEASED,
          releasedAt: now,
          respondedAt: now,
          listingId: null,
        },
      }),
      this.prisma.connectionDay.update({
        where: { id: toDay.id },
        data: {
          outcome: ConnectionDayOutcome.PUBLISHED,
          publishedAt: now,
          listingId: listing.id,
        },
      }),
    ]);

    const donorName =
      target.donorSite.name ??
      target.donorSite.organisationName ??
      target.donorOrg.name ??
      'The business';

    await this.notifier.reservationMoved({
      connectionId: from.connectionId,
      receiverOrgId: from.connection.receiverOrgId,
      receiverSiteId: from.connection.receiverSiteId,
      donorName,
    });
    await this.notifier.collectionReady({
      connectionId: target.id,
      connectionDayId: toDay.id,
      listingId: listing.id,
      receiverOrgId: target.receiverOrgId,
      receiverSiteId: target.receiverSiteId,
      donorName:
        target.donorSite.name ??
        target.donorSite.organisationName ??
        target.donorOrg.name ??
        undefined,
      items: listing.foodItems.map((item) => ({
        name: item.name,
        quantityKg: item.totalQtyKg,
      })),
      windowStartMinutes: target.windowStartMinutes,
      windowEndMinutes: target.windowEndMinutes,
      cutoffAt: resolved.cutoffAt,
      donorTimezone: timezone,
    });

    this.logger.log(
      `Listing ${listing.id} moved from connection ${from.connectionId} to ${target.id}`,
    );
    return {
      message: 'Reserved for the other connection.',
      listingId: listing.id,
      toConnectionId: target.id,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Today's row, created if missing. Never marks it prompted — only
   * `dailyPromptOnce` does that, so opening a row can never swallow the push.
   */
  private async openDay(
    connectionId: number,
    resolved: { scheduledDate: Date; windowStartAt: Date; windowEndAt: Date; cutoffAt: Date },
  ) {
    const where = {
      connectionId_scheduledDate: { connectionId, scheduledDate: resolved.scheduledDate },
    };
    const existing = await this.prisma.connectionDay.findUnique({ where });
    if (existing) return this.alignPromptedWindow(existing, resolved);

    try {
      return await this.prisma.connectionDay.create({
        data: {
          connectionId,
          scheduledDate: resolved.scheduledDate,
          windowStartAt: resolved.windowStartAt,
          windowEndAt: resolved.windowEndAt,
          cutoffAt: resolved.cutoffAt,
          outcome: ConnectionDayOutcome.PROMPTED,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.prisma.connectionDay.findUnique({ where });
        return raced ? this.alignPromptedWindow(raced, resolved) : null;
      }
      throw err;
    }
  }

  private async alignPromptedWindow<
    T extends {
      id: number;
      outcome: ConnectionDayOutcome;
      listingId: number | null;
      windowStartAt: Date;
      windowEndAt: Date;
      cutoffAt: Date;
    },
  >(
    day: T,
    resolved: { windowStartAt: Date; windowEndAt: Date; cutoffAt: Date },
  ): Promise<T> {
    if (day.outcome !== ConnectionDayOutcome.PROMPTED || day.listingId) return day;
    if (
      day.windowStartAt.getTime() === resolved.windowStartAt.getTime() &&
      day.windowEndAt.getTime() === resolved.windowEndAt.getTime() &&
      day.cutoffAt.getTime() === resolved.cutoffAt.getTime()
    ) {
      return day;
    }
    const updated = await this.prisma.connectionDay.update({
      where: { id: day.id },
      data: {
        windowStartAt: resolved.windowStartAt,
        windowEndAt: resolved.windowEndAt,
        cutoffAt: resolved.cutoffAt,
      },
    });
    return { ...day, ...updated };
  }

  private async requireDay(id: number) {
    const day = await this.prisma.connectionDay.findUnique({
      where: { id },
      include: { connection: true },
    });
    if (!day) throw new NotFoundException('Scheduled collection not found');
    return day;
  }

  private async assertDonorOrg(caller: Jwtpayload, siteId: number) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId }, select: { organisationId: true },
    });
    if (!site || site.organisationId !== caller.orgId) {
      throw new ForbiddenException('That site belongs to another organisation.');
    }
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
