-- First remove any existing duplicates, keeping the earliest row per (siteId, listingId)
DELETE FROM site_notifications
WHERE id NOT IN (
  SELECT MIN(id)
  FROM site_notifications
  GROUP BY "siteId", "listingId"
);

-- AddUniqueConstraint
CREATE UNIQUE INDEX "site_notifications_siteId_listingId_key"
ON "site_notifications"("siteId", "listingId");
