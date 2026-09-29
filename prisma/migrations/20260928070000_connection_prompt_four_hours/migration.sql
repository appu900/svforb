-- Remind the business 4 hours before pickup; confirm surplus 2.5 hours before.
ALTER TABLE "connections" ALTER COLUMN "leadTimeMinutes" SET DEFAULT 240;
ALTER TABLE "connections" ALTER COLUMN "cutoffMinutes" SET DEFAULT 150;

UPDATE "connections"
SET "leadTimeMinutes" = 240, "cutoffMinutes" = 150
WHERE status IN ('PENDING', 'ACTIVE', 'PAUSED');
