import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { logger } from '@sentry/node';
import { PrismaService } from '../prisma/prisma.service';
import {
  Operator,
  OperatorStatus,
  OperatorType,
  UserRole,
  OperatorMemberRole,
  TruckClass,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { normalizePhone } from '../common/phone.util';
import { claimOnce } from '../common/claim-once.util';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { AdminCreateOperatorDto } from './dto/admin-create-operator.dto';
import { UpdateOperatorProfileDto } from './dto/update-operator-profile.dto';
import { SaveBankDetailsDto } from './dto/save-bank-details.dto';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { OtpService } from '../otp/otp.service';
import { OperatorMembershipService } from './operator-membership.service';
import {
  hasRole,
  OPERATOR_ADMIN_ROLES,
  OPERATOR_ONBOARDING_ROLES,
} from './domain/operator-staff-roles';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';

// ── Scoring weights ────────────────────────────────────────────────────────────
// Distance is the dominant factor but reliability and speed matter.
// New operators (no history) receive neutral scores on the last two factors
// so they aren't unfairly penalised before they've had a chance to prove themselves.
const WEIGHT_DISTANCE = 0.5;
const WEIGHT_ACCEPTANCE_RATE = 0.3;
const WEIGHT_RESPONSE_SPEED = 0.2;

// Look-back window for computing operator stats
const STATS_LOOKBACK_DAYS = 30;

// Ceiling on an operator's deposit-percent override (setDepositPercent,
// adminCreate). The floor is the platform's current default
// (PlatformConfigService.getConfig().depositPercent, fetched live) — an
// operator can pitch something easier than the platform standard, never
// below it. This ceiling is a separate, fixed platform rule.
const MAX_OPERATOR_DEPOSIT_PERCENT = 50;
// The real floor an operator override may never go below, independent of
// what PlatformConfigService.getConfig().depositPercent happens to read
// live — that value is itself validated at write time (never below 10),
// but trusting it alone here means any future bypass of that write-time
// check (direct DB write, a migration, anything) would silently lower this
// floor too. Matches PlatformConfigService's own floor exactly (2026-10-25
// hotfix) so the two can never drift apart.
const MIN_PLATFORM_DEPOSIT_PERCENT = 10;

export interface ScoredOperator {
  id: string;
  businessName: string;
  phoneNumber: string;
  latitude: number;
  longitude: number;
  serviceRadius: number;
  distance: number; // km from the rescue location
  score: number; // composite 0–1, higher = better
  stats: OperatorStats;
}

export interface OperatorStats {
  totalOffered: number;
  totalAccepted: number;
  totalDeclined: number;
  totalTimedOut: number;
  acceptanceRate: number; // 0–1
  avgResponseSec: number; // seconds; null-safe (0 for new operators)
}

// computeStats() (used by dispatch ranking, which deliberately excludes
// ratings from the composite score) returns plain OperatorStats. The
// admin-facing stats endpoints attach ratings on top of that.
export interface OperatorStatsWithRating extends OperatorStats {
  averageRating: number | null; // ratings RECEIVED from motorists only; null when zero ratings
  ratingCount: number;
}

// ──────────────────────────────────────────────────────────────────────────────

@Injectable()
export class OperatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly otpService: OtpService,
    private readonly operatorMembershipService: OperatorMembershipService,
    private readonly auditLogService: AuditLogService,
    private readonly platformConfigService: PlatformConfigService,
  ) {}

  // ══════════════════════════════════════════════════════
  //  REGISTRATION
  // ══════════════════════════════════════════════════════

  async create(data: CreateOperatorDto) {
    if (!Array.isArray(data.truckClasses) || data.truckClasses.length === 0) {
      throw new BadRequestException(
        'truckClasses is required and must be a non-empty array',
      );
    }
    const invalidTruckClasses = data.truckClasses.filter(
      (tc) => !Object.values(TruckClass).includes(tc),
    );
    if (invalidTruckClasses.length > 0) {
      throw new BadRequestException(
        `Invalid truck class(es): ${invalidTruckClasses.join(', ')}`,
      );
    }

    const personalPhone = normalizePhone(data.phoneNumber);
    const businessPhone = normalizePhone(data.businessPhoneNumber);

    // Two separate, explicit lookups — never a combined OR — so the decision
    // never depends on which row Prisma happens to return first. A combined
    // findFirst({ OR: [{email},{phoneNumber}] }) could match the phone via
    // one row and reason about an unrelated row's email, misattributing a
    // conflict or an upgrade-eligibility check to the wrong account.
    const existingByPhone = await this.prisma.user.findUnique({
      where: { phoneNumber: personalPhone },
    });
    const existingByEmail = data.email
      ? await this.prisma.user.findUnique({ where: { email: data.email } })
      : null;

    if (existingByEmail && existingByEmail.id !== existingByPhone?.id) {
      logger.warn('operator.create: email already registered', {
        email: data.email,
        existingUserId: existingByEmail.id,
      });
      throw new ConflictException('Email or phone number already registered');
    }

    // The upgrade path: an existing CUSTOMER re-using their own number to
    // become an operator, gated by WhatsApp OTP ownership verification.
    // Never applies to an existing OPERATOR/ADMIN on that phone — that's a
    // genuine duplicate-account attempt, not a legitimate ownership case.
    let upgradeUserId: string | null = null;
    let upgradeTokenRowId: string | null = null;
    let freshSignupTokenRowId: string | null = null;

    if (existingByPhone) {
      if (existingByPhone.role !== UserRole.CUSTOMER) {
        logger.warn(
          'operator.create: phone already registered to a non-customer account',
          {
            existingUserId: existingByPhone.id,
            role: existingByPhone.role,
          },
        );
        throw new ConflictException('Email or phone number already registered');
      }

      if (!data.phoneVerificationToken) {
        throw new ConflictException(
          'This number belongs to an existing account — verify your number first.',
        );
      }
      const tokenRow = await this.otpService.findValidTokenRow(
        personalPhone,
        data.phoneVerificationToken,
      );
      if (!tokenRow) {
        throw new ConflictException(
          'This number belongs to an existing account — verify your number first.',
        );
      }
      upgradeUserId = existingByPhone.id;
      upgradeTokenRowId = tokenRow.id;
    } else {
      // Fresh signup — verification is now mandatory here too, not just for
      // upgrades. Deliberately BadRequestException (400), not the upgrade
      // branch's ConflictException (409): the upgrade branch's message is
      // shared with the "phone belongs to someone else" conflict above it in
      // the same block; a fresh signup has no such shared context, and
      // "you skipped verification" is a plain bad request, not a conflict.
      if (!data.phoneVerificationToken) {
        throw new BadRequestException('Verify your phone number first.');
      }
      const tokenRow = await this.otpService.findValidTokenRow(
        personalPhone,
        data.phoneVerificationToken,
      );
      if (!tokenRow) {
        throw new BadRequestException('Verify your phone number first.');
      }
      freshSignupTokenRowId = tokenRow.id;
    }

    // The personal and business numbers are checked against BOTH tables:
    // an operator's own login number must not already be claimed as some
    // other business's dispatch line, and the business's dispatch line must
    // not already be claimed as an existing customer's number — either
    // direction leaves that number permanently unreachable via WhatsApp for
    // whichever role loses the routing race in handleIncomingWhatsAppMessage.
    const personalPhoneClaimedByOperator =
      await this.prisma.operator.findUnique({
        where: { phoneNumber: personalPhone },
      });
    if (personalPhoneClaimedByOperator) {
      throw new ConflictException(
        'This phone number is already registered as a business dispatch line.',
      );
    }

    const businessPhoneClaimedByOperator =
      await this.prisma.operator.findUnique({
        where: { phoneNumber: businessPhone },
      });
    if (businessPhoneClaimedByOperator) {
      throw new ConflictException(
        'This business phone number is already registered.',
      );
    }

    const businessPhoneClaimedByCustomer = await this.prisma.user.findFirst({
      where: { phoneNumber: businessPhone },
    });
    if (businessPhoneClaimedByCustomer) {
      throw new ConflictException(
        'This business phone number is already registered as a customer account. Use a different number for your business line.',
      );
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    return this.prisma.$transaction(async (tx) => {
      let user;

      if (upgradeUserId) {
        await claimOnce(
          tx.phoneVerification,
          {
            where: {
              id: upgradeTokenRowId!,
              consumedAt: null,
              tokenExpiresAt: { gt: new Date() },
            },
            data: { consumedAt: new Date() },
          },
          new ConflictException(
            'This number belongs to an existing account — verify your number first.',
          ),
        );
        const stillFree = data.email
          ? await tx.user.findUnique({ where: { email: data.email } })
          : null;
        if (stillFree && stillFree.id !== upgradeUserId) {
          throw new ConflictException(
            'Email or phone number already registered',
          );
        }

        user = await tx.user.update({
          where: { id: upgradeUserId },
          data: {
            email: data.email,
            passwordHash,
            name: data.name,
            role: UserRole.OPERATOR,
          },
        });
      } else {
        // Same atomic-claim pattern as the upgrade branch above.
        await claimOnce(
          tx.phoneVerification,
          {
            where: {
              id: freshSignupTokenRowId!,
              consumedAt: null,
              tokenExpiresAt: { gt: new Date() },
            },
            data: { consumedAt: new Date() },
          },
          new BadRequestException('Verify your phone number first.'),
        );

        user = await tx.user.create({
          data: {
            email: data.email,
            passwordHash,
            name: data.name,
            phoneNumber: personalPhone,
            role: UserRole.OPERATOR,
          },
        });
      }

      const operator = await tx.operator.create({
        data: {
          type: data.type ?? OperatorType.TOW_TRUCK,
          truckClasses: data.truckClasses,
          businessName: data.businessName,
          contactName: data.contactName,
          phoneNumber: businessPhone,
          email: data.email,
          address: data.address,
          latitude: data.latitude,
          longitude: data.longitude,
          serviceRadius: data.serviceRadius ?? 10,
          status: OperatorStatus.PENDING,
          whatsappEnabled: data.whatsappEnabled ?? true,
        },
      });

      const operatorMember = await tx.operatorMember.create({
        data: {
          userId: user.id,
          operatorId: operator.id,
          role: OperatorMemberRole.OWNER,
        },
      });

      logger.info('operator.create: registered, pending approval', {
        userId: user.id,
        operatorId: operator.id,
      });
      return { user, operator, operatorMember };
    });
  }

  /**
   * Staff onboarding from a physical intake form in the field — no OTP
   * phone verification (staff already verified identity in person) and no
   * upgrade-path consideration (that path exists specifically to pair with
   * OTP ownership proof, which doesn't happen here). Active immediately:
   * the physical form IS the vetting step, so a second PENDING approval
   * would just be the same admin re-approving their own intake.
   */
  async adminCreate(data: AdminCreateOperatorDto) {
    if (!Array.isArray(data.truckClasses) || data.truckClasses.length === 0) {
      throw new BadRequestException(
        'truckClasses is required and must be a non-empty array',
      );
    }
    const invalidTruckClasses = data.truckClasses.filter(
      (tc) => !Object.values(TruckClass).includes(tc),
    );
    if (invalidTruckClasses.length > 0) {
      throw new BadRequestException(
        `Invalid truck class(es): ${invalidTruckClasses.join(', ')}`,
      );
    }

    // Same manual check as setDepositPercent — no global ValidationPipe, so
    // DTO decorators alone don't run. Unlike setDepositPercent's dedicated
    // endpoint, `undefined` is fine here: this is one optional field among
    // many on a creation DTO, so omitting it just means "no override set at
    // creation," not an error.
    if (
      data.depositPercentOverride !== undefined &&
      data.depositPercentOverride !== null
    ) {
      const { depositPercent: liveDefaultRaw } =
        await this.platformConfigService.getConfig();
      // Math.max(10, NaN) is NaN, and every comparison against NaN is
      // false — a corrupt/non-finite config read must not silently defeat
      // this floor (same NaN-contagion class as computeDepositAmount's).
      const liveDefault = Number.isFinite(liveDefaultRaw)
        ? liveDefaultRaw
        : MIN_PLATFORM_DEPOSIT_PERCENT;
      const minDepositPercent = Math.max(
        MIN_PLATFORM_DEPOSIT_PERCENT,
        liveDefault,
      );
      if (
        typeof data.depositPercentOverride !== 'number' ||
        !Number.isFinite(data.depositPercentOverride) ||
        data.depositPercentOverride < minDepositPercent ||
        data.depositPercentOverride > MAX_OPERATOR_DEPOSIT_PERCENT
      ) {
        throw new BadRequestException(
          `depositPercentOverride must be between ${minDepositPercent} and ${MAX_OPERATOR_DEPOSIT_PERCENT}`,
        );
      }
    }

    const personalPhone = normalizePhone(data.phoneNumber);
    const businessPhone = normalizePhone(data.businessPhoneNumber);

    // No OTP ownership proof on this path, so no upgrade case either — any
    // existing account on this number is a conflict, full stop.
    const existingByPhone = await this.prisma.user.findUnique({
      where: { phoneNumber: personalPhone },
    });
    if (existingByPhone) {
      throw new ConflictException('Email or phone number already registered');
    }
    const existingByEmail = data.email
      ? await this.prisma.user.findUnique({ where: { email: data.email } })
      : null;
    if (existingByEmail) {
      throw new ConflictException('Email or phone number already registered');
    }

    const personalPhoneClaimedByOperator =
      await this.prisma.operator.findUnique({
        where: { phoneNumber: personalPhone },
      });
    if (personalPhoneClaimedByOperator) {
      throw new ConflictException(
        'This phone number is already registered as a business dispatch line.',
      );
    }

    const businessPhoneClaimedByOperator =
      await this.prisma.operator.findUnique({
        where: { phoneNumber: businessPhone },
      });
    if (businessPhoneClaimedByOperator) {
      throw new ConflictException(
        'This business phone number is already registered.',
      );
    }

    const businessPhoneClaimedByCustomer = await this.prisma.user.findFirst({
      where: { phoneNumber: businessPhone },
    });
    if (businessPhoneClaimedByCustomer) {
      throw new ConflictException(
        'This business phone number is already registered as a customer account. Use a different number for your business line.',
      );
    }

    const passwordHash = data.password
      ? await bcrypt.hash(data.password, 10)
      : null;

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: data.email,
          passwordHash,
          name: data.name,
          phoneNumber: personalPhone,
          role: UserRole.OPERATOR,
        },
      });

      const operator = await tx.operator.create({
        data: {
          type: data.type ?? OperatorType.TOW_TRUCK,
          truckClasses: data.truckClasses,
          businessName: data.businessName,
          contactName: data.contactName,
          phoneNumber: businessPhone,
          email: data.email,
          address: data.address,
          latitude: data.latitude,
          longitude: data.longitude,
          serviceRadius: data.serviceRadius ?? 10,
          status: OperatorStatus.ACTIVE,
          depositPercentOverride: data.depositPercentOverride ?? null,
          whatsappEnabled: data.whatsappEnabled ?? true,
        },
      });

      const operatorMember = await tx.operatorMember.create({
        data: {
          userId: user.id,
          operatorId: operator.id,
          role: OperatorMemberRole.OWNER,
        },
      });

      logger.info(
        'operator.adminCreate: onboarded by staff, active immediately',
        {
          userId: user.id,
          operatorId: operator.id,
        },
      );
      return { user, operator, operatorMember };
    });
  }

  // ══════════════════════════════════════════════════════
  //  DISPATCH — find and rank candidates
  // ══════════════════════════════════════════════════════

  /**
   * Find all available operators within range, ranked by composite score.
   * Used by the dispatch loop to build each broadcast batch.
   *
   * Scoring = distance (50%) + acceptance rate (30%) + response speed (20%)
   * Operators with no history receive neutral scores on the last two factors.
   *
   * @param excludeIds  Operator IDs already offered this job (skip them)
   * @param extraRadiusKm  Radius expansion applied in retry rounds
   *
   * There is deliberately NO busy/in-flight filter here. An operator already
   * selected for another job — or already driving to one — remains a full
   * candidate and will keep receiving offers. That is intended, not an
   * oversight: we don't know an operator's fleet size (the schema models a
   * business, not its vehicles, and truckClasses is a list precisely because
   * some run several trucks), so the platform cannot tell whether they have
   * capacity for one more. The operator decides, by quoting or replying NO.
   *
   * The consequence is that one operator can legitimately hold several open
   * offers at once, which is why WhatsAppOperatorFlowService has to
   * disambiguate replies by job reference.
   *
   * isAvailable is the operator's OWN switch, set only via the admin
   * availability endpoint. Nothing in dispatch or payment writes it, and
   * nothing should start to — an automatic busy flag is the thing this
   * comment exists to prevent.
   */
  async findAndRankCandidates(
    latitude: number,
    longitude: number,
    excludeIds: string[] = [],
    extraRadiusKm: number = 0,
    type?: OperatorType,
    truckClasses?: TruckClass[],
    isTest: boolean = false,
    whatsappOnly: boolean = true,
  ): Promise<ScoredOperator[]> {
    const operators = await this.prisma.operator.findMany({
      where: {
        status: OperatorStatus.ACTIVE,
        isAvailable: true,
        isTest,
        whatsappEnabled: whatsappOnly,
        ...(excludeIds.length > 0 && { id: { notIn: excludeIds } }),
        ...(type && { type }),
        ...(truckClasses &&
          truckClasses.length > 0 && {
            truckClasses: { hasSome: truckClasses },
          }),
      },
    });

    if (operators.length === 0) return [];

    // Filter to within effective radius and compute distances
    const inRange: Array<{ op: (typeof operators)[0]; distance: number }> = [];
    for (const op of operators) {
      const distance = this.calculateDistance(
        latitude,
        longitude,
        Number(op.latitude),
        Number(op.longitude),
      );
      const effectiveRadius = op.serviceRadius + extraRadiusKm;
      if (distance <= effectiveRadius) {
        inRange.push({ op, distance });
      }
    }

    if (inRange.length === 0) return [];

    // Fetch dispatch history for all candidates in one query
    const since = new Date();
    since.setDate(since.getDate() - STATS_LOOKBACK_DAYS);

    const operatorIds = inRange.map((r) => r.op.id);
    const offers = await this.prisma.dispatchOffer.findMany({
      where: {
        operatorId: { in: operatorIds },
        offeredAt: { gte: since },
      },
      select: {
        operatorId: true,
        status: true,
        offeredAt: true,
        respondedAt: true,
      },
    });

    // Group offers by operator
    const offersByOperator = new Map<string, typeof offers>();
    for (const offer of offers) {
      if (!offersByOperator.has(offer.operatorId)) {
        offersByOperator.set(offer.operatorId, []);
      }
      offersByOperator.get(offer.operatorId)!.push(offer);
    }

    // Compute the max distance in range (used to normalise distance score)
    const maxDistance = Math.max(...inRange.map((r) => r.distance), 1);

    // Score each operator
    const scored: ScoredOperator[] = inRange.map(({ op, distance }) => {
      const stats = this.computeStats(offersByOperator.get(op.id) ?? []);

      // Distance score: closer = 1.0, furthest in range = 0.0
      const distanceScore = 1 - distance / maxDistance;

      // Acceptance rate score: direct 0–1
      const acceptanceScore = stats.acceptanceRate;

      // Response speed score: faster = 1.0. Cap at 5 min (300s) = 0.0.
      // New operators (avgResponseSec === 0) get a neutral 0.5.
      const MAX_RESPONSE_SEC = 300;
      const speedScore =
        stats.totalAccepted === 0
          ? 0.5 // neutral for new operators
          : Math.max(0, 1 - stats.avgResponseSec / MAX_RESPONSE_SEC);

      const score =
        distanceScore * WEIGHT_DISTANCE +
        acceptanceScore * WEIGHT_ACCEPTANCE_RATE +
        speedScore * WEIGHT_RESPONSE_SPEED;

      return {
        id: op.id,
        businessName: op.businessName,
        phoneNumber: op.phoneNumber!,
        latitude: Number(op.latitude),
        longitude: Number(op.longitude),
        serviceRadius: op.serviceRadius,
        distance,
        score,
        stats,
      };
    });

    // Sort highest score first
    return scored.sort((a, b) => b.score - a.score);
  }

  /**
   * @deprecated Use findAndRankCandidates for dispatch.
   * Kept for backwards compatibility with any existing callers.
   */
  async findNearestAvailableExcluding(
    latitude: number,
    longitude: number,
    excludeIds: string[] = [],
    extraRadiusKm: number = 0,
    type?: OperatorType,
  ) {
    const ranked = await this.findAndRankCandidates(
      latitude,
      longitude,
      excludeIds,
      extraRadiusKm,
      type,
    );
    return ranked[0] ?? null;
  }

  async findNearestAvailable(
    latitude: number,
    longitude: number,
    type?: OperatorType,
  ) {
    return this.findNearestAvailableExcluding(latitude, longitude, [], 0, type);
  }

  // ══════════════════════════════════════════════════════
  //  OPERATOR STATS (admin dashboard)
  // ══════════════════════════════════════════════════════

  /**
   * Compute performance stats for a single operator.
   * Admin dashboard can call this per-operator, or aggregate across all.
   */
  async getOperatorStats(
    operatorId: string,
    days = 30,
  ): Promise<OperatorStatsWithRating> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [offers, ratingAgg] = await Promise.all([
      this.prisma.dispatchOffer.findMany({
        where: { operatorId, offeredAt: { gte: since } },
        select: { status: true, offeredAt: true, respondedAt: true },
      }),
      this.prisma.rating.aggregate({
        where: { operatorId, direction: 'MOTORIST_TO_OPERATOR' },
        _avg: { score: true },
        _count: { score: true },
      }),
    ]);

    return {
      ...this.computeStats(offers),
      averageRating: ratingAgg._avg.score,
      ratingCount: ratingAgg._count.score,
    };
  }

  /**
   * Get stats for all operators — used for admin leaderboard / performance page.
   */
  async getAllOperatorStats(days = 30): Promise<
    Array<{
      operatorId: string;
      businessName: string;
      phoneNumber: string;
      status: string;
      stats: OperatorStatsWithRating;
    }>
  > {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [operators, allOffers, ratingGroups] = await Promise.all([
      this.prisma.operator.findMany({
        select: {
          id: true,
          businessName: true,
          phoneNumber: true,
          status: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.dispatchOffer.findMany({
        where: { offeredAt: { gte: since } },
        select: {
          operatorId: true,
          status: true,
          offeredAt: true,
          respondedAt: true,
        },
      }),
      this.prisma.rating.groupBy({
        by: ['operatorId'],
        where: { direction: 'MOTORIST_TO_OPERATOR' },
        _avg: { score: true },
        _count: { score: true },
      }),
    ]);

    const offersByOperator = new Map<string, typeof allOffers>();
    for (const offer of allOffers) {
      if (!offersByOperator.has(offer.operatorId)) {
        offersByOperator.set(offer.operatorId, []);
      }
      offersByOperator.get(offer.operatorId)!.push(offer);
    }

    const ratingsByOperator = new Map<
      string,
      { _avg: { score: number | null }; _count: { score: number } }
    >();
    for (const group of ratingGroups) {
      ratingsByOperator.set(group.operatorId, {
        _avg: group._avg,
        _count: group._count,
      });
    }

    return operators.map((op) => {
      const ratingAgg = ratingsByOperator.get(op.id);
      return {
        operatorId: op.id,
        businessName: op.businessName,
        phoneNumber: op.phoneNumber!,
        status: op.status,
        stats: {
          ...this.computeStats(offersByOperator.get(op.id) ?? []),
          averageRating: ratingAgg?._avg.score ?? null,
          ratingCount: ratingAgg?._count.score ?? 0,
        },
      };
    });
  }

  // ══════════════════════════════════════════════════════
  //  CRUD
  // ══════════════════════════════════════════════════════

  async findAll() {
    return this.prisma.operator.findMany({
      include: { members: { include: { user: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    return this.prisma.operator.findUnique({
      where: { id },
      include: { members: { include: { user: true } } },
    });
  }

  async findByUserId(userId: string) {
    const membership = await this.prisma.operatorMember.findFirst({
      where: {
        userId,
        operator: { deletedAt: null },
        user: { deletedAt: null },
      },
      include: {
        operator: { include: { members: { include: { user: true } } } },
      },
    });
    return membership?.operator || null;
  }

  /**
   * Authorization helper: can this user manage the given operator?
   * Admins always can; otherwise the user must be an OWNER or MANAGER member.
   */
  async assertCanManageOperator(
    user: { userId: string; role: string },
    operatorId: string,
  ): Promise<void> {
    await this.assertStaffOrOwnerManager(
      user,
      operatorId,
      OPERATOR_ADMIN_ROLES,
    );
  }

  /**
   * Like assertCanManageOperator but PRODUCT staff also pass — day-to-day
   * onboarding (profile, payout bank details). Member management and
   * everything else keeps using assertCanManageOperator, so PRODUCT can't
   * add/remove an operator's team.
   */
  async assertCanOnboardOperator(
    user: { userId: string; role: string },
    operatorId: string,
  ): Promise<void> {
    await this.assertStaffOrOwnerManager(
      user,
      operatorId,
      OPERATOR_ONBOARDING_ROLES,
    );
  }

  private async assertStaffOrOwnerManager(
    user: { userId: string; role: string },
    operatorId: string,
    staffRoles: readonly UserRole[],
  ): Promise<void> {
    if (hasRole(user.role, staffRoles)) return;

    const membership = await this.prisma.operatorMember.findUnique({
      where: { userId_operatorId: { userId: user.userId, operatorId } },
    });
    const allowed: OperatorMemberRole[] = [
      OperatorMemberRole.OWNER,
      OperatorMemberRole.MANAGER,
    ];
    if (!membership || !allowed.includes(membership.role)) {
      throw new ForbiddenException(
        'You do not have permission to manage this operator',
      );
    }
  }

  /**
   * Like assertCanManageOperator but any membership counts (e.g. availability
   * toggle), and PRODUCT staff pass too (onboarding). Also guards the
   * read-only member list.
   */
  async assertIsMemberOrAdmin(
    user: { userId: string; role: string },
    operatorId: string,
  ): Promise<void> {
    if (hasRole(user.role, OPERATOR_ONBOARDING_ROLES)) return;

    const membership = await this.prisma.operatorMember.findUnique({
      where: { userId_operatorId: { userId: user.userId, operatorId } },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this operator');
    }
  }

  /**
   * Save an operator's payout bank details. accountName always comes from
   * Paystack's resolve-account response, never from the request body.
   * Creates the Paystack transfer recipient right here — the ONLY place
   * this ever happens, since this is the only point the full account
   * number is available. bankCode and the full accountNumber are used for
   * the two Paystack calls below and are never persisted — only display
   * data (bankName, accountName, accountNumberLast4) and the resulting
   * recipientCode are stored. Changing bank details later simply repeats
   * this whole flow, overwriting paystackRecipientCode with a new one.
   */
  async saveBankDetails(
    id: string,
    dto: SaveBankDetailsDto,
    actingUser: { userId: string; role: string },
  ) {
    // Manual check, not just the DTO's decorators — this app has no global
    // ValidationPipe wired up yet, so class-validator decorators alone
    // don't currently run (see rating.controller.ts for the same gap).
    if (!/^\d{10}$/.test(dto.accountNumber)) {
      throw new BadRequestException('accountNumber must be exactly 10 digits');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.operatorMembershipService.lockActiveMembership(
        tx,
        actingUser,
        id,
        OPERATOR_ONBOARDING_ROLES,
      );
      const operator = await tx.operator.findUnique({ where: { id } });
      if (!operator) throw new NotFoundException('Operator not found');

      const { accountName } = await this.paystackService.resolveAccountNumber(
        dto.accountNumber,
        dto.bankCode,
      );
      const { recipientCode } =
        await this.paystackService.createTransferRecipient({
          accountNumber: dto.accountNumber,
          bankCode: dto.bankCode,
          accountName,
          businessName: operator.businessName,
        });

      return tx.operator.update({
        where: { id },
        data: {
          bankName: dto.bankName,
          accountName,
          accountNumberLast4: dto.accountNumber.slice(-4),
          paystackRecipientCode: recipientCode,
        },
      });
    });
  }

  /**
   * `undefined` means the field was missing from the request body — that's
   * rejected outright, not treated as "no change": without this check a
   * `{}` body would reach Prisma as `data: { depositPercentOverride:
   * undefined }`, which Prisma silently treats as "don't touch this
   * field," returning 200 having changed nothing and logging a
   * meaningless audit entry. `null` is the one legitimate way to clear the
   * override back to the platform default — distinct from, and allowed
   * where `undefined` is not.
   *
   * DTO decorators on SetDepositPercentDto are documentation only — this
   * app has no global ValidationPipe, so they never run; the real
   * enforcement is here, the same way saveBankDetails checks
   * accountNumber's format by hand instead of trusting its DTO.
   */
  async setDepositPercent(
    id: string,
    depositPercentOverride: number | null | undefined,
    actingUser: { userId: string; role: string },
  ): Promise<Operator> {
    if (depositPercentOverride === undefined) {
      throw new BadRequestException(
        'depositPercentOverride is required in the request body (pass null to clear it)',
      );
    }
    // typeof/isFinite first: with no global ValidationPipe, `depositPercentOverride`
    // is whatever the JSON body actually contained — a string, an object, NaN
    // via Infinity arithmetic, anything — not just a number out of range. A
    // bare `< minDepositPercent || > MAX` comparison against a non-number
    // coerces to false on both sides and would let it through to Prisma
    // unvalidated.
    if (depositPercentOverride !== null) {
      const { depositPercent: liveDefaultRaw } =
        await this.platformConfigService.getConfig();
      // Math.max(10, NaN) is NaN, and every comparison against NaN is
      // false — a corrupt/non-finite config read must not silently defeat
      // this floor (same NaN-contagion class as computeDepositAmount's).
      const liveDefault = Number.isFinite(liveDefaultRaw)
        ? liveDefaultRaw
        : MIN_PLATFORM_DEPOSIT_PERCENT;
      const minDepositPercent = Math.max(
        MIN_PLATFORM_DEPOSIT_PERCENT,
        liveDefault,
      );
      if (
        typeof depositPercentOverride !== 'number' ||
        !Number.isFinite(depositPercentOverride) ||
        depositPercentOverride < minDepositPercent ||
        depositPercentOverride > MAX_OPERATOR_DEPOSIT_PERCENT
      ) {
        throw new BadRequestException(
          `depositPercentOverride must be between ${minDepositPercent} and ${MAX_OPERATOR_DEPOSIT_PERCENT}`,
        );
      }
    }

    const { operator, before } = await this.prisma.$transaction(async (tx) => {
      await this.operatorMembershipService.lockActiveMembership(
        tx,
        actingUser,
        id,
      );
      const before = await tx.operator.findUnique({
        where: { id },
        select: { depositPercentOverride: true },
      });
      if (!before) throw new NotFoundException('Operator not found');

      const operator = await tx.operator.update({
        where: { id },
        data: { depositPercentOverride },
      });
      return { operator, before };
    });

    // AuditLogService has no transaction-aware overload, so this write
    // happens just after the transaction commits, not atomically with it —
    // an acceptable gap for a best-effort audit trail (same tradeoff this
    // app already accepts elsewhere; see the AuditLogService module itself
    // for precedent).
    await this.auditLogService.record({
      category: 'deposit_percent_changed',
      message: `Deposit percent changed for operator ${id}`,
      details: {
        targetType: 'Operator',
        targetId: id,
        operatorId: id,
        before:
          before.depositPercentOverride != null
            ? Number(before.depositPercentOverride)
            : null,
        after: depositPercentOverride,
      },
      actorId: actingUser.userId,
    });

    return operator;
  }

  /** Removes the stored payout account. Does not touch the Paystack recipient itself, only our reference to it. */
  async clearBankDetails(
    id: string,
    actingUser: { userId: string; role: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.operatorMembershipService.lockActiveMembership(
        tx,
        actingUser,
        id,
        OPERATOR_ONBOARDING_ROLES,
      );
      const operator = await tx.operator.findUnique({ where: { id } });
      if (!operator) throw new NotFoundException('Operator not found');

      return tx.operator.update({
        where: { id },
        data: {
          bankName: null,
          accountName: null,
          accountNumberLast4: null,
          paystackRecipientCode: null,
        },
      });
    });
  }

  /**
   * Update an operator's business profile.
   * Status, availability and verification are deliberately NOT updatable here —
   * they have their own (admin-guarded) endpoints.
   */
  async updateProfile(
    id: string,
    dto: UpdateOperatorProfileDto,
    actingUser: { userId: string; role: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.operatorMembershipService.lockActiveMembership(
        tx,
        actingUser,
        id,
        OPERATOR_ONBOARDING_ROLES,
      );
      const operator = await tx.operator.findUnique({ where: { id } });
      if (!operator) throw new NotFoundException('Operator not found');

      const data: Record<string, any> = {};

      if (dto.businessName !== undefined) {
        const name = dto.businessName.trim();
        if (!name)
          throw new BadRequestException('Business name cannot be empty');
        data.businessName = name;
      }
      if (dto.contactName !== undefined && dto.contactName.trim())
        data.contactName = dto.contactName.trim();
      if (dto.email !== undefined)
        data.email = dto.email.trim().toLowerCase() || null;
      if (dto.address !== undefined && dto.address.trim())
        data.address = dto.address.trim();

      if (dto.phoneNumber !== undefined && dto.phoneNumber.trim()) {
        const phoneNumber = normalizePhone(dto.phoneNumber);
        if (phoneNumber !== operator.phoneNumber) {
          const existing = await tx.operator.findUnique({
            where: { phoneNumber },
          });
          if (existing && existing.id !== id)
            throw new ConflictException(
              'Phone number already in use by another operator',
            );
          data.phoneNumber = phoneNumber;
        }
      }

      if (dto.latitude !== undefined && dto.longitude !== undefined) {
        const lat = Number(dto.latitude);
        const lng = Number(dto.longitude);
        if (
          Number.isNaN(lat) ||
          Number.isNaN(lng) ||
          Math.abs(lat) > 90 ||
          Math.abs(lng) > 180
        ) {
          throw new BadRequestException('Invalid coordinates');
        }
        data.latitude = lat;
        data.longitude = lng;
      }

      if (dto.type !== undefined) {
        if (!Object.values(OperatorType).includes(dto.type)) {
          throw new BadRequestException(`Invalid operator type: ${dto.type}`);
        }
        data.type = dto.type;
      }

      if (dto.truckClasses !== undefined) {
        const invalid = dto.truckClasses.filter(
          (tc) => !Object.values(TruckClass).includes(tc),
        );
        if (invalid.length > 0) {
          throw new BadRequestException(
            `Invalid truck class(es): ${invalid.join(', ')}`,
          );
        }
        data.truckClasses = dto.truckClasses;
      }

      if (dto.serviceRadius !== undefined) {
        const radius = Number(dto.serviceRadius);
        if (Number.isNaN(radius) || radius < 1 || radius > 100) {
          throw new BadRequestException(
            'Service radius must be between 1 and 100 km',
          );
        }
        data.serviceRadius = radius;
      }

      return tx.operator.update({
        where: { id },
        data,
        include: { members: { include: { user: true } } },
      });
    });
  }

  async updateStatus(id: string, status: OperatorStatus) {
    return this.prisma.operator.update({
      where: { id },
      data: {
        status,
        verifiedAt: status === OperatorStatus.ACTIVE ? new Date() : undefined,
      },
    });
  }

  /**
   * Flags/unflags an operator as a test operator — see
   * findAndRankCandidates's isTest partitioning. Was previously only
   * settable via direct DB access; the controller route this backs is
   * SUPER_ADMIN only, since it changes which customers can reach this
   * operator at all, not just its own state.
   */
  async setIsTest(id: string, isTest: boolean) {
    return this.prisma.operator.update({
      where: { id },
      data: { isTest },
    });
  }

  async setAvailability(
    id: string,
    isAvailable: boolean,
    actingUser: { userId: string; role: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.operatorMembershipService.lockActiveMembership(
        tx,
        actingUser,
        id,
        OPERATOR_ONBOARDING_ROLES,
      );
      return tx.operator.update({
        where: { id },
        data: { isAvailable },
      });
    });
  }

  // ══════════════════════════════════════════════════════
  //  MEMBER MANAGEMENT
  // ══════════════════════════════════════════════════════

  async listMembers(operatorId: string) {
    return this.prisma.operatorMember.findMany({
      where: { operatorId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phoneNumber: true,
            role: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMember(
    operatorId: string,
    data: { userId: string; role: OperatorMemberRole },
    actingUser: { userId: string; role: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.operatorMembershipService.lockActiveMembership(
        tx,
        actingUser,
        operatorId,
      );
      const targetStillActive = await tx.user.updateMany({
        where: { id: data.userId, deletedAt: null },
        data: { updatedAt: new Date() },
      });
      if (targetStillActive.count === 0) {
        throw new BadRequestException(
          'Cannot add this member: account not found or has been deleted.',
        );
      }
      const existing = await tx.operatorMember.findUnique({
        where: { userId_operatorId: { userId: data.userId, operatorId } },
      });
      if (existing) throw new Error('User is already a member');

      return tx.operatorMember.create({
        data: { userId: data.userId, operatorId, role: data.role },
        include: {
          user: {
            select: { id: true, name: true, email: true, phoneNumber: true },
          },
        },
      });
    });
  }

  async removeMember(
    operatorId: string,
    memberId: string,
    actingUser: { userId: string; role: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.operatorMembershipService.lockActiveMembership(
        tx,
        actingUser,
        operatorId,
      );
      const member = await tx.operatorMember.findUnique({
        where: { id: memberId },
      });
      if (!member || member.operatorId !== operatorId)
        throw new Error('Member not found');
      if (member.role === OperatorMemberRole.OWNER)
        throw new Error('Cannot remove the owner');
      return tx.operatorMember.delete({ where: { id: memberId } });
    });
  }

  // ══════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ══════════════════════════════════════════════════════

  private computeStats(
    offers: Array<{
      status: string;
      offeredAt: Date;
      respondedAt: Date | null;
    }>,
  ): OperatorStats {
    const totalOffered = offers.length;
    const totalAccepted = offers.filter((o) => o.status === 'ACCEPTED').length;
    const totalDeclined = offers.filter((o) => o.status === 'DECLINED').length;
    const totalTimedOut = offers.filter((o) => o.status === 'TIMED_OUT').length;

    const acceptanceRate = totalOffered > 0 ? totalAccepted / totalOffered : 0;

    // Average response time only across responded offers (ACCEPTED or DECLINED)
    const respondedOffers = offers.filter(
      (o) =>
        (o.status === 'ACCEPTED' || o.status === 'DECLINED') && o.respondedAt,
    );
    const avgResponseSec =
      respondedOffers.length > 0
        ? respondedOffers.reduce((sum, o) => {
            const ms = o.respondedAt!.getTime() - o.offeredAt.getTime();
            return sum + ms / 1000;
          }, 0) / respondedOffers.length
        : 0;

    return {
      totalOffered,
      totalAccepted,
      totalDeclined,
      totalTimedOut,
      acceptanceRate,
      avgResponseSec,
    };
  }

  private calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }
}
