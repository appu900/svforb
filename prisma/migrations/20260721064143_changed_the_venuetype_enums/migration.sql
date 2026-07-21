-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VenueType" ADD VALUE 'PRODUCE_MARKET_GARDEN';
ALTER TYPE "VenueType" ADD VALUE 'LIVESTOCK_FARM';
ALTER TYPE "VenueType" ADD VALUE 'MIXED_FARM';
ALTER TYPE "VenueType" ADD VALUE 'ORCHARD';
ALTER TYPE "VenueType" ADD VALUE 'PROCESSING_FACILITY';
