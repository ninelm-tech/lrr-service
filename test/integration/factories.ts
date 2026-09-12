import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Seed helpers for integration tests. Each takes only what the test cares
 * about and fills the rest with valid defaults, so a test reads as the
 * scenario it describes rather than a wall of required columns.
 */

let counter = 0;
const unique = () => `${Date.now()}${(counter += 1)}`.slice(-10);

export async function truncateAll(prisma: PrismaService): Promise<void> {
  // One statement so FK order doesn't matter; RESTART IDENTITY keeps any
  // serial columns predictable between tests.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Rating", "Payout", "RequestMedia", "DispatchOffer",
      "RescueRequest", "WhatsAppSession", "OperatorMember",
      "Operator", "User"
    RESTART IDENTITY CASCADE
  `);
}

export async function createCustomer(prisma: PrismaService, phoneNumber?: string) {
  return prisma.user.create({
    data: { phoneNumber: phoneNumber ?? `+234800${unique().slice(-7)}`, role: 'CUSTOMER' },
  });
}

export async function createOperator(prisma: PrismaService, phoneNumber?: string) {
  return prisma.operator.create({
    data: {
      businessName: 'Swift Towing',
      contactName: 'Ada',
      phoneNumber: phoneNumber ?? `+234901${unique().slice(-7)}`,
      address: '14 Admiralty Way, Lekki',
      latitude: 6.4281,
      longitude: 3.4219,
      status: 'ACTIVE',
      isAvailable: true,
    },
  });
}

export async function createRequest(
  prisma: PrismaService,
  customerId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.rescueRequest.create({
    data: {
      customerId,
      status: 'DISPATCHING',
      latitude: 6.4281,
      longitude: 3.4219,
      vehicleType: 'SEDAN',
      destination: 'Ikeja',
      ...overrides,
    },
  });
}

/** Defaults to a live offer — PENDING with its window still open. */
export async function createOffer(
  prisma: PrismaService,
  rescueRequestId: string,
  operatorId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.dispatchOffer.create({
    data: {
      rescueRequestId,
      operatorId,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      batchId: `batch-${unique()}`,
      ...overrides,
    },
  });
}

export async function createSession(
  prisma: PrismaService,
  userId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.whatsAppSession.create({
    data: { userId, state: 'IDLE', offeredOperatorIds: '[]', ...overrides },
  });
}
