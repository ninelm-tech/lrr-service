import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorStatus, OperatorType, UserRole, OperatorMemberRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

interface CreateOperatorDto {
  // User fields
  email: string;
  password: string;
  name?: string;

  // Operator fields
  type?: OperatorType;
  businessName: string;
  contactName: string;
  phoneNumber: string;
  address: string;
  latitude: number;
  longitude: number;
  serviceRadius?: number;
}

@Injectable()
export class OperatorService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Register a new operator (creates User + Operator)
   */
  async create(data: CreateOperatorDto) {
    // Hash password
    const passwordHash = await bcrypt.hash(data.password, 10);

    // Create user and operator in a transaction
    return this.prisma.$transaction(async (tx) => {
      // Create user
      const user = await tx.user.create({
        data: {
          email: data.email,
          passwordHash,
          name: data.name,
          phoneNumber: data.phoneNumber,
          role: UserRole.OPERATOR,
        },
      });

      // Create operator
      const operator = await tx.operator.create({
        data: {
          type: data.type ?? OperatorType.TOW_TRUCK,
          businessName: data.businessName,
          contactName: data.contactName,
          phoneNumber: data.phoneNumber,
          email: data.email,
          address: data.address,
          latitude: data.latitude,
          longitude: data.longitude,
          serviceRadius: data.serviceRadius ?? 10,
          status: OperatorStatus.PENDING,
        },
      });

      // Create OperatorMember (OWNER)
      const operatorMember = await tx.operatorMember.create({
        data: {
          userId: user.id,
          operatorId: operator.id,
          role: OperatorMemberRole.OWNER,
        },
      });

      return { user, operator, operatorMember };
    });
  }

  /**
   * Find the nearest available operator to a given location
   */
  async findNearestAvailable(
    latitude: number,
    longitude: number,
    type?: OperatorType,
  ) {
    // Get all active and available operators
    const operators = await this.prisma.operator.findMany({
      where: {
        status: OperatorStatus.ACTIVE,
        isAvailable: true,
        ...(type && { type }),
      },
      include: {
        members: { include: { user: true } },
      },
    });

    if (operators.length === 0) {
      return null;
    }

    // Calculate distance for each operator and find the nearest
    let nearestOperator = null;
    let shortestDistance = Infinity;

    for (const operator of operators) {
      const distance = this.calculateDistance(
        latitude,
        longitude,
        Number(operator.latitude),
        Number(operator.longitude),
      );

      // Check if within service radius
      if (distance <= operator.serviceRadius && distance < shortestDistance) {
        shortestDistance = distance;
        nearestOperator = { ...operator, distance };
      }
    }

    return nearestOperator;
  }

  /**
   * Get all operators
   */
  async findAll() {
    return this.prisma.operator.findMany({
      include: { members: { include: { user: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get an operator by ID
   */
  async findById(id: string) {
    return this.prisma.operator.findUnique({
      where: { id },
      include: { members: { include: { user: true } } },
    });
  }

  /**
   * Get an operator by user ID
   */
  async findByUserId(userId: string) {
    // Find the first operator where the user is a member
    const membership = await this.prisma.operatorMember.findFirst({
      where: { userId },
      include: { operator: { include: { members: { include: { user: true } } } } },
    });
    return membership?.operator || null;
  }

  /**
   * Update operator status (for admin approval)
   */
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
   * Toggle operator availability
   */
  async setAvailability(id: string, isAvailable: boolean) {
    return this.prisma.operator.update({
      where: { id },
      data: { isAvailable },
    });
  }

  /**
   * Calculate distance between two points using Haversine formula
   * Returns distance in kilometers
   */
  private calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const R = 6371; // Earth's radius in km
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) *
        Math.cos(this.toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }
}
