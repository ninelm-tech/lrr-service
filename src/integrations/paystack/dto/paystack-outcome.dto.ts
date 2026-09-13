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
