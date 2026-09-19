# Account Deletion — Design

**Status:** Approved by user 2026-09-15. Patched 2026-09-19 for
`RequestMedia`'s `context`/`uploadedByRole` fields (added by the
completion-and-dispute-media-evidence plan, which shipped between this
spec's approval and its implementation) — see the `deleteUser`/
`deleteOperator` sections below for what changed.

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

1. **Every destructive guard uses lock → read → write, in one transaction.**
   A plain "check, then update" leaves a window where a new child row can be
   created between the two. But putting relational conditions such as
   `rescueRequests: { none: ... }` inside the locking `updateMany` is not a
   sound fix either: under PostgreSQL `READ COMMITTED`, EvalPlanQual reliably
   rechecks predicates on the parent row it waited to lock, but relational
   subqueries may still reflect the statement's earlier snapshot. The fixed
   shape is: (1) lock the parent with an `updateMany` whose `WHERE` contains
   only parent columns (`id`, `deletedAt`, and, for users, `role`); (2) while
   holding that lock, read child-table eligibility with separate queries;
   (3) perform the irreversible anonymizing update. Every writer that can
   change those child-table answers must first lock the same parent row, so
   it either commits before the guard's fresh reads or waits until deletion
   finishes. This lock ordering is the concurrency contract for the feature.
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
    const locked = await tx.user.updateMany({
      where: {
        id,
        deletedAt: null,
        role: { in: [UserRole.CUSTOMER, UserRole.OPERATOR] },
      },
      data: { updatedAt: new Date() },
    });
    if (locked.count === 0) {
      await this.explainUserLockFailure(tx, id); // always throws
    }

    const blockingRequests = await tx.rescueRequest.findMany({
      where: {
        customerId: id,
        OR: [
          { status: { notIn: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] } },
          { disputed: true, disputeResolvedAt: null },
          {
            payments: {
              some: {
                type: { in: [PaymentType.DEPOSIT, PaymentType.BALANCE, PaymentType.REFUND] },
                status: { in: [PaymentStatus.PENDING, PaymentStatus.SUBMITTED, PaymentStatus.BLOCKED] },
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    if (blockingRequests.length > 0) {
      throw new BadRequestException(
        `Cannot delete: ${blockingRequests.length} request(s) still active, with an unresolved dispute, or with a payment still processing`,
      );
    }

    const ownedOperators = await tx.operatorMember.findMany({
      where: { userId: id, role: OperatorMemberRole.OWNER, operator: { deletedAt: null } },
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
        name: 'Deleted User', email: null, phoneNumber: null,
        passwordHash: null, paystackCustomerCode: null,
        paystackCustomerEmail: null, deletedAt: new Date(),
      },
    });

    // Scrub what's identifying on this customer's own requests — none of
    // it is financial-record data (Background). The guard above already
    // requires every request to be COMPLETED/CANCELLED with no open
    // dispute, so nobody has a live, ongoing need for this any more.
    //
    // uploadedByRole: CUSTOMER — added 2026-09-19, after RequestMedia
    // gained context/uploadedByRole (completion & dispute media evidence
    // plan). Without this filter, deleting a customer would also delete
    // the OPERATOR's own completion/dispute photos on a shared request —
    // those aren't this customer's identity to scrub, and deleteOperator
    // (below) now owns cleaning those up on its own trigger.
    const media = await tx.requestMedia.findMany({
      where: {
        rescueRequest: { customerId: id },
        uploadedByRole: UserRole.CUSTOMER,
      },
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

/** The lock can fail only on parent-row facts; child guards run after it succeeds. */
private async explainUserLockFailure(tx: Prisma.TransactionClient, id: string): Promise<never> {
  const user = await tx.user.findUnique({
    where: { id },
    select: { role: true, deletedAt: true },
  });
  if (!user) throw new NotFoundException('User not found');
  if (user.deletedAt) throw new BadRequestException('This account has already been deleted');
  if (![UserRole.CUSTOMER, UserRole.OPERATOR].includes(user.role)) {
    throw new BadRequestException('Only customer and operator accounts can be deleted through this endpoint');
  }
  throw new BadRequestException('This account cannot be deleted');
}
```

**`AccountDeletionService.deleteOperator`** — same shape, no role check
needed (`Operator` is always a business, never a staff login). It scrubs
both dispute statements on this operator's requests (not just the
operator's own — see the note on `deleteUser`'s equivalent scrub above).

**Updated 2026-09-19, after `RequestMedia` gained `context`/
`uploadedByRole`:** the original draft of this section left media
entirely untouched here, reasoning that all `RequestMedia` was
customer-uploaded and so was the customer's identity to scrub, not the
operator's. That's no longer true — an operator now uploads their own
completion evidence and can upload dispute evidence too, and those
photos can show the operator's own face, vehicle, or plate (Background).
`deleteOperator` now scrubs `RequestMedia` rows tagged
`uploadedByRole: OPERATOR` on this operator's assigned requests, through
the same `PendingMediaDeletion` outbox as `deleteUser`. Customer-uploaded
media on the same requests is untouched here — still identifying data
about the *customer*, still addressed only when that customer is
separately deleted:

```ts
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
          { status: { notIn: [RescueRequestStatus.COMPLETED, RescueRequestStatus.CANCELLED] } },
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

    // Attempt terminality is not obligation settlement. FAILED and REVERSED
    // payout attempts are retryable with a new sibling row, so deletion is
    // allowed only once every completed assigned request has a SUCCEEDED
    // payout attempt.
    const unsettledPayouts = await tx.rescueRequest.findMany({
      where: {
        assignedOperatorId: id,
        status: RescueRequestStatus.COMPLETED,
        payments: {
          none: { type: PaymentType.PAYOUT, status: PaymentStatus.SUCCEEDED },
        },
      },
      select: { id: true },
    });
    if (unsettledPayouts.length > 0) {
      throw new BadRequestException(
        `Cannot delete: ${unsettledPayouts.length} completed request(s) still have an unsettled payout`,
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
      // Both statements, same reasoning as deleteUser above — the
      // customer's own words can name/describe this operator too.
      data: { operatorDisputeStatement: null, customerDisputeStatement: null },
    });

    // This operator's own uploaded evidence (completion photos, dispute
    // evidence) — not the customer's. Same outbox pattern as deleteUser:
    // written in the same transaction as the RequestMedia delete, cleared
    // only once S3 confirms.
    const media = await tx.requestMedia.findMany({
      where: {
        rescueRequest: { assignedOperatorId: id },
        uploadedByRole: UserRole.OPERATOR,
      },
      select: { id: true, s3Key: true },
    });
    if (media.length > 0) {
      await tx.pendingMediaDeletion.createMany({
        data: media.map((m) => ({ s3Key: m.s3Key })),
        skipDuplicates: true,
      });
    }
    await tx.requestMedia.deleteMany({
      where: { id: { in: media.map((m) => m.id) } },
    });

    await tx.auditLog.create({
      data: {
        category: 'account_deleted',
        message: `Operator ${id} deleted`,
        actorId,
        details: { targetType: 'Operator', targetId: id },
      },
    });

    return media.map((m) => m.s3Key);
  });

  // Outside the transaction — S3 isn't transactional with Postgres. Same
  // best-effort-then-retry shape as deleteUser above.
  for (const key of s3KeysToDelete) {
    try {
      await this.s3Service.deleteObject(key);
      await this.prisma.pendingMediaDeletion.delete({ where: { s3Key: key } });
    } catch (err) {
      console.error(`Failed to delete media object ${key} after deleting operator ${id}:`, err);
      Sentry.captureException(err, { extra: { s3Key: key, operatorId: id } });
      // Deliberately not removed — stays for RetryMediaDeletionCheck (Section 4).
    }
  }
}
```

The plain parent lock is intentionally separate from both child reads. The
request-assignment and payout-creation paths described below lock this same
`Operator` row before their own writes, making the post-lock reads stable for
the rest of the deletion transaction.

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

The deletion-side parent lock makes its later reads stable only if every
writer that can change those answers takes the same lock first. Traced the
actual creation path to check whether this is real: there is exactly one live
place a `RescueRequest` gets created for a
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
deletion transaction does this with its plain parent-row `updateMany`.
Creation needs to target the same row, as the first write in a transaction
that then creates the request:

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
    if (input.type === PaymentType.PAYOUT) {
      if (!input.operatorId) {
        throw new BadRequestException('A PAYOUT payment must have an operatorId.');
      }
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
  actingUser: { userId: string; role: string },
  operatorId: string,
): Promise<void> {
  // Fixed order: User, then Operator. Every caller uses this order.
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

  // Read membership only after both locks are held. Reading it first is
  // racy against addMember/removeMember; those mutations also lock this
  // Operator row before changing membership rows.
  if (![UserRole.ADMIN, UserRole.SUPER_ADMIN].includes(actingUser.role as UserRole)) {
    const membership = await tx.operatorMember.findFirst({
      where: { userId: actingUser.userId, operatorId },
    });
    if (!membership) {
      throw new ForbiddenException('Not a member of this operator.');
    }
  }
}
```

Whichever of `lockActiveMembership`'s two locks or the matching deletion's
own `updateMany` commits first — `deleteUser`'s targets the same `User` row
by `id`, `deleteOperator`'s the same `Operator` row by `id` — wins outright,
same guarantee as every other lock in this spec, now covering both parents
instead of just one. The membership read deliberately comes last: an earlier
draft read it before either lock, allowing a concurrent `removeMember` to
invalidate the authorization before the protected mutation committed.
`addMember` and `removeMember` must themselves lock the same Operator row
before changing membership rows. The role-bearing signature also preserves
the existing ADMIN/SUPER_ADMIN bypass; those roles may manage an operator
without owning an `OperatorMember` row. Migrating
`assertCanManageOperator`/`respondToOffer` (and `assertIsMemberOrAdmin` if
applicable) to wrap their mutation in a transaction and call this first is
implementation-plan work, not written out here — the method contract and
which call sites need it is what this design fixes.

### 2d. Fifth pass: assignment, disputes, and both quote channels participate in the locks

The operator deletion guard reads `RescueRequest.assignedOperatorId` only
after locking the Operator row. That read is stable only if every writer of
`assignedOperatorId` locks the same Operator first. There are exactly two
writers: `RescueRequestAdminService.assignOperator` and
`WhatsAppCustomerFlowService.handleQuoteSelected`. `respondToOffer` does not
set this field, so protecting only the offer claim leaves the real race open.

The lock cannot be added only around the final assignment write. In the real
admin flow, the selected offer and deposit Payment are created and Paystack is
called before `assignedOperatorId` is currently persisted; in the WhatsApp
flow, the request is moved to `WAITING_FOR_DEPOSIT` before the Operator lock.
Both orders are invalid: the first calls an external payment provider before
the assignment exists, and the second can leave a dead-end request if the
later lock fails.

Both assignment paths therefore use one short database transaction. Because
deposit creation also locks the request's customer, they follow the global
parent order User then Operator; the Operator lock is:

```ts
const operatorStillActive = await tx.operator.updateMany({
  where: { id: operatorId, deletedAt: null },
  data: { updatedAt: new Date() },
});
```

For manual admin assignment, that transaction locks the customer User then
the Operator, claims the
request, creates the selected offer, creates the PENDING deposit Payment on
the transaction client, and persists assignment/status/pricing/deadline. For
WhatsApp quote selection, the same transaction contains the User lock,
Operator lock, DISPATCHING claim, assignment/status/pricing/deadline, all selected/
not-selected/timed-out offer transitions, and the PENDING deposit Payment.
Only after commit may either path claim the Payment for submission and call
Paystack. Thus no HTTP call occurs while holding the Operator lock, but no
HTTP call occurs before durable assignment either.

This closes both orderings: if assignment commits first, deletion acquires the
lock afterward and its fresh request read blocks deletion; if deletion commits
first, assignment's `deletedAt: null` lock matches zero rows and assignment
aborts. The admin endpoint throws a precise `BadRequestException`; the
WhatsApp flow tells the customer the operator is no longer available and
alerts Sentry. A failed Operator lock rolls the entire selection transaction
back, so there is no knowingly stranded `WAITING_FOR_DEPOSIT` state.

`DispatchService.processQuoteOrDecline` remains the public, channel-agnostic
operation used by dashboard and WhatsApp. The conditional offer write moves
to a private `claimOfferInTx`. The dashboard wrapper calls
`lockActiveMembership` then the helper; the WhatsApp/public wrapper locks the
offer's Operator row directly then calls the same helper. Protecting only
`respondToOffer` would silently leave the WhatsApp channel outside the
protocol.

Dispute opening/reopening is another child write read by both deletion
guards. `DisputeService.raiseDispute` performs one short transaction with a
fixed lock order: request customer User first, assigned Operator second (when
present), then set or reopen the dispute. All notifications and session
updates remain after commit. This prevents either deletion from passing its
fresh dispute read immediately before a concurrent dispute is opened.

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
`deleteUser` or `deleteOperator` (both write to the same
`PendingMediaDeletion` outbox) couldn't delete immediately. Idempotent
because S3's `DeleteObject` succeeds even on an already-gone key:

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

Mocked-Prisma tests in this codebase can't observe real row-lock blocking, so
unit tests assert the three-step query shape and simulate each result: a plain
parent `updateMany` lock, separate child-table reads after that lock succeeds,
then the irreversible update. Integration tests against PostgreSQL cover the
actual serialization behavior. No relational condition belongs in a locking
`updateMany`'s `WHERE`.

- **`deleteUser` locks with parent columns only** — `id`, `deletedAt`, and
  allowed `role`; no `rescueRequests`, `payments`, or memberships relation is
  present in the lock query.
- **`deleteUser` rejects a non-customer, non-operator role outright** — target
  has `role: ADMIN` (or `SUPER_ADMIN`/`PRODUCT`) → the parent lock matches zero
  rows and the parent-only explanation read reports the role.
- **`deleteUser` guard blocks on an active request** — the parent lock returns
  `count: 1`, then the fresh child read finds any status other than
  `COMPLETED`/`CANCELLED` and aborts before anonymization.
- **`deleteUser` guard blocks on an unresolved dispute on an otherwise-
  completed request** — `status: COMPLETED, disputed: true,
  disputeResolvedAt: null` → rejected. A status-only check would miss this.
- **`deleteUser` rejects an already-deleted account** — `deletedAt` already
  set → the parent lock returns `count: 0`; child reads never run.
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
- **`deleteUser` only deletes `uploadedByRole: CUSTOMER` media, never the
  operator's** — a request with one `CUSTOMER`-uploaded (`INITIAL`) row
  and one `OPERATOR`-uploaded (`COMPLETION`) row on the same
  `rescueRequestId` → only the `CUSTOMER` row is found, queued for S3
  deletion, and removed; the `OPERATOR` row and its S3 object are
  untouched. **This is the regression that matters most for this
  query** — before `uploadedByRole` existed, this filter was implicit
  (all media was customer-uploaded); adding it back after the schema
  changed is what this fix is for.
- **`deleteOperator` deletes the operator's own `RequestMedia` rows and
  their S3 objects** — same shape as `deleteUser`'s equivalent test,
  scoped to `rescueRequest.assignedOperatorId` + `uploadedByRole:
  OPERATOR`.
- **`deleteOperator` only deletes `uploadedByRole: OPERATOR` media,
  never the customer's** — mirrors the `deleteUser` regression test
  above: a `CUSTOMER`-uploaded row on the same request survives.
- **`deleteOperator` still commits when an S3 delete fails**, same
  shape as `deleteUser`'s equivalent test.
- **`deleteOperator` writes a `PendingMediaDeletion` row for every media
  item in the same transaction as the `RequestMedia` delete**, same
  shape as `deleteUser`'s equivalent test.
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
- **`deleteOperator` blocks on an unsettled payout entitlement** — any
  COMPLETED assigned request with no SUCCEEDED PAYOUT sibling is blocking,
  including no attempt yet and attempts ending FAILED or REVERSED.
- **A terminal failed attempt is not settlement** — FAILED/REVERSED remains
  blocking because the payment model permits a fresh retry row. An older
  failed attempt stops blocking only when a SUCCEEDED sibling exists.
- **`deleteOperator` succeeds and anonymizes** — sets `status: SUSPENDED`,
  `isAvailable: false`, clears bank fields including
  `paystackRecipientCode`, sets `deletedAt`.
- **`deleteOperator` scrubs both dispute statements** on that operator's
  assigned requests — `operatorDisputeStatement` AND
  `customerDisputeStatement` nulled (**this is the regression that matters
  most for this test** — an earlier draft only cleared the operator's own
  statement, missing that the customer's words can identify the operator
  too). Location on the same request is untouched — that's the customer's
  identifying data, addressed only when the customer is separately
  deleted. (Media is *not* uniformly untouched here any more — see the
  `uploadedByRole`-scoped media tests above: the customer's `INITIAL`
  media survives, the operator's `COMPLETION`/`DISPUTE` media does not.)
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
- **Deletion aborts when request creation wins the parent lock first** — once
  creation commits, deletion acquires the same User lock and its subsequent
  fresh child read sees the new active request. This test must not expect a
  relational condition in deletion's lock query.
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
- **Both quote channels participate in the Operator lock** — dashboard uses
  `lockActiveMembership`; WhatsApp/public `processQuoteOrDecline` locks the
  offer's Operator directly; both call the same transactional claim helper.
- **Assignment persists before Paystack** — admin and WhatsApp tests assert
  the request claim, Operator lock, assignment/pricing, offer transitions,
  and PENDING deposit Payment commit together before any provider call.
- **Dispute opening/reopening participates in both deletion locks** — lock
  order is customer User then assigned Operator, the dispute write commits in
  that transaction, and notifications occur afterward.
- **`deleteUser` nulls both `customerDisputeStatement` and
  `operatorDisputeStatement`** on the customer's requests, not just their
  own statement.
- **`deleteOperator` nulls both `operatorDisputeStatement` and
  `customerDisputeStatement`** on the operator's assigned requests, not
  just their own statement.
- **`lockActiveMembership` throws when no membership row exists** — only after
  both parent locks succeed. Assert the fixed order User → Operator →
  membership read; reading membership first recreates the remove-member race.
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
- **`lockActiveMembership` preserves the admin bypass** — after locking the
  acting User and target Operator, ADMIN/SUPER_ADMIN succeeds without an
  `OperatorMember` row; ordinary OPERATOR users still require membership.
- **A concurrent `deleteUser` and a mutation correctly serialize** —
  integration-level, real database: start a transaction that calls
  `lockActiveMembership` then pauses before committing, run `deleteUser`
  on that same acting user concurrently, then let the first transaction
  attempt its commit — the loser (whichever executed its `updateMany`
  second, once unblocked) must see the other's committed state and abort.
- **A concurrent `deleteOperator` and a mutation correctly serialize** —
  same shape as above, but racing `deleteOperator` against the operator
  lock instead of the user lock.
- **Both `assignedOperatorId` writers lock the selected Operator** — unit
  tests for `assignOperator` and `handleQuoteSelected` simulate lock
  `count: 0` and assert no `RescueRequest` assignment update occurs.
- **A concurrent assignment and `deleteOperator` correctly serialize** —
  integration-level, real database: assignment-first makes deletion's fresh
  request read reject; deletion-first makes assignment's Operator lock reject.
- **Real PostgreSQL race matrix** — deterministic two-client integration
  tests cover both commit orders for deleteUser versus request creation,
  deleteUser versus customer Payment creation, deleteOperator versus
  assignment, and deleteOperator versus PAYOUT creation. Promise barriers,
  not sleeps, control lock acquisition; every test asserts final persisted
  rows as well as the rejected operation.
- **Integration cleanup includes `PendingMediaDeletion`** — add it explicitly
  to `truncateAll()` because it has no foreign key and is not removed by
  cascading truncation of the existing tables.
