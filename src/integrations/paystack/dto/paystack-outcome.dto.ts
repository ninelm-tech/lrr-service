/**
 * What a money-moving Paystack call actually told us.
 *
 * Three-valued on purpose. The distinction between `rejected` and `ambiguous`
 * is the difference between "nothing happened" and "something might have",
 * and collapsing them is how a lost response becomes a double payment:
 *
 * - **`ok`** — Paystack accepted the request. NOT the same as success; the
 *   body's own status may still be `pending`, `otp` or `queued`.
 * - **`rejected`** — a 4xx with a provider `code`. Definitive: nothing
 *   landed, so failing the row is safe and a fresh attempt is legal.
 * - **`ambiguous`** — a 5xx, a timeout, or a thrown network error. The
 *   request may have landed. The row must stay SUBMITTED and be verified;
 *   it must NEVER be failed, or a retry becomes legal for a payment that
 *   already exists at Paystack.
 *
 * Branch on `code`, never on `message` — the code is a contract, the prose
 * is not.
 */
export type PaystackOutcome = 'ok' | 'rejected' | 'ambiguous';

/**
 * A discriminated union, so `outcome === 'ok'` proves `data` is present.
 * A shape with an optional `data` would force a non-null assertion at every
 * call site, and an assertion is exactly the kind of thing that survives a
 * later refactor after it has stopped being true.
 */
export type PaystackInitializeResult =
  | {
      outcome: 'ok';
      data: {
        authorization_url: string;
        access_code: string;
        reference: string;
      };
    }
  | { outcome: 'rejected'; code?: string; message?: string }
  | { outcome: 'ambiguous'; message?: string };

/**
 * A transfer's acceptance, not its result.
 *
 * `ok` means Paystack took the instruction; `data.status` then says what it
 * did with it — `otp` (waiting on a human), `pending`/`queued` (working on
 * it), even `success`. None of those may be claimed as SUCCEEDED here: that
 * comes only from a webhook or from verification.
 *
 * The outbound direction is where `rejected` needs the most care. A
 * duplicate-reference rejection is POSITIVE EVIDENCE the original transfer
 * landed — the opposite of a failure — so callers must check for it before
 * treating a rejection as one.
 */
export type PaystackTransferResult =
  | { outcome: 'ok'; data: { status: string; transfer_code: string } }
  | { outcome: 'rejected'; code?: string; message?: string }
  | { outcome: 'ambiguous'; message?: string };

/**
 * A refund's acceptance.
 *
 * Refunds are the most dangerous of the three to misclassify. Paystack's
 * refund API accepts no `reference` of ours, so there is no duplicate-
 * reference protection and no endpoint that takes an identifier we chose: a
 * second POST simply issues a SECOND REFUND. An `ambiguous` result must
 * therefore never become FAILED, because FAILED is what makes a second
 * attempt legal.
 *
 * `merchant_note` — carrying the bare Payment.id — is the only identifier of
 * ours that travels, and the only thing that makes recovery possible.
 */
export type PaystackRefundResult =
  | { outcome: 'ok'; data: { id: number; status: string } }
  | { outcome: 'rejected'; code?: string; message?: string }
  | { outcome: 'ambiguous'; message?: string };
