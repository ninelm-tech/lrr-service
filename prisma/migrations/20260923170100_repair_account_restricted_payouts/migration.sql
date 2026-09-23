-- Paystack rejects Starter Business transfers during validation, before it
-- creates a transfer. Repair the newest affected attempt so retry reuses its
-- reference; older duplicate attempts remain immutable ledger history.
WITH ranked_payouts AS (
  SELECT
    id,
    "rescueRequestId",
    status,
    "failureReason",
    row_number() OVER (
      PARTITION BY "rescueRequestId"
      ORDER BY "createdAt" DESC, id DESC
    ) AS attempt_rank
  FROM "Payment"
  WHERE type = 'PAYOUT'
)
UPDATE "Payment"
SET status = 'BLOCKED',
    "blockReason" = 'ACCOUNT_RESTRICTED',
    "failureReason" = NULL,
    "settledAt" = NULL
WHERE id IN (
  SELECT id
  FROM ranked_payouts
  WHERE attempt_rank = 1
    AND status = 'FAILED'
    AND lower(coalesce("failureReason", '')) LIKE '%cannot initiate third party payouts%'
    AND NOT EXISTS (
      SELECT 1
      FROM "Payment" active
      WHERE active."rescueRequestId" = ranked_payouts."rescueRequestId"
        AND active.type = 'PAYOUT'
        AND active.status IN ('PENDING', 'SUBMITTED', 'BLOCKED')
    )
);
