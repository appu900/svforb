-- CreateEnum
CREATE TYPE "DriverPickupStatus" AS ENUM ('ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'COLLECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "driver_pickups" (
    "id" SERIAL NOT NULL,
    "driverId" INTEGER NOT NULL,
    "claimId" INTEGER NOT NULL,
    "listingId" INTEGER NOT NULL,
    "status" "DriverPickupStatus" NOT NULL DEFAULT 'ACCEPTED',
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arrivedAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "driver_pickups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "driver_pickups_driverId_idx" ON "driver_pickups"("driverId");

-- CreateIndex
CREATE INDEX "driver_pickups_claimId_idx" ON "driver_pickups"("claimId");

-- CreateIndex
CREATE INDEX "driver_pickups_listingId_idx" ON "driver_pickups"("listingId");

-- CreateIndex
CREATE INDEX "driver_pickups_status_idx" ON "driver_pickups"("status");

-- AddForeignKey
ALTER TABLE "driver_pickups" ADD CONSTRAINT "driver_pickups_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_pickups" ADD CONSTRAINT "driver_pickups_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "food_claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_pickups" ADD CONSTRAINT "driver_pickups_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "food_listings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
