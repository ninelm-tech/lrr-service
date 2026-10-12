import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EDITABLE_STAFF_ROLES, STAFF_ROLES } from './domain/staff-roles';
import { ListStaffOptions } from './dto/list-staff.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { StaffMemberDto } from './dto/staff-member.dto';
import { UpdateStaffResult } from './dto/update-staff-result.dto';
import { normalizeStaffUpdate } from './domain/normalize-staff-update';

const STAFF_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  async list(opts: ListStaffOptions) {
    const where: Prisma.UserWhereInput = {
      role: { in: STAFF_ROLES },
      deletedAt: null,
    };
    if (opts.search) {
      where.OR = [
        { name: { contains: opts.search, mode: 'insensitive' } },
        { email: { contains: opts.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip: (opts.page - 1) * opts.limit,
        take: opts.limit,
        orderBy: { createdAt: 'desc' },
        select: STAFF_SELECT,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: data as StaffMemberDto[],
      meta: {
        page: opts.page,
        limit: opts.limit,
        total,
        pages: Math.ceil(total / opts.limit),
      },
    };
  }

  /**
   * Edit a staff member's name and/or role. Only ADMIN/PRODUCT accounts are
   * editable, never SUPER_ADMIN, and never yourself — so you can't lock
   * yourself out or strip the last super admin by this path.
   *
   * Note the role change takes effect when the person's current session
   * token expires (the role lives in the JWT; login tokens last 7 days).
   */
  async update(
    id: string,
    dto: UpdateStaffDto,
    actorId: string,
  ): Promise<UpdateStaffResult> {
    if (id === actorId) {
      throw new ForbiddenException(
        'You cannot change your own account from here',
      );
    }
    const normalized = normalizeStaffUpdate(dto);
    if (!normalized.ok) throw new BadRequestException(normalized.error);

    const target = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, name: true, deletedAt: true },
    });
    if (
      !target ||
      target.deletedAt ||
      !EDITABLE_STAFF_ROLES.includes(target.role)
    ) {
      throw new NotFoundException('Staff member not found');
    }

    const { data } = normalized;
    const before: UpdateStaffResult['before'] = {};
    const after: UpdateStaffResult['after'] = {};
    if (data.role !== undefined) {
      before.role = target.role;
      after.role = data.role;
    }
    if (data.name !== undefined) {
      before.name = target.name;
      after.name = data.name;
    }

    const user = await this.prisma.user.update({
      where: { id },
      data,
      select: STAFF_SELECT,
    });
    return { user: user, before, after };
  }
}
