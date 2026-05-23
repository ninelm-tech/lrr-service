import {
  Injectable,
  OnModuleInit,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';

// ── Plan config ────────────────────────────────────────────────────────────────
// These Paystack plan codes are created on first boot and stored in config.
// They map to the prices in the MVP brief:
//   Individual monthly:  ₦3,000
//   Individual annual:   ₦30,000
//   Commercial monthly:  ₦3,000 per vehicle (same plan code — vehicle ref stored on Subscription)

const PLAN_DEFINITIONS = [
  {
    key: 'INDIVIDUAL_MONTHLY',
    name: 'LRR Individual – Monthly',
    amount: 300000,          // ₦3,000 in kobo
    interval: 'monthly' as const,
    plan: SubscriptionPlan.INDIVIDUAL,
    tows: 2,
  },
  {
    key: 'INDIVIDUAL_ANNUAL',
    name: 'LRR Individual – Annual',
    amount: 3000000,         // ₦30,000 in kobo
    interval: 'annually' as const,
    plan: SubscriptionPlan.INDIVIDUAL,
    tows: 2,
  },
  {
    key: 'COMMERCIAL_MONTHLY',
    name: 'LRR Commercial/Fleet – Monthly',
    amount: 300000,          // ₦3,000 per vehicle in kobo
    interval: 'monthly' as const,
    plan: SubscriptionPlan.COMMERCIAL,
    tows: 2,
  },
] as const;

type PlanKey = typeof PLAN_DEFINITIONS[number]['key'];

// ──────────────────────────────────────────────────────────────────────────────

@Injectable()
export class SubscriptionService implements OnModuleInit {
  /** In-memory cache of Paystack plan_codes, populated on boot */
  private planCodes: Record<string, string> = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * On startup: ensure all Paystack plans exist; cache their codes.
   * This is idempotent — safe to run on every deploy.
   */
  async onModuleInit() {
    try {
      const existing = await this.paystackService.listPlans();
      const existingByName = new Map(existing.map((p) => [p.name, p.plan_code]));

      for (const def of PLAN_DEFINITIONS) {
        if (existingByName.has(def.name)) {
          this.planCodes[def.key] = existingByName.get(def.name)!;
          console.log(`✅ Paystack plan cached: ${def.key} → ${this.planCodes[def.key]}`);
        } else {
          const created = await this.paystackService.createPlan({
            name:        def.name,
            amount:      def.amount,
            interval:    def.interval,
            description: `Lagos Roadside Rescue — ${def.name}`,
          });
          this.planCodes[def.key] = created.plan_code;
          console.log(`✅ Paystack plan created: ${def.key} → ${created.plan_code}`);
        }
      }
    } catch (err) {
      // Don't crash the app on startup — just warn. Subscriptions won't work until resolved.
      console.error('⚠️  Failed to sync Paystack plans on startup:', err);
    }
  }

  // ══════════════════════════════════════════════════════
  //  PUBLIC — initiate a subscription checkout
  // ══════════════════════════════════════════════════════

  /**
   * Start a new subscription for a customer.
   * Returns a Paystack authorization_url the customer pays at.
   * On successful payment, Paystack fires `invoice.payment_success` which activates the subscription.
   */
  async initiateSubscription(params: {
    userId: string;
    planKey: PlanKey;
    vehicleRef?: string;     // required for COMMERCIAL plans
  }): Promise<{ url: string; reference: string }> {
    const { userId, planKey, vehicleRef } = params;

    const planDef = PLAN_DEFINITIONS.find((p) => p.key === planKey);
    if (!planDef) throw new BadRequestException(`Invalid plan: ${planKey}`);

    const planCode = this.planCodes[planKey];
    if (!planCode) throw new BadRequestException('Payment plans not yet synced. Please try again shortly.');

    // Check for existing active subscription
    const existing = await this.prisma.subscription.findFirst({
      where: {
        userId,
        status:           SubscriptionStatus.ACTIVE,
        currentPeriodEnd: { gte: new Date() },
        ...(vehicleRef ? { vehicleRef } : {}),
      },
    });
    if (existing) throw new BadRequestException('You already have an active subscription for this plan/vehicle.');

    // Fetch user
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const email = user.email || `${user.phoneNumber?.replace(/\D/g, '')}@lrr.ng`;

    // Ensure Paystack customer record exists
    const paystackCustomer = await this.paystackService.createOrFetchCustomer({
      email,
      phone: user.phoneNumber ?? undefined,
      first_name: user.name?.split(' ')[0],
      last_name:  user.name?.split(' ').slice(1).join(' ') || undefined,
    });

    const reference = this.paystackService.generateReference('SUB');

    const checkoutRes = await this.paystackService.initializeSubscriptionCheckout({
      email,
      amount:    planDef.amount,
      plan:      planCode,
      reference,
      metadata: {
        userId,
        planKey,
        vehicleRef:           vehicleRef ?? null,
        paystackCustomerCode: paystackCustomer.customer_code,
        type: 'subscription_init',
      },
    });

    if (!checkoutRes.status) {
      console.error('Failed to initialize subscription checkout:', checkoutRes);
      throw new BadRequestException('Failed to create subscription checkout. Please try again.');
    }

    // Store a PENDING record so we can link it when the webhook fires
    await this.prisma.subscription.create({
      data: {
        userId,
        plan:                    planDef.plan,
        status:                  SubscriptionStatus.CANCELLED, // placeholder until payment confirmed
        paystackCustomerCode:    paystackCustomer.customer_code,
        monthlyAmountKobo:       planDef.amount,
        towsIncludedPerMonth:    planDef.tows,
        towsUsedThisMonth:       0,
        currentPeriodStart:      new Date(),
        currentPeriodEnd:        new Date(), // will be updated by webhook
        vehicleRef:              vehicleRef ?? null,
      },
    });

    return { url: checkoutRes.data.authorization_url, reference };
  }

  // ══════════════════════════════════════════════════════
  //  WEBHOOK HANDLERS
  // ══════════════════════════════════════════════════════

  /**
   * Called by PaymentService when Paystack fires `invoice.payment_success`.
   * Activates (or renews) the subscription for this customer.
   */
  async handleInvoicePaymentSuccess(data: any) {
    const { subscription, customer, period_start, period_end } = data;
    const subscriptionCode  = subscription?.subscription_code;
    const emailToken        = subscription?.email_token;
    const paystackCustomerCode = customer?.customer_code;

    if (!paystackCustomerCode) {
      console.warn('No customer_code in invoice.payment_success event');
      return;
    }

    // Find the subscription record by Paystack customer code
    const sub = await this.prisma.subscription.findFirst({
      where: { paystackCustomerCode },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!sub) {
      console.warn('No subscription record for customer:', paystackCustomerCode);
      return;
    }

    const periodStart = period_start ? new Date(period_start * 1000) : new Date();
    const periodEnd   = period_end   ? new Date(period_end   * 1000) : this.addOneMonth(periodStart);

    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status:                  SubscriptionStatus.ACTIVE,
        paystackSubscriptionCode: subscriptionCode ?? sub.paystackSubscriptionCode,
        towsUsedThisMonth:       0,                   // reset on renewal
        currentPeriodStart:      periodStart,
        currentPeriodEnd:        periodEnd,
      },
    });

    console.log(`✅ Subscription activated/renewed for user ${sub.userId}`);

    // Notify customer via WhatsApp
    const phone = sub.user.phoneNumber;
    if (phone) {
      const tows = sub.towsIncludedPerMonth;
      await this.twilioService.sendWhatsAppMessage(
        phone,
        `🎉 Your LRR subscription is now active!\n\nYou have ${tows} free tow${tows > 1 ? 's' : ''} this month.\n\nSend SOS or HELP anytime you need roadside assistance — no deposit required.`,
      );
    }
  }

  /**
   * Called when Paystack fires `invoice.payment_failed` or `subscription.not_renew`.
   * Marks the subscription as EXPIRED and notifies the customer.
   */
  async handleSubscriptionExpired(data: any) {
    const paystackCustomerCode = data.customer?.customer_code;
    if (!paystackCustomerCode) return;

    const sub = await this.prisma.subscription.findFirst({
      where: { paystackCustomerCode },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub) return;

    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { status: SubscriptionStatus.EXPIRED },
    });

    console.log(`⚠️  Subscription expired for user ${sub.userId}`);

    const phone = sub.user.phoneNumber;
    if (phone) {
      await this.twilioService.sendWhatsAppMessage(
        phone,
        `⚠️ Your LRR subscription has expired or could not be renewed.\n\nYou can still request a tow — a ₦5,000 deposit will apply.\n\nTo resubscribe, visit: https://lrr.ng/subscribe`,
      );
    }
  }

  // ══════════════════════════════════════════════════════
  //  CANCEL
  // ══════════════════════════════════════════════════════

  async cancelSubscription(userId: string, subscriptionId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });

    if (!sub || sub.userId !== userId) {
      throw new NotFoundException('Subscription not found');
    }

    if (sub.status !== SubscriptionStatus.ACTIVE) {
      throw new BadRequestException('Subscription is not active');
    }

    // Cancel on Paystack if we have the subscription code + email_token
    if (sub.paystackSubscriptionCode) {
      const paystackSub = await this.paystackService.fetchSubscription(sub.paystackSubscriptionCode);
      if (paystackSub?.email_token) {
        await this.paystackService.cancelSubscription({
          code:  sub.paystackSubscriptionCode,
          token: paystackSub.email_token,
        });
      }
    }

    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: SubscriptionStatus.CANCELLED },
    });

    return { message: 'Subscription cancelled. You will retain access until the end of your current billing period.' };
  }

  // ══════════════════════════════════════════════════════
  //  QUERIES
  // ══════════════════════════════════════════════════════

  async getMySubscriptions(userId: string) {
    return this.prisma.subscription.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getActiveSubscription(userId: string) {
    return this.prisma.subscription.findFirst({
      where: {
        userId,
        status:           SubscriptionStatus.ACTIVE,
        currentPeriodEnd: { gte: new Date() },
      },
    });
  }

  /** Admin: list all subscriptions with filters */
  async adminList(query: { status?: string; plan?: string; page?: number; limit?: number }) {
    const { status, plan, page = 1, limit = 20 } = query;
    const where: any = {};
    if (status) where.status = status;
    if (plan)   where.plan   = plan;

    const [data, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where,
        include: { user: { select: { id: true, phoneNumber: true, email: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip:  (Number(page) - 1) * Number(limit),
        take:  Number(limit),
      }),
      this.prisma.subscription.count({ where }),
    ]);

    return { data, meta: { page: Number(page), limit: Number(limit), total } };
  }

  // ══════════════════════════════════════════════════════
  //  AVAILABLE PLANS (for frontend plan picker)
  // ══════════════════════════════════════════════════════

  getAvailablePlans() {
    return PLAN_DEFINITIONS.map((def) => ({
      key:              def.key,
      name:             def.name,
      plan:             def.plan,
      interval:         def.interval,
      amountKobo:       def.amount,
      amountNGN:        def.amount / 100,
      towsPerMonth:     def.tows,
      planCode:         this.planCodes[def.key] ?? null,
    }));
  }

  // ──────────────────────────────────────────────────────────────────────────
  private addOneMonth(date: Date): Date {
    const d = new Date(date);
    d.setMonth(d.getMonth() + 1);
    return d;
  }
}
