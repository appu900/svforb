-- Charity must confirm collection 1.5 hours before pickup.
ALTER TABLE "connections" ALTER COLUMN "cutoffMinutes" SET DEFAULT 90;

UPDATE "connections"
SET "cutoffMinutes" = 90
WHERE status IN ('PENDING', 'ACTIVE', 'PAUSED');
