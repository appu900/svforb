-- CreateTable
CREATE TABLE "site_notifications" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "listingId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'new_listing_nearby',
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "site_notifications_siteId_expiresAt_idx" ON "site_notifications"("siteId", "expiresAt");

-- CreateIndex
CREATE INDEX "site_notifications_siteId_isRead_idx" ON "site_notifications"("siteId", "isRead");

-- CreateIndex
CREATE INDEX "site_notifications_listingId_idx" ON "site_notifications"("listingId");

-- AddForeignKey
ALTER TABLE "site_notifications" ADD CONSTRAINT "site_notifications_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_notifications" ADD CONSTRAINT "site_notifications_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "food_listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
