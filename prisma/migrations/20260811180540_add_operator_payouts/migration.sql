-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutBlockReason" AS ENUM ('NO_BANK_DETAILS', 'INSUFFICIENT_BALANCE');

-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "accountName" TEXT,
ADD COLUMN     "accountNumber" TEXT,
ADD COLUMN     "bankCode" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "paystackRecipientCode" TEXT;

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "rescueRequestId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "blockReason" "PayoutBlockReason",
    "paystackTransferCode" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payout_rescueRequestId_key" ON "Payout"("rescueRequestId");

-- CreateIndex
CREATE INDEX "Payout_operatorId_idx" ON "Payout"("operatorId");

-- CreateIndex
CREATE INDEX "Payout_status_idx" ON "Payout"("status");

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_rescueRequestId_fkey" FOREIGN KEY ("rescueRequestId") REFERENCES "RescueRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
