import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorStatus, OperatorType, UserRole, OperatorMemberRole, TruckClass } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { normalizePhone } from '../common/phone.util';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { UpdateOperatorProfileDto } from './dto/update-operator-profile.dto';
import { SaveBankDetailsDto } from './dto/save-bank-details.dto';
import { PaystackService } from '../integrations/paystack/paystack.service';

// ── Scoring weights ────────────────────────────────────────────────────────────
// Distance is the dominant factor but reliability and speed matter.
// New operators (no history) receive neutral scores on the last two factors
// so they aren't unfairly penalised before they've had a chance to prove themselves.
const WEIGHT_DISTANCE        = 0.50;
const WEIGHT_ACCEPTANCE_RATE = 0.30;
const WEIGHT_RESPONSE_SPEED  = 0.20;

// Look-back window for computing operator stats
const STATS_LOOKBACK_DAYS = 30;

export interface ScoredOperator {
  id: string;
  businessName: string;
  phoneNumber: string;
  latitude: number;
  longitude: number;
  serviceRadius: number;
  distance: number;          // km from the rescue location
  score: number;             // composite 0–1, higher = better
  stats: OperatorStats;
}

export interface OperatorStats {
  totalOffered:      number;
  totalAccepted:     number;
  totalDeclined:     number;
  totalTimedOut:     number;
  acceptanceRate:    number;   // 0–1
  avgResponseSec:    number;   // seconds; null-safe (0 for new operators)
}

// computeStats() (used by dispatch ranking, which deliberately excludes
// ratings from the composite score) returns plain OperatorStats. The
// admin-facing stats endpoints attach ratings on top of that.
export interface OperatorStatsWithRating extends OperatorStats {
  averageRating:     number | null; // ratings RECEIVED from motorists only; null when zero ratings
  ratingCount:       number;
}

// ──────────────────────────────────────────────────────────────────────────────

@Injectable()
export class OperatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
  ) {}

  // ══════════════════════════════════════════════════════
  //  REGISTRATION
  // ══════════════════════════════════════════════════════

  async create(data: CreateOperatorDto) {
    if (!Array.isArray(data.truckClasses) || data.truckClasses.length === 0) {
      throw new BadRequestException('truckClasses is required and must be a non-empty array');
    }
    const invalidTruckClasses = data.truckClasses.filter((tc) => !Object.values(TruckClass).includes(tc));
    if (invalidTruckClasses.length > 0) {
      throw new BadRequestException(`Invalid truck class(es): ${invalidTruckClasses.join(', ')}`);
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email:        data.email,
          passwordHash,
          name:         data.name,
          phoneNumber:  data.phoneNumber,
          role:         UserRole.OPERATOR,
        },
      });

      const operator = await tx.operator.create({
        data: {
          type:          data.type ?? OperatorType.TOW_TRUCK,
          truckClasses:  data.truckClasses,
          businessName:  data.businessName,
          contactName:   data.contactName,
          phoneNumber:   data.phoneNumber,
          email:         data.email,
          address:       data.address,
          latitude:      data.latitude,
          longitude:     data.longitude,
          serviceRadius: data.serviceRadius ?? 10,
          status:        OperatorStatus.PENDING,
        },
      });

      const operatorMember = await tx.operatorMember.create({
        data: {
          userId:     user.id,
          operatorId: operator.id,
          role:       OperatorMemberRole.OWNER,
        },
      });

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
   */
  async findAndRankCandidates(
    latitude: number,
    longitude: number,
    excludeIds: string[] = [],
    extraRadiusKm: number = 0,
    type?: OperatorType,
    truckClasses?: TruckClass[],
  ): Promise<ScoredOperator[]> {
    const operators = await this.prisma.operator.findMany({
      where: {
        status:      OperatorStatus.ACTIVE,
        isAvailable: true,
        ...(excludeIds.length > 0 && { id: { notIn: excludeIds } }),
        ...(type && { type }),
        ...(truckClasses && truckClasses.length > 0 && {
          truckClasses: { hasSome: truckClasses },
        }),
      },
    });

    if (operators.length === 0) return [];

    // Filter to within effective radius and compute distances
    const inRange: Array<{ op: typeof operators[0]; distance: number }> = [];
    for (const op of operators) {
      const distance = this.calculateDistance(
        latitude, longitude,
        Number(op.latitude), Number(op.longitude),
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
        offeredAt:  { gte: since },
      },
      select: {
        operatorId:  true,
        status:      true,
        offeredAt:   true,
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
      const speedScore = stats.totalAccepted === 0
        ? 0.5                                                    // neutral for new operators
        : Math.max(0, 1 - stats.avgResponseSec / MAX_RESPONSE_SEC);

      const score =
        distanceScore   * WEIGHT_DISTANCE +
        acceptanceScore * WEIGHT_ACCEPTANCE_RATE +
        speedScore      * WEIGHT_RESPONSE_SPEED;

      return {
        id:            op.id,
        businessName:  op.businessName,
        phoneNumber:   op.phoneNumber,
        latitude:      Number(op.latitude),
        longitude:     Number(op.longitude),
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
    const ranked = await this.findAndRankCandidates(latitude, longitude, excludeIds, extraRadiusKm, type);
    return ranked[0] ?? null;
  }

  async findNearestAvailable(latitude: number, longitude: number, type?: OperatorType) {
    return this.findNearestAvailableExcluding(latitude, longitude, [], 0, type);
  }

  // ══════════════════════════════════════════════════════
  //  OPERATOR STATS (admin dashboard)
  // ══════════════════════════════════════════════════════

  /**
   * Compute performance stats for a single operator.
   * Admin dashboard can call this per-operator, or aggregate across all.
   */
  async getOperatorStats(operatorId: string, days = 30): Promise<OperatorStatsWithRating> {
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
  async getAllOperatorStats(days = 30): Promise<Array<{
    operatorId: string;
    businessName: string;
    phoneNumber: string;
    status: string;
    stats: OperatorStatsWithRating;
  }>> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [operators, allOffers, ratingGroups] = await Promise.all([
      this.prisma.operator.findMany({
        select: { id: true, businessName: true, phoneNumber: true, status: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.dispatchOffer.findMany({
        where: { offeredAt: { gte: since } },
        select: { operatorId: true, status: true, offeredAt: true, respondedAt: true },
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

    const ratingsByOperator = new Map<string, { _avg: { score: number | null }; _count: { score: number } }>();
    for (const group of ratingGroups) {
      ratingsByOperator.set(group.operatorId, { _avg: group._avg, _count: group._count });
    }

    return operators.map((op) => {
      const ratingAgg = ratingsByOperator.get(op.id);
      return {
        operatorId:   op.id,
        businessName: op.businessName,
        phoneNumber:  op.phoneNumber,
        status:       op.status,
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
      where: { userId },
      include: { operator: { include: { members: { include: { user: true } } } } },
    });
    return membership?.operator || null;
  }

  /**
   * Authorization helper: can this user manage the given operator?
   * Admins always can; otherwise the user must be an OWNER or MANAGER member.
   */
  async assertCanManageOperator(user: { userId: string; role: string }, operatorId: string): Promise<void> {
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) return;

    const membership = await this.prisma.operatorMember.findUnique({
      where: { userId_operatorId: { userId: user.userId, operatorId } },
    });
    const allowed: OperatorMemberRole[] = [OperatorMemberRole.OWNER, OperatorMemberRole.MANAGER];
    if (!membership || !allowed.includes(membership.role)) {
      throw new ForbiddenException('You do not have permission to manage this operator');
    }
  }

  /** Like assertCanManageOperator but any membership counts (e.g. availability toggle). */
  async assertIsMemberOrAdmin(user: { userId: string; role: string }, operatorId: string): Promise<void> {
    if (user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN) return;

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
  async saveBankDetails(id: string, dto: SaveBankDetailsDto) {
    const operator = await this.prisma.operator.findUnique({ where: { id } });
    if (!operator) throw new NotFoundException('Operator not found');

    const { accountName } = await this.paystackService.resolveAccountNumber(dto.accountNumber, dto.bankCode);
    const { recipientCode } = await this.paystackService.createTransferRecipient({
      accountNumber: dto.accountNumber,
      bankCode: dto.bankCode,
      accountName,
      businessName: operator.businessName,
    });

    return this.prisma.operator.update({
      where: { id },
      data: {
        bankName: dto.bankName,
        accountName,
        accountNumberLast4: dto.accountNumber.slice(-4),
        paystackRecipientCode: recipientCode,
      },
    });
  }

  /**
   * Update an operator's business profile.
   * Status, availability and verification are deliberately NOT updatable here —
   * they have their own (admin-guarded) endpoints.
   */
  async updateProfile(id: string, dto: UpdateOperatorProfileDto) {
    const operator = await this.prisma.operator.findUnique({ where: { id } });
    if (!operator) throw new NotFoundException('Operator not found');

    const data: Record<string, any> = {};

    if (dto.businessName !== undefined) {
      const name = dto.businessName.trim();
      if (!name) throw new BadRequestException('Business name cannot be empty');
      data.businessName = name;
    }
    if (dto.contactName !== undefined && dto.contactName.trim()) data.contactName = dto.contactName.trim();
    if (dto.email !== undefined) data.email = dto.email.trim().toLowerCase() || null;
    if (dto.address !== undefined && dto.address.trim()) data.address = dto.address.trim();

    if (dto.phoneNumber !== undefined && dto.phoneNumber.trim()) {
      const phoneNumber = normalizePhone(dto.phoneNumber);
      if (phoneNumber !== operator.phoneNumber) {
        const existing = await this.prisma.operator.findUnique({ where: { phoneNumber } });
        if (existing && existing.id !== id) throw new ConflictException('Phone number already in use by another operator');
        data.phoneNumber = phoneNumber;
      }
    }

    if (dto.latitude !== undefined && dto.longitude !== undefined) {
      const lat = Number(dto.latitude);
      const lng = Number(dto.longitude);
      if (Number.isNaN(lat) || Number.isNaN(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
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
      const invalid = dto.truckClasses.filter((tc) => !Object.values(TruckClass).includes(tc));
      if (invalid.length > 0) {
        throw new BadRequestException(`Invalid truck class(es): ${invalid.join(', ')}`);
      }
      data.truckClasses = dto.truckClasses;
    }

    if (dto.serviceRadius !== undefined) {
      const radius = Number(dto.serviceRadius);
      if (Number.isNaN(radius) || radius < 1 || radius > 100) {
        throw new BadRequestException('Service radius must be between 1 and 100 km');
      }
      data.serviceRadius = radius;
    }

    return this.prisma.operator.update({
      where: { id },
      data,
      include: { members: { include: { user: true } } },
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

  async setAvailability(id: string, isAvailable: boolean) {
    return this.prisma.operator.update({
      where: { id },
      data: { isAvailable },
    });
  }

  // ══════════════════════════════════════════════════════
  //  MEMBER MANAGEMENT
  // ══════════════════════════════════════════════════════

  async listMembers(operatorId: string) {
    return this.prisma.operatorMember.findMany({
      where: { operatorId },
      include: { user: { select: { id: true, name: true, email: true, phoneNumber: true, role: true, createdAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMember(operatorId: string, data: { userId: string; role: OperatorMemberRole }) {
    // Validate user exists
    const user = await this.prisma.user.findUnique({ where: { id: data.userId } });
    if (!user) throw new Error('User not found');
    // Check not already a member
    const existing = await this.prisma.operatorMember.findUnique({
      where: { userId_operatorId: { userId: data.userId, operatorId } },
    });
    if (existing) throw new Error('User is already a member');

    return this.prisma.operatorMember.create({
      data: { userId: data.userId, operatorId, role: data.role },
      include: { user: { select: { id: true, name: true, email: true, phoneNumber: true } } },
    });
  }

  async removeMember(operatorId: string, memberId: string) {
    const member = await this.prisma.operatorMember.findUnique({ where: { id: memberId } });
    if (!member || member.operatorId !== operatorId) throw new Error('Member not found');
    if (member.role === OperatorMemberRole.OWNER) throw new Error('Cannot remove the owner');
    return this.prisma.operatorMember.delete({ where: { id: memberId } });
  }

  // ══════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ══════════════════════════════════════════════════════

  private computeStats(
    offers: Array<{ status: string; offeredAt: Date; respondedAt: Date | null }>,
  ): OperatorStats {
    const totalOffered  = offers.length;
    const totalAccepted = offers.filter((o) => o.status === 'ACCEPTED').length;
    const totalDeclined = offers.filter((o) => o.status === 'DECLINED').length;
    const totalTimedOut = offers.filter((o) => o.status === 'TIMED_OUT').length;

    const acceptanceRate = totalOffered > 0 ? totalAccepted / totalOffered : 0;

    // Average response time only across responded offers (ACCEPTED or DECLINED)
    const respondedOffers = offers.filter(
      (o) => (o.status === 'ACCEPTED' || o.status === 'DECLINED') && o.respondedAt,
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

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }
}
