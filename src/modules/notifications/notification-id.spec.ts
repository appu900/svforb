import { describe, expect, it } from '@jest/globals';
import { parseNotificationRecordId } from './notification-id';

describe('parseNotificationRecordId', () => {
  it('accepts a positive integer', () => {
    expect(parseNotificationRecordId(42)).toBe(42);
  });

  it('accepts a numeric string', () => {
    expect(parseNotificationRecordId('42')).toBe(42);
  });

  it('drops leftover Mongo-style hex ids so Prisma is never called', () => {
    expect(parseNotificationRecordId('6abd7850273846aecad3b4b8')).toBeNull();
  });

  it('drops zero, negatives, floats and junk', () => {
    expect(parseNotificationRecordId(0)).toBeNull();
    expect(parseNotificationRecordId(-1)).toBeNull();
    expect(parseNotificationRecordId(1.5)).toBeNull();
    expect(parseNotificationRecordId('')).toBeNull();
    expect(parseNotificationRecordId(' 42')).toBeNull();
    expect(parseNotificationRecordId('fan-out-42')).toBeNull();
    expect(parseNotificationRecordId(undefined)).toBeNull();
    expect(parseNotificationRecordId(null)).toBeNull();
  });
});
