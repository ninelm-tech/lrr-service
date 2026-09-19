import {
  mapRefundStatus,
  mapTransactionStatus,
  mapTransferStatus,
} from './paystack-status';

describe('mapTransferStatus', () => {
  it('maps a completed transfer to SUCCEEDED', () => {
    expect(mapTransferStatus('success')).toEqual({ status: 'SUCCEEDED' });
  });

  it('maps in-progress states to SUBMITTED — waiting resolves them', () => {
    expect(mapTransferStatus('pending')).toEqual({ status: 'SUBMITTED' });
    expect(mapTransferStatus('processing')).toEqual({ status: 'SUBMITTED' });
  });

  it('maps otp to BLOCKED — waiting never resolves it, a human must', () => {
    expect(mapTransferStatus('otp')).toEqual({
      status: 'BLOCKED',
      blockReason: 'AWAITING_OTP',
    });
  });

  it('maps abandoned to FAILED — initiated, never finalised, nothing moved', () => {
    // Every transfer on the test integration is in this state. It is what a
    // transfer becomes when OTP is on and nobody answers, and it is why the
    // payouts looked stuck: the code waited for a webhook that never comes.
    expect(mapTransferStatus('abandoned')).toEqual({ status: 'FAILED' });
  });

  it('maps failed and reversed to their own terminals', () => {
    expect(mapTransferStatus('failed')).toEqual({ status: 'FAILED' });
    expect(mapTransferStatus('reversed')).toEqual({ status: 'REVERSED' });
  });

  it('treats an unrecognised status as SUBMITTED, never as a terminal', () => {
    // A status Paystack adds later must not be guessed into SUCCEEDED or
    // FAILED. Staying SUBMITTED keeps the row polled and visible, which is
    // the safe direction to be wrong in — a wrong SUCCEEDED marks money as
    // moved that has not.
    expect(mapTransferStatus('some_future_status')).toEqual({
      status: 'SUBMITTED',
    });
  });
});

describe('mapTransactionStatus', () => {
  it('maps success to SUCCEEDED', () => {
    expect(mapTransactionStatus('success')).toEqual({ status: 'SUCCEEDED' });
  });

  it('maps failed and reversed to their own terminals', () => {
    expect(mapTransactionStatus('failed')).toEqual({ status: 'FAILED' });
    expect(mapTransactionStatus('reversed')).toEqual({ status: 'REVERSED' });
  });

  it('treats abandoned as SUBMITTED, not FAILED', () => {
    // A collection differs from a transfer here. An abandoned transaction is
    // one the customer has not paid YET — the checkout link may still be in
    // their WhatsApp thread. Failing it would write off a payment they can
    // still make. The deposit window is what ends it, not this mapping.
    expect(mapTransactionStatus('abandoned')).toEqual({ status: 'SUBMITTED' });
  });

  it('treats an unrecognised status as SUBMITTED', () => {
    expect(mapTransactionStatus('some_future_status')).toEqual({
      status: 'SUBMITTED',
    });
  });
});

describe('mapRefundStatus', () => {
  it('maps processed to SUCCEEDED and failed to FAILED', () => {
    expect(mapRefundStatus('processed')).toEqual({ status: 'SUCCEEDED' });
    expect(mapRefundStatus('failed')).toEqual({ status: 'FAILED' });
  });

  it('maps needs-attention to BLOCKED — the customer must supply bank details', () => {
    expect(mapRefundStatus('needs-attention')).toEqual({
      status: 'BLOCKED',
      blockReason: 'NEEDS_CUSTOMER_DETAILS',
    });
  });

  it('maps pending and processing to SUBMITTED', () => {
    // `pending` is what a real refund create returned on the test
    // integration, so this is the ordinary path, not an edge case.
    expect(mapRefundStatus('pending')).toEqual({ status: 'SUBMITTED' });
    expect(mapRefundStatus('processing')).toEqual({ status: 'SUBMITTED' });
  });

  it('treats an unrecognised status as SUBMITTED', () => {
    expect(mapRefundStatus('some_future_status')).toEqual({
      status: 'SUBMITTED',
    });
  });
});
