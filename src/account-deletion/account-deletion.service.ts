import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';
import {
  OperatorMemberRole,
  OperatorStatus,
  PaymentStatus,
  PaymentType,
  RescueRequestStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';

const ACTIVE_OR_PENDING_REQUEST_FILTER = {
  OR: [
    {
      status: {
        notIn: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED],
      },
    },
    { disputed: true, disputeResolvedAt: null },
    {
      payments: {
        some: {
          type: {
            in: [PaymentType.DEPOSIT, PaymentType.BALANCE, PaymentType.REFUND],
          },
          status: {
            in: [
              PaymentStatus.PENDING,
              PaymentStatus.SUBMITTED,
              PaymentStatus.BLOCKED,
            ],
          },
        },
      },
    },
  ],
};

@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
  ) {}

  async deleteUser(id: string, actorId: string): Promise<void> {
    const s3KeysToDelete = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.user.updateMany({
        where: {
          id,
          deletedAt: null,
          role: { in: [UserRole.CUSTOMER, UserRole.OPERATOR] },
        },
        data: { updatedAt: new Date() },
      });
      if (locked.count === 0) {
        const user = await tx.user.findUnique({
          where: { id },
          select: { role: true, deletedAt: true },
        });
        if (!user) throw new NotFoundException('User not found');
        if (user.deletedAt) {
          throw new BadRequestException(
            'This account has already been deleted',
          );
        }
        throw new BadRequestException(
          'Only customer and operator accounts can be deleted through this endpoint',
        );
      }

      const blockingRequests = await tx.rescueRequest.findMany({
        where: { customerId: id, ...ACTIVE_OR_PENDING_REQUEST_FILTER },
        select: { id: true },
      });
      if (blockingRequests.length > 0) {
        throw new BadRequestException(
          `Cannot delete: ${blockingRequests.length} request(s) still active, with an unresolved dispute, or with a payment still processing`,
        );
      }

      const ownedOperators = await tx.operatorMember.findMany({
        where: {
          userId: id,
          role: OperatorMemberRole.OWNER,
          operator: { deletedAt: null },
        },
        select: { operatorId: true },
      });
      if (ownedOperators.length > 0) {
        throw new BadRequestException(
          `Cannot delete: this user owns ${ownedOperators.length} active operator business(es) — transfer ownership or delete the business first`,
        );
      }

      await tx.user.update({
        where: { id },
        data: {
          name: 'Deleted User',
          email: null,
          phoneNumber: null,
          passwordHash: null,
          paystackCustomerCode: null,
          paystackCustomerEmail: null,
          deletedAt: new Date(),
        },
      });

      const media = await tx.requestMedia.findMany({
        where: {
          rescueRequest: { customerId: id },
          uploadedByRole: UserRole.CUSTOMER,
        },
        select: { id: true, s3Key: true },
      });
      if (media.length > 0) {
        await tx.pendingMediaDeletion.createMany({
          data: media.map(({ s3Key }) => ({ s3Key })),
          skipDuplicates: true,
        });
      }
      await tx.requestMedia.deleteMany({
        where: { id: { in: media.map(({ id: mediaId }) => mediaId) } },
      });
      await tx.rescueRequest.updateMany({
        where: { customerId: id },
        data: {
          latitude: null,
          longitude: null,
          destination: null,
          customerDisputeStatement: null,
          operatorDisputeStatement: null,
        },
      });

      await tx.auditLog.create({
        data: {
          category: 'account_deleted',
          message: `User ${id} deleted`,
          actorId,
          details: { targetType: 'User', targetId: id },
        },
      });

      return media.map(({ s3Key }) => s3Key);
    });

    for (const key of s3KeysToDelete) {
      try {
        await this.s3Service.deleteObject(key);
        await this.prisma.pendingMediaDeletion.delete({
          where: { s3Key: key },
        });
      } catch (error) {
        console.error(
          `Failed to delete media object ${key} after deleting user ${id}:`,
          error,
        );
        Sentry.captureException(error, { extra: { s3Key: key, userId: id } });
      }
    }
  }

  async deleteOperator(id: string, actorId: string): Promise<void> {
    const s3KeysToDelete = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.operator.updateMany({
        where: { id, deletedAt: null },
        data: { updatedAt: new Date() },
      });
      if (locked.count === 0) {
        const operator = await tx.operator.findUnique({
          where: { id },
          select: { deletedAt: true },
        });
        if (!operator) throw new NotFoundException('Operator not found');
        throw new BadRequestException('This operator has already been deleted');
      }

      const blockingRequests = await tx.rescueRequest.findMany({
        where: {
          assignedOperatorId: id,
          OR: [
            {
              status: {
                notIn: [
                  RescueRequestStatus.COMPLETED,
                  RescueRequestStatus.CANCELLED,
                ],
              },
            },
            { disputed: true, disputeResolvedAt: null },
          ],
        },
        select: { id: true },
      });
      if (blockingRequests.length > 0) {
        throw new BadRequestException(
          `Cannot delete: ${blockingRequests.length} request(s) still active or disputed`,
        );
      }

      const unsettledPayouts = await tx.rescueRequest.findMany({
        where: {
          assignedOperatorId: id,
          status: RescueRequestStatus.COMPLETED,
          payments: {
            none: {
              type: PaymentType.PAYOUT,
              status: PaymentStatus.SUCCEEDED,
            },
          },
        },
        select: { id: true },
      });
      if (unsettledPayouts.length > 0) {
        throw new BadRequestException(
          `Cannot delete: ${unsettledPayouts.length} completed request(s) still have an unsettled payout`,
        );
      }

      // A CANCELLED request with a paid deposit and no cancellation
      // settlement yet still owes this operator their share of that
      // deposit (see RescueRequestAdminService.resolveCancellationSettlement)
      // — deleting nulls paystackRecipientCode below, which can never be
      // restored, permanently stranding that payout. Distinct from the
      // "active" check above, which deliberately excludes CANCELLED.
      const unsettledCancellations = await tx.rescueRequest.findMany({
        where: {
          assignedOperatorId: id,
          status: RescueRequestStatus.CANCELLED,
          cancellationSettledAt: null,
          payments: {
            some: {
              type: PaymentType.DEPOSIT,
              status: PaymentStatus.SUCCEEDED,
            },
          },
        },
        select: { id: true },
      });
      if (unsettledCancellations.length > 0) {
        throw new BadRequestException(
          `Cannot delete: ${unsettledCancellations.length} cancelled request(s) still have an unsettled cancellation payout`,
        );
      }

      await tx.operator.update({
        where: { id },
        data: {
          businessName: 'Deleted Operator',
          contactName: 'Deleted Operator',
          phoneNumber: null,
          email: null,
          address: '',
          bankName: null,
          accountName: null,
          accountNumberLast4: null,
          paystackRecipientCode: null,
          status: OperatorStatus.SUSPENDED,
          isAvailable: false,
          deletedAt: new Date(),
        },
      });

      await tx.rescueRequest.updateMany({
        where: { assignedOperatorId: id },
        data: {
          operatorDisputeStatement: null,
          customerDisputeStatement: null,
        },
      });

      const media = await tx.requestMedia.findMany({
        where: {
          rescueRequest: { assignedOperatorId: id },
          uploadedByRole: UserRole.OPERATOR,
        },
        select: { id: true, s3Key: true },
      });
      if (media.length > 0) {
        await tx.pendingMediaDeletion.createMany({
          data: media.map(({ s3Key }) => ({ s3Key })),
          skipDuplicates: true,
        });
      }
      await tx.requestMedia.deleteMany({
        where: { id: { in: media.map(({ id: mediaId }) => mediaId) } },
      });

      await tx.auditLog.create({
        data: {
          category: 'account_deleted',
          message: `Operator ${id} deleted`,
          actorId,
          details: { targetType: 'Operator', targetId: id },
        },
      });

      return media.map(({ s3Key }) => s3Key);
    });

    for (const key of s3KeysToDelete) {
      try {
        await this.s3Service.deleteObject(key);
        await this.prisma.pendingMediaDeletion.delete({
          where: { s3Key: key },
        });
      } catch (error) {
        console.error(
          `Failed to delete media object ${key} after deleting operator ${id}:`,
          error,
        );
        Sentry.captureException(error, {
          extra: { s3Key: key, operatorId: id },
        });
      }
    }
  }
}
