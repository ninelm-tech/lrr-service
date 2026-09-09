-- AlterEnum
ALTER TYPE "RescueRequestStatus" ADD VALUE 'IN_DISPUTE';

-- AlterTable
ALTER TABLE "RescueRequest" ADD COLUMN     "customerDisputeStatement" TEXT,
ADD COLUMN     "disputeOriginalBalanceAmount" INTEGER,
ADD COLUMN     "disputeResolutionNote" TEXT,
ADD COLUMN     "operatorDisputeStatement" TEXT;
