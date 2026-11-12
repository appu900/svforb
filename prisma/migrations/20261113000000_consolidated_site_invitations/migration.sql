-- CreateEnum
CREATE TYPE "ConsolidatedSiteInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- AlterTable
ALTER TABLE "consolidated_group_sites" ADD COLUMN     "declineReason" TEXT,
ADD COLUMN     "invitationStatus" "ConsolidatedSiteInvitationStatus" NOT NULL DEFAULT 'ACCEPTED',
ADD COLUMN     "invitedAt" TIMESTAMP(3),
ADD COLUMN     "invitedByUserId" INTEGER,
ADD COLUMN     "respondedAt" TIMESTAMP(3),
ADD COLUMN     "respondedByUserId" INTEGER;

