-- AlterTable
ALTER TABLE "RescueRequest" ADD COLUMN     "cancellationSettledAt" TIMESTAMP(3),
ADD COLUMN     "cancellationSettlementNote" TEXT,
ADD COLUMN     "cancellationSettlementPercent" INTEGER;
