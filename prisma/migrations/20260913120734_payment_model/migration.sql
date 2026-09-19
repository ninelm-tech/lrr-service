-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('DEPOSIT', 'BALANCE', 'REFUND', 'PAYOUT');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUBMITTED', 'BLOCKED', 'SUCCEEDED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "PaymentBlockReason" AS ENUM ('NO_BANK_DETAILS', 'INSUFFICIENT_BALANCE', 'AWAITING_OTP', 'NEEDS_CUSTOMER_DETAILS');

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "rescueRequestId" TEXT NOT NULL,
    "type" "PaymentType" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "providerFee" INTEGER,
    "netAmount" INTEGER,
    "providerRef" TEXT,
    "operatorId" TEXT,
    "failureReason" TEXT,
    "blockReason" "PaymentBlockReason",
    "verifyAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifyAttempts" INTEGER NOT NULL DEFAULT 0,
    "checkoutUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerRef_key" ON "Payment"("providerRef");

-- CreateIndex
CREATE INDEX "Payment_rescueRequestId_idx" ON "Payment"("rescueRequestId");

-- CreateIndex
CREATE INDEX "Payment_status_verifyAfter_idx" ON "Payment"("status", "verifyAfter");

-- CreateIndex
CREATE INDEX "Payment_operatorId_idx" ON "Payment"("operatorId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_rescueRequestId_fkey" FOREIGN KEY ("rescueRequestId") REFERENCES "RescueRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Hand-written: Prisma cannot express partial unique indexes ────────────
--
-- At most one attempt IN FLIGHT per request and type. BLOCKED counts as in
-- flight: the money movement already exists at Paystack and is waiting on a
-- human, so a second attempt would duplicate it. Leaving BLOCKED out would
-- let that second attempt be created — the double-pay by a side door.
CREATE UNIQUE INDEX "one_inflight_payment_per_type"
  ON "Payment" ("rescueRequestId", "type")
  WHERE status IN ('PENDING', 'SUBMITTED', 'BLOCKED');

-- At most one SUCCEEDED per request and type. A FAILED row is history, not a
-- claim, so it never blocks a retry.
CREATE UNIQUE INDEX "one_succeeded_payment_per_type"
  ON "Payment" ("rescueRequestId", "type")
  WHERE status = 'SUCCEEDED';
