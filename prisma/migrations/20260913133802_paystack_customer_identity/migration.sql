-- A User has exactly one Paystack customer, for life — see
-- PaystackCustomerService and docs/superpowers/specs/2026-09-12-payment-model-design.md,
-- "Paystack customer identity". Both columns are nullable: unset until a
-- user's first payment resolves them, and never overwritten after.

ALTER TABLE "User"
  ADD COLUMN "paystackCustomerCode" TEXT,
  ADD COLUMN "paystackCustomerEmail" TEXT;

CREATE UNIQUE INDEX "User_paystackCustomerCode_key" ON "User"("paystackCustomerCode");
