/**
 * The parts of a Paystack webhook payload we actually read.
 *
 * Deliberately partial and deliberately optional. This is untrusted input
 * arriving over HTTP: the signature proves it came from Paystack, not that
 * any particular field is present. Marking these optional is what forces the
 * handlers to decide what to do when one is missing, rather than reading
 * `undefined` off an `any` and writing it to a payment row.
 */
export interface PaystackWebhookBody {
  event?: string;
  data?: PaystackWebhookData;
}

export interface PaystackWebhookData {
  /** Our own reference on charges and transfers: `DEP_`/`BAL_`/`payout_` + Payment.id. */
  reference?: string;

  /** Paystack's numeric id — the transaction id on a charge, the refund id on a refund. */
  id?: number;

  /** Charges only. Kobo. */
  amount?: number;
  fees?: number;
  metadata?: { type?: string } | null;

  /** Transfers only. */
  transfer_code?: string;
  /** Kobo, and Paystack's own spelling. */
  fee_charged?: number;
  reason?: string;

  /**
   * Refunds only, and the sole identifier of ours a refund carries — we put
   * the bare Payment.id here at create time. See *Refund recovery*.
   */
  merchant_note?: string;
  /** Refunds nest the original transaction rather than repeating its reference. */
  transaction?: { id?: number; reference?: string } | null;
}
