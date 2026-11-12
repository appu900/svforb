import { BadRequestException } from '@nestjs/common';
import { ConsolidatedRecurrence } from '@prisma/client';
import {
  assertValidTimezone,
  instantForLocalTime,
  isoWeekdayOf,
  localDateAt,
  parseLocalTime,
  type LocalMinutes,
} from '../../connections/connection.schedule';

/**
 * Pure date maths for collection schedules — no database, no Nest injection.
 *
 * Windows are held as local minutes past midnight rather than instants, which
 * is what makes "2pm" mean 2pm in Melbourne and in Brisbane, and keeps meaning
 * 2pm on either side of a daylight-saving change. The same approach as
 * connections/connection.schedule.ts, whose helpers this builds on.
 */

/** No more than a year of hand-picked dates on one schedule. */
const MAX_CUSTOM_DATES = 366;

export interface ScheduleTimesInput {
  submissionsCloseTime: string;
  handoverStartTime: string;
  handoverEndTime: string;
  pickupStartTime: string;
  pickupEndTime: string;
}

export interface ConsolidatedScheduleInput extends ScheduleTimesInput {
  timezone: string;
  recurrence: ConsolidatedRecurrence;
  /** Local date at UTC midnight. */
  startDate: Date;
  endDate?: Date | null;
  daysOfWeek?: number[];
  customDates?: Date[];
  opensDaysBefore?: number;
}

/** The same schedule with wall-clock strings resolved to minutes. */
export interface NormalisedSchedule {
  timezone: string;
  recurrence: ConsolidatedRecurrence;
  startDate: Date;
  endDate: Date | null;
  daysOfWeek: number[];
  customDates: Date[];
  opensDaysBefore: number;
  submissionsCloseMinutes: LocalMinutes;
  handoverStartMinutes: LocalMinutes;
  handoverEndMinutes: LocalMinutes;
  pickupStartMinutes: LocalMinutes;
  pickupEndMinutes: LocalMinutes;
}

export interface ScheduleWindow {
  opensAt: Date;
  submissionsCloseAt: Date;
  handoverStartAt: Date;
  handoverEndAt: Date;
  pickupStartAt: Date;
  pickupEndAt: Date;
}

const DAY_MS = 86_400_000;

/** A Date as a UTC-midnight local date, discarding any time component. */
export function toLocalDate(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addDays(localDate: Date, days: number): Date {
  return new Date(localDate.getTime() + days * DAY_MS);
}

function sameOrAfter(a: Date, b: Date): boolean {
  return a.getTime() >= b.getTime();
}

/**
 * Validates a schedule and resolves its wall-clock strings to minutes.
 *
 * Returns the normalised shape rather than mutating, so a caller cannot
 * accidentally persist the unvalidated input.
 */
export function validateScheduleInput(
  input: ConsolidatedScheduleInput,
  now: Date = new Date(),
): NormalisedSchedule {
  assertValidTimezone(input.timezone);

  // parseLocalTime rejects anything that is not HH:mm in range.
  const submissionsCloseMinutes = parseLocalTime(input.submissionsCloseTime);
  const handoverStartMinutes = parseLocalTime(input.handoverStartTime);
  const handoverEndMinutes = parseLocalTime(input.handoverEndTime);
  const pickupStartMinutes = parseLocalTime(input.pickupStartTime);
  const pickupEndMinutes = parseLocalTime(input.pickupEndTime);

  // SPEC A6. No overnight windows in Phase 1, so every boundary is on the
  // collection date and the order is total.
  if (handoverStartMinutes >= handoverEndMinutes) {
    throw new BadRequestException('Handover must start before it ends.');
  }
  if (submissionsCloseMinutes > handoverEndMinutes) {
    throw new BadRequestException('Submissions must close by the end of handover.');
  }
  if (handoverEndMinutes > pickupStartMinutes) {
    throw new BadRequestException('Handover must end before charity pickup starts.');
  }
  if (pickupStartMinutes >= pickupEndMinutes) {
    throw new BadRequestException('Charity pickup must start before it ends.');
  }

  const startDate = toLocalDate(input.startDate);
  const endDate = input.endDate ? toLocalDate(input.endDate) : null;
  const today = localDateAt(input.timezone, now);

  if (!sameOrAfter(startDate, today)) {
    throw new BadRequestException('The schedule cannot start in the past.');
  }
  if (endDate && endDate.getTime() < startDate.getTime()) {
    throw new BadRequestException('The schedule cannot end before it starts.');
  }

  const opensDaysBefore = input.opensDaysBefore ?? 0;
  if (opensDaysBefore < 0 || opensDaysBefore > 30) {
    throw new BadRequestException('Submissions may open at most 30 days before a collection.');
  }

  const daysOfWeek = [...new Set(input.daysOfWeek ?? [])].sort((a, b) => a - b);
  const customDates = (input.customDates ?? []).map(toLocalDate);

  switch (input.recurrence) {
    case ConsolidatedRecurrence.WEEKLY:
      if (daysOfWeek.length !== 1) {
        throw new BadRequestException('A weekly schedule needs exactly one day of the week.');
      }
      break;
    case ConsolidatedRecurrence.SELECTED_WEEKDAYS:
      if (daysOfWeek.length === 0) {
        throw new BadRequestException('Choose at least one day of the week.');
      }
      break;
    case ConsolidatedRecurrence.CUSTOM_DATES:
      if (customDates.length === 0) {
        throw new BadRequestException('Choose at least one date.');
      }
      if (customDates.length > MAX_CUSTOM_DATES) {
        throw new BadRequestException(
          `A schedule may hold at most ${MAX_CUSTOM_DATES} dates.`,
        );
      }
      if (customDates.some((d) => !sameOrAfter(d, today))) {
        throw new BadRequestException('Chosen dates cannot be in the past.');
      }
      break;
    default:
      break;
  }

  if (daysOfWeek.some((d) => d < 1 || d > 7)) {
    throw new BadRequestException('Days of the week must be 1 (Monday) to 7 (Sunday).');
  }

  return {
    timezone: input.timezone,
    recurrence: input.recurrence,
    startDate,
    endDate,
    daysOfWeek,
    customDates,
    opensDaysBefore,
    submissionsCloseMinutes,
    handoverStartMinutes,
    handoverEndMinutes,
    pickupStartMinutes,
    pickupEndMinutes,
  };
}

/**
 * Local dates this schedule collects on, within `[from, to]` inclusive.
 *
 * Always clipped to the schedule's own start and end, so a caller cannot widen
 * a finished schedule by asking for a later window.
 */
export function occurrenceDates(
  schedule: Pick<
    NormalisedSchedule,
    'recurrence' | 'startDate' | 'endDate' | 'daysOfWeek' | 'customDates'
  >,
  from: Date,
  to: Date,
): Date[] {
  const lower = Math.max(toLocalDate(from).getTime(), schedule.startDate.getTime());
  const upper = Math.min(
    toLocalDate(to).getTime(),
    schedule.endDate?.getTime() ?? Number.POSITIVE_INFINITY,
  );
  if (lower > upper) return [];

  if (schedule.recurrence === ConsolidatedRecurrence.ONE_OFF) {
    const start = schedule.startDate.getTime();
    return start >= lower && start <= upper ? [new Date(start)] : [];
  }

  if (schedule.recurrence === ConsolidatedRecurrence.CUSTOM_DATES) {
    return schedule.customDates
      .filter((d) => d.getTime() >= lower && d.getTime() <= upper)
      .sort((a, b) => a.getTime() - b.getTime());
  }

  const out: Date[] = [];
  for (let t = lower; t <= upper; t += DAY_MS) {
    const date = new Date(t);
    if (
      schedule.recurrence === ConsolidatedRecurrence.DAILY ||
      schedule.daysOfWeek.includes(isoWeekdayOf(date))
    ) {
      out.push(date);
    }
  }
  return out;
}

/**
 * The absolute instants for one occurrence.
 *
 * Submissions open at local midnight of the collection date, or earlier when
 * `opensDaysBefore` is set (SPEC A5).
 */
export function resolveOccurrence(
  schedule: Pick<
    NormalisedSchedule,
    | 'timezone'
    | 'opensDaysBefore'
    | 'submissionsCloseMinutes'
    | 'handoverStartMinutes'
    | 'handoverEndMinutes'
    | 'pickupStartMinutes'
    | 'pickupEndMinutes'
  >,
  localDate: Date,
): ScheduleWindow {
  const day = toLocalDate(localDate);
  const at = (minutes: LocalMinutes, on: Date = day) =>
    instantForLocalTime(schedule.timezone, on, minutes);

  return {
    opensAt: at(0, addDays(day, -schedule.opensDaysBefore)),
    submissionsCloseAt: at(schedule.submissionsCloseMinutes),
    handoverStartAt: at(schedule.handoverStartMinutes),
    handoverEndAt: at(schedule.handoverEndMinutes),
    pickupStartAt: at(schedule.pickupStartMinutes),
    pickupEndAt: at(schedule.pickupEndMinutes),
  };
}
