import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { hasRole, OPERATOR_ADMIN_ROLES } from './domain/operator-staff-roles';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OperatorMembershipService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Operators this User may currently act for — excludes a deleted
   * Operator, AND excludes the case where the acting User themselves has
   * been deleted (their JWT can still be valid for up to 24h, so this
   * must not trust a live session alone).
   */
  async findActiveOperatorIdsForUser(userId: string): Promise<string[]> {
    const memberships = await this.prisma.operatorMember.findMany({
      where: {
        userId,
        operator: { deletedAt: null },
        user: { deletedAt: null },
      },
      select: { operatorId: true },
    });
    return memberships.map((m) => m.operatorId);
  }

  /** Throws unless this User is a member of this specific, non-deleted Operator, and is not themselves deleted. */
  async assertActiveMembership(
    userId: string,
    operatorId: string,
  ): Promise<void> {
    const membership = await this.prisma.operatorMember.findFirst({
      where: {
        userId,
        operatorId,
        operator: { deletedAt: null },
        user: { deletedAt: null },
      },
    });
    if (!membership) {
      throw new ForbiddenException(
        'Not a member of this operator, the operator has been deleted, or this account has been deleted.',
      );
    }
  }

  /**
   * For mutations only — `assertActiveMembership` above is a pre-check,
   * not a guard. Call this ADDITIONALLY, as the first statement inside
   * the same transaction as the mutation that follows (do not use it to
   * replace a role-based authorization check like
   * `OperatorService.assertCanManageOperator` — this re-verifies that
   * neither party has been deleted since that check ran, it does not
   * re-derive the authorization decision itself).
   *
   * `actingUser.role` matters: the controller pre-checks
   * (`assertCanManageOperator`, `assertCanOnboardOperator`,
   * `assertIsMemberOrAdmin`) let platform staff through with no
   * `OperatorMember` row at all — staff acting on an operator are never
   * expected to BE members of that operator's business. This method must
   * recognize the same bypass, or staff who legitimately passed the
   * pre-check would fail here purely for not being a member of a business
   * they were never meant to join. `bypassRoles` defaults to
   * ADMIN/SUPER_ADMIN; only the onboarding mutations (profile, bank
   * details, availability) pass OPERATOR_ONBOARDING_ROLES to include
   * PRODUCT. Both the pre-check and this bypass read the role from the
   * login token, not the database.
   *
   * **Lock order matters and is fixed: User, then Operator, then — only
   * once both locks are held — read the membership row.** An earlier
   * draft read the membership FIRST, before locking anything: that's a
   * plain, unlocked read, racy against a concurrent `removeMember` on the
   * same operator (it could delete that exact row between this read and
   * the writes that follow). Reading it after both locks are held is
   * safe because `addMember`/`removeMember` themselves also lock this
   * same Operator row before touching its memberships (Task 8) — so any
   * concurrent membership change is either already fully committed
   * before we acquire our lock (and this read sees it) or blocked behind
   * our lock entirely (and can't happen until we're done).
   */
  async lockActiveMembership(
    tx: Prisma.TransactionClient,
    actingUser: { userId: string; role: string },
    operatorId: string,
    bypassRoles: readonly UserRole[] = OPERATOR_ADMIN_ROLES,
  ): Promise<void> {
    const userStillActive = await tx.user.updateMany({
      where: { id: actingUser.userId, deletedAt: null },
      data: { updatedAt: new Date() },
    });
    if (userStillActive.count === 0) {
      throw new ForbiddenException('This account has been deleted.');
    }

    const operatorStillActive = await tx.operator.updateMany({
      where: { id: operatorId, deletedAt: null },
      data: { updatedAt: new Date() },
    });
    if (operatorStillActive.count === 0) {
      throw new ForbiddenException('This operator has been deleted.');
    }

    if (!hasRole(actingUser.role, bypassRoles)) {
      const membership = await tx.operatorMember.findFirst({
        where: { userId: actingUser.userId, operatorId },
      });
      if (!membership) {
        throw new ForbiddenException('Not a member of this operator.');
      }
    }
  }
}
