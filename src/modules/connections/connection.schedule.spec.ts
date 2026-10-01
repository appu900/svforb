import { BadRequestException } from '@nestjs/common';
import {
  CHARITY_CONFIRM_MINUTES, collectsOn, describeSchedule, formatClock12, formatWindow,
  formatWindowRange, instantForLocalTime, isoWeekdayOf, isBusinessListByDue, isPromptDue,
  LIST_BY_MINUTES, listByAt, localDateAt, nextOccurrence, offsetMinutesAt, parseLocalTime,
  PROMPT_LEAD_MINUTES, resolveDay, resolveDonorTimezone, validateSchedule,
  dayWordFor, dueDays,
} from './connection.schedule';
import { describe, expect, it } from '@jest/globals';

describe('windows that start just after midnight', () => {
  // Connection 1: every day 12:30am–6:00pm in India, 4h prompt.
  const kolkata = {
    timezone: 'Asia/Kolkata',
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    windowStartMinutes: 30,
    windowEndMinutes: 18 * 60,
    leadTimeMinutes: PROMPT_LEAD_MINUTES,
    cutoffMinutes: CHARITY_CONFIRM_MINUTES,
  };

  it('prompts at 8:30pm the night before, not at midnight', () => {
    const before = dueDays(kolkata, utc('2026-10-01T14:59:00Z')); // 8:29pm IST, 1 Oct
    expect(before.map((d) => d.windowStartAt.toISOString())).not.toContain('2026-10-01T19:00:00.000Z');

    const at = dueDays(kolkata, utc('2026-10-01T15:00:00Z')); // 8:30pm IST, 1 Oct
    expect(at.map((d) => d.windowStartAt.toISOString())).toContain('2026-10-01T19:00:00.000Z');
    expect(at.find((d) => d.windowStartAt.toISOString() === '2026-10-01T19:00:00.000Z')!
      .scheduledDate.toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });

  it('calls that window "tomorrow" in the 8:30pm push and "today" after midnight', () => {
    const start = utc('2026-10-01T19:00:00Z'); // 12:30am IST, 2 Oct
    expect(dayWordFor('Asia/Kolkata', start, utc('2026-10-01T15:00:00Z'))).toBe('tomorrow');
    expect(dayWordFor('Asia/Kolkata', start, utc('2026-10-01T18:45:00Z'))).toBe('today');
    expect(dayWordFor('Asia/Kolkata', listByAt(start), utc('2026-10-01T15:00:00Z'))).toBe('today');
  });

  it('keeps an 11pm–1am window due after midnight', () => {
    const overnight = { ...kolkata, windowStartMinutes: 23 * 60, windowEndMinutes: 60 };
    const days = dueDays(overnight, utc('2026-10-01T19:00:00Z')); // 12:30am IST, 2 Oct
    expect(days.map((d) => d.windowStartAt.toISOString())).toContain('2026-10-01T17:30:00.000Z');
  });

  it('a normal afternoon window is still only due on its own day', () => {
    const afternoon = { ...kolkata, windowStartMinutes: 14 * 60, windowEndMinutes: 17 * 60 };
    const days = dueDays(afternoon, utc('2026-10-01T05:00:00Z')); // 10:30am IST, prompt at 10am
    expect(days).toHaveLength(1);
    expect(days[0].scheduledDate.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

const BRISBANE = 'Australia/Brisbane';   // +10, never observes DST
const ADELAIDE = 'Australia/Adelaide';   // +9:30 / +10:30
const PERTH = 'Australia/Perth';         // +8
const utc = (iso: string) => new Date(iso);

const scheduleFor = (timezone: string, over: Partial<any> = {}) => ({
  timezone,
  daysOfWeek: [1, 2, 3, 4, 5],
  windowStartMinutes: 16 * 60, // 4:00pm
  windowEndMinutes: 17 * 60,   // 5:00pm
  leadTimeMinutes: 60,
  cutoffMinutes: 30,
  ...over,
});

describe('Connection scheduling', () => {
  describe('parsing wall-clock times', () => {
    it('reads HH:MM as minutes past midnight', () => {
      expect(parseLocalTime('00:00')).toBe(0);
      expect(parseLocalTime('16:00')).toBe(960);
      expect(parseLocalTime('23:59')).toBe(1439);
    });

    it('rejects times that do not exist', () => {
      for (const bad of ['24:00', '16:60', '4pm', '16', '', '99:99']) {
        expect(() => parseLocalTime(bad)).toThrow(BadRequestException);
      }
    });

    it('renders a window the way the notification shows it', () => {
      expect(formatWindow(16 * 60, 17 * 60)).toBe('4:00pm–5:00pm');
      expect(formatWindow(0, 30)).toBe('12:00am–12:30am');
      expect(formatWindow(12 * 60, 13 * 60)).toBe('12:00pm–1:00pm');
    });

    it('speaks the daily reminder window and the add-by time', () => {
      expect(formatWindowRange(16 * 60, 17 * 60)).toBe('4:00–5:00 pm');
      expect(formatClock12(16 * 60 - LIST_BY_MINUTES)).toBe('1:30 pm');
      expect(formatWindowRange(23 * 60, 60)).toBe('11:00 pm–1:00 am');
    });
  });

  describe('timezone offsets', () => {
    it('reads Brisbane as +10 all year', () => {
      expect(offsetMinutesAt(BRISBANE, utc('2026-01-15T00:00:00Z'))).toBe(600);
      expect(offsetMinutesAt(BRISBANE, utc('2026-07-15T00:00:00Z'))).toBe(600);
    });

    it('reads Perth as +8', () => {
      expect(offsetMinutesAt(PERTH, utc('2026-09-24T00:00:00Z'))).toBe(480);
    });

    // The case a hard-coded offset gets wrong for half the year.
    it('follows Adelaide across daylight saving', () => {
      expect(offsetMinutesAt(ADELAIDE, utc('2026-07-15T00:00:00Z'))).toBe(570);  // +9:30
      expect(offsetMinutesAt(ADELAIDE, utc('2026-01-15T00:00:00Z'))).toBe(630);  // +10:30
    });
  });

  describe('a 4pm window means 4pm locally, everywhere', () => {
    const localDate = utc('2026-09-24T00:00:00Z'); // Thursday

    it('resolves to different UTC instants per timezone', () => {
      const bne = instantForLocalTime(BRISBANE, localDate, 16 * 60);
      const per = instantForLocalTime(PERTH, localDate, 16 * 60);
      expect(bne.toISOString()).toBe('2026-09-24T06:00:00.000Z'); // 16:00 +10
      expect(per.toISOString()).toBe('2026-09-24T08:00:00.000Z'); // 16:00 +8
      expect(per.getTime() - bne.getTime()).toBe(2 * 3600_000);
    });

    it('keeps 4pm at 4pm on both sides of an Adelaide DST switch', () => {
      const winter = instantForLocalTime(ADELAIDE, utc('2026-07-15T00:00:00Z'), 16 * 60);
      const summer = instantForLocalTime(ADELAIDE, utc('2026-01-15T00:00:00Z'), 16 * 60);
      expect(winter.toISOString()).toBe('2026-07-15T06:30:00.000Z'); // +9:30
      expect(summer.toISOString()).toBe('2026-01-15T05:30:00.000Z'); // +10:30
    });
  });

  describe('resolving a scheduled day', () => {
    const localDate = utc('2026-09-24T00:00:00Z');

    it('places prompt, cut-off and window in the right order', () => {
      const day = resolveDay(scheduleFor(BRISBANE), localDate);
      expect(day.promptAt.toISOString()).toBe('2026-09-24T05:00:00.000Z');    // 3pm
      expect(day.cutoffAt.toISOString()).toBe('2026-09-24T05:30:00.000Z');    // 3:30pm
      expect(day.windowStartAt.toISOString()).toBe('2026-09-24T06:00:00.000Z'); // 4pm
      expect(day.windowEndAt.toISOString()).toBe('2026-09-24T07:00:00.000Z');   // 5pm
      expect(day.promptAt < day.cutoffAt).toBe(true);
      expect(day.cutoffAt < day.windowStartAt).toBe(true);
    });

    it('reminds the business 4 hours before pickup and asks the charity to confirm 1.5 hours before', () => {
      const day = resolveDay(
        scheduleFor(BRISBANE, {
          leadTimeMinutes: PROMPT_LEAD_MINUTES,
          cutoffMinutes: CHARITY_CONFIRM_MINUTES,
        }),
        localDate,
      );
      expect(PROMPT_LEAD_MINUTES).toBe(240);
      expect(LIST_BY_MINUTES).toBe(150);
      expect(CHARITY_CONFIRM_MINUTES).toBe(90);
      expect(day.promptAt.toISOString()).toBe('2026-09-24T02:00:00.000Z'); // 12:00pm
      expect(day.cutoffAt.toISOString()).toBe('2026-09-24T04:30:00.000Z'); // 2:30pm
    });

    it('carries a window that crosses midnight into the next day', () => {
      const lateShift = scheduleFor(BRISBANE, {
        windowStartMinutes: 23 * 60, // 11pm
        windowEndMinutes: 60,        // 1am
      });
      const day = resolveDay(lateShift, localDate);
      expect(day.windowStartAt.toISOString()).toBe('2026-09-24T13:00:00.000Z');
      expect(day.windowEndAt.toISOString()).toBe('2026-09-24T15:00:00.000Z');
      expect(day.windowEndAt > day.windowStartAt).toBe(true);
    });
  });

  describe('which days collect', () => {
    it('maps weekdays the ISO way, Monday = 1', () => {
      expect(isoWeekdayOf(utc('2026-09-21T00:00:00Z'))).toBe(1); // Monday
      expect(isoWeekdayOf(utc('2026-09-27T00:00:00Z'))).toBe(7); // Sunday
    });

    it('collects on scheduled days only', () => {
      const s = scheduleFor(BRISBANE); // Mon–Fri
      expect(collectsOn(s, utc('2026-09-24T00:00:00Z'))).toBe(true);  // Thu
      expect(collectsOn(s, utc('2026-09-26T00:00:00Z'))).toBe(false); // Sat
    });

    it('finds the next occurrence, skipping the weekend', () => {
      // Friday 6pm Brisbane — that day's window has closed.
      const next = nextOccurrence(scheduleFor(BRISBANE), utc('2026-09-25T08:00:00Z'));
      expect(next).not.toBeNull();
      expect(next!.scheduledDate.toISOString()).toBe('2026-09-28T00:00:00.000Z'); // Monday
    });

    it('still offers today while the window is open', () => {
      // Thursday 4:30pm Brisbane, window runs to 5pm.
      const next = nextOccurrence(scheduleFor(BRISBANE), utc('2026-09-24T06:30:00Z'));
      expect(next!.scheduledDate.toISOString()).toBe('2026-09-24T00:00:00.000Z');
    });

    it('returns nothing when no days are set', () => {
      expect(nextOccurrence(scheduleFor(BRISBANE, { daysOfWeek: [] }), new Date())).toBeNull();
    });
  });

  describe('prompt timing', () => {
    const day = resolveDay(scheduleFor(BRISBANE), utc('2026-09-24T00:00:00Z'));

    it('is not due before the lead time', () => {
      expect(isPromptDue(day, utc('2026-09-24T04:59:00Z'))).toBe(false);
    });

    it('is due inside the lead window', () => {
      expect(isPromptDue(day, utc('2026-09-24T05:00:00Z'))).toBe(true);
      expect(isPromptDue(day, utc('2026-09-24T05:59:00Z'))).toBe(true);
    });

    it('stays due after the window opens so a same-day accept still notifies', () => {
      expect(isPromptDue(day, utc('2026-09-24T06:00:00Z'))).toBe(true);
    });

    it('stops once the pickup window has closed', () => {
      expect(isPromptDue(day, utc('2026-09-24T07:00:00Z'))).toBe(false);
    });
  });

  describe('donor timezone', () => {
    it('uses only the donor site zone — the same clock the app shows', () => {
      expect(resolveDonorTimezone('Australia/Melbourne')).toBe('Australia/Melbourne');
      expect(resolveDonorTimezone('Asia/Kolkata')).toBe('Asia/Kolkata');
      expect(resolveDonorTimezone(null)).toBeNull();
      expect(resolveDonorTimezone('')).toBeNull();
    });

    it('fires the 4h prompt an hour earlier for Melbourne than Brisbane during AEDT', () => {
      // First Sunday in October 2026 is the 4th — Melbourne is AEDT after that.
      const localDate = utc('2026-10-08T00:00:00Z');
      const melbourne = resolveDay(scheduleFor('Australia/Melbourne'), localDate);
      const brisbane = resolveDay(scheduleFor(BRISBANE), localDate);
      expect(melbourne.windowStartAt.toISOString()).toBe('2026-10-08T05:00:00.000Z'); // 4pm AEDT
      expect(brisbane.windowStartAt.toISOString()).toBe('2026-10-08T06:00:00.000Z'); // 4pm AEST
      expect(melbourne.promptAt.getTime()).toBe(brisbane.promptAt.getTime() - 60 * 60000);
    });
  });

  describe('business list-by deadline', () => {
    it('is 2.5 hours before pickup', () => {
      const start = utc('2026-09-24T06:00:00.000Z');
      expect(listByAt(start).toISOString()).toBe('2026-09-24T03:30:00.000Z');
      expect(isBusinessListByDue(start, utc('2026-09-24T03:29:00Z'))).toBe(false);
      expect(isBusinessListByDue(start, utc('2026-09-24T03:30:00Z'))).toBe(true);
    });
  });

  describe('local date resolution', () => {
    // 09:00 UTC on the 24th is already 19:00 on the 24th in Brisbane,
    // but still 17:00 on the same day in Perth.
    it('returns the local calendar date, not the UTC one', () => {
      expect(localDateAt(BRISBANE, utc('2026-09-24T15:00:00Z')).toISOString())
        .toBe('2026-09-25T00:00:00.000Z'); // already tomorrow in Brisbane
      expect(localDateAt(PERTH, utc('2026-09-24T15:00:00Z')).toISOString())
        .toBe('2026-09-24T00:00:00.000Z'); // still today in Perth
    });
  });

  describe('validation', () => {
    const base = {
      daysOfWeek: [1, 2, 3], windowStartMinutes: 960, windowEndMinutes: 1020,
      leadTimeMinutes: 60, cutoffMinutes: 30,
    };

    it('accepts a sane schedule', () => {
      expect(() => validateSchedule(base)).not.toThrow();
    });

    it('requires at least one day', () => {
      expect(() => validateSchedule({ ...base, daysOfWeek: [] })).toThrow(BadRequestException);
    });

    it('rejects weekday numbers outside 1–7', () => {
      expect(() => validateSchedule({ ...base, daysOfWeek: [0] })).toThrow(BadRequestException);
      expect(() => validateSchedule({ ...base, daysOfWeek: [8] })).toThrow(BadRequestException);
    });

    it('rejects a duplicated day', () => {
      expect(() => validateSchedule({ ...base, daysOfWeek: [1, 1] })).toThrow(BadRequestException);
    });

    it('rejects a zero-length window', () => {
      expect(() => validateSchedule({ ...base, windowEndMinutes: 960 })).toThrow(BadRequestException);
    });

    // Otherwise the charity is chased before the business has been asked.
    it('refuses a cut-off that lands before the business is prompted', () => {
      expect(() => validateSchedule({ ...base, leadTimeMinutes: 30, cutoffMinutes: 60 }))
        .toThrow(BadRequestException);
    });
  });

  describe('invitation wording', () => {
    it('collapses Monday to Friday', () => {
      expect(describeSchedule([1, 2, 3, 4, 5], 960, 1020)).toBe('Mon–Fri | 4:00pm–5:00pm');
    });

    it('collapses a full week', () => {
      expect(describeSchedule([1, 2, 3, 4, 5, 6, 7], 960, 1020)).toBe('Every day | 4:00pm–5:00pm');
    });

    it('lists selected days in order', () => {
      expect(describeSchedule([3, 1], 600, 660)).toBe('Mon, Wed | 10:00am–11:00am');
    });
  });
});

describe('Multiple connections on one site', () => {
  const at = (days: number[], start: number, end: number) => ({
    daysOfWeek: days, windowStartMinutes: start, windowEndMinutes: end,
  });
  const { schedulesOverlap } = require('./connection.schedule');

  it('allows different charities on different days', () => {
    const rosies = at([1, 3, 5], 16 * 60, 17 * 60);   // Mon/Wed/Fri
    const fareshare = at([2, 4], 16 * 60, 17 * 60);   // Tue/Thu
    expect(schedulesOverlap(rosies, fareshare)).toBe(false);
  });

  it('allows a lunch charity and a dinner charity on the same days', () => {
    const lunch = at([1, 2, 3, 4, 5], 14 * 60, 15 * 60);
    const dinner = at([1, 2, 3, 4, 5], 19 * 60, 20 * 60);
    expect(schedulesOverlap(lunch, dinner)).toBe(false);
  });

  it('treats back-to-back windows as not overlapping', () => {
    expect(schedulesOverlap(at([1], 16 * 60, 17 * 60), at([1], 17 * 60, 18 * 60)))
      .toBe(false);
  });

  it('flags two charities due in the same window on the same day', () => {
    expect(schedulesOverlap(at([1, 2, 3, 4, 5], 16 * 60, 17 * 60), at([1], 16 * 60, 17 * 60)))
      .toBe(true);
  });

  it('flags a partial overlap', () => {
    expect(schedulesOverlap(at([1], 16 * 60, 18 * 60), at([1], 17 * 60, 19 * 60)))
      .toBe(true);
  });

  it('handles a window that runs past midnight', () => {
    const lateShift = at([1], 23 * 60, 60);        // 11pm–1am
    expect(schedulesOverlap(lateShift, at([1], 23 * 60 + 30, 23 * 60 + 45))).toBe(true);
    expect(schedulesOverlap(lateShift, at([1], 12 * 60, 13 * 60))).toBe(false);
  });
});
