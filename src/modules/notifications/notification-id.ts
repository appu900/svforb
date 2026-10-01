/**
 * NotificationRecord.id is a Postgres Int. Old Redis jobs (and any payload
 * that still carries a Mongo-style hex string) must not be sent to Prisma —
 * that throws, retries, and burns pool connections.
 */
export function parseNotificationRecordId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    return parsed > 0 ? parsed : null;
  }
  return null;
}
