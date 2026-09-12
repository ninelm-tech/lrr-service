-- AlterTable
ALTER TABLE "PlatformConfig" ADD COLUMN     "disputeAlertPhoneNumber" TEXT;

-- AlterTable
ALTER TABLE "RescueRequest" ADD COLUMN     "disputeRaisedAt" TIMESTAMP(3),
ADD COLUMN     "disputeResolvedAt" TIMESTAMP(3),
ADD COLUMN     "disputed" BOOLEAN NOT NULL DEFAULT false;
