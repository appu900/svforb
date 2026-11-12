import { BadRequestException } from '@nestjs/common';
import { ConsolidatedRecurrence } from '@prisma/client';
import {
  occurrenceDates,
  resolveOccurrence,
  validateScheduleInput,
  type ConsolidatedScheduleInput,
} from './consolidated-schedule';

const TZ = 'Australia/Melbourne';
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Renders an instant as HH:mm in the schedule's own timezone. */
const localClock = (instant: Date, timezone = TZ) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(instant);

/** The local calendar date at an instant, in the schedule's own timezone. */
const localDay = (instant: Date, timezone = TZ) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(instant);

const baseTimes = {
  submissionsCloseTime: '13:30',
  handoverStartTime: '13:00',
  handoverEndTime: '13:45',
  pickupStartTime: '14:00',
  pickupEndTime: '15:00',
};

function input(over: Partial<ConsolidatedScheduleInput> = {}): ConsolidatedScheduleInput {
  return {
    timezone: TZ,
    recurrence: ConsolidatedRecurrence.ONE_OFF,
    startDate: d('2026-12-01'),
    ...baseTimes,
    ...over,
  };
}

const NOW = new Date('2026-11-12T00:00:00.000Z');

describe('validateScheduleInput', () => {
  it('normalises wall-clock strings to local minutes', () => {
    const s = validateScheduleInput(input(), NOW);
    expect(s.pickupStartMinutes).toBe(14 * 60);
    expect(s.pickupEndMinutes).toBe(15 * 60);
    expect(s.opensDaysBefore).toBe(0);
  });

  it('rejects an unknown timezone', () => {
    expect(() => validateScheduleInput(input({ timezone: 'Mars/Olympus' }), NOW))
      .toThrow(BadRequestException);
  });

  it('rejects a malformed time', () => {
    expect(() => validateScheduleInput(input({ pickupEndTime: '25:99' }), NOW))
      .toThrow(BadRequestException);
  });

  // SPEC A6 — each boundary in the chain, checked one at a time.
  it.each([
    ['handover ends before it starts', { handoverStartTime: '14:00', handoverEndTime: '13:00' }],
    ['submissions close after handover ends', { submissionsCloseTime: '13:50' }],
    ['handover ends after pickup starts', { handoverEndTime: '14:30' }],
    ['pickup ends before it starts', { pickupStartTime: '15:00', pickupEndTime: '14:00' }],
  ])('rejects when %s', (_label, over) => {
    expect(() => validateScheduleInput(input(over), NOW)).toThrow(BadRequestException);
  });

  it('rejects a start date in the past', () => {
    expect(() => validateScheduleInput(input({ startDate: d('2026-11-01') }), NOW))
      .toThrow(BadRequestException);
  });

  it('rejects an end date before the start date', () => {
    expect(() => validateScheduleInput(
      input({ startDate: d('2026-12-10'), endDate: d('2026-12-01') }), NOW,
    )).toThrow(BadRequestException);
  });

  it('requires exactly one day for WEEKLY', () => {
    const weekly = (days: number[]) =>
      input({ recurrence: ConsolidatedRecurrence.WEEKLY, daysOfWeek: days });
    expect(() => validateScheduleInput(weekly([]), NOW)).toThrow(BadRequestException);
    expect(() => validateScheduleInput(weekly([1, 3]), NOW)).toThrow(BadRequestException);
    expect(validateScheduleInput(weekly([5]), NOW).daysOfWeek).toEqual([5]);
  });

  it('requires at least one day for SELECTED_WEEKDAYS', () => {
    expect(() => validateScheduleInput(
      input({ recurrence: ConsolidatedRecurrence.SELECTED_WEEKDAYS, daysOfWeek: [] }), NOW,
    )).toThrow(BadRequestException);
  });

  it('rejects empty, past or oversized custom date lists', () => {
    const custom = (dates: Date[]) =>
      input({ recurrence: ConsolidatedRecurrence.CUSTOM_DATES, customDates: dates });
    expect(() => validateScheduleInput(custom([]), NOW)).toThrow(BadRequestException);
    expect(() => validateScheduleInput(custom([d('2026-01-01')]), NOW)).toThrow(BadRequestException);

    const tooMany = Array.from({ length: 367 }, (_, i) =>
      new Date(d('2026-12-01').getTime() + i * 86_400_000));
    expect(() => validateScheduleInput(custom(tooMany), NOW)).toThrow(BadRequestException);
  });
});

describe('occurrenceDates', () => {
  const horizon = (s: ReturnType<typeof validateScheduleInput>, from: string, to: string) =>
    occurrenceDates(s, d(from), d(to)).map((x) => x.toISOString().slice(0, 10));

  it('ONE_OFF yields only its start date', () => {
    const s = validateScheduleInput(input({ startDate: d('2026-12-04') }), NOW);
    expect(horizon(s, '2026-12-01', '2026-12-14')).toEqual(['2026-12-04']);
    expect(horizon(s, '2026-12-05', '2026-12-14')).toEqual([]);
  });

  it('DAILY yields every day in the window', () => {
    const s = validateScheduleInput(
      input({ recurrence: ConsolidatedRecurrence.DAILY, startDate: d('2026-12-01') }), NOW);
    expect(horizon(s, '2026-12-01', '2026-12-05')).toEqual([
      '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05',
    ]);
  });

  it('WEEKLY yields the matching weekday only', () => {
    // 2026-12-04 is a Friday (ISO 5).
    const s = validateScheduleInput(
      input({ recurrence: ConsolidatedRecurrence.WEEKLY, daysOfWeek: [5], startDate: d('2026-12-01') }), NOW);
    expect(horizon(s, '2026-12-01', '2026-12-20')).toEqual([
      '2026-12-04', '2026-12-11', '2026-12-18',
    ]);
  });

  it('SELECTED_WEEKDAYS yields Mon/Wed/Fri', () => {
    const s = validateScheduleInput(input({
      recurrence: ConsolidatedRecurrence.SELECTED_WEEKDAYS,
      daysOfWeek: [1, 3, 5],
      startDate: d('2026-12-01'),
    }), NOW);
    expect(horizon(s, '2026-12-01', '2026-12-07')).toEqual([
      '2026-12-02', '2026-12-04', '2026-12-07',
    ]);
  });

  it('CUSTOM_DATES yields only dates inside the window, sorted', () => {
    const s = validateScheduleInput(input({
      recurrence: ConsolidatedRecurrence.CUSTOM_DATES,
      startDate: d('2026-12-01'),
      customDates: [d('2026-12-20'), d('2026-12-03')],
    }), NOW);
    expect(horizon(s, '2026-12-01', '2026-12-10')).toEqual(['2026-12-03']);
  });

  it('clips to endDate, so a finished schedule cannot be widened', () => {
    const s = validateScheduleInput(input({
      recurrence: ConsolidatedRecurrence.DAILY,
      startDate: d('2026-12-01'),
      endDate: d('2026-12-03'),
    }), NOW);
    expect(horizon(s, '2026-12-01', '2026-12-31')).toEqual([
      '2026-12-01', '2026-12-02', '2026-12-03',
    ]);
  });
});

describe('resolveOccurrence', () => {
  it('keeps 2:00 pm local across the October daylight-saving start', () => {
    // Melbourne moves to AEDT on the first Sunday of October 2026 (Oct 4).
    const s = validateScheduleInput(input({ startDate: d('2026-11-12') }), NOW);

    const before = resolveOccurrence(s, d('2026-10-02'));
    const after = resolveOccurrence(s, d('2026-10-06'));

    expect(localClock(before.pickupStartAt)).toBe('14:00');
    expect(localClock(after.pickupStartAt)).toBe('14:00');
    // Same wall clock, different UTC instants — that is the whole point.
    expect(before.pickupStartAt.getUTCHours()).not.toBe(after.pickupStartAt.getUTCHours());
  });

  it('keeps 2:00 pm local across the April daylight-saving end', () => {
    const s = validateScheduleInput(input({ startDate: d('2026-11-12') }), NOW);
    expect(localClock(resolveOccurrence(s, d('2027-04-02')).pickupStartAt)).toBe('14:00');
    expect(localClock(resolveOccurrence(s, d('2027-04-06')).pickupStartAt)).toBe('14:00');
  });

  it('opens at local midnight of the collection date by default', () => {
    const s = validateScheduleInput(input(), NOW);
    const w = resolveOccurrence(s, d('2026-12-04'));
    expect(localClock(w.opensAt)).toBe('00:00');
  });

  it('opensDaysBefore moves the opening earlier by whole local days', () => {
    const s = validateScheduleInput(input({ opensDaysBefore: 2 }), NOW);
    const w = resolveOccurrence(s, d('2026-12-04'));
    expect(localClock(w.opensAt)).toBe('00:00');
    expect(localDay(w.opensAt)).toBe('2026-12-02');
  });

  it('orders the whole window', () => {
    const s = validateScheduleInput(input(), NOW);
    const w = resolveOccurrence(s, d('2026-12-04'));
    expect(w.opensAt.getTime()).toBeLessThan(w.handoverStartAt.getTime());
    expect(w.handoverStartAt.getTime()).toBeLessThan(w.handoverEndAt.getTime());
    expect(w.handoverEndAt.getTime()).toBeLessThanOrEqual(w.pickupStartAt.getTime());
    expect(w.pickupStartAt.getTime()).toBeLessThan(w.pickupEndAt.getTime());
  });
});
