/**
 * The parts of a rescue request that sending a balance payment link needs.
 *
 * Structural rather than the full Prisma model, because the two callers pass
 * different things: markJobCompleted passes a loaded row, and resolveDispute
 * spreads one with an overridden balanceAmount. Naming the fields is what
 * lets the compiler check those spreads — the `any` this replaced silently
 * accepted a row with no `customer` relation loaded.
 */
export interface BalancePaymentTarget {
  id: string;
  customerId: string;
  balanceAmount: number | null;
  customer: {
    phoneNumber: string | null;
    email: string | null;
  };
}
