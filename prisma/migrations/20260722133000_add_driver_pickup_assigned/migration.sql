-- AlterEnum: charity/farmer assign waits for driver accept/decline
ALTER TYPE "DriverPickupStatus" ADD VALUE IF NOT EXISTS 'ASSIGNED';
