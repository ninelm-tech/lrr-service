import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListCustomersOptions } from './dto/list-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomerDto } from './dto/customer.dto';
import { UpdateCustomerResult } from './dto/update-customer-result.dto';
import { normalizeCustomerUpdate } from './domain/normalize-customer-update';

const CUSTOMER_SELECT = {
  id: true,
  email: true,
  phoneNumber: true,
  name: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

const EMAIL_IN_USE = 'That email is already in use by another account';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(opts: ListCustomersOptions) {
    const where: Prisma.UserWhereInput = { role: UserRole.CUSTOMER };
    if (opts.search) {
      where.OR = [
        { name: { contains: opts.search, mode: 'insensitive' } },
        { email: { contains: opts.search, mode: 'insensitive' } },
        { phoneNumber: { contains: opts.search } },
      ];
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip: (opts.page - 1) * opts.limit,
        take: opts.limit,
        orderBy: { createdAt: 'desc' },
        select: CUSTOMER_SELECT,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: data as CustomerDto[],
      meta: {
        page: opts.page,
        limit: opts.limit,
        total,
        pages: Math.ceil(total / opts.limit),
      },
    };
  }

  async update(
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<UpdateCustomerResult> {
    const normalized = normalizeCustomerUpdate(dto);
    if (!normalized.ok) throw new BadRequestException(normalized.error);

    const target = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, deletedAt: true },
    });
    if (!target || target.deletedAt || target.role !== UserRole.CUSTOMER) {
      throw new NotFoundException('Customer not found');
    }

    const { data, changedFields } = normalized;

    if (typeof data.email === 'string') {
      // Case-insensitive: older accounts may hold a mixed-case email.
      const clash = await this.prisma.user.findFirst({
        where: {
          email: { equals: data.email, mode: 'insensitive' },
          id: { not: id },
        },
        select: { id: true },
      });
      if (clash) throw new ConflictException(EMAIL_IN_USE);
    }

    try {
      const customer = await this.prisma.user.update({
        where: { id },
        data,
        select: CUSTOMER_SELECT,
      });
      return { customer: customer, changedFields };
    } catch (err) {
      // Two edits racing past the check above: the unique index decides.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(EMAIL_IN_USE);
      }
      throw err;
    }
  }
}
