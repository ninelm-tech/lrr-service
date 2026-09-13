import { Injectable } from '@nestjs/common';
import {
  Payment,
  PaymentBlockReason,
  PaymentStatus,
  PaymentType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MappedStatus } from './domain/paystack-status';
import {
  INITIAL_VERIFY_DELAY_MS,
  MAX_VERIFY_BACKOFF_MS,
  REFERENCE_PREFIX,
} from './payment.constants';

/**
 * The submission protocol, in one place.
 *
 * Every money-moving flow goes through this service rather than writing its
 * own status transitions, because the ORDERING is the correctness: the row is
 * committed before the call, the claim precedes the call, and only a webhook
 * or verification produces SUCCEEDED. A flow that re-implements any of that
 * will eventually get one of them wrong.
 *
 * See docs/superpowers/specs/2026-09-12-payment-model-design.md.
 */
@Injectable()
export class PaymentLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Step 1 — committed before anything leaves. */
  async create(input: {
    rescueRequestId: string;
    type: PaymentType;
    amount: number;
    operatorId?: string;
    tx?: Prisma.TransactionClient;
  }): Promise<Payment> {
    const client = input.tx ?? this.prisma;
    return client.payment.create({
      data: {
        rescueRequestId: input.rescueRequestId,
        type: input.type,
        amount: input.amount,
        operatorId: input.operatorId ?? null,
      },
    });
  }

  /**
   * Step 2 — the claim, which MUST happen before the HTTP call.
   *
   * Pushing verifyAfter out in the same update is not an optimisation. A row
   * left at its creation-time verifyAfter is eligible for verification while
   * its own POST is in flight, and a concurrent check would see "not found"
   * and fail a payment that is about to succeed — leaving money received
   * against a row no webhook can claim.
   *
   * Returns false when another caller already claimed it. Both the reconciler
   * and the request handler can reach here for the same row; **the loser must
   * not call Paystack.**
   */
  async claimForSubmission(paymentId: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.PENDING },
      data: {
        status: PaymentStatus.SUBMITTED,
        verifyAfter: new Date(now.getTime() + INITIAL_VERIFY_DELAY_MS),
      },
    });
    return count === 1;
  }

  /** The Paystack reference. Refunds get '' and use merchant_note instead. */
  referenceFor(payment: Pick<Payment, 'id' | 'type'>): string {
    const prefix = REFERENCE_PREFIX[payment.type];
    return prefix ? `${prefix}_${payment.id}` : '';
  }

  /**
   * Step 4 — a DEFINITIVE provider rejection.
   *
   * Never called for an ambiguous failure (a 5xx, a timeout) or for a
   * duplicate-reference error: FAILED makes a fresh attempt legal, which is
   * exactly wrong when the original may have landed.
   */
  async recordRejection(
    paymentId: string,
    failureReason: string,
    blockReason?: PaymentBlockReason,
  ): Promise<void> {
    await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.SUBMITTED },
      data: {
        status: PaymentStatus.FAILED,
        failureReason,
        blockReason: blockReason ?? null,
      },
    });
  }

  /** Step 4 — reached Paystack, which is now waiting on a human. */
  async recordBlocked(
    paymentId: string,
    blockReason: PaymentBlockReason,
  ): Promise<void> {
    await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.SUBMITTED },
      data: { status: PaymentStatus.BLOCKED, blockReason },
    });
  }

  /**
   * A human resolved what the row was blocked on.
   *
   * Returns it to SUBMITTED, never to a terminal state: supplying bank
   * details makes Paystack answer `processing`, not `success`. The webhook or
   * the verification check finishes it from there, like any other submitted
   * row.
   */
  async unblock(paymentId: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentStatus.BLOCKED },
      data: {
        status: PaymentStatus.SUBMITTED,
        blockReason: null,
        verifyAfter: new Date(now.getTime() + INITIAL_VERIFY_DELAY_MS),
      },
    });
    return count === 1;
  }

  /**
   * Step 5 — the only path to SUCCEEDED.
   *
   * The guard is the query. Once both the webhook and the verification check
   * exist they WILL arrive for the same payment; whichever is second gets
   * false and does nothing. That is the normal case, not an edge case.
   */
  async claimTerminal(
    paymentId: string,
    mapped: MappedStatus,
    fields: {
      providerRef?: string;
      providerFee?: number;
      netAmount?: number;
    } = {},
  ): Promise<boolean> {
    const isTerminal =
      mapped.status === PaymentStatus.SUCCEEDED ||
      mapped.status === PaymentStatus.FAILED ||
      mapped.status === PaymentStatus.REVERSED;

    const { count } = await this.prisma.payment.updateMany({
      where: {
        id: paymentId,
        status: { in: [PaymentStatus.SUBMITTED, PaymentStatus.BLOCKED] },
      },
      data: {
        status: mapped.status,
        blockReason: mapped.blockReason ?? null,
        settledAt: isTerminal ? new Date() : null,
        ...(fields.providerRef ? { providerRef: fields.providerRef } : {}),
        ...(fields.providerFee !== undefined
          ? { providerFee: fields.providerFee }
          : {}),
        ...(fields.netAmount !== undefined
          ? { netAmount: fields.netAmount }
          : {}),
      },
    });
    return count === 1;
  }

  /** Paystack still says pending — come back later rather than polling hard. */
  async backOff(paymentId: string, now: Date): Promise<void> {
    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    const elapsed = Math.max(
      INITIAL_VERIFY_DELAY_MS,
      now.getTime() - payment.createdAt.getTime(),
    );
    const next = Math.min(elapsed * 2, MAX_VERIFY_BACKOFF_MS);
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: {
        verifyAfter: new Date(now.getTime() + next),
        // Counted so PaymentVerifyCheck can stop guessing and escalate.
        verifyAttempts: { increment: 1 },
      },
    });
  }
}
