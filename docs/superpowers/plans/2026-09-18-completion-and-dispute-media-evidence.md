# Completion & Dispute Media Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make operators submit photo/video evidence before a job can be marked DONE, and let both the motorist and the operator attach photo/video evidence to their dispute statements — both viewable by admin staff, both reusing the existing WhatsApp media-capture mechanism.

**Architecture:** One additive Prisma migration adds a `context`/`uploadedByRole` pair to the existing `RequestMedia` table. Two WhatsApp session-state extensions (one new operator state for completion evidence, two existing dispute states gain media handling) reuse a generalized, now-shared `captureMediaAttachment`. The admin dashboard backend adds a role-gated `media` array alongside the existing `mediaLinks`; the frontend renders it grouped by context in the existing Details/Dispute tabs.

**Tech Stack:** NestJS, Prisma/PostgreSQL, Jest (unit + integration), Next.js/React (lrr-web), Twilio WhatsApp webhooks, S3.

**Spec:** docs/superpowers/specs/2026-09-18-completion-and-dispute-media-evidence-design.md

## Global Constraints

- Media cap is per-`(rescueRequestId, context, uploadedByRole)`, not per-request — 5 items (`MAX_MEDIA_ITEMS`) per bucket.
- Any "evidence provided" gate (completion DONE, and nowhere else) counts only `MediaType.IMAGE`/`MediaType.VIDEO` — never `AUDIO`. The 5-item cap counts all recognized types including `AUDIO`.
- `mapToDetailDto`'s new `media` array is populated only when `includeAllMedia` is `true`, passed `true` only from the `SUPER_ADMIN`/`ADMIN` branch of `detailForUser`. `OPERATOR`/`CUSTOMER` never receive it.
- `mediaLinks` (the existing flat array) keeps its shape and every current consumer's behavior unchanged — it gains a `context: INITIAL` filter, nothing else about it changes. There are **two independent producers** of this shape: `RescueRequestAdminService.mapToDetailDto` and `DispatchService.listMyPendingOffers` (`dispatch.service.ts:1235-1287`, unrelated code, its own `prisma.dispatchOffer.findMany` query) — both need the filter (Task 6), both get integration coverage (Task 7).
- `uploadedByRole` reuses the existing `UserRole` enum (`CUSTOMER`/`OPERATOR`) — no new enum for this.
- No admin ability to delete or moderate media in this plan (spec Non-Goals).
- No change to `buildMediaLinksSection` (`dispatch.service.ts`) — it only ever runs during dispatching, strictly before a request can reach `COMPLETED`/`DISPUTE` status, so `COMPLETION`/`DISPUTE` rows can never exist yet when it queries. Do not "fix" this — it is already safe by construction of the request lifecycle, not an oversight.

---

### Task 1: Schema migration — `MediaContext` + `RequestMedia` columns

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_media_context_and_uploaded_by_role/migration.sql`

**Interfaces:**
- Produces: `MediaContext` enum (`INITIAL`, `COMPLETION`, `DISPUTE`); `RequestMedia.context: MediaContext` (default `INITIAL`); `RequestMedia.uploadedByRole: UserRole` (default `CUSTOMER`); index `@@index([rescueRequestId, context, uploadedByRole])`. Every later task's Prisma queries depend on these exact field names.

- [ ] **Step 1: Add the enum and fields to the schema**

Open `prisma/schema.prisma`. Find the existing `RequestMedia` model (search for `model RequestMedia`). Add a new enum immediately above it, and add two fields plus a second index inside it:

```prisma
enum MediaContext {
  INITIAL
  COMPLETION
  DISPUTE
}

model RequestMedia {
  id String @id @default(cuid())

  rescueRequestId String
  rescueRequest   RescueRequest @relation(fields: [rescueRequestId], references: [id])

  mediaType   MediaType
  s3Key       String
  contentType String

  context        MediaContext @default(INITIAL)
  uploadedByRole UserRole     @default(CUSTOMER)

  createdAt DateTime @default(now())

  @@index([rescueRequestId])
  @@index([rescueRequestId, context, uploadedByRole])
}
```

This replaces the existing `RequestMedia` model definition (which today has no `context`/`uploadedByRole` fields and only the single `@@index([rescueRequestId])`) — do not leave two `model RequestMedia` blocks.

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name add_media_context_and_uploaded_by_role --create-only`

This creates `prisma/migrations/<timestamp>_add_media_context_and_uploaded_by_role/migration.sql` without applying it yet. Open the generated file and confirm it contains an `ALTER TABLE "RequestMedia"` adding both columns with their defaults, and a `CREATE TYPE "MediaContext"` — Prisma generates this automatically from the schema diff; do not hand-write it.

- [ ] **Step 3: Apply the migration and regenerate the client**

Run: `npx prisma migrate dev`

Expected: migration applies cleanly against your local dev database, `Prisma Client` regenerates, and `npx tsc --noEmit` from the repo root passes (existing code doesn't yet reference the new fields, so nothing should break).

- [ ] **Step 4: Verify the integration test database picks it up too**

Run: `npx prisma migrate deploy --schema prisma/schema.prisma` is not needed locally — instead confirm the integration suite's `globalSetup` (which applies real migrations against the Docker Postgres) will pick this up automatically in Task 7; no action needed here beyond confirming the migration file is committed in the next step.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add context and uploadedByRole to RequestMedia"
```

---

### Task 2: Shared plumbing — `captureMediaAttachment` signature, `body` threading, new session state

**Files:**
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts`
- Modify: `src/rescue-request/whatsapp-operator-flow.service.ts`
- Modify: `src/rescue-request/whatsapp-inbound.service.ts`
- Modify: `src/rescue-request/state/whatsapp-session.types.ts`
- Test: `src/rescue-request/whatsapp-customer-flow.service.spec.ts`

**Interfaces:**
- Consumes: `MediaContext`, `UserRole` from `@prisma/client` (Task 1).
- Produces: `WhatsAppCustomerFlowService.captureMediaAttachment(rescueRequestId: string, mediaUrl: string, contentType: string, context: MediaContext, uploadedByRole: UserRole): Promise<boolean>` (no longer `private`). `WhatsAppOperatorFlowService.handleOperatorMessage`'s signature gains a `body: Record<string, any>` last parameter. `WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA`. Tasks 3, 4, 5 all call `captureMediaAttachment` with this exact signature; Task 3 relies on `handleOperatorMessage` receiving `body`.

This task makes no user-visible behavior change — it's pure plumbing. The one existing call site (the `INITIAL` media step) is updated to pass explicit `MediaContext.INITIAL, UserRole.CUSTOMER` so behavior is provably unchanged.

- [ ] **Step 1: Write a failing test for the new `captureMediaAttachment` signature**

Open `src/rescue-request/whatsapp-customer-flow.service.spec.ts`. `WhatsAppCustomerFlowService`'s real constructor takes 14 dependencies beyond `prisma` (confirmed by reading `whatsapp-customer-flow.service.ts:56-77`: `twilioService, s3Service, geocodingService, ratingService, paystackService, platformConfigService, operatorService, dispatchService, disputeService, paymentEventsService, sessionStore, sharedService, paymentLedger, paystackCustomerService`) — a `TestingModule` missing any of these fails to `.compile()`. Reuse the file's own existing complete provider list verbatim (see the `describe('handleRatingReply', ...)` block already in this file, lines 25-65, which has the full working list including the `PaymentLedgerService`/`PaystackCustomerService` mock-factory imports) rather than a reduced one:

```typescript
describe('captureMediaAttachment', () => {
  let service: WhatsAppCustomerFlowService;
  let prisma: { requestMedia: { create: jest.Mock } };
  let twilioService: { downloadMedia: jest.Mock };
  let s3Service: { uploadMedia: jest.Mock };

  beforeEach(async () => {
    prisma = { requestMedia: { create: jest.fn().mockResolvedValue({}) } };
    twilioService = {
      downloadMedia: jest.fn().mockResolvedValue(Buffer.from('fake')),
    };
    s3Service = { uploadMedia: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppCustomerFlowService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentLedgerService, useValue: createPaymentLedgerMock() },
        { provide: PaystackCustomerService, useValue: createPaystackCustomerServiceMock() },
        { provide: TwilioService, useValue: twilioService },
        { provide: S3Service, useValue: s3Service },
        { provide: GeocodingService, useValue: {} },
        { provide: RatingService, useValue: {} },
        { provide: PaystackService, useValue: {} },
        { provide: PlatformConfigService, useValue: {} },
        { provide: OperatorService, useValue: {} },
        { provide: DispatchService, useValue: {} },
        { provide: DisputeService, useValue: {} },
        { provide: PaymentEventsService, useValue: {} },
        { provide: WhatsAppSessionStore, useValue: {} },
        { provide: RescueRequestSharedService, useValue: {} },
      ],
    }).compile();

    service = module.get<WhatsAppCustomerFlowService>(
      WhatsAppCustomerFlowService,
    );
  });

  it('saves the row tagged with the context and uploader role it was called with', async () => {
    const saved = await service.captureMediaAttachment(
      'req-1',
      'https://twilio.example/media/1',
      'image/jpeg',
      MediaContext.COMPLETION,
      UserRole.OPERATOR,
    );

    expect(saved).toBe(true);
    expect(prisma.requestMedia.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rescueRequestId: 'req-1',
        mediaType: MediaType.IMAGE,
        context: MediaContext.COMPLETION,
        uploadedByRole: UserRole.OPERATOR,
      }),
    });
  });
});
```

Add `MediaContext` and `UserRole` to the existing `import { RescueRequestStatus, VehicleType, MediaType, RatingDirection } from '@prisma/client';` line at the top of the spec file (and confirm the same import exists in the spec file already, or add it).

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx jest whatsapp-customer-flow.service.spec.ts -t "captureMediaAttachment"`
Expected: FAIL — `captureMediaAttachment` doesn't accept a 4th/5th argument yet, and isn't public, so this either doesn't compile or the created row lacks `context`/`uploadedByRole`.

- [ ] **Step 3: Update `captureMediaAttachment`'s signature and body**

In `src/rescue-request/whatsapp-customer-flow.service.ts`, find the existing method (currently `private async captureMediaAttachment(rescueRequestId: string, mediaUrl: string, contentType: string): Promise<boolean>`, around line 598). Replace it:

```typescript
  /**
   * Downloads a Twilio media attachment and stores it as a RequestMedia
   * row. Returns false (rather than throwing) on any failure — a single
   * bad attachment must not break the rest of the batch or the flow.
   * Shared across the customer and operator flows (see
   * WhatsAppOperatorFlowService, which calls this via its injected
   * customerFlowService) — context/uploadedByRole let every caller tag
   * which of INITIAL/COMPLETION/DISPUTE this attachment belongs to and who
   * sent it.
   */
  async captureMediaAttachment(
    rescueRequestId: string,
    mediaUrl: string,
    contentType: string,
    context: MediaContext,
    uploadedByRole: UserRole,
  ): Promise<boolean> {
    const mediaType = classifyMediaType(contentType);
    if (!mediaType) return false;

    try {
      const buffer = await this.twilioService.downloadMedia(mediaUrl);
      const extension = getExtensionFromContentType(contentType);
      const s3Key = `rescue-requests/${rescueRequestId}/${crypto.randomUUID()}.${extension}`;

      await this.s3Service.uploadMedia(buffer, contentType, s3Key);

      await this.prisma.requestMedia.create({
        data: {
          rescueRequestId,
          mediaType,
          s3Key,
          contentType,
          context,
          uploadedByRole,
        },
      });

      logger.info('media: attachment saved', {
        rescueRequestId,
        mediaType,
        context,
        uploadedByRole,
        contentType,
      });
      return true;
    } catch (error) {
      console.error('Failed to capture media attachment:', error);
      Sentry.captureException(error);
      return false;
    }
  }
```

Add `MediaContext` and `UserRole` to the file's existing `@prisma/client` import (currently `import { RescueRequestStatus, VehicleType, MediaType, RatingDirection } from '@prisma/client';`).

- [ ] **Step 4: Update the one existing call site**

Still in `whatsapp-customer-flow.service.ts`, find the call inside the `WAITING_FOR_MEDIA` branch (around line 528):

```typescript
        const saved = await this.captureMediaAttachment(
          rescueRequestId,
          mediaUrl,
          contentType,
        );
```

Replace with:

```typescript
        const saved = await this.captureMediaAttachment(
          rescueRequestId,
          mediaUrl,
          contentType,
          MediaContext.INITIAL,
          UserRole.CUSTOMER,
        );
```

- [ ] **Step 5: Run the test again, confirm it passes**

Run: `npx jest whatsapp-customer-flow.service.spec.ts -t "captureMediaAttachment"`
Expected: PASS.

- [ ] **Step 6: Run the whole customer-flow spec file to confirm no regression**

Run: `npx jest whatsapp-customer-flow.service.spec.ts`
Expected: all existing tests still PASS — the `INITIAL`/`CUSTOMER` call site behaves identically to before.

- [ ] **Step 7: Add the new session state**

In `src/rescue-request/state/whatsapp-session.types.ts`, find the `// ── Operator states ──` section of the `WhatsAppFlowState` enum and add a new member after `OPERATOR_AT_LOCATION`:

```typescript
  // Set after operator sends DONE — operator must submit at least one
  // photo/video before the job actually completes.
  OPERATOR_AWAITING_COMPLETION_MEDIA = 'OPERATOR_AWAITING_COMPLETION_MEDIA',
```

- [ ] **Step 8: Thread `body` into `handleOperatorMessage`**

In `src/rescue-request/whatsapp-operator-flow.service.ts`, change the method signature (around line 36):

```typescript
  async handleOperatorMessage(
    phoneNumber: string,
    userId: string,
    message: string,
    rawMessage: string,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    operator: { id: string; businessName: string; phoneNumber: string },
    body: Record<string, any>,
  ) {
```

In `src/rescue-request/whatsapp-inbound.service.ts`, update the call site (around line 74-81) to pass `body` through:

```typescript
      return this.operatorFlow.handleOperatorMessage(
        phoneNumber,
        userId,
        message,
        rawMessage,
        session,
        operatorRecord,
        body,
      );
```

- [ ] **Step 9: Confirm the whole repo still typechecks and the operator-flow spec still passes**

Run: `npx tsc --noEmit`
Expected: clean — the operator-flow spec file's existing calls to `handleOperatorMessage` (which don't pass a 7th argument yet) would now fail to typecheck as a required param; add `, {}` as the 7th argument to every existing call in `whatsapp-operator-flow.service.spec.ts` that doesn't need real body data (grep the spec file for `handleOperatorMessage(` and add `{}` after every call's `operator` argument).

Run: `npx jest whatsapp-operator-flow.service.spec.ts`
Expected: all existing tests PASS.

- [ ] **Step 10: Commit**

```bash
git add src/rescue-request/whatsapp-customer-flow.service.ts src/rescue-request/whatsapp-customer-flow.service.spec.ts src/rescue-request/whatsapp-operator-flow.service.ts src/rescue-request/whatsapp-operator-flow.service.spec.ts src/rescue-request/whatsapp-inbound.service.ts src/rescue-request/state/whatsapp-session.types.ts
git commit -m "refactor: share captureMediaAttachment across flows, thread body into operator messages"
```

---

### Task 3: Completion evidence flow

**Files:**
- Modify: `src/rescue-request/whatsapp-operator-flow.service.ts`
- Test: `src/rescue-request/whatsapp-operator-flow.service.spec.ts`

**Interfaces:**
- Consumes: `WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA` (Task 2), `captureMediaAttachment(...)` (Task 2), `handleOperatorMessage`'s `body` param (Task 2).
- Produces: nothing new consumed by later tasks — this task's deliverable is self-contained operator-facing behavior.

- [ ] **Step 1: Write a failing test — DONE no longer completes the job immediately**

Add to `src/rescue-request/whatsapp-operator-flow.service.spec.ts`, in a new `describe` block matching the file's existing per-scenario setup pattern (mock `PrismaService`, `WhatsAppSessionStore`, etc. — copy the `beforeEach` shape from the file's other `describe` blocks):

```typescript
describe('handleOperatorMessage — completion evidence', () => {
  let service: WhatsAppOperatorFlowService;
  let prisma: {
    operator: { findUnique: jest.Mock };
    rescueRequest: { findUnique: jest.Mock; update: jest.Mock };
    requestMedia: { count: jest.Mock };
  };
  let sessionStore: { update: jest.Mock; clear: jest.Mock };
  let customerFlowService: { captureMediaAttachment: jest.Mock };

  beforeEach(async () => {
    prisma = {
      operator: { findUnique: jest.fn() },
      rescueRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'req-1',
          status: 'OPERATOR_ASSIGNED',
          customer: { phoneNumber: '+2348010000000' },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      requestMedia: { count: jest.fn() },
    };
    sessionStore = {
      update: jest.fn().mockResolvedValue(undefined),
      clear: jest.fn().mockResolvedValue(undefined),
    };
    customerFlowService = {
      captureMediaAttachment: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppOperatorFlowService,
        { provide: PrismaService, useValue: prisma },
        { provide: TwilioService, useValue: {} },
        { provide: DispatchService, useValue: {} },
        { provide: PaymentEventsService, useValue: {} },
        { provide: WhatsAppCustomerFlowService, useValue: customerFlowService },
        { provide: WhatsAppSessionStore, useValue: sessionStore },
        { provide: PlatformConfigService, useValue: {} },
      ],
    }).compile();

    service = module.get<WhatsAppOperatorFlowService>(
      WhatsAppOperatorFlowService,
    );
  });

  it('DONE transitions to awaiting-media instead of completing the job', async () => {
    const session = {
      state: WhatsAppFlowState.OPERATOR_AT_LOCATION,
      rescueRequestId: 'req-1',
    } as any;
    const operator = {
      id: 'op-1',
      businessName: 'Swift Towing',
      phoneNumber: '+2341111111111',
    };

    await service.handleOperatorMessage(
      '+2341111111111',
      'op-user-1',
      'done',
      'done',
      session,
      operator,
      {},
    );

    expect(sessionStore.update).toHaveBeenCalledWith('op-user-1', {
      state: WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA,
    });
    expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
  });

  it('rejects "2" (continue) with zero visual evidence saved', async () => {
    prisma.requestMedia.count.mockResolvedValue(0);
    const session = {
      state: WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA,
      rescueRequestId: 'req-1',
    } as any;
    const operator = {
      id: 'op-1',
      businessName: 'Swift Towing',
      phoneNumber: '+2341111111111',
    };

    const result = await service.handleOperatorMessage(
      '+2341111111111',
      'op-user-1',
      '2',
      '2',
      session,
      operator,
      {},
    );

    expect(result).toContain('at least one');
    expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
  });

  it('a voice-note-only submission does not satisfy the gate', async () => {
    // visualCount (IMAGE|VIDEO only) stays 0 even though a row exists —
    // the mock's count() is called with a mediaType filter; return 0
    // regardless of args to simulate "only an AUDIO row exists".
    prisma.requestMedia.count.mockResolvedValue(0);
    const session = {
      state: WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA,
      rescueRequestId: 'req-1',
    } as any;
    const operator = {
      id: 'op-1',
      businessName: 'Swift Towing',
      phoneNumber: '+2341111111111',
    };

    const result = await service.handleOperatorMessage(
      '+2341111111111',
      'op-user-1',
      '2',
      '2',
      session,
      operator,
      {},
    );

    expect(result).toContain('at least one');
  });

  it('saves an attachment and, once visual evidence exists, "2" completes the job', async () => {
    prisma.requestMedia.count.mockResolvedValue(1);
    const session = {
      state: WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA,
      rescueRequestId: 'req-1',
    } as any;
    const operator = {
      id: 'op-1',
      businessName: 'Swift Towing',
      phoneNumber: '+2341111111111',
    };

    await service.handleOperatorMessage(
      '+2341111111111',
      'op-user-1',
      '2',
      '2',
      session,
      operator,
      {},
    );

    expect(prisma.rescueRequest.update).toHaveBeenCalled();
  });

  it('saves media sent while awaiting completion evidence, tagged COMPLETION/OPERATOR', async () => {
    const session = {
      state: WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA,
      rescueRequestId: 'req-1',
    } as any;
    const operator = {
      id: 'op-1',
      businessName: 'Swift Towing',
      phoneNumber: '+2341111111111',
    };

    await service.handleOperatorMessage(
      '+2341111111111',
      'op-user-1',
      '',
      '',
      session,
      operator,
      {
        NumMedia: '1',
        MediaUrl0: 'https://twilio.example/media/9',
        MediaContentType0: 'image/jpeg',
      },
    );

    expect(customerFlowService.captureMediaAttachment).toHaveBeenCalledWith(
      'req-1',
      'https://twilio.example/media/9',
      'image/jpeg',
      MediaContext.COMPLETION,
      UserRole.OPERATOR,
    );
  });

  it('5 voice notes are never saved and never consume the cap — a photo afterward still satisfies the gate', async () => {
    const session = {
      state: WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA,
      rescueRequestId: 'req-1',
    } as any;
    const operator = {
      id: 'op-1',
      businessName: 'Swift Towing',
      phoneNumber: '+2341111111111',
    };

    // 5 audio attachments in one message — the per-role cap is 5, so if
    // audio counted toward it, this alone would exhaust it.
    const audioBody: Record<string, string> = { NumMedia: '5' };
    for (let i = 0; i < 5; i++) {
      audioBody[`MediaUrl${i}`] = `https://twilio.example/media/audio-${i}`;
      audioBody[`MediaContentType${i}`] = 'audio/ogg';
    }

    const audioResult = await service.handleOperatorMessage(
      '+2341111111111',
      'op-user-1',
      '',
      '',
      session,
      operator,
      audioBody,
    );

    expect(customerFlowService.captureMediaAttachment).not.toHaveBeenCalled();
    expect(audioResult).toContain("aren't used as completion evidence");

    // A photo sent next — existingCount is still 0 (nothing was ever
    // saved), so this must succeed, not hit the cap.
    await service.handleOperatorMessage(
      '+2341111111111',
      'op-user-1',
      '',
      '',
      session,
      operator,
      {
        NumMedia: '1',
        MediaUrl0: 'https://twilio.example/media/photo',
        MediaContentType0: 'image/jpeg',
      },
    );

    expect(customerFlowService.captureMediaAttachment).toHaveBeenCalledWith(
      'req-1',
      'https://twilio.example/media/photo',
      'image/jpeg',
      MediaContext.COMPLETION,
      UserRole.OPERATOR,
    );

    // And "2" now succeeds — visualCount reflects the photo just saved.
    prisma.requestMedia.count.mockResolvedValue(1);
    await service.handleOperatorMessage(
      '+2341111111111',
      'op-user-1',
      '2',
      '2',
      session,
      operator,
      {},
    );
    expect(prisma.rescueRequest.update).toHaveBeenCalled();
  });
});
```

Add `MediaContext, UserRole, MediaType` to whatever `@prisma/client` import already exists at the top of `whatsapp-operator-flow.service.spec.ts` (add the import line if none exists yet).

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx jest whatsapp-operator-flow.service.spec.ts -t "completion evidence"`
Expected: FAIL — none of this branching exists yet.

- [ ] **Step 3: Change the DONE branch to transition instead of complete**

In `src/rescue-request/whatsapp-operator-flow.service.ts`, find the existing DONE/COMPLETE/FINISHED branch (around line 199-228):

```typescript
    // ── Job DONE — prompt customer to confirm ──────────────────────────────
    if (
      message === 'done' ||
      message === 'complete' ||
      message === 'finished'
    ) {
      if (
        session.state !== WhatsAppFlowState.OPERATOR_AT_LOCATION ||
        !session.rescueRequestId
      ) {
        logger.info('whatsapp: DONE rejected — wrong session state', {
          operatorId: operator.id,
          sessionState: session.state,
          rescueRequestId: session.rescueRequestId,
        });
        return this.reply(
          `Please send ARRIVED first when you reach the customer location.`,
        );
      }
      logger.info('whatsapp: DONE accepted', {
        operatorId: operator.id,
        rescueRequestId: session.rescueRequestId,
      });
      return this.handleOperatorJobDone(
        phoneNumber,
        userId,
        session.rescueRequestId,
        operator,
      );
    }
```

Replace the final block (from `logger.info('whatsapp: DONE accepted'` through the closing `}`) with:

```typescript
      logger.info('whatsapp: DONE accepted — awaiting completion evidence', {
        operatorId: operator.id,
        rescueRequestId: session.rescueRequestId,
      });
      await this.sessionStore.update(userId, {
        state: WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA,
      });
      return this.reply(
        `📸 Please send at least one photo or video showing the completed job.`,
      );
    }
```

**Voice notes are not accepted for completion evidence at all** — unlike `INITIAL`, where a voice note is a welcome extra alongside a required photo. Here, the required-visual gate (below) counts only `IMAGE`/`VIDEO`, but the 5-item cap originally counted every saved type including `AUDIO` — so 5 voice notes would exhaust the cap while `visualCount` stayed 0, permanently blocking the operator from ever submitting the one photo the gate demands, with no way out short of staff intervention. Fixed by not saving `AUDIO` for this context at all, so it can never consume a cap slot.

- [ ] **Step 4: Add the new branch handling `OPERATOR_AWAITING_COMPLETION_MEDIA`**

Still in `whatsapp-operator-flow.service.ts`, add a new branch. Place it directly after the DONE branch you just edited (before the `── Contextual help ──` section):

```typescript
    // ── Awaiting completion evidence ────────────────────────────────────
    if (session.state === WhatsAppFlowState.OPERATOR_AWAITING_COMPLETION_MEDIA) {
      const rescueRequestId = session.rescueRequestId;
      if (!rescueRequestId) {
        await this.sessionStore.update(userId, {
          state: WhatsAppFlowState.OPERATOR_ON_JOB,
        });
        return this.reply(
          `Sorry, we lost track of this job. Please send ARRIVED/DONE again.`,
        );
      }

      if (message === '1') {
        return this.reply(`Go ahead — send your photo(s) or video(s).`);
      }

      if (message === '2') {
        const visualCount = await this.prisma.requestMedia.count({
          where: {
            rescueRequestId,
            context: MediaContext.COMPLETION,
            uploadedByRole: UserRole.OPERATOR,
            mediaType: { in: [MediaType.IMAGE, MediaType.VIDEO] },
          },
        });
        if (visualCount === 0) {
          return this.reply(
            `Please send at least one photo or video before continuing.`,
          );
        }
        return this.handleOperatorJobDone(
          phoneNumber,
          userId,
          rescueRequestId,
          operator,
        );
      }

      const numMedia = Number(body.NumMedia ?? 0);
      if (numMedia === 0) {
        return this.reply(
          `Please send at least one photo or video.\n\n1️⃣ Add more\n2️⃣ Continue`,
        );
      }

      const existingCount = await this.prisma.requestMedia.count({
        where: {
          rescueRequestId,
          context: MediaContext.COMPLETION,
          uploadedByRole: UserRole.OPERATOR,
        },
      });
      let savedCount = existingCount;
      let failedCount = 0;
      let audioSkipped = 0;
      let capReached = false;

      for (let i = 0; i < numMedia; i++) {
        const mediaUrl: string | undefined = body[`MediaUrl${i}`];
        const contentType: string | undefined = body[`MediaContentType${i}`];
        if (!mediaUrl || !contentType) continue;

        // Audio is never saved for completion evidence — see the note on
        // Step 3's reply copy above. Checked before the cap, not after, so
        // a voice note can never consume a slot a genuine photo/video needs.
        if (classifyMediaType(contentType) === MediaType.AUDIO) {
          audioSkipped++;
          continue;
        }

        if (savedCount >= MAX_MEDIA_ITEMS) {
          capReached = true;
          break;
        }

        const saved = await this.customerFlowService.captureMediaAttachment(
          rescueRequestId,
          mediaUrl,
          contentType,
          MediaContext.COMPLETION,
          UserRole.OPERATOR,
        );
        if (saved) {
          savedCount++;
        } else {
          failedCount++;
        }
      }

      const capNote = capReached
        ? `\n\n⚠️ You've reached the ${MAX_MEDIA_ITEMS}-item limit — further attachments won't be saved.`
        : '';
      const failNote =
        failedCount > 0
          ? `\n\n⚠️ ${failedCount} item(s) failed to upload — please resend if important.`
          : '';
      const audioNote =
        audioSkipped > 0
          ? `\n\n🎤 Voice notes aren't used as completion evidence — please send a photo or video instead.`
          : '';

      return this.reply(
        `📸 Received (${savedCount}/${MAX_MEDIA_ITEMS} items saved).${capNote}${failNote}${audioNote}\n\n1️⃣ Add more\n2️⃣ Continue`,
      );
    }
```

Add `MediaContext, UserRole, MediaType` to the file's `@prisma/client` import (currently `import { RescueRequestStatus, RatingDirection, VehicleType } from '@prisma/client';`), add `import { classifyMediaType } from './domain/media-classification';` (this file doesn't currently import it — `whatsapp-customer-flow.service.ts` does), and add a `MAX_MEDIA_ITEMS = 5` constant near the top of the file (matching the constant already defined in `whatsapp-customer-flow.service.ts` — this file doesn't currently have its own copy).

- [ ] **Step 5: Run the tests, confirm they pass**

Run: `npx jest whatsapp-operator-flow.service.spec.ts -t "completion evidence"`
Expected: PASS, all 5 new tests.

- [ ] **Step 6: Run the whole operator-flow spec file to confirm no regression**

Run: `npx jest whatsapp-operator-flow.service.spec.ts`
Expected: all tests PASS — confirmed via `grep -n "'done'" whatsapp-operator-flow.service.spec.ts` that no existing test in this file exercises the DONE branch today, so there is nothing pre-existing to update here.

- [ ] **Step 7: Commit**

```bash
git add src/rescue-request/whatsapp-operator-flow.service.ts src/rescue-request/whatsapp-operator-flow.service.spec.ts
git commit -m "feat: require photo/video evidence before a job can be marked DONE"
```

---

### Task 4: Dispute evidence — motorist side

**Files:**
- Modify: `src/rescue-request/whatsapp-customer-flow.service.ts`
- Test: `src/rescue-request/whatsapp-customer-flow.service.spec.ts`

**Interfaces:**
- Consumes: `captureMediaAttachment(...)` (Task 2, now on `this` directly since this is the customer flow itself).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write a failing test**

Add to `src/rescue-request/whatsapp-customer-flow.service.spec.ts`, a new `describe` block. Use the file's full, real provider list (same 14-dependency set as Task 2's test — see `whatsapp-customer-flow.service.ts:56-77`), and give the `prisma` stub a `requestMedia` object: the implementation this test drives calls both `prisma.requestMedia.count` (the per-role cap check) and `prisma.requestMedia.create` (inside `captureMediaAttachment`, via `twilioService`/`s3Service`):

```typescript
describe('handleCustomerMessage — dispute evidence', () => {
  let service: WhatsAppCustomerFlowService;
  let prisma: {
    rescueRequest: { update: jest.Mock; findUnique: jest.Mock };
    requestMedia: { count: jest.Mock; create: jest.Mock };
  };
  let sessionStore: { update: jest.Mock };
  let twilioService: { downloadMedia: jest.Mock };
  let s3Service: { uploadMedia: jest.Mock };

  beforeEach(async () => {
    prisma = {
      rescueRequest: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
      },
      requestMedia: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    sessionStore = { update: jest.fn().mockResolvedValue(undefined) };
    twilioService = {
      downloadMedia: jest.fn().mockResolvedValue(Buffer.from('fake')),
    };
    s3Service = { uploadMedia: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppCustomerFlowService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentLedgerService, useValue: createPaymentLedgerMock() },
        { provide: PaystackCustomerService, useValue: createPaystackCustomerServiceMock() },
        { provide: TwilioService, useValue: twilioService },
        { provide: S3Service, useValue: s3Service },
        { provide: GeocodingService, useValue: {} },
        { provide: RatingService, useValue: {} },
        { provide: PaystackService, useValue: {} },
        { provide: PlatformConfigService, useValue: {} },
        { provide: OperatorService, useValue: {} },
        { provide: DispatchService, useValue: {} },
        { provide: DisputeService, useValue: {} },
        { provide: PaymentEventsService, useValue: {} },
        { provide: WhatsAppSessionStore, useValue: sessionStore },
        { provide: RescueRequestSharedService, useValue: {} },
      ],
    }).compile();

    service = module.get<WhatsAppCustomerFlowService>(
      WhatsAppCustomerFlowService,
    );
  });

  it('text-only statement ends the state exactly as before', async () => {
    const session = {
      state: WhatsAppFlowState.AWAITING_DISPUTE_REASON,
      rescueRequestId: 'req-1',
    } as any;

    await service.handleCustomerMessage(
      '+2348010000000',
      'cust-1',
      'the operator never showed up',
      'the operator never showed up',
      undefined,
      undefined,
      undefined,
      session,
      {},
    );

    expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { customerDisputeStatement: 'the operator never showed up' },
    });
    expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
      state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
    });
  });

  it('media with no text saves the attachment and stays in the same state', async () => {
    const session = {
      state: WhatsAppFlowState.AWAITING_DISPUTE_REASON,
      rescueRequestId: 'req-1',
    } as any;

    const result = await service.handleCustomerMessage(
      '+2348010000000',
      'cust-1',
      '',
      '',
      undefined,
      undefined,
      undefined,
      session,
      {
        NumMedia: '1',
        MediaUrl0: 'https://twilio.example/media/7',
        MediaContentType0: 'image/jpeg',
      },
    );

    expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    expect(sessionStore.update).not.toHaveBeenCalled();
    expect(result).toContain('Got it');
  });

  it('media plus text saves the attachment and ends the state', async () => {
    const session = {
      state: WhatsAppFlowState.AWAITING_DISPUTE_REASON,
      rescueRequestId: 'req-1',
    } as any;

    await service.handleCustomerMessage(
      '+2348010000000',
      'cust-1',
      'see attached',
      'see attached',
      undefined,
      undefined,
      undefined,
      session,
      {
        NumMedia: '1',
        MediaUrl0: 'https://twilio.example/media/8',
        MediaContentType0: 'image/jpeg',
      },
    );

    expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: { customerDisputeStatement: 'see attached' },
    });
    expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
      state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
    });
    expect(s3Service.uploadMedia).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx jest whatsapp-customer-flow.service.spec.ts -t "dispute evidence"`
Expected: FAIL — the `AWAITING_DISPUTE_REASON` branch doesn't handle media yet, and unconditionally writes `rawMessage` (even when empty) then always ends the state.

- [ ] **Step 3: Update the `AWAITING_DISPUTE_REASON` branch**

In `src/rescue-request/whatsapp-customer-flow.service.ts`, find the existing branch (around line 153-165):

```typescript
    if (session.state === WhatsAppFlowState.AWAITING_DISPUTE_REASON) {
      if (session.rescueRequestId) {
        await this.prisma.rescueRequest.update({
          where: { id: session.rescueRequestId },
          data: { customerDisputeStatement: rawMessage },
        });
      }
      await this.sessionStore.update(userId, {
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
      });
      return this.reply(
        `Thanks — we've recorded that. Our team will be in touch.`,
      );
    }
```

Replace with:

```typescript
    if (session.state === WhatsAppFlowState.AWAITING_DISPUTE_REASON) {
      const rescueRequestId = session.rescueRequestId;
      const numMedia = Number(body.NumMedia ?? 0);

      if (rescueRequestId && numMedia > 0) {
        let existingCount = await this.prisma.requestMedia.count({
          where: {
            rescueRequestId,
            context: MediaContext.DISPUTE,
            uploadedByRole: UserRole.CUSTOMER,
          },
        });
        for (let i = 0; i < numMedia; i++) {
          if (existingCount >= MAX_MEDIA_ITEMS) break;
          const mediaUrl: string | undefined = body[`MediaUrl${i}`];
          const contentType: string | undefined = body[`MediaContentType${i}`];
          if (!mediaUrl || !contentType) continue;
          const saved = await this.captureMediaAttachment(
            rescueRequestId,
            mediaUrl,
            contentType,
            MediaContext.DISPUTE,
            UserRole.CUSTOMER,
          );
          if (saved) existingCount++;
        }
      }

      if (!rawMessage) {
        return this.reply(
          `📸 Got it — send more evidence, or reply with your explanation to finish.`,
        );
      }

      if (rescueRequestId) {
        await this.prisma.rescueRequest.update({
          where: { id: rescueRequestId },
          data: { customerDisputeStatement: rawMessage },
        });
      }
      await this.sessionStore.update(userId, {
        state: WhatsAppFlowState.AWAITING_COMPLETION_CONFIRM,
      });
      return this.reply(
        `Thanks — we've recorded that. Our team will be in touch.`,
      );
    }
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `npx jest whatsapp-customer-flow.service.spec.ts -t "dispute evidence"`
Expected: PASS, all 3 new tests.

- [ ] **Step 5: Run the whole customer-flow spec file to confirm no regression**

Run: `npx jest whatsapp-customer-flow.service.spec.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rescue-request/whatsapp-customer-flow.service.ts src/rescue-request/whatsapp-customer-flow.service.spec.ts
git commit -m "feat: accept dispute evidence photos from the motorist"
```

---

### Task 5: Dispute evidence — operator side

**Files:**
- Modify: `src/rescue-request/whatsapp-operator-flow.service.ts`
- Test: `src/rescue-request/whatsapp-operator-flow.service.spec.ts`

**Interfaces:**
- Consumes: `customerFlowService.captureMediaAttachment(...)` (Task 2), `body` param on `handleOperatorMessage` (Task 2).
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Write a failing test**

Add to `src/rescue-request/whatsapp-operator-flow.service.spec.ts`, reusing the same `describe`-block setup pattern as Task 3's tests (fresh `beforeEach` with mocked `PrismaService`, `WhatsAppSessionStore`, `WhatsAppCustomerFlowService`) — the `prisma` stub needs a `requestMedia` object too, since the per-role cap check this task adds calls `prisma.requestMedia.count`:

```typescript
describe('handleOperatorMessage — dispute evidence', () => {
  let service: WhatsAppOperatorFlowService;
  let prisma: {
    rescueRequest: { update: jest.Mock };
    requestMedia: { count: jest.Mock };
  };
  let sessionStore: { update: jest.Mock };
  let customerFlowService: { captureMediaAttachment: jest.Mock };

  beforeEach(async () => {
    prisma = {
      rescueRequest: { update: jest.fn().mockResolvedValue({}) },
      requestMedia: { count: jest.fn().mockResolvedValue(0) },
    };
    sessionStore = { update: jest.fn().mockResolvedValue(undefined) };
    customerFlowService = {
      captureMediaAttachment: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppOperatorFlowService,
        { provide: PrismaService, useValue: prisma },
        { provide: TwilioService, useValue: {} },
        { provide: DispatchService, useValue: {} },
        { provide: PaymentEventsService, useValue: {} },
        { provide: WhatsAppCustomerFlowService, useValue: customerFlowService },
        { provide: WhatsAppSessionStore, useValue: sessionStore },
        { provide: PlatformConfigService, useValue: {} },
      ],
    }).compile();

    service = module.get<WhatsAppOperatorFlowService>(
      WhatsAppOperatorFlowService,
    );
  });

  it('text-only statement ends the state exactly as before', async () => {
    const session = {
      state: WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE,
      rescueRequestId: 'req-1',
    } as any;
    const operator = {
      id: 'op-1',
      businessName: 'Swift Towing',
      phoneNumber: '+2341111111111',
    };

    await service.handleOperatorMessage(
      '+2341111111111',
      'op-user-1',
      'i arrived on time, customer was not there',
      'i arrived on time, customer was not there',
      session,
      operator,
      {},
    );

    expect(prisma.rescueRequest.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: {
        operatorDisputeStatement:
          'i arrived on time, customer was not there',
      },
    });
  });

  it('media with no text saves the attachment and stays in the same state', async () => {
    const session = {
      state: WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE,
      rescueRequestId: 'req-1',
    } as any;
    const operator = {
      id: 'op-1',
      businessName: 'Swift Towing',
      phoneNumber: '+2341111111111',
    };

    const result = await service.handleOperatorMessage(
      '+2341111111111',
      'op-user-1',
      '',
      '',
      session,
      operator,
      {
        NumMedia: '1',
        MediaUrl0: 'https://twilio.example/media/9',
        MediaContentType0: 'image/jpeg',
      },
    );

    expect(customerFlowService.captureMediaAttachment).toHaveBeenCalledWith(
      'req-1',
      'https://twilio.example/media/9',
      'image/jpeg',
      MediaContext.DISPUTE,
      UserRole.OPERATOR,
    );
    expect(prisma.rescueRequest.update).not.toHaveBeenCalled();
    expect(result).toContain('Got it');
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx jest whatsapp-operator-flow.service.spec.ts -t "dispute evidence"`
Expected: FAIL.

- [ ] **Step 3: Update the `AWAITING_DISPUTE_RESPONSE` branch**

In `src/rescue-request/whatsapp-operator-flow.service.ts`, find the existing branch (around line 76-89):

```typescript
    if (session.state === WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE) {
      if (session.rescueRequestId) {
        await this.prisma.rescueRequest.update({
          where: { id: session.rescueRequestId },
          data: { operatorDisputeStatement: rawMessage },
        });
      }
      await this.sessionStore.update(userId, {
        state: WhatsAppFlowState.OPERATOR_AT_LOCATION,
      });
      return this.reply(
        `Thanks — we've recorded that. Our team will be in touch.`,
      );
    }
```

Replace with:

```typescript
    if (session.state === WhatsAppFlowState.AWAITING_DISPUTE_RESPONSE) {
      const rescueRequestId = session.rescueRequestId;
      const numMedia = Number(body.NumMedia ?? 0);

      if (rescueRequestId && numMedia > 0) {
        let existingCount = await this.prisma.requestMedia.count({
          where: {
            rescueRequestId,
            context: MediaContext.DISPUTE,
            uploadedByRole: UserRole.OPERATOR,
          },
        });
        for (let i = 0; i < numMedia; i++) {
          if (existingCount >= MAX_MEDIA_ITEMS) break;
          const mediaUrl: string | undefined = body[`MediaUrl${i}`];
          const contentType: string | undefined = body[`MediaContentType${i}`];
          if (!mediaUrl || !contentType) continue;
          const saved = await this.customerFlowService.captureMediaAttachment(
            rescueRequestId,
            mediaUrl,
            contentType,
            MediaContext.DISPUTE,
            UserRole.OPERATOR,
          );
          if (saved) existingCount++;
        }
      }

      if (!rawMessage) {
        return this.reply(
          `📸 Got it — send more evidence, or reply with your explanation to finish.`,
        );
      }

      if (rescueRequestId) {
        await this.prisma.rescueRequest.update({
          where: { id: rescueRequestId },
          data: { operatorDisputeStatement: rawMessage },
        });
      }
      await this.sessionStore.update(userId, {
        state: WhatsAppFlowState.OPERATOR_AT_LOCATION,
      });
      return this.reply(
        `Thanks — we've recorded that. Our team will be in touch.`,
      );
    }
```

- [ ] **Step 4: Run the tests, confirm they pass**

Run: `npx jest whatsapp-operator-flow.service.spec.ts -t "dispute evidence"`
Expected: PASS.

- [ ] **Step 5: Run the whole operator-flow spec file plus the full unit suite**

Run: `npx jest whatsapp-operator-flow.service.spec.ts` then `npx jest`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rescue-request/whatsapp-operator-flow.service.ts src/rescue-request/whatsapp-operator-flow.service.spec.ts
git commit -m "feat: accept dispute evidence photos from the operator"
```

---

### Task 6: Admin backend — role-gated `media`, `mediaLinks` INITIAL filter (both consumers)

**Files:**
- Create: `src/media/dto/request-media.dto.ts`
- Modify: `src/rescue-request/dto/rescue-request-response.dto.ts`
- Modify: `src/rescue-request/rescue-request-admin.service.ts`
- Modify: `src/rescue-request/dispatch.service.ts` (`listMyPendingOffers` — a second, independent `mediaLinks` producer, unrelated to `RescueRequestAdminService`)
- Test: `src/rescue-request/rescue-request-admin.service.spec.ts` (already exists — add a new nested `describe` block inside its existing top-level `describe('RescueRequestAdminService', () => { ... })`, matching the file's existing `describe('detailForUser — quote-compliance data', ...)` block's provider-mocking pattern exactly)
- Test: `src/rescue-request/dispatch.service.spec.ts` (check first whether it exists: `find src/rescue-request -iname "dispatch.service.spec.ts"`)

There are **two** independent places in this codebase that build a flat `mediaLinks`-shaped array from `RequestMedia` rows — `RescueRequestAdminService.mapToDetailDto` (the admin dashboard's request detail) and `DispatchService.listMyPendingOffers` (an operator's list of jobs they can still bid on, confirmed via `dispatch.service.ts:1235-1287` — it does its own `prisma.dispatchOffer.findMany` with a nested `rescueRequest: { select: { ..., media: { select: { id: true } } } }`, entirely separate from `mapToDetailDto`). Both need the same `INITIAL`-only fix; fixing only one leaves the other leaking dispute/completion evidence into an unrelated operator's pre-quote job list.

**Interfaces:**
- Consumes: `MediaContext`, `UserRole` (Task 1).
- Produces: `RequestMediaDto { id, url, mediaType, context, uploadedByRole, createdAt }`; `RescueRequestDetailDto.media?: RequestMediaDto[]`. Task 9/10 (frontend) consume this exact shape.

- [ ] **Step 1: Create the DTO**

Create `src/media/dto/request-media.dto.ts`:

```typescript
import { MediaContext, MediaType, UserRole } from '@prisma/client';

/**
 * A single evidence item as surfaced to admin dashboard callers — richer
 * than the flat `mediaLinks: string[]` array (which stays INITIAL-only and
 * unchanged for OPERATOR/CUSTOMER callers). `url` reuses the existing
 * `/api/v1/media/:id` signed-redirect endpoint.
 */
export interface RequestMediaDto {
  id: string;
  url: string;
  mediaType: MediaType;
  context: MediaContext;
  uploadedByRole: UserRole;
  createdAt: Date;
}
```

- [ ] **Step 2: Add `media` to `RescueRequestDetailDto`**

In `src/rescue-request/dto/rescue-request-response.dto.ts`, add the import and field:

```typescript
import { RequestMediaDto } from '../../media/dto/request-media.dto';
```

In `RescueRequestDetailDto`, add after the existing `mediaLinks: string[];` line:

```typescript
  media?: RequestMediaDto[];
```

- [ ] **Step 3: Write a failing test for role gating**

In `src/rescue-request/rescue-request-admin.service.spec.ts`, add a new nested `describe` block inside the file's existing top-level `describe('RescueRequestAdminService', () => { ... })` — as a sibling to the existing `describe('detailForUser — quote-compliance data', ...)` block, reusing the exact same provider list that block already sets up (`PrismaService`, `PaymentLedgerService` via `createPaymentLedgerMock()`, `PaystackCustomerService` via `createPaystackCustomerServiceMock()`, `PaystackService`, `TwilioService`, `PlatformConfigService`, `PaymentEventsService`, `DispatchService`, `RescueRequestSharedService`, `WhatsAppSessionStore`), since `detailForUser`'s actual access checks are: `SUPER_ADMIN`/`ADMIN` — no extra check; `OPERATOR` — queries `this.prisma.operatorMember.findMany({ where: { userId } })` and requires the result to include `raw.assignedOperatorId`; `CUSTOMER` — requires `raw.customerId === userId` directly, no extra query.

```typescript
  describe('detailForUser — media gating', () => {
    let detailService: RescueRequestAdminService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      operatorMember: { findMany: jest.Mock };
    };
    let platformConfigService: { getConfig: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findUnique: jest.fn() },
        operatorMember: { findMany: jest.fn() },
      };
      platformConfigService = { getConfig: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestAdminService,
          { provide: PrismaService, useValue: prisma },
          { provide: PaymentLedgerService, useValue: createPaymentLedgerMock() },
          { provide: PaystackCustomerService, useValue: createPaystackCustomerServiceMock() },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: PlatformConfigService, useValue: platformConfigService },
          { provide: PaymentEventsService, useValue: {} },
          { provide: DispatchService, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: { clear: jest.fn() } },
        ],
      }).compile();

      detailService = module.get<RescueRequestAdminService>(
        RescueRequestAdminService,
      );
    });

    const rawWithMedia = {
      id: 'req-1',
      status: 'COMPLETED',
      issueType: undefined,
      vehicleType: 'SEDAN',
      destination: 'Mainland',
      latitude: null,
      longitude: null,
      depositAmount: undefined,
      balanceAmount: undefined,
      payments: [],
      createdAt: new Date('2026-09-18T00:00:00Z'),
      updatedAt: new Date('2026-09-18T00:00:00Z'),
      customer: { id: 'cust-1', phoneNumber: '+2348010000000', email: null, name: null },
      customerId: 'cust-1',
      assignedOperatorId: 'op-1',
      assignedOperator: { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2341111111111', email: null },
      dispatchOffers: [],
      ratings: [],
      media: [
        { id: 'm1', mediaType: 'IMAGE', context: 'INITIAL', uploadedByRole: 'CUSTOMER', createdAt: new Date('2026-09-18T00:00:00Z') },
        { id: 'm2', mediaType: 'IMAGE', context: 'DISPUTE', uploadedByRole: 'OPERATOR', createdAt: new Date('2026-09-18T00:00:00Z') },
      ],
    };

    it('SUPER_ADMIN receives the full media array', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(rawWithMedia);
      platformConfigService.getConfig.mockResolvedValue({ serviceFeePercent: 10, depositPercent: 10 });

      const result = await detailService.detailForUser(
        { role: 'SUPER_ADMIN', userId: 'admin-1' },
        'req-1',
      );

      expect(result.data.media).toHaveLength(2);
    });

    it('OPERATOR (with access to this job) does not receive media at all', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(rawWithMedia);
      prisma.operatorMember.findMany.mockResolvedValue([{ operatorId: 'op-1' }]);

      const result = await detailService.detailForUser(
        { role: 'OPERATOR', userId: 'op-user-1' },
        'req-1',
      );

      expect(result.data.media).toBeUndefined();
    });

    it('CUSTOMER (the owner) does not receive media at all', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(rawWithMedia);

      const result = await detailService.detailForUser(
        { role: 'CUSTOMER', userId: 'cust-1' },
        'req-1',
      );

      expect(result.data.media).toBeUndefined();
    });
  });
```

- [ ] **Step 4: Run it, confirm it fails**

Run: `npx jest rescue-request-admin.service.spec.ts -t "media gating"`
Expected: FAIL — `media` doesn't exist on the response yet, and `mediaLinks` isn't filtered.

- [ ] **Step 5: Update `mapToDetailDto` and its call sites**

In `src/rescue-request/rescue-request-admin.service.ts`, find `mapToDetailDto` (around line 780):

```typescript
  private mapToDetailDto(
    raw: any,
    offers?: DispatchOfferAdminDto[],
  ): RescueRequestDetailDto {
    const apiBaseUrl = process.env.API_BASE_URL;
    const mediaLinks: string[] =
      raw.media && apiBaseUrl
        ? raw.media.map(
            (m: { id: string }) => `${apiBaseUrl}/api/v1/media/${m.id}`,
          )
        : [];

    return {
```

Replace with:

```typescript
  private mapToDetailDto(
    raw: any,
    includeAllMedia: boolean,
    offers?: DispatchOfferAdminDto[],
  ): RescueRequestDetailDto {
    const apiBaseUrl = process.env.API_BASE_URL;
    const initialMedia: { id: string }[] =
      raw.media?.filter((m: { context: string }) => m.context === 'INITIAL') ?? [];
    const mediaLinks: string[] =
      apiBaseUrl
        ? initialMedia.map((m) => `${apiBaseUrl}/api/v1/media/${m.id}`)
        : [];
    const media: RequestMediaDto[] | undefined =
      includeAllMedia && apiBaseUrl
        ? (raw.media ?? []).map((m: any) => ({
            id: m.id,
            url: `${apiBaseUrl}/api/v1/media/${m.id}`,
            mediaType: m.mediaType,
            context: m.context,
            uploadedByRole: m.uploadedByRole,
            createdAt: m.createdAt,
          }))
        : undefined;

    return {
```

Find where `mediaLinks,` is used inside the returned object literal (a few lines below) and add `media,` right after it:

```typescript
      mediaLinks,
      media,
```

Add the import at the top of the file: `import { RequestMediaDto } from '../media/dto/request-media.dto';`

- [ ] **Step 6: Update every `mapToDetailDto` call site**

`mapToDetailDto` has 7 call sites in this file. Verified against the controller (`rescue-request.controller.ts`) which methods are actually admin-gated:

| Line (approx) | Inside method | Controller route | Roles | `includeAllMedia` |
|---|---|---|---|---|
| ~293 | `assignOperator` | `PATCH :id/assign-operator` | `ADMIN`, `SUPER_ADMIN` | `true` |
| ~469 | `updateStatus` | `PATCH :id/status` | `ADMIN`, `SUPER_ADMIN` | `true` |
| ~520 | `cancel` | `PATCH :id/cancel` | `ADMIN`, `SUPER_ADMIN` | `true` |
| ~569 | `operatorDetail` | *(none — not called from any controller; confirmed via `grep -rn "\.operatorDetail(" src/` returning nothing, this method is dead code)* | — | `false` |
| ~700 | `detailForUser`, `SUPER_ADMIN`/`ADMIN` branch | `GET :id` | `SUPER_ADMIN`, `ADMIN` | `true` |
| ~714 | `detailForUser`, `OPERATOR` branch | `GET :id` | `OPERATOR` | `false` |
| ~723 | `detailForUser`, `CUSTOMER` branch | `GET :id` | `CUSTOMER` | `false` |

Change each site exactly as follows (run `grep -n "mapToDetailDto(" src/rescue-request/rescue-request-admin.service.ts` first to confirm current line numbers, since Steps 1-5 of this task may have shifted them slightly):

```typescript
// ~293, inside assignOperator — was: return { data: this.mapToDetailDto(updated) };
    return { data: this.mapToDetailDto(updated, true) };

// ~469, inside updateStatus — was: return { data: this.mapToDetailDto(updated) };
    return { data: this.mapToDetailDto(updated, true) };

// ~520, inside cancel — was: return { data: this.mapToDetailDto(updated) };
    return { data: this.mapToDetailDto(updated, true) };

// ~569, inside operatorDetail — was: return { data: this.mapToDetailDto(raw) };
    return { data: this.mapToDetailDto(raw, false) };

// ~700, inside detailForUser's admin branch — was: return { data: this.mapToDetailDto(raw, offers) };
      return { data: this.mapToDetailDto(raw, true, offers) };

// ~714, inside detailForUser's OPERATOR branch — was: return { data: this.mapToDetailDto(raw) };
      return { data: this.mapToDetailDto(raw, false) };

// ~723, inside detailForUser's CUSTOMER branch — was: return { data: this.mapToDetailDto(raw) };
      return { data: this.mapToDetailDto(raw, false) };
```

- [ ] **Step 7: Update `detailForUser`'s Prisma `include`**

Find the `include.media` line (around line 673): `media: { select: { id: true } },`. Replace with:

```typescript
        media: {
          select: {
            id: true,
            mediaType: true,
            context: true,
            uploadedByRole: true,
            createdAt: true,
          },
        },
```

- [ ] **Step 8: Fix the second, independent `mediaLinks` producer — `DispatchService.listMyPendingOffers`**

This is a completely separate code path from `mapToDetailDto` — an operator's list of jobs they can still bid on, unrelated to the admin request-detail endpoint. Confirmed via `dispatch.service.ts:1235-1287`: it runs its own `prisma.dispatchOffer.findMany` with a nested `rescueRequest.media` select (`{ select: { id: true } }`, no context filter) and maps every row into each offer's `request.mediaLinks`. Left unfixed, this leaks `COMPLETION`/`DISPUTE` evidence into an unrelated operator's pre-quote job list the moment such rows exist for any request with a still-open dispatch offer.

First, write a failing test. Check whether `src/rescue-request/dispatch.service.spec.ts` already has a `describe('listMyPendingOffers', ...)` block (`grep -n "listMyPendingOffers" src/rescue-request/dispatch.service.spec.ts`); if not, add one following this file's own established pattern (see `describe('getDispatchBoard', ...)`, lines 30-54, for the exact 6-provider list `DispatchService`'s real constructor needs: `PrismaService, TwilioService, OperatorService, PlatformConfigService, WhatsAppSessionStore, RescueRequestSharedService`):

```typescript
  describe('listMyPendingOffers — media filtering', () => {
    let service: DispatchService;
    let prisma: {
      operatorMember: { findMany: jest.Mock };
      dispatchOffer: { findMany: jest.Mock };
    };

    beforeEach(async () => {
      prisma = {
        operatorMember: { findMany: jest.fn() },
        dispatchOffer: { findMany: jest.fn() },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
        ],
      }).compile();

      service = module.get<DispatchService>(DispatchService);
    });

    it('only queries INITIAL-context media for the pending-offers list', async () => {
      prisma.operatorMember.findMany.mockResolvedValue([{ operatorId: 'op-1' }]);
      prisma.dispatchOffer.findMany.mockResolvedValue([]);

      await service.listMyPendingOffers('op-user-1');

      expect(prisma.dispatchOffer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            rescueRequest: expect.objectContaining({
              select: expect.objectContaining({
                media: {
                  where: { context: 'INITIAL' },
                  select: { id: true },
                },
              }),
            }),
          }),
        }),
      );
    });
  });
```

Run: `npx jest dispatch.service.spec.ts -t "media filtering"` — expect FAIL (no `where` clause on `media` exists yet).

Now fix it. In `src/rescue-request/dispatch.service.ts`, find `listMyPendingOffers` (line 1235-1287) and its `media: { select: { id: true } },` line (line 1257):

```typescript
            media: { select: { id: true } },
```

Replace with:

```typescript
            media: { where: { context: MediaContext.INITIAL }, select: { id: true } },
```

Add `MediaContext` to whatever `@prisma/client` import already exists at the top of `dispatch.service.ts`.

Run: `npx jest dispatch.service.spec.ts -t "media filtering"` — expect PASS. Then run `npx jest dispatch.service.spec.ts` to confirm no regression in the file's other (many) existing tests.

- [ ] **Step 9: Run the `rescue-request-admin.service.spec.ts` tests, confirm they pass**

Run: `npx jest rescue-request-admin.service.spec.ts -t "media gating"`
Expected: PASS.

- [ ] **Step 10: Run the full unit suite and typecheck**

Run: `npx tsc --noEmit` then `npx jest`
Expected: both clean. Pay particular attention to any other test file asserting on `mapToDetailDto`'s old 2-argument signature or on `mediaLinks` content — update any that break.

- [ ] **Step 11: Commit**

```bash
git add src/media/dto/request-media.dto.ts src/rescue-request/dto/rescue-request-response.dto.ts src/rescue-request/rescue-request-admin.service.ts src/rescue-request/rescue-request-admin.service.spec.ts src/rescue-request/dispatch.service.ts src/rescue-request/dispatch.service.spec.ts
git commit -m "feat: surface completion/dispute media to admin, keep mediaLinks INITIAL-only in both producers"
```

---

### Task 7: Integration test — `mediaLinks` INITIAL-only filter against real Postgres (both producers)

**Files:**
- Create: `test/integration/media-links-filter.int-spec.ts`

**Interfaces:**
- Consumes: `RescueRequestAdminService.detailForUser` AND `DispatchService.listMyPendingOffers` (both fixed in Task 6), the existing `test/integration/factories.ts` helpers (`createCustomer`, `createOperator`, `createRequest`, `createOffer`), real Postgres via `docker-compose.test.yml`.

Covers both of Task 6's fixes against real rows in one file — `detailForUser` and `listMyPendingOffers` are independent code paths with independent risk, per Task 6's own finding.

- [ ] **Step 1: Write the failing test**

Create `test/integration/media-links-filter.int-spec.ts` with two top-level `describe` blocks, matching `test/integration/audit-log.int-spec.ts`'s exact setup shape (direct `PrismaService` instantiation, `beforeAll`/`afterAll` connect/disconnect, `beforeEach` calling `truncateAll`) — one constructing `RescueRequestAdminService` directly with its 10 constructor arguments (`prisma, paystackService, twilioService, platformConfigService, paymentEventsService, dispatchService, sharedService, sessionStore, paymentLedger, paystackCustomerService` — confirmed via `constructor(...)` in `rescue-request-admin.service.ts:46-58`), the other constructing `DispatchService` directly with its 6 (`prisma, twilioService, operatorService, platformConfigService, sessionStore, sharedService` — confirmed via `dispatch.service.ts:79-86`), each stubbing every dependency the method under test doesn't touch:

```typescript
import { RescueRequestAdminService } from '../../src/rescue-request/rescue-request-admin.service';
import { DispatchService } from '../../src/rescue-request/dispatch.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { truncateAll, createCustomer, createOperator, createRequest, createOffer } from './factories';

describe('RescueRequestAdminService.detailForUser — mediaLinks filter (integration)', () => {
  let prisma: PrismaService;
  let service: RescueRequestAdminService;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    service = new RescueRequestAdminService(
      prisma,
      {} as any, // paystackService — unused by detailForUser
      {} as any, // twilioService — unused by detailForUser
      { getConfig: async () => ({ serviceFeePercent: 10, depositPercent: 10 }) } as any, // platformConfigService
      {} as any, // paymentEventsService — unused by detailForUser
      {} as any, // dispatchService — unused by detailForUser
      {} as any, // sharedService — unused by detailForUser
      {} as any, // sessionStore — unused by detailForUser
      {} as any, // paymentLedger — unused by detailForUser
      {} as any, // paystackCustomerService — unused by detailForUser
    );
  });

  it('mediaLinks only ever contains INITIAL-context media, even when COMPLETION and DISPUTE rows exist for the same request', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'COMPLETED',
      assignedOperatorId: operator.id,
    });

    const initial = await prisma.requestMedia.create({
      data: {
        rescueRequestId: request.id,
        mediaType: 'IMAGE',
        s3Key: 'k-initial',
        contentType: 'image/jpeg',
        context: 'INITIAL',
        uploadedByRole: 'CUSTOMER',
      },
    });
    await prisma.requestMedia.create({
      data: {
        rescueRequestId: request.id,
        mediaType: 'IMAGE',
        s3Key: 'k-completion',
        contentType: 'image/jpeg',
        context: 'COMPLETION',
        uploadedByRole: 'OPERATOR',
      },
    });
    await prisma.requestMedia.create({
      data: {
        rescueRequestId: request.id,
        mediaType: 'IMAGE',
        s3Key: 'k-dispute',
        contentType: 'image/jpeg',
        context: 'DISPUTE',
        uploadedByRole: 'CUSTOMER',
      },
    });

    const result = await service.detailForUser(
      { role: 'SUPER_ADMIN', userId: 'admin-1' },
      request.id,
    );

    expect(result.data.mediaLinks).toHaveLength(1);
    expect(result.data.mediaLinks[0]).toContain(initial.id);
    expect(result.data.media).toHaveLength(3);
  });
});

describe('DispatchService.listMyPendingOffers — mediaLinks filter (integration)', () => {
  let prisma: PrismaService;
  let service: DispatchService;

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    service = new DispatchService(
      prisma,
      {} as any, // twilioService — unused by listMyPendingOffers
      {} as any, // operatorService — unused by listMyPendingOffers
      {} as any, // platformConfigService — unused by listMyPendingOffers
      {} as any, // sessionStore — unused by listMyPendingOffers
      {} as any, // sharedService — unused by listMyPendingOffers
    );
  });

  it('a pending offer\'s request.mediaLinks only ever contains INITIAL-context media', async () => {
    const customer = await createCustomer(prisma);
    const operator = await createOperator(prisma);
    const request = await createRequest(prisma, customer.id, {
      status: 'DISPATCHING',
    });
    await createOffer(prisma, request.id, operator.id);

    const initial = await prisma.requestMedia.create({
      data: {
        rescueRequestId: request.id,
        mediaType: 'IMAGE',
        s3Key: 'k-initial',
        contentType: 'image/jpeg',
        context: 'INITIAL',
        uploadedByRole: 'CUSTOMER',
      },
    });
    // A DISPATCHING request can't actually have COMPLETION/DISPUTE media
    // yet in real use (see this plan's Global Constraints on
    // buildMediaLinksSection) — created directly here anyway, bypassing
    // the WhatsApp flow, specifically so this test proves the query filter
    // itself is correct rather than relying on the state machine to keep
    // it out of reach.
    await prisma.requestMedia.create({
      data: {
        rescueRequestId: request.id,
        mediaType: 'IMAGE',
        s3Key: 'k-completion',
        contentType: 'image/jpeg',
        context: 'COMPLETION',
        uploadedByRole: 'OPERATOR',
      },
    });

    // operatorMember rows aren't created by the createOperator/createOffer
    // factories — create the membership linking a fresh operator user to
    // this operator directly, matching what listMyPendingOffers queries by.
    const operatorUser = await createCustomer(prisma);
    await prisma.operatorMember.create({
      data: { userId: operatorUser.id, operatorId: operator.id, role: 'OWNER' },
    });

    const result = await service.listMyPendingOffers(operatorUser.id);

    expect(result.data).toHaveLength(1);
    expect(result.data[0].request.mediaLinks).toHaveLength(1);
    expect(result.data[0].request.mediaLinks[0]).toContain(initial.id);
  });
});
```

`SUPER_ADMIN` role is used deliberately in the first test (not `OPERATOR`/`CUSTOMER`) — its job is proving the `mediaLinks` query filter works against real rows, which Task 6's unit tests didn't exercise against an actual database; role-based `media` gating itself is already covered by Task 6's unit tests, so it also asserts `media` for completeness but doesn't need to re-prove the gating logic. `OperatorMember.role: 'OWNER'` above is confirmed valid — `OperatorMemberRole` (`prisma/schema.prisma:29-34`) is `OWNER | MANAGER | DISPATCHER | DRIVER | STAFF`.

- [ ] **Step 2: Bring up the test database and run it, confirm it fails for the right reason**

Run: `docker compose -f docker-compose.test.yml up -d --wait` then `DATABASE_URL="postgresql://lrr:lrr@localhost:5433/lrr_test" npx jest --config ./test/integration/jest-integration.json media-links-filter`
Expected: FAIL before Task 6's fix would have been needed — but since Task 6 already shipped the filter, this should actually PASS immediately if Task 6 was done correctly. If it fails, that means Task 6's `mapToDetailDto` filter has a bug — fix `mapToDetailDto` (not this test) until it passes, since this integration test is the acceptance check for Task 6's core risk, not new production code of its own.

- [ ] **Step 3: Confirm it passes**

Run the same command as Step 2.
Expected: PASS.

- [ ] **Step 4: Tear down and run the full integration suite**

Run: `DATABASE_URL="postgresql://lrr:lrr@localhost:5433/lrr_test" npx jest --config ./test/integration/jest-integration.json` then `docker compose -f docker-compose.test.yml down -v`
Expected: all integration suites PASS.

- [ ] **Step 5: Commit**

```bash
git add test/integration/media-links-filter.int-spec.ts
git commit -m "test: verify mediaLinks stays INITIAL-only against real Postgres, both producers"
```

---

### Task 8: Frontend types

**Files:**
- Modify: `app/types.ts`

**Interfaces:**
- Produces: `RequestMediaItem` interface, `RescueRequestDetail.media?: RequestMediaItem[]`. Tasks 9 and 10 consume this.

- [ ] **Step 1: Add the type**

In `app/types.ts`, find `RescueRequestDetail` (around line 181) and its existing `mediaLinks: string[];` field (around line 186). Add a new interface above `RescueRequestDetail`, and a new optional field inside it:

```typescript
export interface RequestMediaItem {
  id: string;
  url: string;
  mediaType: "IMAGE" | "VIDEO" | "AUDIO";
  context: "INITIAL" | "COMPLETION" | "DISPUTE";
  uploadedByRole: "CUSTOMER" | "OPERATOR";
  createdAt: string;
}
```

Inside `RescueRequestDetail`, immediately after `mediaLinks: string[];`, add:

```typescript
  media?: RequestMediaItem[];
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (this is an additive, optional field — nothing currently constructs a `RescueRequestDetail` object literal that would need updating).

- [ ] **Step 3: Commit**

```bash
git add app/types.ts
git commit -m "feat: add RequestMediaItem type for admin media display"
```

---

### Task 9: Frontend — Details tab media grid, grouped by context

**Files:**
- Modify: `app/components/tabs/RescueRequestsTabAdmin.tsx`

**Interfaces:**
- Consumes: `RequestMediaItem`, `RescueRequestDetail.media` (Task 8).

- [ ] **Step 1: Replace the flat media-links block**

In `app/components/tabs/RescueRequestsTabAdmin.tsx`, find the existing block (around lines 660-673):

```tsx
              {/* ── Media links ── */}
              {selectedDetail && selectedDetail.mediaLinks.length > 0 && (
                <div style={{ marginBottom: "1.5rem" }}>
                  <p style={{ margin: "0 0 0.5rem 0", fontWeight: 700, color: "#333", fontSize: "0.95rem" }}>Media</p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    {selectedDetail.mediaLinks.map((link, i) => (
                      <a key={link} href={link} target="_blank" rel="noreferrer"
                        style={{ padding: "0.4rem 0.9rem", background: "#dde8f8", borderRadius: 8, fontSize: "0.85rem", fontWeight: 600, color: "#003DB4", textDecoration: "none" }}>
                        Photo {i + 1}
                      </a>
                    ))}
                  </div>
                </div>
              )}
```

Replace with:

```tsx
              {/* ── Media, grouped by context ── */}
              {selectedDetail?.media && selectedDetail.media.length > 0 ? (
                <>
                  {(["INITIAL", "COMPLETION"] as const).map((ctx) => {
                    const items = selectedDetail.media!.filter((m) => m.context === ctx);
                    if (items.length === 0) return null;
                    return (
                      <div key={ctx} style={{ marginBottom: "1.5rem" }}>
                        <p style={{ margin: "0 0 0.5rem 0", fontWeight: 700, color: "#333", fontSize: "0.95rem" }}>
                          {ctx === "INITIAL" ? "Breakdown Photos" : "Completion Evidence"}
                        </p>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                          {items.map((m) => (
                            <a key={m.id} href={m.url} target="_blank" rel="noreferrer" style={{ display: "block" }}>
                              {m.mediaType === "VIDEO" ? (
                                <video src={m.url} style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8, border: "1px solid #dde8f8" }} />
                              ) : m.mediaType === "IMAGE" ? (
                                <img src={m.url} alt="" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8, border: "1px solid #dde8f8" }} />
                              ) : (
                                <div style={{ width: 96, height: 96, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, border: "1px solid #dde8f8", background: "#F6FAFF", fontSize: "0.78rem", color: "#8892a6" }}>
                                  🎤 Audio
                                </div>
                              )}
                            </a>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </>
              ) : (
                selectedDetail && selectedDetail.mediaLinks.length > 0 && (
                  <div style={{ marginBottom: "1.5rem" }}>
                    <p style={{ margin: "0 0 0.5rem 0", fontWeight: 700, color: "#333", fontSize: "0.95rem" }}>Media</p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                      {selectedDetail.mediaLinks.map((link, i) => (
                        <a key={link} href={link} target="_blank" rel="noreferrer"
                          style={{ padding: "0.4rem 0.9rem", background: "#dde8f8", borderRadius: 8, fontSize: "0.85rem", fontWeight: 600, color: "#003DB4", textDecoration: "none" }}>
                          Photo {i + 1}
                        </a>
                      ))}
                    </div>
                  </div>
                )
              )}
```

This keeps the old flat-link rendering as a fallback for `OPERATOR`/`CUSTOMER`-role viewers of this same component (if it's ever reused outside the admin-only tab — `selectedDetail.media` is `undefined` for those roles per Task 6, so they fall through to the existing `mediaLinks` rendering unchanged) while giving admin the new grouped thumbnail view.

- [ ] **Step 2: Manually verify in the browser**

Run: `npm run dev` from `lrr-web`, log in as an admin, open a completed request's detail modal with known media. Confirm: photos render as thumbnails grouped under "Breakdown Photos" (and "Completion Evidence" once Task 3's data exists), each thumbnail links out to the full media on click.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/components/tabs/RescueRequestsTabAdmin.tsx
git commit -m "feat: show breakdown and completion photos as thumbnails, grouped"
```

---

### Task 10: Frontend — Dispute tab media section

**Files:**
- Modify: `app/components/tabs/RescueRequestsTabAdmin.tsx`

**Interfaces:**
- Consumes: `RequestMediaItem`, `RescueRequestDetail.media` (Task 8).

- [ ] **Step 1: Add the dispute-media block**

In `app/components/tabs/RescueRequestsTabAdmin.tsx`, find the Dispute tab's statement block (around lines 824-833):

```tsx
                  <div style={{ display: "grid", gap: "0.6rem", marginBottom: "1rem" }}>
                    <div>
                      <p style={{ margin: 0, fontSize: "0.78rem", color: "#999", fontWeight: 600, textTransform: "uppercase" }}>Customer said</p>
                      <p style={{ margin: "2px 0 0 0", fontSize: "0.9rem", color: "#333" }}>{selectedDetail?.customerDisputeStatement || "No response yet"}</p>
                    </div>
                    <div>
                      <p style={{ margin: 0, fontSize: "0.78rem", color: "#999", fontWeight: 600, textTransform: "uppercase" }}>Operator said</p>
                      <p style={{ margin: "2px 0 0 0", fontSize: "0.9rem", color: "#333" }}>{selectedDetail?.operatorDisputeStatement || "No response yet"}</p>
                    </div>
                  </div>
```

Add a new block immediately after this closing `</div>` (still before the `{selectedRequest.disputeResolvedAt ? (` line):

```tsx
                  {selectedDetail?.media && selectedDetail.media.some((m) => m.context === "DISPUTE") && (
                    <div style={{ marginBottom: "1rem" }}>
                      <p style={{ margin: "0 0 0.5rem 0", fontSize: "0.78rem", color: "#999", fontWeight: 600, textTransform: "uppercase" }}>Dispute Evidence</p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                        {selectedDetail.media.filter((m) => m.context === "DISPUTE").map((m) => (
                          <a key={m.id} href={m.url} target="_blank" rel="noreferrer" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                            {m.mediaType === "VIDEO" ? (
                              <video src={m.url} style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 8, border: "1px solid #f5c2c2" }} />
                            ) : m.mediaType === "IMAGE" ? (
                              <img src={m.url} alt="" style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 8, border: "1px solid #f5c2c2" }} />
                            ) : (
                              <div style={{ width: 88, height: 88, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, border: "1px solid #f5c2c2", background: "#fdf6f6", fontSize: "0.75rem", color: "#8892a6" }}>
                                🎤 Audio
                              </div>
                            )}
                            <span style={{ fontSize: "0.72rem", fontWeight: 600, color: m.uploadedByRole === "CUSTOMER" ? "#003DB4" : "#721c24" }}>
                              {m.uploadedByRole === "CUSTOMER" ? "From customer" : "From operator"}
                            </span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
```

- [ ] **Step 2: Manually verify in the browser**

Open a disputed request with dispute-context media (create one via the WhatsApp flows from Tasks 4/5 against a local dev backend, or seed one directly). Confirm the labeled thumbnails appear above the resolution form, correctly attributed "From customer"/"From operator".

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/components/tabs/RescueRequestsTabAdmin.tsx
git commit -m "feat: show dispute evidence photos in the admin dispute tab"
```

---

## Post-Plan Follow-Ups (not part of this plan)

- A new section in `docs/qa/2026-09-10-full-system-test-plan.md` covering these flows manually end-to-end — add after this plan ships, per the user's own stated sequencing.
- `docs/superpowers/specs/2026-09-15-account-deletion-design.md` needs a pass to account for `uploadedByRole` before it's implemented (see the design spec's "Note for the (Unimplemented) Account-Deletion Plan" section) — the user's own next step after this plan.
