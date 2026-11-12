import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ConsolidatedCollectionStatus, ConsolidatedScheduleStatus, Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { Jwtpayload } from '../../auth/interface/jwt.interface';
import { localDateAt } from '../../connections/connection.schedule';
import { CONSOLIDATED_HORIZON_DAYS } from '../consolidated.constants';
import { CreateScheduleDto, EndScheduleDto, UpdateScheduleDto } from '../dto/schedule.dto';
import { ConsolidatedAccessService } from './consolidated-access.service';
import { CONSOLIDATED_ACTION, ConsolidatedAuditService, RequestContext } from './consolidated-audit.service';
import {
  NormalisedSchedule, occurrenceDates, resolveOccurrence, toLocalDate, validateScheduleInput,
} from './consolidated-schedule';

const DAY_MS = 86_400_000;

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Schedules, and the occurrences they materialise.
 *
 * Collections are real rows rather than computed on the fly, because each one
 * accumulates its own contributions, receipts and status. The sweep keeps a
 * rolling horizon ahead of today (A4).
 */
@Injectable()
export class ConsolidatedScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConsolidatedAccessService,
    private readonly audit: ConsolidatedAuditService,
  ) {}

  // ─── Create ────────────────────────────────────────────────────────────────

  async create(caller: Jwtpayload, groupId: number, dto: CreateScheduleDto, req?: RequestContext) {
    const group = await this.access.assertManager(caller, groupId);

    const point = await this.prisma.consolidatedCollectionPoint.findFirst({
      where: { id: dto.collectionPointId, groupId, isActive: true },
    });
    if (!point) throw new NotFoundException('Collection point not found in this group.');

    const activeSiteIds = group.sites.map((s) => s.siteId);
    const participating = this.resolveParticipants(dto.participatingSiteIds, activeSiteIds);

    const normalised = validateScheduleInput({
      timezone: group.timezone,
      recurrence: dto.recurrence,
      startDate: new Date(dto.startDate),
      endDate: dto.endDate ? new Date(dto.endDate) : null,
      daysOfWeek: dto.daysOfWeek,
      customDates: dto.customDates?.map((d) => new Date(d)),
      opensDaysBefore: dto.opensDaysBefore,
      submissionsCloseTime: dto.submissionsCloseTime,
      handoverStartTime: dto.handoverStartTime,
      handoverEndTime: dto.handoverEndTime,
      pickupStartTime: dto.pickupStartTime,
      pickupEndTime: dto.pickupEndTime,
    });

    const actor = await this.audit.actorFrom(caller, req);

    return this.prisma.$transaction(async (tx) => {
      const schedule = await tx.consolidatedSchedule.create({
        data: {
          groupId,
          collectionPointId: point.id,
          method: dto.method,
          recurrence: normalised.recurrence,
          timezone: normalised.timezone,
          startDate: normalised.startDate,
          endDate: normalised.endDate,
          daysOfWeek: normalised.daysOfWeek,
          customDates: normalised.customDates,
          opensDaysBefore: normalised.opensDaysBefore,
          submissionsCloseMinutes: normalised.submissionsCloseMinutes,
          handoverStartMinutes: normalised.handoverStartMinutes,
          handoverEndMinutes: normalised.handoverEndMinutes,
          pickupStartMinutes: normalised.pickupStartMinutes,
          pickupEndMinutes: normalised.pickupEndMinutes,
          contactName: dto.contactName,
          contactPhone: dto.contactPhone,
          instructions: dto.instructions,
          suitabilityNotes: dto.suitabilityNotes,
          participatingSiteIds: participating,
          createdByUserId: caller.sub,
        },
      });

      const created = await this.generate(tx, schedule.id);

      await this.audit.log(tx, actor, {
        organisationId: group.organisationId,
        action: CONSOLIDATED_ACTION.SCHEDULE_CREATED,
        entityType: 'ConsolidatedSchedule',
        entityId: schedule.id,
        entityLabel: group.name,
        newValue: {
          recurrence: schedule.recurrence,
          startDate: schedule.startDate,
          participatingSiteIds: participating,
        },
        summary:
          `Scheduled ${schedule.recurrence.toLowerCase().replace(/_/g, ' ')} collections for ` +
          `"${group.name}". ${created} occurrence(s) created.`,
      });

      return { schedule, collectionsCreated: created };
    });
  }

  // ─── Generation ────────────────────────────────────────────────────────────

  /**
   * Materialises occurrences up to the horizon.
   *
   * Idempotent on two counts: existing dates are skipped, and the unique index
   * on (scheduleId, scheduledDate) stops a concurrent sweep duplicating a row.
   */
  async generate(db: Db, scheduleId: number, now: Date = new Date()): Promise<number> {
    const schedule = await db.consolidatedSchedule.findUnique({
      where: { id: scheduleId },
      include: { group: { select: { organisationId: true } } },
    });
    if (!schedule || schedule.status !== ConsolidatedScheduleStatus.ACTIVE) return 0;

    const today = localDateAt(schedule.timezone, now);
    const horizonEnd = new Date(today.getTime() + CONSOLIDATED_HORIZON_DAYS * DAY_MS);

    const dates = occurrenceDates(
      {
        recurrence: schedule.recurrence,
        startDate: toLocalDate(schedule.startDate),
        endDate: schedule.endDate ? toLocalDate(schedule.endDate) : null,
        daysOfWeek: schedule.daysOfWeek,
        customDates: schedule.customDates.map(toLocalDate),
      },
      today,
      horizonEnd,
    );
    if (dates.length === 0) {
      await this.markGenerated(db, scheduleId, horizonEnd);
      return 0;
    }

    const existing = await db.consolidatedCollection.findMany({
      where: { scheduleId, scheduledDate: { in: dates } },
      select: { scheduledDate: true },
    });
    const have = new Set(existing.map((e) => e.scheduledDate.getTime()));
    const missing = dates.filter((d) => !have.has(d.getTime()));
    if (missing.length === 0) {
      await this.markGenerated(db, scheduleId, horizonEnd);
      return 0;
    }

    const point = await db.consolidatedCollectionPoint.findUnique({
      where: { id: schedule.collectionPointId },
    });
    if (!point) return 0;

    const windowFor = (date: Date) =>
      resolveOccurrence(schedule as unknown as NormalisedSchedule, date);

    const result = await db.consolidatedCollection.createMany({
      data: missing.map((date) => {
        const w = windowFor(date);
        return {
          organisationId: schedule.group.organisationId,
          groupId: schedule.groupId,
          scheduleId: schedule.id,
          collectionPointId: point.id,
          // Snapshot: editing the point later must not rewrite history.
          pointName: point.name,
          pointAddress: point.address,
          pointPostcode: point.postcode,
          pointLat: point.lat,
          pointLng: point.lng,
          pointDirections: point.directions,
          method: schedule.method,
          status:
            w.opensAt <= now
              ? ConsolidatedCollectionStatus.OPEN
              : ConsolidatedCollectionStatus.SCHEDULED,
          openedAt: w.opensAt <= now ? now : null,
          timezone: schedule.timezone,
          scheduledDate: date,
          opensAt: w.opensAt,
          submissionsCloseAt: w.submissionsCloseAt,
          handoverStartAt: w.handoverStartAt,
          handoverEndAt: w.handoverEndAt,
          pickupStartAt: w.pickupStartAt,
          pickupEndAt: w.pickupEndAt,
          contactName: schedule.contactName,
          contactPhone: schedule.contactPhone,
          instructions: schedule.instructions,
          suitabilityNotes: schedule.suitabilityNotes,
          participatingSiteIds: schedule.participatingSiteIds,
        };
      }),
      skipDuplicates: true,
    });

    await this.markGenerated(db, scheduleId, horizonEnd);
    return result.count;
  }

  private markGenerated(db: Db, scheduleId: number, until: Date) {
    return db.consolidatedSchedule.update({
      where: { id: scheduleId },
      data: { generatedUntil: until },
    });
  }

  // ─── Update ────────────────────────────────────────────────────────────────

  /**
   * Edits the series. Only occurrences that have not opened and have not been
   * edited individually are rewritten — a detached occurrence is deliberately
   * left alone (A4).
   */
  async update(caller: Jwtpayload, scheduleId: number, dto: UpdateScheduleDto, req?: RequestContext) {
    const existing = await this.prisma.consolidatedSchedule.findUnique({
      where: { id: scheduleId },
      include: { group: true },
    });
    if (!existing) throw new NotFoundException('Schedule not found.');
    const group = await this.access.assertManager(caller, existing.groupId);

    const pointId = dto.collectionPointId ?? existing.collectionPointId;
    const point = await this.prisma.consolidatedCollectionPoint.findFirst({
      where: { id: pointId, groupId: existing.groupId, isActive: true },
    });
    if (!point) throw new NotFoundException('Collection point not found in this group.');

    const time = (next: string | undefined, current: number) =>
      next ?? `${String(Math.floor(current / 60)).padStart(2, '0')}:${String(current % 60).padStart(2, '0')}`;

    const normalised = validateScheduleInput(
      {
        timezone: group.timezone,
        recurrence: dto.recurrence ?? existing.recurrence,
        startDate: dto.startDate ? new Date(dto.startDate) : existing.startDate,
        endDate: dto.endDate ? new Date(dto.endDate) : existing.endDate,
        daysOfWeek: dto.daysOfWeek ?? existing.daysOfWeek,
        customDates: dto.customDates?.map((d) => new Date(d)) ?? existing.customDates,
        opensDaysBefore: dto.opensDaysBefore ?? existing.opensDaysBefore,
        submissionsCloseTime: time(dto.submissionsCloseTime, existing.submissionsCloseMinutes),
        handoverStartTime: time(dto.handoverStartTime, existing.handoverStartMinutes),
        handoverEndTime: time(dto.handoverEndTime, existing.handoverEndMinutes),
        pickupStartTime: time(dto.pickupStartTime, existing.pickupStartMinutes),
        pickupEndTime: time(dto.pickupEndTime, existing.pickupEndMinutes),
      },
      // The start date is already in the past for a running series; validating
      // against it rather than today keeps an edit from being rejected for it.
      existing.startDate < new Date() ? existing.startDate : new Date(),
    );

    const participating = this.resolveParticipants(
      dto.participatingSiteIds ?? existing.participatingSiteIds,
      group.sites.map((s) => s.siteId),
    );
    const actor = await this.audit.actorFrom(caller, req);

    return this.prisma.$transaction(async (tx) => {
      const schedule = await tx.consolidatedSchedule.update({
        where: { id: scheduleId },
        data: {
          collectionPointId: point.id,
          method: dto.method ?? existing.method,
          recurrence: normalised.recurrence,
          startDate: normalised.startDate,
          endDate: normalised.endDate,
          daysOfWeek: normalised.daysOfWeek,
          customDates: normalised.customDates,
          opensDaysBefore: normalised.opensDaysBefore,
          submissionsCloseMinutes: normalised.submissionsCloseMinutes,
          handoverStartMinutes: normalised.handoverStartMinutes,
          handoverEndMinutes: normalised.handoverEndMinutes,
          pickupStartMinutes: normalised.pickupStartMinutes,
          pickupEndMinutes: normalised.pickupEndMinutes,
          contactName: dto.contactName ?? existing.contactName,
          contactPhone: dto.contactPhone ?? existing.contactPhone,
          instructions: dto.instructions ?? existing.instructions,
          suitabilityNotes: dto.suitabilityNotes ?? existing.suitabilityNotes,
          participatingSiteIds: participating,
          // Re-generation re-fills the horizon under the new rule.
          generatedUntil: null,
        },
      });

      const now = new Date();
      const future = await tx.consolidatedCollection.findMany({
        where: {
          scheduleId,
          isDetached: false,
          status: { in: [ConsolidatedCollectionStatus.SCHEDULED, ConsolidatedCollectionStatus.OPEN] },
          scheduledDate: { gte: localDateAt(group.timezone, now) },
        },
        select: { id: true, scheduledDate: true, _count: { select: { contributions: true } } },
      });

      const stillValid = new Set(
        occurrenceDates(normalised, localDateAt(group.timezone, now),
          new Date(localDateAt(group.timezone, now).getTime() + CONSOLIDATED_HORIZON_DAYS * DAY_MS))
          .map((d) => d.getTime()),
      );

      for (const row of future) {
        if (stillValid.has(row.scheduledDate.getTime())) {
          const w = resolveOccurrence(normalised, row.scheduledDate);
          await tx.consolidatedCollection.update({
            where: { id: row.id },
            data: {
              collectionPointId: point.id,
              pointName: point.name,
              pointAddress: point.address,
              pointPostcode: point.postcode,
              pointLat: point.lat,
              pointLng: point.lng,
              pointDirections: point.directions,
              method: schedule.method,
              opensAt: w.opensAt,
              submissionsCloseAt: w.submissionsCloseAt,
              handoverStartAt: w.handoverStartAt,
              handoverEndAt: w.handoverEndAt,
              pickupStartAt: w.pickupStartAt,
              pickupEndAt: w.pickupEndAt,
              contactName: schedule.contactName,
              contactPhone: schedule.contactPhone,
              instructions: schedule.instructions,
              suitabilityNotes: schedule.suitabilityNotes,
              participatingSiteIds: participating,
            },
          });
          continue;
        }

        // No longer part of the series. Empty ones are removed outright; ones
        // sites have already acted on are cancelled so the history survives.
        if (row._count.contributions === 0) {
          await tx.consolidatedCollection.delete({ where: { id: row.id } });
        } else {
          await tx.consolidatedCollection.update({
            where: { id: row.id },
            data: {
              status: ConsolidatedCollectionStatus.CANCELLED,
              cancelledAt: now,
              cancelledByUserId: caller.sub,
              cancelReason: 'Schedule changed',
            },
          });
        }
      }

      const created = await this.generate(tx, scheduleId, now);

      await this.audit.log(tx, actor, {
        organisationId: group.organisationId,
        action: CONSOLIDATED_ACTION.SCHEDULE_UPDATED,
        entityType: 'ConsolidatedSchedule',
        entityId: scheduleId,
        entityLabel: group.name,
        previousValue: {
          recurrence: existing.recurrence,
          pickupStartMinutes: existing.pickupStartMinutes,
        },
        newValue: {
          recurrence: schedule.recurrence,
          pickupStartMinutes: schedule.pickupStartMinutes,
        },
        summary: `Updated the collection schedule for "${group.name}".`,
      });

      return { schedule, collectionsCreated: created };
    });
  }

  // ─── End ───────────────────────────────────────────────────────────────────

  async end(caller: Jwtpayload, scheduleId: number, dto: EndScheduleDto, req?: RequestContext) {
    const existing = await this.prisma.consolidatedSchedule.findUnique({
      where: { id: scheduleId },
      include: { group: true },
    });
    if (!existing) throw new NotFoundException('Schedule not found.');
    const group = await this.access.assertManager(caller, existing.groupId);

    const from = toLocalDate(new Date(dto.fromDate));
    if (Number.isNaN(from.getTime())) throw new BadRequestException('Invalid date.');

    const actor = await this.audit.actorFrom(caller, req);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.consolidatedSchedule.update({
        where: { id: scheduleId },
        data: {
          status: ConsolidatedScheduleStatus.ENDED,
          endDate: new Date(from.getTime() - DAY_MS),
        },
      });

      const cancelled = await tx.consolidatedCollection.updateMany({
        where: {
          scheduleId,
          scheduledDate: { gte: from },
          status: { in: [ConsolidatedCollectionStatus.SCHEDULED, ConsolidatedCollectionStatus.OPEN] },
        },
        data: {
          status: ConsolidatedCollectionStatus.CANCELLED,
          cancelledAt: now,
          cancelledByUserId: caller.sub,
          cancelReason: 'Schedule ended',
        },
      });

      await this.audit.log(tx, actor, {
        organisationId: group.organisationId,
        action: CONSOLIDATED_ACTION.SCHEDULE_ENDED,
        entityType: 'ConsolidatedSchedule',
        entityId: scheduleId,
        entityLabel: group.name,
        summary:
          `Ended the collection schedule for "${group.name}". ` +
          `${cancelled.count} upcoming collection(s) cancelled.`,
      });

      return { ended: true, cancelledCollections: cancelled.count };
    });
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  async listForGroup(caller: Jwtpayload, groupId: number) {
    await this.access.assertReceiver(caller, groupId);
    return this.prisma.consolidatedSchedule.findMany({
      where: { groupId },
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Empty means every active site in the group (SPEC §7.3). */
  private resolveParticipants(requested: number[] | undefined, activeSiteIds: number[]): number[] {
    if (!requested || requested.length === 0) return activeSiteIds;

    const active = new Set(activeSiteIds);
    const outside = requested.filter((id) => !active.has(id));
    if (outside.length > 0) {
      throw new BadRequestException(
        `Site ${outside[0]} is not an active site in this collection group.`,
      );
    }
    return [...new Set(requested)];
  }
}
