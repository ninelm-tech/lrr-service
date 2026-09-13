import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';

export interface PaystackCustomerIdentity {
  code: string;
  email: string;
}

/**
 * A `User` has exactly one Paystack customer, for life.
 *
 * Paystack's `email` on `/transaction/initialize` is not a contact detail —
 * it is how Paystack finds or creates a Customer, and saved cards and
 * authorizations attach to that customer. Sending `User.email` there, freely
 * changeable, would silently split one person into two Paystack customers
 * the moment they set a real email after paying as a guest. Harmless while
 * every payment is one-off; not harmless once a card is saved for a renewal.
 *
 * The fix is to resolve the customer once and freeze the identity email
 * forever. Paystack's Update Customer API takes `first_name`, `last_name`,
 * `phone` and `metadata` — never `email` — so there is no way to correct the
 * identity later. `User.email` stays free to change; `paystackCustomerEmail`
 * never does. See docs/superpowers/specs/2026-09-12-payment-model-design.md,
 * "Paystack customer identity".
 */
@Injectable()
export class PaystackCustomerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
  ) {}

  /**
   * The Paystack customer for this user, created on first use and reused
   * forever after.
   *
   * Serialised under a row lock, not a claim taken after the fact. Two
   * concurrent first payments would otherwise both reach
   * createOrFetchCustomer — a GET then a POST — before either had written
   * anything, and a conditional update afterwards would only decide which
   * code WE keep; it says nothing about how many customers Paystack
   * actually created, and whether a concurrent same-email POST dedupes
   * provider-side is not known and must not be assumed.
   *
   * Holding a row lock across an HTTP round trip is ordinarily worth
   * avoiding. It is acceptable here because it happens once per user, on a
   * path that is already waiting on Paystack.
   */
  async customerFor(userId: string): Promise<PaystackCustomerIdentity> {
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<
        {
          paystackCustomerCode: string | null;
          paystackCustomerEmail: string | null;
          email: string | null;
          phoneNumber: string | null;
        }[]
      >`SELECT "paystackCustomerCode", "paystackCustomerEmail", "email", "phoneNumber"
          FROM "User" WHERE id = ${userId} FOR UPDATE`;

      if (locked.paystackCustomerCode && locked.paystackCustomerEmail) {
        return {
          code: locked.paystackCustomerCode,
          email: locked.paystackCustomerEmail,
        };
      }

      // Chosen ONCE, here, and frozen. User.email may change after this
      // moment; Paystack never sees the change — see the class doc.
      const identityEmail =
        locked.email ?? `${locked.phoneNumber!.replace(/\D/g, '')}@lrr.ng`;
      const { customer_code } =
        await this.paystackService.createOrFetchCustomer({
          email: identityEmail,
          phone: locked.phoneNumber ?? undefined,
        });

      await tx.user.update({
        where: { id: userId },
        data: {
          paystackCustomerCode: customer_code,
          paystackCustomerEmail: identityEmail,
        },
      });
      return { code: customer_code, email: identityEmail };
    });
  }
}
