# Rating Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After balance payment, prompt both the motorist and the operator on WhatsApp to rate each other 1-5, store both directions, send each a link to an unauthenticated web page for optional free-text feedback (single submission), and display the operator's average *received* rating on their own portal and the admin operators list.

**Architecture:** A `Rating` model with a `direction` enum (`MOTORIST_TO_OPERATOR` / `OPERATOR_TO_MOTORIST`) holds both directions, one row each, per completed `RescueRequest`. `handleBalancePaymentConfirmed` prompts and sets `WAITING_FOR_RATING` on *both* parties' sessions, each with its own 10-minute abandonment timeout. Two router branches (customer-side and operator-side) call one shared handler. A new unguarded `RatingController`/`RatingService` (mirroring the existing public `MediaController` pattern) serves the feedback page's read/write-once. Operator stats gain `averageRating`/`ratingCount`, scoped to ratings *received* only.

**Tech Stack:** NestJS + Prisma (`lrr-service`), Next.js + React (`lrr-web`), no CSS framework — inline `style={{}}`.

## Global Constraints

- One rating per `RescueRequest` per direction — enforced by `@@unique([rescueRequestId, direction])` on `Rating`, not just application logic. (Design spec, "Data model changes".)
- The operator-side `WAITING_FOR_RATING` check in `handleOperatorMessage` MUST be placed before the existing `if (/^\d+$/.test(message))` quote-parsing branch — that branch treats any bare digit as a dispatch-offer price quote unconditionally, and would silently swallow a rating reply otherwise. (Design spec, "Two router branches, one shared handler".)
- The feedback link's only access control is the rating's own `id` (unguessable `cuid()`) — no separate token field, no login. Sent to **both** directions (operator's rating of the motorist also gets a link, per human decision during spec revision). (Design spec, "Feedback web page".)
- `PATCH /ratings/:id` is single-submission — a second call on a row that already has a non-null `comment` returns `400`, not a silent overwrite. (Design spec, "Feedback web page" — corrects an earlier draft that allowed unlimited overwrites.)
- Operator stats' `averageRating`/`ratingCount` are scoped to `direction: MOTORIST_TO_OPERATOR` only — ratings the operator gave motorists must never leak into their own reputation figure. (Design spec, "Display".)
- No display surface for `OPERATOR_TO_MOTORIST` ratings this pass — collection only. (Design spec, "Non-goals".)
- Reuse the existing `FRONTEND_URL` env var (already used by `subscription.service.ts`) for the feedback link's base URL — do not introduce a new env var.
- **Accepted MVP limitation:** the rating-abandonment timeout uses in-memory `setTimeout` (same pattern as the existing `batchTimers`/`graceTimers` in this file) — if the service restarts, any abandoned `WAITING_FOR_RATING` session won't auto-clear until that party sends another message (SOS still works immediately regardless). No persistence/DB-backed scheduling is being built for this; documented here rather than engineered around, consistent with how this file's other in-memory timers already work.
- **In `handleRatingReply`, create the `Rating` row before clearing the session to `IDLE`**, not after — if `ratingService.create()` throws, the session must stay `WAITING_FOR_RATING` so the reviewer can retry, rather than the write being silently lost while the session has already moved on.

---

### Task 1: Prisma schema — `Rating` model + `WAITING_FOR_RATING` state

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/rescue-request/state/whatsapp-session.types.ts`

**Interfaces:**
- Produces: `Rating` model (`id, rescueRequestId, direction, operatorId, customerId, score, comment, createdAt`, unique on `[rescueRequestId, direction]`), `RatingDirection` enum, `WhatsAppFlowState.WAITING_FOR_RATING`. Tasks 2 and 3 depend on all three.

- [ ] **Step 1: Add the `RatingDirection` enum and `Rating` model**

In `prisma/schema.prisma`, find the end of `DispatchOffer`:

```prisma
model DispatchOffer {
  id               String              @id @default(cuid())

  rescueRequestId  String
  rescueRequest    RescueRequest       @relation(fields: [rescueRequestId], references: [id])

  operatorId       String
  operator         Operator            @relation(fields: [operatorId], references: [id])

  status           DispatchOfferStatus @default(PENDING)
  quotedPrice      Int?
  offeredAt        DateTime            @default(now())
  respondedAt      DateTime?
  expiresAt        DateTime

  @@index([rescueRequestId])
  @@index([operatorId])
  @@index([status])
}
```

Add directly after it (before the `// WhatsApp conversation sessions` comment):

```prisma
enum RatingDirection {
  MOTORIST_TO_OPERATOR
  OPERATOR_TO_MOTORIST
}

// Two-way post-job rating — one row per direction per completed job,
// collected via WhatsApp (score) and an optional unauthenticated web link
// (comment), sent right after balance payment confirms.
model Rating {
  id               String          @id @default(cuid())

  rescueRequestId  String
  rescueRequest    RescueRequest   @relation(fields: [rescueRequestId], references: [id])

  direction        RatingDirection

  operatorId       String
  operator         Operator        @relation(fields: [operatorId], references: [id])

  customerId       String
  customer         User            @relation(fields: [customerId], references: [id])

  score            Int
  comment          String?

  createdAt        DateTime        @default(now())

  @@unique([rescueRequestId, direction])
  @@index([operatorId])
  @@index([customerId])
}
```

- [ ] **Step 2: Add the back-relation fields**

In `model RescueRequest`, find:

```prisma
  dispatchOffers     DispatchOffer[]
  media              RequestMedia[]
```

Replace with:

```prisma
  dispatchOffers     DispatchOffer[]
  media              RequestMedia[]
  ratings            Rating[]
```

In `model Operator`, find:

```prisma
  members        OperatorMember[]
  rescueRequests RescueRequest[]
  dispatchOffers DispatchOffer[]
```

Replace with:

```prisma
  members        OperatorMember[]
  rescueRequests RescueRequest[]
  dispatchOffers DispatchOffer[]
  ratings        Rating[]
```

In `model User`, find:

```prisma
  operatorMemberships OperatorMember[]
  rescueRequests      RescueRequest[]
  subscriptions       Subscription[]
  whatsAppSession     WhatsAppSession?
```

Replace with:

```prisma
  operatorMemberships OperatorMember[]
  rescueRequests      RescueRequest[]
  subscriptions       Subscription[]
  whatsAppSession     WhatsAppSession?
  ratings             Rating[]
```

- [ ] **Step 3: Add `WAITING_FOR_RATING` to `WhatsAppFlowState`**

In `src/rescue-request/state/whatsapp-session.types.ts`, find:

```typescript
  WAITING_FOR_QUOTE_SELECTION = 'WAITING_FOR_QUOTE_SELECTION',
```

Add directly after it:

```typescript
  WAITING_FOR_QUOTE_SELECTION = 'WAITING_FOR_QUOTE_SELECTION',
  WAITING_FOR_RATING = 'WAITING_FOR_RATING',
```

(This single state is reused by both the customer's and the operator's own session — each party's session is independent, so there's no collision.)

- [ ] **Step 4: Generate and apply the migration**

```bash
export PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="<get explicit human approval first, exact text here>"
npx prisma migrate dev --name add_rating
```

Additive only (new table, new enum, no drops) — confirm the generated SQL before applying, per this project's established destructive-command approval pattern (explicit human sign-off before running `migrate dev` against the local dev DB).

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/rescue-request/state/whatsapp-session.types.ts
git commit -m "feat(schema): add two-way Rating model and WAITING_FOR_RATING state"
```

---

### Task 2: `RatingService` + public `RatingController`

**Files:**
- Create: `src/rating/rating.service.ts`
- Create: `src/rating/rating.controller.ts`
- Create: `src/rating/rating.module.ts`
- Create: `src/rating/dto/rating-response.dto.ts`
- Test: `src/rating/rating.service.spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `Rating` model, `RatingDirection` enum (Task 1).
- Produces: `RatingService.create({ rescueRequestId, direction, operatorId, customerId, score }): Promise<Rating>`, `RatingService.findById(id): Promise<Rating | null>`, `RatingService.setComment(id, comment): Promise<Rating>` (throws `BadRequestException` if a comment already exists, `NotFoundException` if the ID doesn't exist). `GET /api/v1/ratings/:id`, `PATCH /api/v1/ratings/:id` (both public, no guard). Task 3 consumes `create`. Task 5 consumes both endpoints.

- [ ] **Step 1: Write the failing test**

```typescript
// src/rating/rating.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RatingService } from './rating.service';
import { PrismaService } from '../prisma/prisma.service';

describe('RatingService', () => {
  let service: RatingService;
  let prisma: { rating: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      rating: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RatingService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<RatingService>(RatingService);
  });

  describe('create', () => {
    it('creates a rating row for the given direction', async () => {
      prisma.rating.create.mockResolvedValue({ id: 'rating-1', score: 5, direction: 'MOTORIST_TO_OPERATOR' });
      const result = await service.create({
        rescueRequestId: 'req-1', direction: 'MOTORIST_TO_OPERATOR', operatorId: 'op-1', customerId: 'cust-1', score: 5,
      });
      expect(prisma.rating.create).toHaveBeenCalledWith({
        data: { rescueRequestId: 'req-1', direction: 'MOTORIST_TO_OPERATOR', operatorId: 'op-1', customerId: 'cust-1', score: 5 },
      });
      expect(result.id).toBe('rating-1');
    });
  });

  describe('findById', () => {
    it('returns null when not found', async () => {
      prisma.rating.findUnique.mockResolvedValue(null);
      const result = await service.findById('missing');
      expect(result).toBeNull();
    });
  });

  describe('setComment', () => {
    it('throws NotFoundException when the rating does not exist', async () => {
      prisma.rating.findUnique.mockResolvedValue(null);
      await expect(service.setComment('missing', 'text')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when a comment already exists', async () => {
      prisma.rating.findUnique.mockResolvedValue({ id: 'rating-1', comment: 'already here' });
      await expect(service.setComment('rating-1', 'new text')).rejects.toThrow(BadRequestException);
      expect(prisma.rating.update).not.toHaveBeenCalled();
    });

    it('sets comment on a rating with no existing comment', async () => {
      prisma.rating.findUnique.mockResolvedValue({ id: 'rating-1', comment: null });
      prisma.rating.update.mockResolvedValue({ id: 'rating-1', comment: 'Great service' });
      const result = await service.setComment('rating-1', 'Great service');
      expect(prisma.rating.update).toHaveBeenCalledWith({
        where: { id: 'rating-1' },
        data: { comment: 'Great service' },
      });
      expect(result.comment).toBe('Great service');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest rating.service.spec.ts
```

Expected: FAIL — `Cannot find module './rating.service'`.

- [ ] **Step 3: Write `rating-response.dto.ts`**

```typescript
// src/rating/dto/rating-response.dto.ts
export class RatingDetailDto {
  ratedName: string;
  score: number;
  comment: string | null;
}
```

- [ ] **Step 4: Write `rating.service.ts`**

```typescript
// src/rating/rating.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Rating, RatingDirection } from '@prisma/client';

export interface CreateRatingInput {
  rescueRequestId: string;
  direction: RatingDirection;
  operatorId: string;
  customerId: string;
  score: number;
}

@Injectable()
export class RatingService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateRatingInput): Promise<Rating> {
    return this.prisma.rating.create({ data: input });
  }

  async findById(id: string): Promise<Rating | null> {
    return this.prisma.rating.findUnique({ where: { id } });
  }

  async setComment(id: string, comment: string): Promise<Rating> {
    const existing = await this.prisma.rating.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Rating not found');
    }
    if (existing.comment !== null) {
      throw new BadRequestException('Feedback already submitted for this rating.');
    }
    return this.prisma.rating.update({ where: { id }, data: { comment } });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx jest rating.service.spec.ts
```

Expected: PASS, all 5 tests green.

- [ ] **Step 6: Write `rating.controller.ts`**

Fully public — no `@UseGuards`, mirroring `src/media/media.controller.ts`'s existing pattern exactly. `ratedName` reveals only the operator's business name for a `MOTORIST_TO_OPERATOR` row, or the generic "the motorist" (no customer PII) for an `OPERATOR_TO_MOTORIST` row:

```typescript
// src/rating/rating.controller.ts
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RatingService } from './rating.service';
import { RatingDetailDto } from './dto/rating-response.dto';

@Controller('ratings')
export class RatingController {
  constructor(
    private readonly ratingService: RatingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get(':id')
  async detail(@Param('id') id: string): Promise<{ data: RatingDetailDto }> {
    const rating = await this.prisma.rating.findUnique({
      where: { id },
      include: { operator: { select: { businessName: true } } },
    });
    if (!rating) throw new NotFoundException('Rating not found');

    const ratedName = rating.direction === 'MOTORIST_TO_OPERATOR'
      ? rating.operator.businessName
      : 'the motorist';

    return {
      data: { ratedName, score: rating.score, comment: rating.comment },
    };
  }

  @Patch(':id')
  async updateComment(
    @Param('id') id: string,
    @Body() body: { comment: string },
  ): Promise<{ data: { comment: string | null } }> {
    if (!body.comment || !body.comment.trim()) {
      throw new BadRequestException('comment is required');
    }
    const updated = await this.ratingService.setComment(id, body.comment);
    return { data: { comment: updated.comment } };
  }
}
```

- [ ] **Step 7: Write `rating.module.ts`**

```typescript
// src/rating/rating.module.ts
import { Module } from '@nestjs/common';
import { RatingService } from './rating.service';
import { RatingController } from './rating.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [RatingController],
  providers: [RatingService],
  exports: [RatingService],
})
export class RatingModule {}
```

- [ ] **Step 8: Wire `RatingModule` into `AppModule`**

In `src/app.module.ts`, add the import and add `RatingModule` to the `imports` array, alongside `MediaModule`/`PlatformConfigModule`.

- [ ] **Step 9: Verify TypeScript compiles and the full suite passes**

```bash
npx tsc --noEmit
npx jest
```

Expected: no errors; all suites pass.

- [ ] **Step 10: Commit**

```bash
git add src/rating src/app.module.ts
git commit -m "feat(rating): add RatingService and public two-way rating endpoints"
```

---

### Task 3: WhatsApp flow — prompt, collect, and link (both directions)

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts`

**Interfaces:**
- Consumes: `RatingService.create` (Task 2), `WhatsAppFlowState.WAITING_FOR_RATING`, `RatingDirection` (Task 1).
- Produces: `Rating` rows created from WhatsApp replies, both directions. No other task depends on this one.

- [ ] **Step 1: Inject `RatingService`**

Add the import alongside the existing service imports in `rescue-request.service.ts` (search for `from '../platform-config/platform-config.service'` and add directly after):

```typescript
import { RatingService } from '../rating/rating.service';
import { RatingDirection } from '@prisma/client';
```

(Check the top of the file first — `@prisma/client` is very likely already imported for other enums like `RescueRequestStatus`/`UserRole`; add `RatingDirection` to that existing import list rather than a new separate import line.)

Find the constructor (search for `private readonly platformConfigService: PlatformConfigService,`) and add directly after it:

```typescript
    private readonly platformConfigService: PlatformConfigService,
    private readonly ratingService: RatingService,
```

- [ ] **Step 2: Wire `RatingModule` into `RescueRequestModule`**

In `src/rescue-request/rescue-request.module.ts`, add the import and add `RatingModule` to the `imports` array, alongside `PlatformConfigModule`.

- [ ] **Step 3: Add the rating-timeout constant and scheduler**

Add directly after the `graceTimers`/`QUOTE_GRACE_MS` fields near the top of the class (search for `private readonly QUOTE_GRACE_MS = 25 * 1000;` and add after it):

```typescript
  private readonly RATING_TIMEOUT_MS = 10 * 60 * 1000;

  /**
   * If a rating prompt goes unanswered, silently clear that party's session
   * back to IDLE after RATING_TIMEOUT_MS — ratings don't block anything, so
   * this is quiet cleanup, not a hard deadline. Checks the session is still
   * WAITING_FOR_RATING for the SAME rescueRequestId before clearing, so it
   * can't clobber a state the party has since moved past (already rated, or
   * started a fresh SOS).
   */
  private scheduleRatingTimeout(userId: string, rescueRequestId: string) {
    setTimeout(async () => {
      const fresh = await this.sessionStore.getOrCreate(userId);
      if (fresh.state === WhatsAppFlowState.WAITING_FOR_RATING && fresh.rescueRequestId === rescueRequestId) {
        await this.sessionStore.update(userId, { state: WhatsAppFlowState.IDLE, rescueRequestId: undefined });
      }
    }, this.RATING_TIMEOUT_MS);
  }
```

- [ ] **Step 4: Update `handleBalancePaymentConfirmed` — prompt both parties**

Find the entire method body from `// Notify customer` through the closing of the operator `if` block:

```typescript
    // Notify customer — payment confirmed
    const customerId    = rescueRequest.customerId;
    const customerPhone = rescueRequest.customer.phoneNumber;
    const balanceNaira  = ((rescueRequest.balanceAmount ?? 0) / 100).toLocaleString();
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `✅ Payment of ₦${balanceNaira} confirmed! Thank you for using Lagos Roadside Rescue 🙏`,
      );
    }
    // Clear customer session
    await this.sessionStore.update(customerId, {
      state: WhatsAppFlowState.IDLE,
      rescueRequestId: undefined,
    });

    // Notify operator — release the vehicle
    const operator = rescueRequest.assignedOperator;
    if (operator?.phoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `💵 *Payment received!*\n\nThe customer has paid the ₦${balanceNaira} balance in full.\n\n✅ You may now *release the vehicle*. Job complete — well done!\n\nYour payment will be remitted within 24 hours.`,
      );
      // Clear operator session
      const opUser = await this.findOrCreateCustomer(operator.phoneNumber);
      await this.sessionStore.update(opUser.id, {
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: undefined,
      });
    }
```

Replace with:

```typescript
    // Notify customer — payment confirmed, then prompt to rate the operator
    const customerId    = rescueRequest.customerId;
    const customerPhone = rescueRequest.customer.phoneNumber;
    const balanceNaira  = ((rescueRequest.balanceAmount ?? 0) / 100).toLocaleString();
    const operator = rescueRequest.assignedOperator;
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `✅ Payment of ₦${balanceNaira} confirmed! Thank you for using Lagos Roadside Rescue 🙏`,
      );
      const operatorName = operator?.businessName ?? 'your operator';
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `How was your experience with ${operatorName}? Reply with a number from 1 to 5 to rate them.`,
      );
    }
    await this.sessionStore.update(customerId, {
      state: WhatsAppFlowState.WAITING_FOR_RATING,
      rescueRequestId: rescueRequest.id,
    });
    this.scheduleRatingTimeout(customerId, rescueRequest.id);

    // Notify operator — release the vehicle, then prompt to rate the motorist
    if (operator?.phoneNumber) {
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `💵 *Payment received!*\n\nThe customer has paid the ₦${balanceNaira} balance in full.\n\n✅ You may now *release the vehicle*. Job complete — well done!\n\nYour payment will be remitted within 24 hours.`,
      );
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `How was your experience with this customer? Reply with a number from 1 to 5 to rate them.`,
      );
      const opUser = await this.findOrCreateCustomer(operator.phoneNumber);
      await this.sessionStore.update(opUser.id, {
        state: WhatsAppFlowState.WAITING_FOR_RATING,
        rescueRequestId: rescueRequest.id,
      });
      this.scheduleRatingTimeout(opUser.id, rescueRequest.id);
    }
```

- [ ] **Step 5: Add the customer-side router branch**

Find, in `handleIncomingWhatsAppMessage`:

```typescript
    // ── Step 4: Request active — searching for operator ───────────────────
    if (session.state === WhatsAppFlowState.REQUEST_CONFIRMED) {
      return this.reply(
        `🔍 We've received your request and are searching for the nearest operator.\n\nYou will be notified once one is confirmed. Reply CANCEL to cancel (no charge).`,
      );
    }

    return this.reply(
      `👋 Welcome to Lagos Roadside Rescue.\n\nSend HELP or SOS if you need roadside assistance.`,
    );
  }
```

Replace with:

```typescript
    // ── Step 4: Request active — searching for operator ───────────────────
    if (session.state === WhatsAppFlowState.REQUEST_CONFIRMED) {
      return this.reply(
        `🔍 We've received your request and are searching for the nearest operator.\n\nYou will be notified once one is confirmed. Reply CANCEL to cancel (no charge).`,
      );
    }

    // ── Step 5: Waiting for post-job rating (motorist rates operator) ─────
    if (session.state === WhatsAppFlowState.WAITING_FOR_RATING) {
      return this.handleRatingReply(
        userId, rawMessage, session.rescueRequestId, RatingDirection.MOTORIST_TO_OPERATOR,
      );
    }

    return this.reply(
      `👋 Welcome to Lagos Roadside Rescue.\n\nSend HELP or SOS if you need roadside assistance.`,
    );
  }
```

(Placed after the SOS/CANCEL checks near the top of the function, same section as `WAITING_FOR_LOCATION`/`WAITING_FOR_QUOTE_SELECTION` — SOS still supersedes an abandoned rating prompt, exactly like it already supersedes those states. Do not move this branch above the SOS/CANCEL checks.)

- [ ] **Step 6: Add the operator-side router branch — BEFORE the quote-parsing check**

Find, in `handleOperatorMessage`:

```typescript
  private async handleOperatorMessage(
    phoneNumber: string,
    userId: string,
    message: string,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    operator: { id: string; businessName: string; phoneNumber: string },
  ) {
    // ── Dispatch quote / decline ─────────────────────────────────────────
    if (message === 'no' || message === 'decline') {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, undefined);
    }
    if (/^\d+$/.test(message)) {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, Number(message) * 100);
    }
```

Replace with:

```typescript
  private async handleOperatorMessage(
    phoneNumber: string,
    userId: string,
    message: string,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    operator: { id: string; businessName: string; phoneNumber: string },
  ) {
    // ── Waiting for post-job rating (operator rates motorist) ─────────────
    // MUST come before the quote-parsing check below, which treats any bare
    // digit as a dispatch-offer price quote — without this ordering, a
    // rating reply would be silently swallowed as a bogus quote attempt.
    if (session.state === WhatsAppFlowState.WAITING_FOR_RATING) {
      return this.handleRatingReply(
        userId, message, session.rescueRequestId, RatingDirection.OPERATOR_TO_MOTORIST,
      );
    }

    // ── Dispatch quote / decline ─────────────────────────────────────────
    if (message === 'no' || message === 'decline') {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, undefined);
    }
    if (/^\d+$/.test(message)) {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, Number(message) * 100);
    }
```

(`message` here is the already-lowercased/trimmed version passed down from `handleIncomingWhatsAppMessage` — the same variable the existing quote-parsing branch already uses, so `handleRatingReply`'s numeric parsing works on it identically to the customer-side call.)

- [ ] **Step 7: Add the shared `handleRatingReply`**

Add this new private method near `handleQuoteSelected` (or any other convenient spot among the other private handler methods):

```typescript
  private async handleRatingReply(
    reviewerUserId: string,
    rawMessage: string,
    rescueRequestId: string | undefined,
    direction: RatingDirection,
  ) {
    const score = Number(rawMessage.trim());
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return this.reply(`Please reply with a number from 1 to 5.`);
    }

    if (!rescueRequestId) {
      await this.sessionStore.update(reviewerUserId, { state: WhatsAppFlowState.IDLE });
      return this.reply(`Thanks for your feedback!`);
    }

    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: { customerId: true, assignedOperatorId: true },
    });

    if (!rescueRequest?.assignedOperatorId) {
      await this.sessionStore.update(reviewerUserId, {
        state: WhatsAppFlowState.IDLE,
        rescueRequestId: undefined,
      });
      return this.reply(`Thanks for your feedback!`);
    }

    // Create the rating BEFORE clearing the session — if this throws (DB
    // error), the session stays WAITING_FOR_RATING so the reviewer's next
    // message re-enters this handler and can retry, instead of silently
    // losing the rating while the session has already moved to IDLE.
    const rating = await this.ratingService.create({
      rescueRequestId,
      direction,
      operatorId: rescueRequest.assignedOperatorId,
      customerId: rescueRequest.customerId,
      score,
    });

    await this.sessionStore.update(reviewerUserId, {
      state: WhatsAppFlowState.IDLE,
      rescueRequestId: undefined,
    });

    const frontendUrl = process.env.FRONTEND_URL ?? 'http://localhost:3001';
    return this.reply(
      `Thanks for rating us ${score}/5! 🙏\n\nWant to add more detail? Tell us more here: ${frontendUrl}/feedback/${rating.id}`,
    );
  }
```

(Note: `operatorId`/`customerId` on the created `Rating` are always the job's actual operator and customer, regardless of `direction` — `direction` alone records who authored this particular row.)

- [ ] **Step 8: Write tests for both `WAITING_FOR_RATING` branches**

The approved design spec explicitly calls for unit tests on both handler
branches. Check the top of `rescue-request.service.spec.ts` for the exact
existing import list and mock pattern (the file already has a
`describe('detailForUser — quote-compliance data', ...)` block with its
own local `beforeEach` building a fresh `TestingModule` with real
`jest.fn()` mocks, and a `describe('buildMediaLinksSection', ...)` block
that calls a private method directly via `(service as any).methodName(...)`
— follow both patterns together here). Add:

```typescript
  describe('handleRatingReply (via WhatsApp router)', () => {
    let ratingTestService: RescueRequestService;
    let prisma: { rescueRequest: { findUnique: jest.Mock } };
    let sessionStore: { update: jest.Mock; getOrCreate: jest.Mock };
    let ratingServiceMock: { create: jest.Mock };

    beforeEach(async () => {
      prisma = { rescueRequest: { findUnique: jest.fn() } };
      sessionStore = { update: jest.fn(), getOrCreate: jest.fn() };
      ratingServiceMock = { create: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: ratingServiceMock },
        ],
      }).compile();

      ratingTestService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('creates a MOTORIST_TO_OPERATOR rating for a valid customer-side reply', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ customerId: 'cust-1', assignedOperatorId: 'op-1' });
      ratingServiceMock.create.mockResolvedValue({ id: 'rating-1' });

      await (ratingTestService as any).handleRatingReply('cust-1', '5', 'req-1', 'MOTORIST_TO_OPERATOR');

      expect(ratingServiceMock.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1', direction: 'MOTORIST_TO_OPERATOR', operatorId: 'op-1', customerId: 'cust-1', score: 5,
      });
    });

    it('creates an OPERATOR_TO_MOTORIST rating for a valid operator-side reply', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ customerId: 'cust-1', assignedOperatorId: 'op-1' });
      ratingServiceMock.create.mockResolvedValue({ id: 'rating-2' });

      await (ratingTestService as any).handleRatingReply('op-user-1', '4', 'req-1', 'OPERATOR_TO_MOTORIST');

      expect(ratingServiceMock.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1', direction: 'OPERATOR_TO_MOTORIST', operatorId: 'op-1', customerId: 'cust-1', score: 4,
      });
    });

    it('re-prompts and does not create a rating for invalid input', async () => {
      await (ratingTestService as any).handleRatingReply('cust-1', 'banana', 'req-1', 'MOTORIST_TO_OPERATOR');

      expect(ratingServiceMock.create).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
    });

    it('re-prompts and does not create a rating for an out-of-range number', async () => {
      await (ratingTestService as any).handleRatingReply('cust-1', '7', 'req-1', 'MOTORIST_TO_OPERATOR');

      expect(ratingServiceMock.create).not.toHaveBeenCalled();
      expect(sessionStore.update).not.toHaveBeenCalled();
    });
  });

  describe('handleOperatorMessage — rating branch ordering', () => {
    let orderingService: RescueRequestService;
    let prisma: { operator: { findUnique: jest.Mock }; rescueRequest: { findUnique: jest.Mock } };
    let sessionStore: { update: jest.Mock };
    let ratingServiceMock: { create: jest.Mock };

    beforeEach(async () => {
      prisma = { operator: { findUnique: jest.fn() }, rescueRequest: { findUnique: jest.fn() } };
      sessionStore = { update: jest.fn() };
      ratingServiceMock = { create: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: ratingServiceMock },
        ],
      }).compile();

      orderingService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('routes a WAITING_FOR_RATING operator reply to the rating handler, not the quote parser', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ customerId: 'cust-1', assignedOperatorId: 'op-1' });
      ratingServiceMock.create.mockResolvedValue({ id: 'rating-3' });

      const session = { state: WhatsAppFlowState.WAITING_FOR_RATING, rescueRequestId: 'req-1' } as any;
      const operator = { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2341111111111' };

      await (orderingService as any).handleOperatorMessage('+2341111111111', 'op-user-1', '4', session, operator);

      // handleOperatorQuoteOrDecline's quote path always starts with an
      // operator.findUnique lookup — asserting it was never called proves
      // the numeric reply was routed to the rating handler instead, not
      // treated as a bogus price quote.
      expect(prisma.operator.findUnique).not.toHaveBeenCalled();
      expect(ratingServiceMock.create).toHaveBeenCalledWith({
        rescueRequestId: 'req-1', direction: 'OPERATOR_TO_MOTORIST', operatorId: 'op-1', customerId: 'cust-1', score: 4,
      });
    });
  });
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
npx jest rescue-request.service.spec.ts -t "handleRatingReply"
npx jest rescue-request.service.spec.ts -t "rating branch ordering"
```

Expected: PASS, all tests green, including the ordering regression test
from Step 8 fully implemented (not left as a stub).

- [ ] **Step 10: Verify TypeScript compiles and the full suite passes**

```bash
npx tsc --noEmit
npx jest
```

Expected: no errors; all suites pass.

- [ ] **Step 11: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts src/rescue-request/rescue-request.module.ts src/rescue-request/rescue-request.service.spec.ts
git commit -m "feat(rescue-request): collect two-way post-job ratings over WhatsApp"
```

---

### Task 4: Operator stats — `averageRating`/`ratingCount` (received only)

**Files:**
- Modify: `src/operator/operator.service.ts`

**Interfaces:**
- Consumes: `Rating` model, `RatingDirection` (Task 1).
- Produces: `OperatorStats` gains `averageRating: number | null`, `ratingCount: number` — scoped to `direction: MOTORIST_TO_OPERATOR` only. Tasks 6 and 7 consume this via the existing `GET /operators/:id/stats` and `GET /operators/all-stats` endpoints — no controller changes needed.

- [ ] **Step 1: Write the failing test**

Check `src/operator/operator.service.spec.ts` first for its existing mock/test-module setup pattern and match it. Add:

```typescript
describe('getOperatorStats — ratings', () => {
  it('includes averageRating and ratingCount, scoped to ratings received', async () => {
    (prisma.dispatchOffer.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.rating.aggregate as jest.Mock).mockResolvedValue({
      _avg: { score: 4.5 },
      _count: { score: 2 },
    });

    const result = await service.getOperatorStats('op-1');

    expect(prisma.rating.aggregate).toHaveBeenCalledWith({
      where: { operatorId: 'op-1', direction: 'MOTORIST_TO_OPERATOR' },
      _avg: { score: true },
      _count: { score: true },
    });
    expect(result.averageRating).toBe(4.5);
    expect(result.ratingCount).toBe(2);
  });

  it('returns null averageRating and 0 ratingCount for an operator with no ratings', async () => {
    (prisma.dispatchOffer.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.rating.aggregate as jest.Mock).mockResolvedValue({
      _avg: { score: null },
      _count: { score: 0 },
    });

    const result = await service.getOperatorStats('op-1');

    expect(result.averageRating).toBeNull();
    expect(result.ratingCount).toBe(0);
  });
});
```

Use whatever the file's actual mock variable is named (likely `prisma`) rather than assuming — check the top of `operator.service.spec.ts` first.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest operator.service.spec.ts -t "ratings"
```

Expected: FAIL — `averageRating`/`ratingCount` undefined, or `prisma.rating.aggregate` not called/mocked.

- [ ] **Step 3: Extend `OperatorStats` and `getOperatorStats`**

Find:

```typescript
export interface OperatorStats {
  totalOffered:      number;
  totalAccepted:     number;
  totalDeclined:     number;
  totalTimedOut:     number;
  acceptanceRate:    number;   // 0–1
  avgResponseSec:    number;   // seconds; null-safe (0 for new operators)
}
```

Replace with:

```typescript
export interface OperatorStats {
  totalOffered:      number;
  totalAccepted:     number;
  totalDeclined:     number;
  totalTimedOut:     number;
  acceptanceRate:    number;   // 0–1
  avgResponseSec:    number;   // seconds; null-safe (0 for new operators)
  averageRating:     number | null; // ratings RECEIVED from motorists only; null when zero ratings
  ratingCount:       number;
}
```

Find `getOperatorStats`:

```typescript
  async getOperatorStats(operatorId: string, days = 30): Promise<OperatorStats> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const offers = await this.prisma.dispatchOffer.findMany({
      where: { operatorId, offeredAt: { gte: since } },
      select: { status: true, offeredAt: true, respondedAt: true },
    });

    return this.computeStats(offers);
  }
```

Replace with:

```typescript
  async getOperatorStats(operatorId: string, days = 30): Promise<OperatorStats> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [offers, ratingAgg] = await Promise.all([
      this.prisma.dispatchOffer.findMany({
        where: { operatorId, offeredAt: { gte: since } },
        select: { status: true, offeredAt: true, respondedAt: true },
      }),
      this.prisma.rating.aggregate({
        where: { operatorId, direction: 'MOTORIST_TO_OPERATOR' },
        _avg: { score: true },
        _count: { score: true },
      }),
    ]);

    return {
      ...this.computeStats(offers),
      averageRating: ratingAgg._avg.score,
      ratingCount: ratingAgg._count.score,
    };
  }
```

(Ratings are NOT scoped to the `days` window, unlike offer stats — average rating is intentionally a lifetime figure. The `direction: 'MOTORIST_TO_OPERATOR'` filter is what keeps ratings this operator *gave* motorists out of their own reputation figure — do not drop it. `computeStats` must not already return keys named `averageRating`/`ratingCount` that this spread would silently clobber — verify by reading its current return shape before applying this step.)

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest operator.service.spec.ts -t "ratings"
```

Expected: PASS, both new tests green.

- [ ] **Step 5: Verify TypeScript compiles and the full suite passes**

```bash
npx tsc --noEmit
npx jest
```

Expected: no errors; all suites pass.

- [ ] **Step 6: Commit**

```bash
git add src/operator/operator.service.ts src/operator/operator.service.spec.ts
git commit -m "feat(operator): surface average received rating and rating count in operator stats"
```

---

### Task 5: `lrr-web` — feedback page (both directions)

**Files:**
- Create: `app/feedback/[ratingId]/page.tsx`
- Create: `app/hooks/useRatingApi.ts`
- Modify: `app/hooks/index.ts`

**Interfaces:**
- Consumes: `GET /ratings/:id`, `PATCH /ratings/:id` (Task 2).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Write `useRatingApi.ts`**

Follows the exact pattern already established by `useSettingsApi.ts`:

```typescript
// app/hooks/useRatingApi.ts
import { useCallback, useState } from "react";
import { apiFetch } from "./api";

export interface RatingDetail {
  ratedName: string;
  score: number;
  comment: string | null;
}

export function useRatingApi() {
  const [rating, setRating] = useState<RatingDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRating = useCallback(async (id: string): Promise<RatingDetail> => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/ratings/${id}`);
      const data = res.data as RatingDetail;
      setRating(data);
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load rating";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const submitComment = useCallback(async (id: string, comment: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/ratings/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to submit feedback";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { rating, loading, error, fetchRating, submitComment };
}
```

- [ ] **Step 2: Register the export**

Add to `app/hooks/index.ts`, alongside the other hook exports:

```typescript
export { useRatingApi } from "./useRatingApi";
export type { RatingDetail } from "./useRatingApi";
```

- [ ] **Step 3: Write the feedback page**

Used by both directions — the page shape is identical regardless of who's giving feedback, since `ratedName` already carries the right label from the backend:

```tsx
// app/feedback/[ratingId]/page.tsx
"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useRatingApi } from "../../hooks";

const dm = "var(--font-dm-sans), sans-serif";
const navy = "#07152f";
const blue = "#003DB4";

export default function FeedbackPage() {
  const params = useParams();
  const ratingId = String(params.ratingId);
  const { rating, loading, error, fetchRating, submitComment } = useRatingApi();

  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    fetchRating(ratingId).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratingId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitComment(ratingId, comment);
      setSubmitted(true);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to submit feedback");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#F6FAFF", fontFamily: dm, padding: "1.5rem",
    }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: "2rem", width: "100%", maxWidth: 440, boxShadow: "0 8px 40px rgba(0,0,0,0.1)" }}>
        {loading && !rating ? (
          <p style={{ color: "#999" }}>Loading…</p>
        ) : error && !rating ? (
          <p style={{ color: "#dc2626" }}>This feedback link isn&apos;t valid.</p>
        ) : rating ? (
          <>
            <h1 style={{ margin: "0 0 0.5rem 0", fontSize: "1.25rem", color: navy }}>
              Thanks for rating {rating.ratedName}
            </h1>
            <p style={{ margin: "0 0 1.5rem 0", color: "#6c7890", fontSize: "0.9rem" }}>
              You gave {rating.score}/5. Want to tell us more?
            </p>
            {rating.comment ? (
              <p style={{ color: "#19a56b", fontWeight: 600 }}>Feedback already received for this rating — thank you!</p>
            ) : submitted ? (
              <p style={{ color: "#19a56b", fontWeight: 600 }}>Thank you — your feedback has been recorded.</p>
            ) : (
              <form onSubmit={handleSubmit}>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Tell us more about your experience (optional)"
                  rows={5}
                  style={{ width: "100%", padding: "0.75rem", border: "1.5px solid #dde8f8", borderRadius: 8, fontFamily: dm, fontSize: "0.9rem", boxSizing: "border-box", marginBottom: "1rem" }}
                />
                {submitError && <p style={{ color: "#dc2626", fontSize: "0.85rem", marginBottom: "0.75rem" }}>{submitError}</p>}
                <button
                  type="submit"
                  disabled={submitting || !comment.trim()}
                  style={{ padding: "0.75rem 1.5rem", background: blue, color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, cursor: submitting ? "not-allowed" : "pointer" }}
                >
                  {submitting ? "Submitting…" : "Submit feedback"}
                </button>
              </form>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
```

(The `rating.comment ? ... : submitted ? ...` branch handles the case where someone reopens a link after already submitting — the backend's write-once `PATCH` would reject a second attempt anyway, but checking `rating.comment` client-side avoids showing a form that's guaranteed to fail.)

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Manual verification**

With the backend running, create ratings of both directions manually (or via the WhatsApp flow once Task 3 is live) and visit `/feedback/<ratingId>` for each. Confirm the name/score render correctly for both directions, submitting a comment shows the thank-you state, submitting a second time (or reloading after submitting) shows the "already received" message instead of the form, and an invalid/nonexistent ID shows the "not valid" message.

- [ ] **Step 6: Commit**

```bash
git add app/feedback app/hooks/useRatingApi.ts app/hooks/index.ts
git commit -m "feat(feedback): add public two-way rating feedback page"
```

---

### Task 6: `lrr-web` — operator portal ratings display

**Files:**
- Modify: `app/components/tabs/OverviewTabOperator.tsx`

**Interfaces:**
- Consumes: `fetchStats` from `useOperatorApi` (already exists — this task is its first caller in this component), `OperatorStats.averageRating`/`ratingCount` (Task 4, already scoped to ratings received).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Fetch stats on mount**

Read the current top of `OverviewTabOperator.tsx` first (`fetchMe`/`setAvailability` are already destructured from `useOperatorApi`) and add `fetchStats` to that same destructuring. Add a `stats` state variable and call `fetchStats(operator.id)` once the operator's own ID is known — check how `fetchMe`'s result is currently used before adding this, since the exact sequencing depends on existing state names in the file.

- [ ] **Step 2: Add a "Ratings" section**

Add a card/section (matching this file's existing card styling) showing:
- `stats.averageRating !== null ? stats.averageRating.toFixed(1) : "—"` with a "★" suffix.
- `stats.ratingCount` as "N ratings".
- If `stats.ratingCount === 0`, show "No ratings yet" instead of the above.

(This section shows ratings the operator has *received* from motorists only — `averageRating`/`ratingCount` are already scoped that way by Task 4, no additional filtering needed here.)

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Manual verification**

Log in as an operator with at least one received rating (from Task 3's WhatsApp flow, tested end-to-end) and confirm the average and count render correctly on their dashboard.

- [ ] **Step 5: Commit**

```bash
git add app/components/tabs/OverviewTabOperator.tsx
git commit -m "feat(operator): show average received rating on operator dashboard"
```

---

### Task 7: `lrr-web` — admin operators list rating column

**Files:**
- Modify: `app/components/tabs/OperatorsTab.tsx`

**Interfaces:**
- Consumes: `fetchAllStats` from `useOperatorApi` (already called in this file), `OperatorStats.averageRating`/`ratingCount` (Task 4).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Add an "Avg Rating" column**

`OperatorsTab.tsx` already calls `fetchAllStats()` and stores per-operator stats. Find wherever the existing stats (e.g. acceptance rate) are rendered as a table column, and add a sibling column: `stats.averageRating !== null ? \`${stats.averageRating.toFixed(1)} ★ (${stats.ratingCount})\` : "—"`. Match the existing column's header/cell styling exactly.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Manual verification**

Log in as admin, open the Operators tab, confirm the new column shows the correct average/count for an operator with received ratings and "—" for one without.

- [ ] **Step 4: Commit**

```bash
git add app/components/tabs/OperatorsTab.tsx
git commit -m "feat(admin): show average received rating in operators list"
```

---
