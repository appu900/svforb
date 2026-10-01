import { BadRequestException } from '@nestjs/common';

/**
 * Turning a Connection's wall-clock schedule into absolute instants.
 *
 * Everything here is pure so it can be tested without a database or a clock.
 * A Connection stores "4:00–5:00pm on Mon–Fri" as local minutes past midnight
 * plus ISO weekday numbers, never as timestamps — because 4pm is a different
 * UTC instant in Brisbane, Adelaide and Perth, and shifts again across a
 * daylight-saving boundary.
 */

/** Minutes past local midnight, e.g. 16:00 -> 960. */
export type LocalMinutes = number;

export const MINUTES_IN_DAY = 24 * 60;

/** Business is reminded this long before the pickup window starts. */
export const PROMPT_LEAD_MINUTES = 4 * 60;
/** Business must add food and quantities this long before pickup. */
export const LIST_BY_MINUTES = 150;
/** Charity must confirm collection this long before pickup. */
export const CHARITY_CONFIRM_MINUTES = 90;

/** ISO weekday: 1 = Monday … 7 = Sunday, matching `Date.getUTCDay()` remapped. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const WEEKDAY_LABEL: Record<number, string> = {
  1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun',
};

export interface ConnectionScheduleInput {
  timezone: string;
  daysOfWeek: number[];
  windowStartMinutes: LocalMinutes;
  windowEndMinutes: LocalMinutes;
  leadTimeMinutes: number;
  cutoffMinutes: number;
}

export interface ResolvedDay {
  /** Local calendar date, as UTC midnight, so it can key a unique index. */
  scheduledDate: Date;
  /** When the business is asked what is available today. */
  promptAt: Date;
  /** When an unconfirmed listing escalates to the business. */
  cutoffAt: Date;
  windowStartAt: Date;
  windowEndAt: Date;
}

/** `hh:mm` -> minutes past midnight. Rejects anything that is not a real time. */
export function parseLocalTime(value: string): LocalMinutes {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) {
    throw new BadRequestException(
      `"${value}" is not a valid time. Use 24-hour HH:MM, for example 16:00.`,
    );
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatLocalTime(minutes: LocalMinutes): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "4:00–5:00pm" style label for notifications. */
export function formatWindow(start: LocalMinutes, end: LocalMinutes): string {
  return `${formatClock12(start, false)}–${formatClock12(end, false)}`;
}

/** "1:30 pm" or "1:30pm". */
export function formatClock12(minutes: LocalMinutes, spaced = true): string {
  const normalized = ((minutes % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  const suffix = h < 12 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')}${spaced ? ' ' : ''}${suffix}`;
}

/** "4:00–5:00 pm" when both ends share am/pm, otherwise "11:00 pm–1:00 am". */
export function formatWindowRange(start: LocalMinutes, end: LocalMinutes): string {
  const startNorm = ((start % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const endNorm = ((end % MINUTES_IN_DAY) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  const startPm = startNorm >= 12 * 60;
  const endPm = endNorm >= 12 * 60;
  if (startPm === endPm) {
    const suffix = startPm ? 'pm' : 'am';
    return `${formatClock12(startNorm, false).replace(/am|pm/, '')}–${formatClock12(endNorm, false).replace(/am|pm/, '')} ${suffix}`;
  }
  return `${formatClock12(startNorm)}–${formatClock12(endNorm)}`;
}

/**
 * The timezone's offset from UTC, in minutes, at a given instant.
 *
 * Derived from Intl rather than a lookup table so daylight saving is handled
 * by the platform's own tz database — Adelaide is +9:30 in winter and +10:30
 * in summer, and hard-coding either is wrong for half the year.
 */
export function offsetMinutesAt(timezone: string, instant: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  // Intl renders midnight as hour 24 in some environments.
  const hour = parts.hour === 24 ? 0 : parts.hour;

  const asUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second,
  );
  return (asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000;
}

export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new BadRequestException(
      `"${timezone}" is not a known timezone. Use an IANA name such as Australia/Brisbane.`,
    );
  }
}

/** The local calendar date at `instant`, as UTC midnight. */
export function localDateAt(timezone: string, instant: Date): Date {
  const offset = offsetMinutesAt(timezone, instant);
  const shifted = new Date(instant.getTime() + offset * 60000);
  return new Date(Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(),
  ));
}

/** ISO weekday (1–7) of a UTC-midnight local date. */
export function isoWeekdayOf(localDate: Date): IsoWeekday {
  const day = localDate.getUTCDay(); // 0 = Sunday
  return (day === 0 ? 7 : day) as IsoWeekday;
}

/**
 * The absolute instant of a wall-clock time on a local date.
 *
 * The offset is resolved twice: once from a first guess, then again from the
 * result. Without the second pass a time that sits near a daylight-saving
 * transition resolves with the wrong side's offset.
 */
export function instantForLocalTime(
  timezone: string,
  localDate: Date,
  minutes: LocalMinutes,
): Date {
  const naive = Date.UTC(
    localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate(),
  ) + minutes * 60000;

  const firstGuess = new Date(naive - offsetMinutesAt(timezone, new Date(naive)) * 60000);
  const corrected = new Date(naive - offsetMinutesAt(timezone, firstGuess) * 60000);
  return corrected;
}

/** Whether this Connection collects on the local date given. */
export function collectsOn(
  schedule: Pick<ConnectionScheduleInput, 'daysOfWeek'>,
  localDate: Date,
): boolean {
  return schedule.daysOfWeek.includes(isoWeekdayOf(localDate));
}

/**
 * Resolve one scheduled day into the four instants the workflow turns on.
 *
 * A window may run past midnight (a late-service kitchen collecting 11pm–1am),
 * so the end is pushed to the following day when it would otherwise precede
 * the start.
 */
export function resolveDay(
  schedule: ConnectionScheduleInput,
  localDate: Date,
): ResolvedDay {
  const windowStartAt = instantForLocalTime(
    schedule.timezone, localDate, schedule.windowStartMinutes,
  );

  const endsNextDay = schedule.windowEndMinutes <= schedule.windowStartMinutes;
  const endDate = endsNextDay
    ? new Date(localDate.getTime() + MINUTES_IN_DAY * 60000)
    : localDate;
  const windowEndAt = instantForLocalTime(
    schedule.timezone, endDate, schedule.windowEndMinutes,
  );

  return {
    scheduledDate: localDate,
    promptAt: new Date(windowStartAt.getTime() - schedule.leadTimeMinutes * 60000),
    cutoffAt: new Date(windowStartAt.getTime() - schedule.cutoffMinutes * 60000),
    windowStartAt,
    windowEndAt,
  };
}

/**
 * The next scheduled day at or after `from`, or null when the Connection has
 * no days at all. Looks ahead one week, which is enough for any weekly cycle.
 */
export function nextOccurrence(
  schedule: ConnectionScheduleInput,
  from: Date,
): ResolvedDay | null {
  if (!schedule.daysOfWeek.length) return null;

  for (let offset = 0; offset <= 7; offset++) {
    const localDate = new Date(
      localDateAt(schedule.timezone, from).getTime() + offset * MINUTES_IN_DAY * 60000,
    );
    if (!collectsOn(schedule, localDate)) continue;

    const day = resolveDay(schedule, localDate);
    // Today only counts while its window has not already closed.
    if (day.windowEndAt.getTime() > from.getTime()) return day;
  }
  return null;
}

/**
 * Prompt from 4 hours before pickup until the window closes.
 * Same-day accept / a window already open still gets one nudge.
 */
export function isPromptDue(day: ResolvedDay, now: Date): boolean {
  return now >= day.promptAt && now < day.windowEndAt;
}

/**
 * Every scheduled day whose prompt is due at `now`, earliest first.
 *
 * Looking only at today's local date misses two cases: a 12:30am window is
 * prompted at 8:30pm the night before (tomorrow's date), and an 11pm–1am
 * window is still open after midnight (yesterday's date).
 */
export function dueDays(schedule: ConnectionScheduleInput, now: Date): ResolvedDay[] {
  const today = localDateAt(schedule.timezone, now);
  const days: ResolvedDay[] = [];
  for (const offset of [-1, 0, 1]) {
    const localDate = new Date(today.getTime() + offset * MINUTES_IN_DAY * 60000);
    if (!collectsOn(schedule, localDate)) continue;
    const day = resolveDay(schedule, localDate);
    if (isPromptDue(day, now)) days.push(day);
  }
  return days;
}

/** "today" or "tomorrow" for a window, as the kitchen's clock reads at `now`. */
export function dayWordFor(
  timezone: string,
  windowStartAt: Date,
  now: Date = new Date(),
): 'today' | 'tomorrow' {
  return localDateAt(timezone, windowStartAt).getTime() > localDateAt(timezone, now).getTime()
    ? 'tomorrow'
    : 'today';
}

/**
 * The kitchen IANA zone required when a Connection is created.
 * Never guess from region — Australia is not one zone, and a guess is how
 * the 4h / 2.5h pushes drifted from the time the app shows.
 */
export function resolveDonorTimezone(siteTimezone?: string | null): string | null {
  const timezone = siteTimezone?.trim();
  return timezone || null;
}

/** Latest instant the business may still confirm today’s surplus. */
export function listByAt(windowStartAt: Date): Date {
  return new Date(windowStartAt.getTime() - LIST_BY_MINUTES * 60000);
}

/** Business silence at this point is “no response”, not “no surplus”. */
export function isBusinessListByDue(windowStartAt: Date, now: Date): boolean {
  return now.getTime() >= listByAt(windowStartAt).getTime();
}

export function validateSchedule(input: {
  daysOfWeek: number[];
  windowStartMinutes: number;
  windowEndMinutes: number;
  leadTimeMinutes: number;
  cutoffMinutes: number;
}): void {
  if (!input.daysOfWeek.length) {
    throw new BadRequestException('Choose at least one collection day.');
  }
  if (input.daysOfWeek.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new BadRequestException('Collection days must be 1 (Monday) to 7 (Sunday).');
  }
  if (new Set(input.daysOfWeek).size !== input.daysOfWeek.length) {
    throw new BadRequestException('The same collection day is listed twice.');
  }
  for (const [name, value] of [
    ['windowStartMinutes', input.windowStartMinutes],
    ['windowEndMinutes', input.windowEndMinutes],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value >= MINUTES_IN_DAY) {
      throw new BadRequestException(`${name} must be between 00:00 and 23:59.`);
    }
  }
  if (input.windowStartMinutes === input.windowEndMinutes) {
    throw new BadRequestException('The pickup window cannot be zero minutes long.');
  }
  if (input.leadTimeMinutes < 0 || input.leadTimeMinutes > MINUTES_IN_DAY) {
    throw new BadRequestException('Lead time must be between 0 minutes and 24 hours.');
  }
  if (input.cutoffMinutes < 0 || input.cutoffMinutes > MINUTES_IN_DAY) {
    throw new BadRequestException('Cut-off must be between 0 minutes and 24 hours.');
  }
  // The business must be asked before the charity is chased, or the cut-off
  // fires against a listing nobody has had the chance to create.
  if (input.cutoffMinutes > input.leadTimeMinutes) {
    throw new BadRequestException(
      'The cut-off must fall after the business is prompted. Lower the cut-off or raise the lead time.',
    );
  }
}

/** Human summary for an invitation, e.g. "Mon, Tue, Wed | 4:00–5:00pm". */
export function describeSchedule(
  daysOfWeek: number[],
  windowStartMinutes: number,
  windowEndMinutes: number,
): string {
  const days = [...daysOfWeek].sort((a, b) => a - b);
  const isWeekdays = days.length === 5 && days.every((d, i) => d === i + 1);
  const isEveryDay = days.length === 7;

  const label = isEveryDay
    ? 'Every day'
    : isWeekdays
      ? 'Mon–Fri'
      : days.map((d) => WEEKDAY_LABEL[d]).join(', ');

  return `${label} | ${formatWindow(windowStartMinutes, windowEndMinutes)}`;
}


/**
 * Whether two schedules on the same site would collect at the same time.
 *
 * A site may hold any number of Connections — a lunch charity and a dinner
 * charity is a normal arrangement. What is ambiguous is two charities due in
 * the same window on the same day: the kitchen is then prompted twice for one
 * pile of food, with nothing to say how it splits.
 *
 * Windows are compared as local minutes, which is sound because both belong to
 * the same site and therefore the same timezone.
 */
export function schedulesOverlap(
  a: { daysOfWeek: number[]; windowStartMinutes: number; windowEndMinutes: number },
  b: { daysOfWeek: number[]; windowStartMinutes: number; windowEndMinutes: number },
): boolean {
  const sharedDay = a.daysOfWeek.some((d) => b.daysOfWeek.includes(d));
  if (!sharedDay) return false;

  // A window ending at or before its start runs past midnight.
  const spans = (w: { windowStartMinutes: number; windowEndMinutes: number }) =>
    w.windowEndMinutes <= w.windowStartMinutes
      ? [[w.windowStartMinutes, MINUTES_IN_DAY], [0, w.windowEndMinutes]]
      : [[w.windowStartMinutes, w.windowEndMinutes]];

  for (const [aStart, aEnd] of spans(a)) {
    for (const [bStart, bEnd] of spans(b)) {
      // Touching at the boundary is not an overlap: 4–5pm and 5–6pm are fine.
      if (aStart < bEnd && bStart < aEnd) return true;
    }
  }
  return false;
}
