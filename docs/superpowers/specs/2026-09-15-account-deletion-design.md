# Account Deletion — Design

**Status:** Approved by user 2026-09-15.

**Goal:** Let a SUPER_ADMIN delete a customer or operator account — anonymizing
their identity data immediately — without breaking Nigeria's financial
recordkeeping duty on the payment history that account leaves behind.

**Not legal advice.** The NDPA/CBN summary below is general background used
to justify the design's shape, not a 
 sign-off. Confirm with
counsel before this ships, same caveat already given for the privacy-policy
discussion earlier.

## Background

No account-deletion capability exists in this codebase today.

Two Nigerian legal regimes pull in opposite directions on the same data:

- **NDPA 2023** (enforced by the NDPC): storage-limitation principle (don't
  keep personal data longer than necessary) and a general right to erasure.
- **CBN/AML-CFT rules**: financial institutions and payment intermediaries
  must retain transaction records for a minimum period, commonly cited as
  ~5 years.

Deleting a `User` outright is also not mechanically safe regardless of the
legal question: `RescueRequest.customerId` is a required field, so a hard
delete would cascade through every request that customer ever made, and with
it every `Payment` tied to those requests — destroying the exact financial
records CBN/AML requires. This is why the model below **anonymizes, never
hard-deletes**, and defers actual row deletion to a scheduled purge once the
retention window has passed.

Schema check (this spec is built on it): `Payment`, `Rating`,
`WhatsAppSession`, `OperatorMember`, and `DispatchOffer` carry no
denormalized name/phone/email — only `User` and `Operator` hold identifying
fields directly. **`RescueRequest` is a different case, corrected from an
earlier draft of this spec:** no name/phone/email there either, but its
`latitude`/`longitude`/`destination` pin a real-world location (often a home
or workplace), its `customerDisputeStatement`/`operatorDisputeStatement` are
free text that can name people, and its `RequestMedia` rows point to actual
photos/videos in S3 that can show a face or a house. None of that is
financial-record data, so the CBN/AML retention argument doesn't reach it —
it must be scrubbed at deletion time, not left behind. Section 2 covers
exactly what.

## The model

### 1. Data model

```prisma
model User {
  // ...existing fields...
  deletedAt DateTime?
}

model Operator {
  // ...existing fields...
  deletedAt DateTime?
}

// Durable outbox for S3 objects deleted from RequestMedia's DB rows —
// see Section 2a. Kept until a confirmed S3 delete removes the row.
model PendingMediaDeletion {
  id        String   @id @default(cuid())
  s3Key     String   @unique
  createdAt DateTime @default(now())
}
```

`deletedAt: null` means active; any non-null value means deleted. One hand-
written, additive migration (matching this repo's existing migration
convention — Prisma refuses destructive changes non-interactively, and this
isn't destructive anyway):

```sql
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "Operator" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE TABLE "PendingMediaDeletion" (
    "id" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingMediaDeletion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PendingMediaDeletion_s3Key_key" ON "PendingMediaDeletion"("s3Key");
```

No index needed on `deletedAt` itself — deletion is a rare, admin-triggered
action, not a hot query path. The purge job (Section 4) scans on `deletedAt`
infrequently enough that a sequential scan is fine at this table size;
revisit only if that stops being true.

### 2. Delete flow

Two new endpoints on a new `AccountDeletionController`
(`src/account-deletion/`, following this repo's per-module `dto/`/`domain/`
layout), both `@Roles(UserRole.SUPER_ADMIN)`:

```
DELETE /users/:id
DELETE /operators/:id
```

**Corrected from an earlier draft of this spec, on three points raised in
review:**

1. **The guard must not be a separate read before the write.** A plain
   "check, then update" leaves a window where a new `RescueRequest` or
   `Payment` can be created between the two — by a customer messaging
   WhatsApp, a webhook, anything — and the anonymizing write would then
   proceed against state that's no longer true. This codebase's answer to
   exactly this shape of problem is already established everywhere else
   (payout retry, refund, dispute resolution): **the guard has to be the
   query** — a single conditional `updateMany` whose `WHERE` encodes the
   guard, so Postgres evaluates eligibility and writes atomically. An
   earlier draft of this spec called the two-step version acceptable on the
   reasoning that "a SUPER_ADMIN clicking delete twice" is the only race —
   that reasoning was wrong; the real race is with unrelated processes, not
   with the admin's own second click.
2. **Deletion and its audit entry must commit together.** `AuditLogService
   .record()` deliberately never throws, everywhere else in this codebase,
   so that a logging hiccup can never break the action being audited
   (settings updates, refunds, payout retries). That tradeoff is right for
   those — frequent, lower-stakes, and Sentry-alerted on failure. It's wrong
   here: an irreversible identity anonymization must never commit without
   the record of who did it and why, so this is the one call site that
   writes to `AuditLog` directly inside the same transaction as the
   anonymizing update, instead of going through `AuditLogService.record()`.
   If the audit insert fails, the whole transaction — including the
   anonymization — rolls back.
3. **`DELETE /users/:id` must reject staff/admin targets.** The `User`
   table holds every role, not just customers and operators, and nothing in
   an earlier draft stopped this endpoint from anonymizing an `ADMIN` or
   `SUPER_ADMIN` row. That was never the ask — this feature deletes
   customers and operator staff, not internal accounts — and it matters
   for the JWT-revocation limitation in Section 3: a lingering session on a
   deleted *customer* login is a much smaller risk than a lingering session
   on a deleted *admin* login. The guard now rejects any role other than
   `CUSTOMER`/`OPERATOR` outright.

**`AccountDeletionService.deleteUser`:**

```ts
async deleteUser(id: string, actorId: string): Promise<void> {
  const s3KeysToDelete = await this.prisma.$transaction(async (tx) => {
    const claimed = await tx.user.updateMany({
      where: {
        id,
        deletedAt: null,
        role: { in: [UserRole.CUSTOMER, UserRole.OPERATOR] },
        rescueRequests: {
          none: {
            OR: [
              { status: { notIn: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] } },
              { disputed: true, disputeResolvedAt: null },
              // A request can be CANCELLED (satisfying the line above) while
              // its REFUND payment is still stuck — e.g. BLOCKED on
              // NEEDS_CUSTOMER_DETAILS, waiting on bank info from exactly
              // the person about to be anonymized. Terminal request status
              // alone doesn't mean the money side is settled.
              { payments: { some: { status: { in: [PaymentStatus.PENDING, PaymentStatus.SUBMITTED, PaymentStatus.BLOCKED] } } } },
            ],
          },
        },
      },
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
    if (claimed.count === 0) {
      await this.explainUserDeleteFailure(tx, id); // always throws — see below
    }

    // Scrub what's identifying on this customer's own requests — none of
    // it is financial-record data (Background). The guard above already
    // requires every request to be COMPLETED/CANCELLED with no open
    // dispute, so nobody has a live, ongoing need for this any more.
    const media = await tx.requestMedia.findMany({
      where: { rescueRequest: { customerId: id } },
      select: { id: true, s3Key: true },
    });
    // Durable outbox entry BEFORE the row disappears (Section 2a) — this
    // is the only record of which S3 objects still need deleting once the
    // RequestMedia row that named them is gone, so it must land in the
    // same transaction as that delete, never after it.
    if (media.length > 0) {
      await tx.pendingMediaDeletion.createMany({
        data: media.map((m) => ({ s3Key: m.s3Key })),
        skipDuplicates: true,
      });
    }
    await tx.requestMedia.deleteMany({
      where: { id: { in: media.map((m) => m.id) } },
    });
    await tx.rescueRequest.updateMany({
      where: { customerId: id },
      data: {
        latitude: null,
        longitude: null,
        destination: null,
        // Both statements — not just the customer's own. Free text written
        // BY the operator ABOUT this customer can still name/identify them
        // (Background); scrubbing is about whose identity is protected,
        // not whose words these are.
        customerDisputeStatement: null,
        operatorDisputeStatement: null,
      },
    });

    // Written directly here, not via AuditLogService.record() — see point
    // 2 above. A failure here must roll back the anonymization.
    await tx.auditLog.create({
      data: {
        category: 'account_deleted',
        message: `User ${id} deleted`,
        actorId,
        details: { targetType: 'User', targetId: id },
      },
    });

    return media.map((m) => m.s3Key);
  });

  // Outside the transaction — S3 isn't transactional with Postgres. A
  // failure here leaves the durable PendingMediaDeletion row in place
  // (Section 2a) rather than just an alert — the retry check picks it up
  // later, so nothing is only ever recorded in Sentry.
  for (const key of s3KeysToDelete) {
    try {
      await this.s3Service.deleteObject(key);
      await this.prisma.pendingMediaDeletion.delete({ where: { s3Key: key } });
    } catch (err) {
      console.error(`Failed to delete media object ${key} after deleting user ${id}:`, err);
      Sentry.captureException(err, { extra: { s3Key: key, userId: id } });
      // Deliberately not removed — stays for RetryMediaDeletionCheck (Section 4).
    }
  }
}

/** Always throws — a courtesy re-read purely to build a precise error message, same shape as every other guard in this codebase (e.g. `refundDeposit`'s comment on why its own pre-check isn't the real guard). */
private async explainUserDeleteFailure(tx: Prisma.TransactionClient, id: string): Promise<never> {
  const user = await tx.user.findUnique({
    where: { id },
    include: {
      rescueRequests: {
        where: {
          OR: [
            { status: { notIn: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] } },
            { disputed: true, disputeResolvedAt: null },
            { payments: { some: { status: { in: [PaymentStatus.PENDING, PaymentStatus.SUBMITTED, PaymentStatus.BLOCKED] } } } },
          ],
        },
        select: { id: true },
      },
    },
  });
  if (!user) throw new NotFoundException('User not found');
  if (user.deletedAt) throw new BadRequestException('This account has already been deleted');
  if (![UserRole.CUSTOMER, UserRole.OPERATOR].includes(user.role)) {
    throw new BadRequestException('Only customer and operator accounts can be deleted through this endpoint');
  }
  throw new BadRequestException(
    `Cannot delete: ${user.rescueRequests.length} request(s) still active, with an unresolved dispute, or with a payment still processing`,
  );
}
```

**`AccountDeletionService.deleteOperator`** — same shape, no role check
needed (`Operator` is always a business, never a staff login). It scrubs
both dispute statements on this operator's requests (not just the
operator's own — see the note on `deleteUser`'s equivalent scrub above);
the customer-side location/media scrub is untouched here, since that's
identifying data about the *customer*, addressed only when that customer is
separately deleted:

```ts
async deleteOperator(id: string, actorId: string): Promise<void> {
  await this.prisma.$transaction(async (tx) => {
    const claimed = await tx.operator.updateMany({
      where: {
        id,
        deletedAt: null,
        rescueRequests: {
          none: {
            OR: [
              { status: { notIn: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] } },
              { disputed: true, disputeResolvedAt: null },
            ],
          },
        },
        payments: {
          none: { status: { in: [PaymentStatus.PENDING, PaymentStatus.SUBMITTED, PaymentStatus.BLOCKED] } },
        },
      },
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
    if (claimed.count === 0) {
      await this.explainOperatorDeleteFailure(tx, id); // always throws
    }

    await tx.rescueRequest.updateMany({
      where: { assignedOperatorId: id },
      // Both statements, same reasoning as deleteUser above — the
      // customer's own words can name/describe this operator too.
      data: { operatorDisputeStatement: null, customerDisputeStatement: null },
    });

    await tx.auditLog.create({
      data: {
        category: 'account_deleted',
        message: `Operator ${id} deleted`,
        actorId,
        details: { targetType: 'Operator', targetId: id },
      },
    });
  });
}
```

(`explainOperatorDeleteFailure` mirrors `explainUserDeleteFailure` above,
minus the role check, plus the `Payment` status check from the original
guard description.)

`S3Service` (`src/integrations/s3/s3.service.ts`) has no delete method
today — only `uploadMedia`/`getSignedUrl`. This spec needs one added:

```ts
async deleteObject(key: string): Promise<void> {
  await this.client.send(
    new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
  );
}
```

`paystackCustomerCode`/`paystackCustomerEmail` (User) and
`paystackRecipientCode` (Operator) are nulled on delete — an earlier draft
of this spec kept `paystackCustomerCode` on the reasoning that it's "just an
opaque pointer," but nothing ever needs it again once the account is
deleted (it can't log in, can't pay again as that identity), so there's no
reason to keep our own reference to it. What we cannot do, regardless, is
delete Paystack's own copy of the underlying customer/recipient record —
they're a separate data controller with their own KYC/AML retention duties.
That remains a real, disclosed limit of what "delete" means here.

`Operator.phoneNumber` has a `@unique` constraint — Postgres treats multiple
`NULL`s as distinct, so this is safe across repeated deletions, same as
`User.email`/`phoneNumber`/`paystackCustomerCode` today.

### 2a. Three more corrections from a second review pass

#### The atomic guard still doesn't close the race with a brand-new child row

`updateMany`'s `WHERE ... NOT EXISTS (...)` is atomic against already
*committed* data, but it does nothing about a **concurrent, not-yet-committed**
sibling transaction. Traced the actual creation path to check whether this is
real: there is exactly one live place a `RescueRequest` gets created for a
customer — `WhatsAppCustomerFlowService`, `whatsapp-customer-flow.service.ts:417`
— and it does this:

```ts
const customer = await this.sharedService.findOrCreateCustomer(phoneNumber);
const rescueRequest = await this.prisma.rescueRequest.create({
  data: { customerId: customer.id, /* ... */ },
});
```

`findOrCreateCustomer` (`rescue-request-shared.service.ts:28`) upserts the
`User` by phone number and returns it; the `create` is a **separate**
statement straight after, outside any transaction. The race: `findOrCreate
Customer` resolves the still-active customer, then — before the `create`
executes — the deletion transaction runs and commits (nothing yet exists for
`NOT EXISTS` to find), anonymizing the customer; then the `create` finally
runs, inserting a live `RescueRequest` for an identity that's already been
wiped. (There's a second call site, `initiateDeposit` at line 691 — grepped
the whole repo, it's dead code, never called. Not touched by this fix.)

**Rejected fix: `SERIALIZABLE` isolation.** It only aborts a transaction
when Postgres detects two transactions' actual read/write sets conflict —
and today's creation path never reads anything about the `User` row besides
using `.id`, so there's nothing for Postgres to detect a conflict against.
Raising the isolation level here would change nothing without also changing
the query shape, and it would add serialization-failure retry handling this
codebase doesn't have anywhere else.

**Fix: make both sides take a real row lock on the same `User` row, using
an ordinary `updateMany` as the lock — no raw SQL, no isolation-level
change.** This is standard Postgres behavior, not a new mechanism: when an
`UPDATE`'s `WHERE` targets a specific row, Postgres takes a row lock as it
evaluates that row, and a second concurrent `UPDATE` targeting the *same*
row blocks until the first commits, then re-checks its own `WHERE` against
the now-current data before deciding whether to proceed. The deletion
guard's `updateMany` already does this by targeting `id`. Creation needs to
do the same, as the first statement in a transaction that then creates the
request:

```ts
// whatsapp-customer-flow.service.ts — destination-collection step,
// replacing the two bare statements at line 415-426
const rescueRequest = await this.prisma.$transaction(async (tx) => {
  const customer = await this.sharedService.findOrCreateCustomer(phoneNumber, tx);

  // Purely a lock, not a real update — its only job is to contend for the
  // same row the deletion guard's updateMany writes to. Whichever of the
  // two commits first determines what the other one sees.
  const stillActive = await tx.user.updateMany({
    where: { id: customer.id, deletedAt: null },
    data: { updatedAt: new Date() },
  });
  if (stillActive.count === 0) {
    throw new BadRequestException('This account is no longer active.');
  }

  return tx.rescueRequest.create({
    data: {
      customerId: customer.id,
      status: RescueRequestStatus.WAITING_FOR_MEDIA,
      latitude: session.latitude,
      longitude: session.longitude,
      vehicleType: session.vehicleType as VehicleType,
      destination,
    },
  });
});
```

`RescueRequestSharedService.findOrCreateCustomer` gains an optional
transaction-client parameter so it can run inside this transaction instead
of on its own connection:

```ts
async findOrCreateCustomer(
  phoneNumber: string,
  client: Prisma.TransactionClient | PrismaService = this.prisma,
) {
  return client.user.upsert({
    where: { phoneNumber },
    update: {},
    create: { phoneNumber, role: UserRole.CUSTOMER },
  });
}
```

Whichever transaction (creation or deletion) commits first wins outright;
the other sees the correct, final state once unblocked and correctly
aborts. No isolation-level change, no retry loop, no raw SQL.

#### S3 deletion can permanently leak a deleted photo

The previous draft deleted the `RequestMedia` row, then attempted the S3
delete outside the transaction, sending only a Sentry exception on failure
— which loses the one durable record of which key still needs deleting.

Fixed with a durable outbox table, `PendingMediaDeletion` (Section 1,
additive migration alongside the `deletedAt` columns), written in the
**same transaction** as the `RequestMedia` delete so the outbox entry can
never be missing if the deletion committed, and cleared only once
`S3Service.deleteObject` actually confirms success — both now reflected
directly in `deleteUser`'s code in Section 2 above, not repeated here.

A second check on the same standalone ticker (Section 4) retries whatever's
left: `RetryMediaDeletionCheck.run()` reads every `PendingMediaDeletion`
row, calls `deleteObject` again, and removes the row on success. S3's
`DeleteObject` is idempotent — deleting an already-gone key still returns
success — so retrying a row that actually succeeded last time but failed to
clear its outbox entry is harmless, and the row simply stops appearing once
it clears.

#### Deleting an Operator doesn't stop its staff from acting as it

Setting `Operator.status: SUSPENDED` only stops *new dispatch* — traced
every place this codebase resolves "which Operator does this logged-in
staff `User` act for" and none of them check the Operator's status at all,
let alone `deletedAt`. There's no shared guard doing this resolution today;
it's nine independent inline lookups:

- `operator.service.ts`: `findByUserId` (:592), `assertCanManageOperator`
  (:606), `assertIsMemberOrAdmin` (:628)
- `rescue-request-admin.service.ts`: four inline `OperatorMember` lookups
  (:510, :526, :611, :690)
- `dispatch.service.ts`: `listMyPendingOffers` (:1204), `respondToOffer`
  (:1259)

Patching all nine inline is how this kind of check drifts out of sync later
(the exact failure mode this project already hit once this session, with
`lrr-web`'s nav/page-guard pairs). Instead: a new shared
`OperatorMembershipService` (`src/operator/operator-membership.service.ts`)
becomes the one place this is resolved, and all nine call sites are migrated
to it as part of this feature (mechanical per-site changes, not written out
here — this becomes its own implementation-plan task):

```ts
@Injectable()
export class OperatorMembershipService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Operators this User may currently act for — excludes a deleted
   * Operator, AND excludes the case where the acting User themselves has
   * been deleted (their JWT can still be valid for up to 24h — Section 3
   * — so this must not trust a live session alone).
   */
  async findActiveOperatorIdsForUser(userId: string): Promise<string[]> {
    const memberships = await this.prisma.operatorMember.findMany({
      where: { userId, operator: { deletedAt: null }, user: { deletedAt: null } },
      select: { operatorId: true },
    });
    return memberships.map((m) => m.operatorId);
  }

  /** Throws unless this User is a member of this specific, non-deleted Operator, and is not themselves deleted. */
  async assertActiveMembership(userId: string, operatorId: string): Promise<void> {
    const membership = await this.prisma.operatorMember.findFirst({
      where: { userId, operatorId, operator: { deletedAt: null }, user: { deletedAt: null } },
    });
    if (!membership) {
      throw new ForbiddenException(
        'Not a member of this operator, the operator has been deleted, or this account has been deleted.',
      );
    }
  }
}
```

This deliberately does **not** delete the `OperatorMember` rows or the
staff's own `User` accounts when the business is deleted — deleting the
person is already its own, separate SUPER_ADMIN action (per this spec's
scope decision that person- and business-level deletion are separate), and
the membership row itself carries no PII worth erasing (only `userId`/
`operatorId`/`role`), so keeping it preserves the business's staffing
history at no privacy cost. A deleted business's former staff can still log
in as themselves; they simply can no longer act on behalf of a business
that no longer exists — and the `user: { deletedAt: null }` clause above
means the reverse holds too: a deleted *staff member* can no longer act for
a business that's still fully active, even during their lingering JWT's
24h. Both directions matter equally; the first draft of this fix only
checked the operator's side. See 2b.

### 2b. A third review pass, and one more corner

#### Payout creation must close the same race as request creation — and so must a customer's own refund

`deleteOperator`'s guard checks for a non-terminal `Payment`, but that
check is only as good as the moment it runs — a *new* payout `Payment` can
still be inserted by a concurrent transaction right after, the same shape
of race Section 2a already fixed for `RescueRequest` creation. The same
question applies on the customer side: `refundDeposit` creates a `REFUND`
`Payment` for a customer whose `RescueRequest` is already `CANCELLED` —
exactly the state `deleteUser`'s guard (Section 2, updated above) now also
has to see, but only if that `Payment` row already exists by the time the
guard runs.

Both are the same underlying gap — *Payment creation doesn't know or care
whether the party it's for has just been deleted* — and both are closed by
one fix, in the one place all four Payment-creating call sites in this
codebase already funnel through: `PaymentLedgerService.create()`
(`payment-ledger.service.ts:33`), which already accepts an optional `tx`
today, unused by most of its callers:

```ts
async create(input: {
  rescueRequestId: string;
  type: PaymentType;
  amount: number;
  operatorId?: string;
  tx?: Prisma.TransactionClient;
}): Promise<Payment> {
  const run = async (client: Prisma.TransactionClient | PrismaService) => {
    // Same lock-as-mutex idiom as Section 2a's creation-side fix — targets
    // the same row deleteOperator's/deleteUser's own updateMany writes to,
    // so Postgres serializes the two regardless of which commits first.
    if (input.type === PaymentType.PAYOUT && input.operatorId) {
      const stillActive = await client.operator.updateMany({
        where: { id: input.operatorId, deletedAt: null },
        data: { updatedAt: new Date() },
      });
      if (stillActive.count === 0) {
        throw new BadRequestException('Cannot create a payout: this operator has been deleted.');
      }
    } else {
      const rescueRequest = await client.rescueRequest.findUnique({
        where: { id: input.rescueRequestId },
        select: { customerId: true },
      });
      if (rescueRequest) {
        const stillActive = await client.user.updateMany({
          where: { id: rescueRequest.customerId, deletedAt: null },
          data: { updatedAt: new Date() },
        });
        if (stillActive.count === 0) {
          throw new BadRequestException('Cannot create this payment: the customer has been deleted.');
        }
      }
    }

    return client.payment.create({
      data: {
        rescueRequestId: input.rescueRequestId,
        type: input.type,
        amount: input.amount,
        operatorId: input.operatorId ?? null,
      },
    });
  };

  // The lock-check and the insert must commit together, or the "lock" is
  // just a stale read. Most callers today (e.g. PayoutService.claimPayoutPayment)
  // call this with no `tx` at all — this method now opens its own when the
  // caller didn't supply one, rather than requiring every one of the four
  // call sites to be individually rewritten to pass one in.
  if (input.tx) return run(input.tx);
  return this.prisma.$transaction((tx) => run(tx));
}
```

This is a real, deliberate behavior change to a shared, already-used
method, not additive-only — flagging it plainly: `create()` now always
runs atomically (previously it was a single plain `insert`), and it can
now throw `BadRequestException` in a case it never could before (the
referenced customer or operator has been deleted). Every existing caller
(`rescue-request-admin.service.ts:189,347`, `payment-events.service.ts:338`,
`whatsapp-customer-flow.service.ts:709,1005`, `payout.service.ts:178`)
needs its own error handling checked against this new failure mode as part
of implementing this — none of them should ever hit it in practice (they
only create payments for accounts this feature's own guards should have
already kept from being deleted while in use), but "should never happen"
still needs a defined behavior, not a silent crash.

One gap knowingly left open: this closes the race for *new* Payment rows,
but a `RescueRequest`'s `status` transition to `CANCELLED` (the other half
of the "CANCELLED request, stuck refund" scenario) is a plain `update`
elsewhere in this codebase, not routed through anything that locks the
`User` row. A customer being deleted at the *exact* instant one of their
requests is being cancelled by an entirely different process remains a
narrow, unaddressed race — accepted as out of scope: unlike the WhatsApp-
driven creation race (any customer, any time, high frequency), this
requires two rare, independent state changes on the same customer inside
the same instant, and the consequence (a request left active rather than
cancelled after all) is far less severe than the leaked-media or double-
payment risks this spec is built to close.

### 2c. A fourth pass: two identity-scope gaps in the last two fixes

#### Dispute scrubbing was party-based, not identity-based

Already fixed directly in Section 2's code above (not repeated here): both
`deleteUser` and `deleteOperator` now null **both** dispute-statement
fields on the affected requests, not just the deleted party's own. The
earlier draft scrubbed `customerDisputeStatement` only on customer deletion
and `operatorDisputeStatement` only on operator deletion, on the reasoning
that each party's own words are what needs protecting — but the Background
section's own point was that either field can *name* either party,
regardless of who wrote it. Scrubbing is about whose identity is being
protected, not whose statement it grammatically is.

#### `OperatorMembershipService`'s check is a pre-check, not a guard, for anything that mutates

`assertActiveMembership` (Section 2a) is a plain read: it can pass, and
then — before the mutation it's gating actually commits — `deleteOperator`
can run and commit in between. The check and the write it's meant to
protect aren't the same atomic unit, the exact shape of every race this
spec has already closed elsewhere. Concretely: staff calls
`respondToOffer` → `assertActiveMembership` passes (operator still active)
→ `deleteOperator` commits → `respondToOffer` continues, writing to
`DispatchOffer`/`RescueRequest` on behalf of a business that, by the time
that write lands, no longer exists.

The read-only check is still correct for *reads* (`GET /operators/me`,
listing pending offers, admin views of an operator's requests) — a stale
read just shows slightly-out-of-date information for a moment, not a
lasting integrity problem. It's specifically wrong for anything that
**mutates** on the strength of "this membership is valid" — and per Section
2a's inventory, that's `operator.service.ts`'s `assertCanManageOperator`
(gates operator update/bank-details/availability/member mutations) and
`dispatch.service.ts`'s `respondToOffer` (accepting/quoting/declining a
job). `assertIsMemberOrAdmin` needs the same treatment if any of its
callers mutate rather than read — not confirmed from the inventory alone,
to be checked when each call site is migrated.

Fix: the same lock-as-mutex idiom as everywhere else in this spec, added
to `OperatorMembershipService` as a second method — used as the *first*
statement inside the SAME transaction as the mutation it's guarding, not as
a separate pre-check:

```ts
/**
 * For mutations only — `assertActiveMembership` above is a pre-check, not
 * a guard. This must run as the first statement inside the same
 * transaction as the mutation that follows, so it contends for the same
 * User row `deleteUser`'s own updateMany writes to, AND the same Operator
 * row `deleteOperator`'s own updateMany writes to — a mutation can be
 * invalidated by either side being deleted concurrently, the acting staff
 * member or the business they act for, not just one of the two.
 */
async lockActiveMembership(
  tx: Prisma.TransactionClient,
  userId: string,
  operatorId: string,
): Promise<void> {
  const membership = await tx.operatorMember.findFirst({
    where: { userId, operatorId },
  });
  if (!membership) {
    throw new ForbiddenException('Not a member of this operator.');
  }

  // Two separate locks, not one — the membership read above is only a
  // snapshot; these are what actually serialize against concurrent
  // deletion, same idiom as every other lock in this spec.
  const userStillActive = await tx.user.updateMany({
    where: { id: userId, deletedAt: null },
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
}
```

Whichever of `lockActiveMembership`'s two locks or the matching deletion's
own `updateMany` commits first — `deleteUser`'s targets the same `User` row
by `id`, `deleteOperator`'s the same `Operator` row by `id` — wins outright,
same guarantee as every other lock in this spec, now covering both parents
instead of just one. Migrating
`assertCanManageOperator`/`respondToOffer` (and `assertIsMemberOrAdmin` if
applicable) to wrap their mutation in a transaction and call this first is
implementation-plan work, not written out here — the method contract and
which call sites need it is what this design fixes.

### 3. Effect on existing read paths

Checked directly rather than assumed:

- **Staff/admin login** (`AuthService.login`, `auth.service.ts:71`) looks up
  by `email`. Once `email` is nulled, this lookup can never match the
  deleted account again — no separate `deletedAt` check needed here.
- **WhatsApp customer flow** looks up by `phoneNumber`
  (`auth.service.ts:396`). Same effect: nulled phone number means a message
  from that number after deletion is treated as a brand-new customer (a
  fresh `User`/`WhatsAppSession` gets created). This is the correct
  behavior, not a gap — from the platform's point of view the old identity
  is gone.
- **Dispatch eligibility** (`dispatch.service.ts:527`) already filters
  candidates on `status: 'ACTIVE'`. Setting a deleted operator's `status` to
  `SUSPENDED` (Section 2) excludes them from new job offers with no change
  to dispatch code at all.
- **Existing sessions (JWT):** `AuthGuard` is stateless — it verifies the
  JWT signature and never re-queries the `User` row per request. A deleted
  account keeps a working token until it naturally expires (24h, per
  `JwtModule`'s `expiresIn`). Section 2's role guard means this can only
  ever apply to a `CUSTOMER` or `OPERATOR`-role login — `DELETE /users/:id`
  rejects `ADMIN`/`SUPER_ADMIN`/`PRODUCT` outright, so a privileged session
  is never the one left running. See "Explicitly not doing" below.

### 4. Purge job (and media-deletion retries)

The existing reconciler (`src/rescue-request/reconciler/reconciler.service.ts`)
is explicitly documented as closed to outside contributions — its provider
array comment reads *"A check is registered here and nowhere else, so this
list is the whole inventory of scheduled work in the service"* — and every
check it runs is RescueRequest-domain. Account purging is a different
domain, so this design does **not** add a check into that array; instead it
reuses the SAME `ReconcilerCheck` shape (`name` + `run(now): Promise<number>`)
for its own two small checks, run by a standalone ticker scoped to
`AccountDeletionModule` — copying the pattern, not the registration. Neither
check is time-sensitive to the second, so this ticker runs hourly rather
than every 15s:

```ts
// src/account-deletion/account-deletion-ticker.service.ts
@Injectable()
export class AccountDeletionTickerService implements OnModuleInit, OnModuleDestroy {
  private readonly INTERVAL_MS = 60 * 60 * 1000; // hourly
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly purgeCheck: PurgeExpiredFinancialDataCheck,
    private readonly mediaRetryCheck: RetryMediaDeletionCheck,
  ) {}

  onModuleInit() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(now: Date = new Date()): Promise<void> {
    for (const check of [this.purgeCheck, this.mediaRetryCheck]) {
      try {
        await check.run(now);
      } catch (error) {
        console.error(`Account-deletion check "${check.name}" failed:`, error);
        Sentry.captureException(error, { extra: { check: check.name } });
      }
    }
  }
}
```

**`PurgeExpiredFinancialDataCheck`:**

```ts
@Injectable()
export class PurgeExpiredFinancialDataCheck {
  readonly name = 'purge-expired-financial-data';
  private readonly RETENTION_MS = 5 * 365 * 24 * 60 * 60 * 1000; // ~5 years

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async run(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.RETENTION_MS);
    // Retention is anchored on the TRANSACTION's own age (createdAt), not on
    // how long ago the account was deleted — a payment already 8 years old
    // at the moment its customer is deleted must not get another 5-year
    // grace period; it's purgeable on the very next tick. The `deletedAt`
    // check is only the gate ("this identity is gone"), never the clock.
    //
    // Corrected from an earlier draft: every Payment row has a
    // rescueRequestId (and so a customer) REGARDLESS of type, including
    // PAYOUT rows — a naive `customer.deletedAt OR operator.deletedAt`
    // check let a payout to a still-active operator get purged just
    // because the unrelated customer on that job happened to be deleted.
    // Each branch is scoped to the party the transaction actually
    // concerns: a DEPOSIT/BALANCE/REFUND moves money for the customer, a
    // PAYOUT moves money to the operator.
    const result = await this.prisma.payment.deleteMany({
      where: {
        createdAt: { lt: cutoff },
        OR: [
          {
            type: { in: [PaymentType.DEPOSIT, PaymentType.BALANCE, PaymentType.REFUND] },
            rescueRequest: { customer: { deletedAt: { not: null } } },
          },
          {
            type: PaymentType.PAYOUT,
            operator: { deletedAt: { not: null } },
          },
        ],
      },
    });
    if (result.count > 0) {
      await this.auditLogService.record({
        category: 'financial_data_purged',
        message: `Purged ${result.count} Payment rows past retention window`,
        details: { cutoff: cutoff.toISOString() },
      });
    }
    return result.count;
  }
}
```

**`RetryMediaDeletionCheck`** — clears whatever the best-effort loop in
`deleteUser` (Section 2a) couldn't delete immediately. Idempotent because
S3's `DeleteObject` succeeds even on an already-gone key:

```ts
@Injectable()
export class RetryMediaDeletionCheck {
  readonly name = 'retry-media-deletion';

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
  ) {}

  async run(): Promise<number> {
    const pending = await this.prisma.pendingMediaDeletion.findMany({ take: 100 });
    let cleared = 0;
    for (const row of pending) {
      try {
        await this.s3Service.deleteObject(row.s3Key);
        await this.prisma.pendingMediaDeletion.delete({ where: { id: row.id } });
        cleared++;
      } catch (err) {
        console.error(`Retry: failed to delete media object ${row.s3Key}:`, err);
        Sentry.captureException(err, { extra: { s3Key: row.s3Key } });
      }
    }
    return cleared;
  }
}
```

Registered as ordinary providers in `AccountDeletionModule`, started via the
ticker's own `OnModuleInit` — no wiring into `RescueRequestModule` at all.

Only `Payment` rows are purged here — `RescueRequest`/`Rating` rows are not
deleted by this job. That's not because they're free of personal data (the
Background correction above covers what they do carry); it's because their
identifying fields are already scrubbed *at deletion time* by Section 2, not
left for the purge job to find later. What's left on `RescueRequest` after
that — status, amounts, timestamps, issue type — isn't financial-record data
either, but it's also not identifying, so it has no purge deadline of its
own.

### 5. Admin UI

- "Delete account" action on the existing user-detail and operator-detail
  admin pages (`lrr-web`), `RequireRole roles={["SUPER_ADMIN"]}` — matches
  every other SUPER_ADMIN-only surface already shipped this project
  (Platform Settings, Audit Log, Payouts).
- Confirmation modal lists exactly what gets wiped (name, phone, email; bank
  details for an operator) before the SUPER_ADMIN confirms.
- If the guard rejects it, the modal shows the exact reason the API returns
  (e.g. "2 active requests", "1 payout awaiting OTP") rather than a generic
  error.
- Deleted accounts are not hidden from existing admin lists — they show a
  "Deleted" badge (`deletedAt != null`) so history stays visible and
  auditable, consistent with "anonymize, don't disappear."

## Explicitly not doing

- **Immediate JWT/session revocation.** `AuthGuard` is stateless by design
  elsewhere in this codebase; building a token-blocklist just for this
  feature is new infrastructure disproportionate to a rare, SUPER_ADMIN-only
  action. Section 2's role guard confines this to `CUSTOMER`/`OPERATOR`
  logins only — accepted worst case is one of those keeping a working
  session for up to 24h, never an admin/staff session. Flagged, not
  silently ignored.
- **Reaching into Paystack to delete their copy of the data.** Outside our
  authority — Paystack is a separate data controller with its own retention
  duties. Our own pointers to it (`paystackCustomerCode`,
  `paystackRecipientCode`) are nulled immediately at deletion (Section 2),
  not retained until purge — nothing we control needs them once the account
  is gone.
- **Self-service / customer-initiated deletion.** SUPER_ADMIN only, per the
  original ask.
- **An undo window / soft "trash" period beyond the active-state guard.**
  The guard (Section 2) is the safety net before the irreversible step;
  there's no separate grace period after confirming.
- **A generic soft-delete framework for other models.** The `deletedAt` flag
  and login-blocking pattern is scoped to `User` and `Operator` only — those
  are the only two tables with a login/identity of their own to close off.
  `RescueRequest`'s identifying fields are handled differently (an inline
  scrub in the same transaction, Section 2), not by giving it its own
  `deletedAt`.
- **Purging `RescueRequest`/`Rating` rows.** They're operational history, not
  financial records, and have no retention deadline — only `Payment` rows
  are in scope for the purge job.

## Testing

Mocked-Prisma tests in this codebase can't observe real `NULL`/conditional-
`WHERE` semantics, so these assert call shape and simulate query results,
matching this repo's existing convention. Because the guard is now the
`updateMany`'s `WHERE` rather than a separate read, "blocks on X" below
means: simulate `count: 0` and assert the specific error
`explainUserDeleteFailure`/`explainOperatorDeleteFailure` produces from that
state — not that some earlier read rejected first.

- **`deleteUser` rejects a non-customer, non-operator role outright** —
  target has `role: ADMIN` (or `SUPER_ADMIN`/`PRODUCT`) → `updateMany`
  matches zero rows, the explain-read reports the role, rejected before
  anything about requests/disputes is even considered. **This is the
  regression that matters most** — an earlier draft had no role check at
  all.
- **`deleteUser` guard blocks on an active request** — any status other than
  `COMPLETED`/`CANCELLED` → `count: 0`, explain-read reports the count of
  still-active/disputed requests.
- **`deleteUser` guard blocks on an unresolved dispute on an otherwise-
  completed request** — `status: COMPLETED, disputed: true,
  disputeResolvedAt: null` → rejected. A status-only check would miss this.
- **`deleteUser` rejects an already-deleted account** — `deletedAt` already
  set → `count: 0`, explain-read reports "already deleted" rather than
  re-running the request check.
- **`deleteUser` succeeds and anonymizes** — eligible role, no active
  requests, no open disputes → `name/email/phoneNumber/passwordHash/
  paystackCustomerCode/paystackCustomerEmail` cleared, `deletedAt` set.
- **`deleteUser` scrubs the customer's own `RescueRequest` rows** —
  `latitude`/`longitude`/`destination` and **both** dispute statements
  (`customerDisputeStatement` AND `operatorDisputeStatement` — the
  operator's own words about this customer can identify them too) nulled
  on every request belonging to that customer, in the same transaction as
  the anonymizing update.
- **`deleteUser` deletes the customer's `RequestMedia` rows and their S3
  objects** — captured `s3Key`s match what `S3Service.deleteObject` is
  called with, once per row, after the transaction commits.
- **`deleteUser` still commits when an S3 delete fails** — `s3Service
  .deleteObject` rejects for one key → the deletion itself is unaffected
  (already committed), a Sentry exception is captured, no exception
  escapes to the caller. The database write and the S3 cleanup are
  deliberately not the same atomicity boundary (Section 2).
- **`deleteUser` writes its audit entry inside the same transaction as the
  anonymizing update** — assert `tx.auditLog.create` is called with the
  same transaction client the `updateMany`/`requestMedia` calls used, not
  via `AuditLogService.record()`.
- **`deleteUser` rolls back the anonymization if the audit write fails** —
  not observable via a mocked Prisma client (mocks don't roll anything
  back), so this is an integration-level test against a real database:
  call `deleteUser` with the transaction's `auditLog.create` deliberately
  passed an invalid `category: null as never` (the column is `NOT NULL`,
  so Postgres rejects the insert for real), and assert the `User` row's
  `deletedAt` is still `null` and its `name` unchanged afterward — the
  earlier `updateMany` in the same transaction must have rolled back too.
- **`deleteOperator` guard blocks on a non-terminal payout** — a `Payment`
  row in `PENDING`/`SUBMITTED`/`BLOCKED` for that operator → rejected,
  message names which.
- **`deleteOperator` guard does not block on terminal payouts** —
  `SUCCEEDED`/`FAILED`/`REVERSED` don't count as blocking.
- **`deleteOperator` succeeds and anonymizes** — sets `status: SUSPENDED`,
  `isAvailable: false`, clears bank fields including
  `paystackRecipientCode`, sets `deletedAt`.
- **`deleteOperator` scrubs both dispute statements** on that operator's
  assigned requests — `operatorDisputeStatement` AND
  `customerDisputeStatement` nulled (**this is the regression that matters
  most for this test** — an earlier draft only cleared the operator's own
  statement, missing that the customer's words can identify the operator
  too). Location/media on the same request are untouched — that's the
  customer's identifying data, addressed only when the customer is
  separately deleted.
- **Post-delete login lookup fails** — a `User` with `email: null` cannot be
  found by `AuthService.login`'s `findUnique({ where: { email } })`.
- **Purge check is a no-op when nothing qualifies** — `run()` returns `0`, no
  audit log write.
- **Purge check does not touch a deleted customer's recent payment** —
  `User` is deleted, but the linked `Payment.createdAt` is inside the
  retention window → not purged.
- **Purge check does not touch an old payment on a still-active account** —
  `Payment.createdAt` is past the cutoff, but the linked `User`/`Operator`
  has `deletedAt: null` → not purged. The clock is transaction age, but
  deletion is still the gate.
- **Purge check does NOT purge a `PAYOUT` row just because the request's
  customer was deleted, when the operator is still active** — `Payment`
  is `type: PAYOUT`, past the cutoff, `rescueRequest.customer.deletedAt` is
  set, `operator.deletedAt` is `null` → not purged. **This is the
  regression that matters most** — an earlier draft's `OR` clause purged
  exactly this case, because every `Payment` row (payouts included) also
  has a `rescueRequestId` and therefore a customer.
- **Purge check DOES purge a `PAYOUT` row once its operator is deleted**,
  independent of the request's customer's deletion status.
- **Purge check purges a `DEPOSIT`/`BALANCE`/`REFUND` row once its
  customer is deleted**, independent of the assigned operator's deletion
  status.
- **Creation aborts when the customer was deleted between resolving them
  and creating the request** — integration-level, real database required
  (mocked Prisma can't model row-lock blocking): start the deletion
  transaction, let its `updateMany` commit, then run the creation
  transaction against the same customer id — its own `updateMany` lock
  must see `deletedAt` already set and `count: 0`, aborting before
  `rescueRequest.create` runs. **This is the regression that matters
  most** — an earlier draft's guard was atomic only against already-
  committed data, not a concurrent in-flight sibling transaction.
- **Deletion aborts when a request was created between the guard's last
  known-good state and its own commit** — the mirror image of the above:
  creation's transaction commits first (row now has an active request),
  then deletion's `updateMany` — unblocked and re-evaluating its `WHERE`
  against current data — must see the new request and return `count: 0`.
- **`RetryMediaDeletionCheck` clears a `PendingMediaDeletion` row once its
  S3 object deletes successfully.**
- **`RetryMediaDeletionCheck` leaves a row in place when its S3 delete
  still fails**, and captures a Sentry exception — same as the initial
  best-effort attempt in `deleteUser`, so nothing is silently dropped
  twice.
- **`deleteUser` writes a `PendingMediaDeletion` row for every media item
  in the same transaction as the `RequestMedia` delete** — assert both
  calls happen against the same `tx`, so a mid-transaction failure can't
  leave one written without the other.
- **`OperatorMembershipService.findActiveOperatorIdsForUser` excludes a
  deleted operator** — a membership row exists, but `operator.deletedAt`
  is set → not included in the result.
- **`OperatorMembershipService.assertActiveMembership` rejects membership
  in a deleted operator** — throws `ForbiddenException` even though the
  `OperatorMember` row itself still exists untouched.
- **`OperatorMembershipService` also rejects a deleted acting user** — the
  membership row and the `Operator` are both intact, but `user.deletedAt`
  is set → excluded from `findActiveOperatorIdsForUser`, and
  `assertActiveMembership` throws. **This is the regression that matters
  most for this method** — an earlier draft only ever checked the
  operator's side, so a deleted staff member's still-valid 24h JWT could
  keep acting for a fully active business.
- **`deleteUser` guard blocks when a request has a non-terminal payment**
  even though its `status` is already `CANCELLED` — a `Payment` in
  `PENDING`/`SUBMITTED`/`BLOCKED` (e.g. a refund blocked on
  `NEEDS_CUSTOMER_DETAILS`) → `count: 0`, explain-read's count includes
  this request. **This is the regression that matters most for this
  guard** — an earlier draft treated a `CANCELLED` request as always safe,
  missing the case where the request is done but its money isn't.
- **`PaymentLedgerService.create()` refuses a `PAYOUT` for a deleted
  operator** — `operatorId` resolves to `deletedAt` already set →
  `BadRequestException`, no `Payment` row created.
- **`PaymentLedgerService.create()` refuses a `DEPOSIT`/`BALANCE`/`REFUND`
  for a request whose customer is deleted** — resolves `rescueRequestId`
  → `customerId` → `deletedAt` already set → `BadRequestException`.
- **`PaymentLedgerService.create()` still succeeds for an active
  operator/customer**, and wraps the lock-check and insert in its own
  transaction when the caller passed no `tx` — assert both calls (the
  `updateMany` lock and the `payment.create`) happen against the same
  transaction client.
- **A concurrent payout creation and `deleteOperator` correctly serialize**
  — integration-level, real database: whichever of the two `updateMany`
  calls (the payout lock-check, or the deletion guard) commits first
  determines the other's outcome, mirroring the creation-vs-deletion test
  already specified above for customers.
- **`deleteUser` nulls both `customerDisputeStatement` and
  `operatorDisputeStatement`** on the customer's requests, not just their
  own statement.
- **`deleteOperator` nulls both `operatorDisputeStatement` and
  `customerDisputeStatement`** on the operator's assigned requests, not
  just their own statement.
- **`lockActiveMembership` throws when no membership row exists** — before
  either lock is even attempted.
- **`lockActiveMembership` throws when the acting user has been deleted**
  — the membership row and `Operator` are both intact, but `user
  .updateMany`'s own guard (`deletedAt: null`) matches zero rows. **This
  is the regression that matters most for this method** — an earlier
  draft only filtered `user.deletedAt` inside the membership read, a plain
  snapshot with no lock; a `deleteUser` committing between that read and
  the caller's own mutation would have gone undetected.
- **`lockActiveMembership` throws when the operator has been deleted**,
  even though the membership row and `User` are both intact —
  `operator.updateMany`'s own guard matches zero rows.
- **`lockActiveMembership` succeeds and returns for an active membership**
  — no exception, both `updateMany` calls return `count: 1`.
- **A concurrent `deleteUser` and a mutation correctly serialize** —
  integration-level, real database: start a transaction that calls
  `lockActiveMembership` then pauses before committing, run `deleteUser`
  on that same acting user concurrently, then let the first transaction
  attempt its commit — the loser (whichever executed its `updateMany`
  second, once unblocked) must see the other's committed state and abort.
- **A concurrent `deleteOperator` and a mutation correctly serialize** —
  same shape as above, but racing `deleteOperator` against the operator
  lock instead of the user lock.
