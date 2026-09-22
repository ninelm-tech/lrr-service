/**
 * The "claim by writing a non-null value to a column that starts null,
 * guarded by a WHERE that checks it's still null" idiom — used throughout
 * this codebase wherever a one-time resource (a phone-verification token,
 * a cancellation settlement decision) must be claimed exactly once under
 * concurrent callers. See AuthService.resetPasswordWithCode/loginWithOtp/
 * registerCustomer, OperatorService.create, and
 * RescueRequestAdminService.resolveCancellationSettlement for the call
 * sites this replaces.
 *
 * Two concurrent claims race on the SAME updateMany: the WHERE clause's
 * null-check means only one can ever match, so only one caller's `count`
 * comes back 1 — the other gets 0 and throws. This IS the atomic claim,
 * not a courtesy check before a separate write — a read-then-write would
 * let two concurrent callers both pass a "still null" check before either
 * commits.
 *
 * `delegate` is whichever Prisma model client the claim runs against (e.g.
 * `tx.phoneVerification` or `this.prisma.rescueRequest`) — this works
 * unmodified inside or outside a transaction, since both expose the same
 * `updateMany`. `errorIfNotClaimed` is thrown as-is, so each call site
 * keeps its own exception class and message (BadRequestException,
 * UnauthorizedException, ...) rather than this helper picking one.
 */
export async function claimOnce<TWhere, TData>(
  delegate: {
    updateMany: (args: {
      where: TWhere;
      data: TData;
    }) => Promise<{ count: number }>;
  },
  args: { where: TWhere; data: TData },
  errorIfNotClaimed: Error,
): Promise<void> {
  const { count } = await delegate.updateMany(args);
  if (count !== 1) {
    throw errorIfNotClaimed;
  }
}
