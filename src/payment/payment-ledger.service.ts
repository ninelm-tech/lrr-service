import { BadRequestException, Injectable } from '@nestjs/common';
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

  /**
   * Step 1 — committed before anything leaves.
   *
   * Also locks against a deleted party before inserting: a PAYOUT locks its
   * Operator row, everything else locks the request's customer User row.
   * Both use the same lock-as-mutex idiom as the account-deletion guards
   * (`updateMany` with `deletedAt: null` in the WHERE) so this contends for
   * the exact row `deleteOperator`/`deleteUser` writes to — whichever
   * commits first wins. The lock-check and the insert run in one
   * transaction (opened here when the caller passed no `tx`), or the lock
   * is just a stale read.
   */
  async create(input: {
    rescueRequestId: string;
    type: PaymentType;
    amount: number;
    operatorId?: string;
    tx?: Prisma.TransactionClient;
  }): Promise<Payment> {
    const run = async (
      client: Prisma.TransactionClient | PrismaService,
    ): Promise<Payment> => {
      if (input.type === PaymentType.PAYOUT) {
        // Branch purely on `type`, not `type && operatorId` — the AND form
        // let a malformed PAYOUT call with no operatorId fall through to
        // the customer branch below (checking the wrong party's deletedAt
        // entirely) and then insert a payout row with operatorId: null.
        if (!input.operatorId) {
          throw new BadRequestException(
            'A PAYOUT payment must have an operatorId.',
          );
        }
        const stillActive = await client.operator.updateMany({
          where: { id: input.operatorId, deletedAt: null },
          data: { updatedAt: new Date() },
        });
        if (stillActive.count === 0) {
          throw new BadRequestException(
            'Cannot create a payout: this operator has been deleted.',
          );
        }
      } else {
        const rescueRequest = await client.rescueRequest.findUnique({
          where: { id: input.rescueRequestId },
          select: { customerId: true, assignedOperatorId: true },
        });
        if (rescueRequest) {
          if (
            input.type === PaymentType.DEPOSIT &&
            !rescueRequest.assignedOperatorId
          ) {
            throw new BadRequestException(
              'Cannot create a deposit payment before an operator is assigned.',
            );
          }

          const stillActive = await client.user.updateMany({
            where: { id: rescueRequest.customerId, deletedAt: null },
            data: { updatedAt: new Date() },
          });
          if (stillActive.count === 0) {
            throw new BadRequestException(
              'Cannot create this payment: the customer has been deleted.',
            );
          }
        }
      }

      return client.payment.create({
        data: {
          rescueRequestId: input.rescueRequestId,
          type: input.type,
          amount: input.amount,
          operatorId: input.operatorId ?? null,
        },
      });
    };

    if (input.tx) return run(input.tx);
    return this.prisma.$transaction((tx) => run(tx));
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

  /** Step 4 — cannot proceed until its recorded condition is resolved. */
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
   * Returns it to SUBMITTED, never to a terminal state. The caller either
   * resubmits the same provider reference or continues an existing provider
   * transfer; webhook or verification owns the final outcome.
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

    try {
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
    } catch (error) {
      if (
        mapped.status === PaymentStatus.SUCCEEDED &&
        this.isUniqueConstraint(error, ['rescueRequestId', 'type'])
      ) {
        await this.recordDuplicateSuccess(paymentId, fields);
        return false;
      }
      throw error;
    }
  }

  /**
   * Paystack can report a second real success after another attempt for the
   * same request/type already won. The unique index is still right: only one
   * row may be the canonical SUCCEEDED payment that drives business side
   * effects. This row is quarantined as money that moved but needs a human
   * reconciliation/refund, and then removed from the verifier's retry set.
   */
  private async recordDuplicateSuccess(
    paymentId: string,
    fields: {
      providerRef?: string;
      providerFee?: number;
      netAmount?: number;
    },
  ): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        rescueRequestId: true,
        type: true,
        status: true,
        amount: true,
      },
    });
    const claimableStatuses: PaymentStatus[] = [
      PaymentStatus.SUBMITTED,
      PaymentStatus.BLOCKED,
    ];
    if (!payment || !claimableStatuses.includes(payment.status)) {
      return;
    }

    const existing = await this.prisma.payment.findFirst({
      where: {
        id: { not: payment.id },
        rescueRequestId: payment.rescueRequestId,
        type: payment.type,
        status: PaymentStatus.SUCCEEDED,
      },
      select: { id: true, providerRef: true },
    });
    if (!existing) {
      return;
    }

    const failureReason = `Provider reported success, but payment ${existing.id} already succeeded for this request/type; manual reconciliation required.`;
    const updated = await this.updateDuplicateSuccessPayment(
      payment.id,
      failureReason,
      fields,
    );
    if (!updated) return;

    await this.recordDuplicateSuccessAudit({
      payment,
      existing,
      fields,
    });
  }

  private async updateDuplicateSuccessPayment(
    paymentId: string,
    failureReason: string,
    fields: {
      providerRef?: string;
      providerFee?: number;
      netAmount?: number;
    },
    includeProviderRef = true,
  ): Promise<boolean> {
    try {
      const { count } = await this.prisma.payment.updateMany({
        where: {
          id: paymentId,
          status: { in: [PaymentStatus.SUBMITTED, PaymentStatus.BLOCKED] },
        },
        data: {
          status: PaymentStatus.DUPLICATE_SUCCEEDED,
          blockReason: null,
          settledAt: new Date(),
          failureReason,
          ...(includeProviderRef && fields.providerRef
            ? { providerRef: fields.providerRef }
            : {}),
          ...(fields.providerFee !== undefined
            ? { providerFee: fields.providerFee }
            : {}),
          ...(fields.netAmount !== undefined
            ? { netAmount: fields.netAmount }
            : {}),
        },
      });
      return count === 1;
    } catch (error) {
      if (
        includeProviderRef &&
        fields.providerRef &&
        this.isUniqueConstraint(error, ['providerRef'])
      ) {
        return this.updateDuplicateSuccessPayment(
          paymentId,
          failureReason,
          fields,
          false,
        );
      }
      throw error;
    }
  }

  private async recordDuplicateSuccessAudit(input: {
    payment: {
      id: string;
      rescueRequestId: string;
      type: PaymentType;
      amount: number;
    };
    existing: { id: string; providerRef: string | null };
    fields: {
      providerRef?: string;
      providerFee?: number;
      netAmount?: number;
    };
  }): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          category: 'duplicate_payment_success',
          message: `Duplicate provider success quarantined for payment ${input.payment.id}`,
          details: {
            rescueRequestId: input.payment.rescueRequestId,
            type: input.payment.type,
            duplicatePaymentId: input.payment.id,
            existingSucceededPaymentId: input.existing.id,
            amount: input.payment.amount,
            duplicateProviderRef: input.fields.providerRef ?? null,
            existingProviderRef: input.existing.providerRef,
            providerFee: input.fields.providerFee ?? null,
            netAmount: input.fields.netAmount ?? null,
          },
        },
      });
    } catch (error) {
      console.error('Failed to write duplicate payment audit log:', error);
    }
  }

  private isUniqueConstraint(error: unknown, fields: string[]): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2002'
    ) {
      return false;
    }

    const target = error.meta?.target;
    if (Array.isArray(target)) {
      return fields.every((field) => target.includes(field));
    }
    if (typeof target === 'string') {
      return fields.every((field) => target.includes(field));
    }
    return fields.every((field) => error.message.includes(field));
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
