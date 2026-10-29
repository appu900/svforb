import { rangeBound } from './impact.service';

describe('impact date range bounds', () => {
  const MELBOURNE = 'Australia/Melbourne'; // +11 in October (AEDT)

  it('covers the whole end day, including collections later today', () => {
    const end = rangeBound('2026-10-29', 'end', MELBOURNE);
    expect(end.toISOString()).toBe('2026-10-29T12:59:59.999Z'); // 11:59:59pm, 29 Oct
    const collectedAt = new Date('2026-10-29T00:15:00Z'); // 11:15am, 29 Oct
    expect(collectedAt <= end).toBe(true);
  });

  it('starts at local midnight on the start day', () => {
    expect(rangeBound('2026-10-23', 'start', MELBOURNE).toISOString())
      .toBe('2026-10-22T13:00:00.000Z'); // 12:00am, 23 Oct
  });

  it('uses the site timezone when it has one', () => {
    expect(rangeBound('2026-10-23', 'start', 'Australia/Perth').toISOString())
      .toBe('2026-10-22T16:00:00.000Z'); // +8
  });

  it('falls back to Melbourne for sites without a timezone', () => {
    expect(rangeBound('2026-10-23', 'start', null).toISOString())
      .toBe('2026-10-22T13:00:00.000Z');
  });

  it('uses full timestamps exactly as sent', () => {
    expect(rangeBound('2026-10-29T05:00:00.000Z', 'end', MELBOURNE).toISOString())
      .toBe('2026-10-29T05:00:00.000Z');
  });
});
