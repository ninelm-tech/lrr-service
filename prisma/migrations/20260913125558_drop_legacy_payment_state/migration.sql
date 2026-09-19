-- Payment becomes the only record of money movement.
--
-- These columns/tables duplicated state that Payment now carries: depositPaid
-- and balancePaid become "a SUCCEEDED Payment of that type exists";
-- depositReference/balanceReference become the Payment row's own reference
-- (referenceFor); depositRefundStatus/depositRefundId become derived from
-- the REFUND Payment row's own status and providerRef. The Payout table is
-- superseded entirely by Payment rows of type PAYOUT.
--
-- Prisma refuses to generate destructive migrations non-interactively, so
-- this is hand-written. Every reader of these columns was converted before
-- this migration was written — see the payment-model plan, Task 11.
--
-- BEFORE RUNNING ON STAGING: truncate transactional data first (see the
-- plan's Task 11, Step 0) — dropping these columns without it leaves every
-- existing request reading as unpaid, since no Payment row exists for
-- traffic that predates the payment model. Backfilling is not the answer:
-- providerFee, netAmount and a real providerRef cannot be reconstructed for
-- old deposits.

ALTER TABLE "RescueRequest"
  DROP COLUMN "depositPaid",
  DROP COLUMN "balancePaid",
  DROP COLUMN "depositReference",
  DROP COLUMN "balanceReference",
  DROP COLUMN "depositRefundStatus",
  DROP COLUMN "depositRefundId";

DROP TABLE "Payout";
DROP TYPE "PayoutStatus";
DROP TYPE "PayoutBlockReason";
DROP TYPE "RefundStatus";
