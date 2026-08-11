# Admin Dispatch Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a live, polling view of every in-flight (and recently-resolved) rescue-request dispatch, with the ability to cancel, force-expand the search radius, or manually offer a job to a specific operator.

**Architecture:** One new admin-only read endpoint (`GET /rescue-requests/dispatch-board`) aggregates `RescueRequest` + `DispatchOffer` + `WhatsAppSession.dispatchRound` into board rows. Two new admin-only action endpoints (`expand-radius`, `offer-to/:operatorId`) both funnel through a new `supersedeActiveRound` private helper that safely tears down any in-flight automatic round before starting a replacement one, reusing the existing `batchTimers`/`graceTimers` mutex rather than inventing a new concurrency primitive. The manual offer is implemented as an ordinary single-operator "round" so it flows through the existing quote/decline/resolution machinery unchanged. `lrr-web` gets a new `DispatchBoardTab.tsx` polling the board endpoint, matching the existing `PendingOffers.tsx` polling pattern.

**Tech Stack:** NestJS, Prisma/Postgres, Next.js/React (`lrr-web`), Jest.

## Global Constraints

- No schema changes — the board is built entirely from `RescueRequest`, `DispatchOffer`, and `WhatsAppSession.dispatchRound`, all of which already exist.
- The board query includes `RescueRequest.status = DISPATCHING` (live) OR (`status IN (OPERATOR_ASSIGNED, CANCELLED)` AND `updatedAt >= now - 60 minutes`) (recent history, read-only in the UI — no action buttons on these rows).
- `GET /rescue-requests/dispatch-board` MUST be declared in `RescueRequestController` before the existing `@Get(':id')` route — as a literal path segment it would otherwise be swallowed as an `:id` value, the same param-shadowing rule the file's existing `offers/mine` route already documents.
- `PATCH /:id/cancel` already exists and is already admin-guarded — the board's Cancel button calls it directly. No backend change for cancellation itself.
- **Concurrency invariant: only one active dispatch round per request.** Both `expand-radius` and `offer-to/:operatorId` MUST call a new private `supersedeActiveRound(rescueRequestId)` helper before starting their replacement round. It must, in order: (1) if `batchTimers.has(rescueRequestId)`, `clearTimeout` and delete the entry; (2) if `graceTimers.has(rescueRequestId)`, `clearTimeout` and delete the entry (mirrors `resolveBatch`'s own self-cleanup); (3) mark every currently-`PENDING` `DispatchOffer` for that `rescueRequestId` as `TIMED_OUT`. Skipping any of these three steps reintroduces the exact bug the design spec traced through: a stale timer from the superseded round firing later, grabbing the *new* round's `batchTimers` entry via the shared map key, and resolving with the *old* round's stale `batchOperatorIds`.
- The manual offer (`offer-to/:operatorId`) is implemented as an ordinary single-operator round — one `DispatchOffer` row with its own fresh `expiresAt`, a timer stored under the same `batchTimers` key exactly like a normal batch. It must NOT special-case quote handling: `processQuoteOrDecline`/`maybeResolveBatchEarly` already resolve "the batch" as whichever offers share `rescueRequestId` + `expiresAt`, which naturally generalizes to a batch of one.
- Manual-offer targets must be `status: ACTIVE` operators — `400`/`404` otherwise (existence + status both checked).
- `lrr-web` polls the board endpoint every 15 seconds — this corrects the design spec's "5 seconds, matching `PendingOffers.tsx`" claim, which was wrong: `PendingOffers.tsx`'s actual `POLL_MS` constant is `15_000`. Match the real value, not the spec's mistaken one.
- The "offer to operator" picker shows each candidate's `truckClasses` and `address` alongside their name, since this bypasses the ranking algorithm entirely and an admin needs enough info to avoid an obviously bad manual match (e.g. a heavy-trailer job to a light-duty operator).

---

### Task 1: Backend — `GET /rescue-requests/dispatch-board`

**Files:**
- Modify: `src/rescue-request/dto/rescue-request-response.dto.ts`
- Modify: `src/rescue-request/rescue-request.service.ts`
- Modify: `src/rescue-request/rescue-request.controller.ts`
- Test: `src/rescue-request/rescue-request.service.spec.ts`

**Interfaces:**
- Consumes: `DispatchOfferAdminDto` (existing, `src/rescue-request/dto/rescue-request-response.dto.ts:41`) — reused for each row's `offers` array.
- Produces: `RescueRequestService.getDispatchBoard(): Promise<DispatchBoardRowDto[]>`, `DispatchBoardRowDto` — consumed by `lrr-web` in Task 4.

- [ ] **Step 1: Add `DispatchBoardRowDto`**

In `src/rescue-request/dto/rescue-request-response.dto.ts`, add near `DispatchOfferAdminDto`:

```typescript
export class DispatchBoardRowDto {
  id: string;
  status: RescueRequestStatus;
  vehicleType?: VehicleType;
  destination?: string;
  round: number;
  createdAt: Date;
  offers: DispatchOfferAdminDto[];
}
```

Check the file's existing imports for `RescueRequestStatus`/`VehicleType` — they're already imported for the other DTOs in this file.

- [ ] **Step 2: Write the failing test**

Check `src/rescue-request/rescue-request.service.spec.ts`'s `describe('detailForUser — quote-compliance data', ...)` block (around line 65) for its exact `TestingModule`/mock pattern — this test follows the same shape, with its own local `beforeEach`. Add a new `describe` block:

```typescript
  describe('getDispatchBoard', () => {
    let boardService: RescueRequestService;
    let prisma: {
      rescueRequest: { findMany: jest.Mock };
      whatsAppSession: { findMany: jest.Mock };
    };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findMany: jest.fn() },
        whatsAppSession: { findMany: jest.fn() },
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PayoutService, useValue: {} },
        ],
      }).compile();

      boardService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('queries DISPATCHING requests plus resolved ones from the last 60 minutes, with offers and round number', async () => {
      prisma.rescueRequest.findMany.mockResolvedValue([
        {
          id: 'req-1',
          status: 'DISPATCHING',
          vehicleType: 'SEDAN',
          destination: 'Lekki',
          createdAt: new Date('2026-08-12T10:00:00Z'),
          customerId: 'cust-1',
          dispatchOffers: [
            {
              operatorId: 'op-1',
              status: 'PENDING',
              quotedPrice: null,
              offeredAt: new Date('2026-08-12T10:00:00Z'),
              respondedAt: null,
              operator: { businessName: 'Swift Towing' },
            },
          ],
        },
      ]);
      prisma.whatsAppSession.findMany.mockResolvedValue([
        { userId: 'cust-1', dispatchRound: 2 },
      ]);

      const result = await boardService.getDispatchBoard();

      expect(prisma.rescueRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { status: 'DISPATCHING' },
              {
                status: { in: ['OPERATOR_ASSIGNED', 'CANCELLED'] },
                updatedAt: { gte: expect.any(Date) },
              },
            ],
          },
        }),
      );
      expect(result).toEqual([
        {
          id: 'req-1',
          status: 'DISPATCHING',
          vehicleType: 'SEDAN',
          destination: 'Lekki',
          round: 2,
          createdAt: new Date('2026-08-12T10:00:00Z'),
          offers: [
            {
              operatorId: 'op-1',
              businessName: 'Swift Towing',
              status: 'PENDING',
              quotedPrice: undefined,
              offeredAt: new Date('2026-08-12T10:00:00Z'),
              respondedAt: undefined,
            },
          ],
        },
      ]);
    });

    it('defaults round to 0 when no session is found for the customer', async () => {
      prisma.rescueRequest.findMany.mockResolvedValue([
        {
          id: 'req-1', status: 'DISPATCHING', vehicleType: null, destination: null,
          createdAt: new Date(), customerId: 'cust-1', dispatchOffers: [],
        },
      ]);
      prisma.whatsAppSession.findMany.mockResolvedValue([]);

      const result = await boardService.getDispatchBoard();

      expect(result[0].round).toBe(0);
    });
  });
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx jest rescue-request.service.spec.ts -t "getDispatchBoard"
```

Expected: FAIL — method doesn't exist.

- [ ] **Step 4: Implement `getDispatchBoard`**

Add this method to `RescueRequestService`, near `detailForUser` (a convenient spot among the other public query methods):

```typescript
  async getDispatchBoard(): Promise<DispatchBoardRowDto[]> {
    const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000);

    const requests = await this.prisma.rescueRequest.findMany({
      where: {
        OR: [
          { status: RescueRequestStatus.DISPATCHING },
          {
            status: { in: [RescueRequestStatus.OPERATOR_ASSIGNED, RescueRequestStatus.CANCELLED] },
            updatedAt: { gte: sixtyMinAgo },
          },
        ],
      },
      include: {
        dispatchOffers: {
          include: { operator: { select: { businessName: true } } },
          orderBy: { offeredAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const customerIds = [...new Set(requests.map((r) => r.customerId))];
    const sessions = await this.prisma.whatsAppSession.findMany({
      where: { userId: { in: customerIds } },
      select: { userId: true, dispatchRound: true },
    });
    const roundByCustomerId = new Map(sessions.map((s) => [s.userId, s.dispatchRound]));

    return requests.map((r) => ({
      id: r.id,
      status: r.status,
      vehicleType: r.vehicleType ?? undefined,
      destination: r.destination ?? undefined,
      round: roundByCustomerId.get(r.customerId) ?? 0,
      createdAt: r.createdAt,
      offers: r.dispatchOffers.map((o) => ({
        operatorId: o.operatorId,
        businessName: o.operator.businessName,
        status: o.status,
        quotedPrice: o.quotedPrice ?? undefined,
        offeredAt: o.offeredAt,
        respondedAt: o.respondedAt ?? undefined,
      })),
    }));
  }
```

Add `DispatchBoardRowDto` to the existing DTO import block at the top of `rescue-request.service.ts` (alongside `DispatchOfferAdminDto` etc.).

- [ ] **Step 5: Add the controller endpoint**

In `src/rescue-request/rescue-request.controller.ts`, add this **before** the `@Get(':id')` route (around line 50 — check the file for the exact current line, since the file has changed since this plan was written) — same placement rule as the existing `offers/mine` route:

```typescript
  /** Live + recent dispatch state across all requests, for the admin ops board. */
  @Get('dispatch-board')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async dispatchBoard() {
    const rows = await this.rescueRequestService.getDispatchBoard();
    return { data: rows };
  }
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npx jest rescue-request.service.spec.ts -t "getDispatchBoard"
```

Expected: PASS, both tests green.

- [ ] **Step 7: Verify TypeScript compiles and the full suite passes**

```bash
npx tsc --noEmit
npx jest
```

Expected: no errors; all suites pass.

- [ ] **Step 8: Commit**

```bash
git add src/rescue-request/dto/rescue-request-response.dto.ts src/rescue-request/rescue-request.service.ts src/rescue-request/rescue-request.controller.ts src/rescue-request/rescue-request.service.spec.ts
git commit -m "feat(dispatch-board): add admin dispatch-board read endpoint"
```

---

### Task 2: Backend — `supersedeActiveRound` + `POST /:id/expand-radius`

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts`
- Modify: `src/rescue-request/rescue-request.controller.ts`
- Test: `src/rescue-request/rescue-request.service.spec.ts`

**Interfaces:**
- Consumes: `this.batchTimers`, `this.graceTimers` (existing private fields, `src/rescue-request/rescue-request.service.ts:75,87`), `this.startDispatch` (existing).
- Produces: `RescueRequestService.expandRadiusNow(rescueRequestId: string): Promise<void>` — called by the controller in this task. `private supersedeActiveRound(rescueRequestId: string): Promise<void>` — consumed by Task 3's `manualOfferToOperator`.

- [ ] **Step 1: Write the failing tests**

Add to `src/rescue-request/rescue-request.service.spec.ts`, following the same `TestingModule` mock pattern used elsewhere in this file (see Task 1's `getDispatchBoard` block for the shape):

```typescript
  describe('expandRadiusNow', () => {
    let radiusService: RescueRequestService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      dispatchOffer: { updateMany: jest.Mock };
    };
    let sessionStore: { getOrCreate: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findUnique: jest.fn() },
        dispatchOffer: { updateMany: jest.fn() },
      };
      sessionStore = { getOrCreate: jest.fn() };

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
          { provide: RatingService, useValue: {} },
          { provide: PayoutService, useValue: {} },
        ],
      }).compile();

      radiusService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('rejects a request that is not DISPATCHING', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'OPERATOR_ASSIGNED' });

      await expect(radiusService.expandRadiusNow('req-1')).rejects.toThrow('not currently DISPATCHING');
    });

    it('clears any active batch/grace timer, times out pending offers, and starts a new round with an expanded radius', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
      });
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 1 });
      sessionStore.getOrCreate.mockResolvedValue({ dispatchRound: 1 });

      const startDispatchSpy = jest.spyOn(radiusService as any, 'startDispatch').mockResolvedValue(undefined);
      const existingTimer = setTimeout(() => {}, 100000);
      (radiusService as any).batchTimers.set('req-1', existingTimer);

      await radiusService.expandRadiusNow('req-1');

      expect((radiusService as any).batchTimers.has('req-1')).toBe(false);
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
        where: { rescueRequestId: 'req-1', status: 'PENDING' },
        data: { status: 'TIMED_OUT', respondedAt: expect.any(Date) },
      });
      // round 1 → current radius approximated as 1 * RADIUS_EXPANSION_KM (2) = 2,
      // expanded by one more increment = 4
      expect(startDispatchSpy).toHaveBeenCalledWith('req-1', 'cust-1', 4);

      clearTimeout(existingTimer);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest rescue-request.service.spec.ts -t "expandRadiusNow"
```

Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement `supersedeActiveRound` and `expandRadiusNow`**

Add both methods to `RescueRequestService`, near `resolveBatch` (around line 1134 — check the file for the exact current line):

```typescript
  /**
   * Tears down whatever automatic dispatch round is currently active for a
   * request, so an admin-initiated round (expand-radius or a manual offer)
   * can safely take over the round slot. Without this, a stale timer from
   * the superseded round could later fire, grab the *new* round's
   * batchTimers entry via the shared map key, and resolve using the *old*
   * round's stale operator list — see Global Constraints for the full
   * mechanism this guards against.
   */
  private async supersedeActiveRound(rescueRequestId: string): Promise<void> {
    const batchTimer = this.batchTimers.get(rescueRequestId);
    if (batchTimer) {
      clearTimeout(batchTimer);
      this.batchTimers.delete(rescueRequestId);
    }

    const graceTimer = this.graceTimers.get(rescueRequestId);
    if (graceTimer) {
      clearTimeout(graceTimer);
      this.graceTimers.delete(rescueRequestId);
    }

    await this.prisma.dispatchOffer.updateMany({
      where: { rescueRequestId, status: 'PENDING' },
      data: { status: 'TIMED_OUT', respondedAt: new Date() },
    });
  }

  /**
   * Admin action: immediately start a new dispatch round with an expanded
   * radius, instead of waiting for the automatic DISPATCH_RETRY_MINUTES
   * timer. extraRadiusKm isn't persisted between rounds (see the comment
   * on maybeResolveBatchEarly's callers), so the current radius is
   * approximated from the session's dispatchRound — the same
   * approximation the automatic retry path already effectively produces.
   */
  async expandRadiusNow(rescueRequestId: string): Promise<void> {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
    });
    if (!rescueRequest || rescueRequest.status !== RescueRequestStatus.DISPATCHING) {
      throw new BadRequestException('Request is not currently DISPATCHING');
    }

    await this.supersedeActiveRound(rescueRequestId);

    const session = await this.sessionStore.getOrCreate(rescueRequest.customerId);
    const currentRadius = (session.dispatchRound ?? 0) * RADIUS_EXPANSION_KM;
    const expandedRadius = currentRadius + RADIUS_EXPANSION_KM;

    void this.startDispatch(rescueRequestId, rescueRequest.customerId, expandedRadius);
  }
```

- [ ] **Step 4: Add the controller endpoint**

In `src/rescue-request/rescue-request.controller.ts`, add near the `dispatch-board` route added in Task 1:

```typescript
  @Post(':id/expand-radius')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async expandRadius(@Param('id') id: string) {
    await this.rescueRequestService.expandRadiusNow(id);
    return { message: 'Radius expansion triggered' };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx jest rescue-request.service.spec.ts -t "expandRadiusNow"
```

Expected: PASS, both tests green.

- [ ] **Step 6: Verify TypeScript compiles and the full suite passes**

```bash
npx tsc --noEmit
npx jest
```

Expected: no errors; all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts src/rescue-request/rescue-request.controller.ts src/rescue-request/rescue-request.service.spec.ts
git commit -m "feat(dispatch-board): add admin force-expand-radius action"
```

---

### Task 3: Backend — `manualOfferToOperator` + `POST /:id/offer-to/:operatorId`

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts`
- Modify: `src/rescue-request/rescue-request.controller.ts`
- Test: `src/rescue-request/rescue-request.service.spec.ts`

**Interfaces:**
- Consumes: `supersedeActiveRound` (Task 2, private), `this.batchTimers` (existing), `this.twilioService.sendWhatsAppMessage` (existing), `this.buildMediaLinksSection` (existing private helper).
- Produces: `RescueRequestService.manualOfferToOperator(rescueRequestId: string, operatorId: string): Promise<void>` — called by the controller in this task.

- [ ] **Step 1: Write the failing tests**

Add to `src/rescue-request/rescue-request.service.spec.ts`:

```typescript
  describe('manualOfferToOperator', () => {
    let manualService: RescueRequestService;
    let prisma: {
      rescueRequest: { findUnique: jest.Mock };
      operator: { findUnique: jest.Mock };
      dispatchOffer: { create: jest.Mock; updateMany: jest.Mock };
    };
    let sessionStore: { getOrCreate: jest.Mock; update: jest.Mock };
    let twilioService: { sendWhatsAppMessage: jest.Mock };

    beforeEach(async () => {
      prisma = {
        rescueRequest: { findUnique: jest.fn() },
        operator: { findUnique: jest.fn() },
        dispatchOffer: { create: jest.fn(), updateMany: jest.fn() },
      };
      sessionStore = {
        getOrCreate: jest.fn().mockResolvedValue({ offeredOperatorIds: ['op-already-tried'] }),
        update: jest.fn(),
      };
      twilioService = { sendWhatsAppMessage: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RescueRequestService,
          { provide: WhatsAppSessionStore, useValue: sessionStore },
          { provide: PrismaService, useValue: prisma },
          { provide: PaystackService, useValue: {} },
          { provide: TwilioService, useValue: twilioService },
          { provide: OperatorService, useValue: {} },
          { provide: S3Service, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: RatingService, useValue: {} },
          { provide: PayoutService, useValue: {} },
        ],
      }).compile();

      manualService = module.get<RescueRequestService>(RescueRequestService);
    });

    it('rejects a request that is not DISPATCHING', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({ id: 'req-1', status: 'OPERATOR_ASSIGNED' });

      await expect(manualService.manualOfferToOperator('req-1', 'op-1')).rejects.toThrow('not currently DISPATCHING');
    });

    it('rejects a missing or inactive operator', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
        vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({ id: 'op-1', status: 'INACTIVE' });

      await expect(manualService.manualOfferToOperator('req-1', 'op-1')).rejects.toThrow('not an active operator');
    });

    it('creates a single-operator round: offer created, WhatsApp sent, session updated, timer scheduled', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1', status: 'DISPATCHING', customerId: 'cust-1',
        vehicleType: 'SEDAN', destination: 'Lekki', latitude: 6.5, longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1', status: 'ACTIVE', businessName: 'Swift Towing', phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' });

      await manualService.manualOfferToOperator('req-1', 'op-1');

      expect(prisma.dispatchOffer.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          rescueRequestId: 'req-1',
          operatorId: 'op-1',
          expiresAt: expect.any(Date),
        }),
      });
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('2349012345678'),
        expect.stringContaining('NEW RESCUE JOB'),
      );
      expect(sessionStore.update).toHaveBeenCalledWith('cust-1', {
        offeredOperatorIds: ['op-already-tried', 'op-1'],
      });
      expect((manualService as any).batchTimers.has('req-1')).toBe(true);

      // Clean up the real timer this test scheduled
      clearTimeout((manualService as any).batchTimers.get('req-1'));
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest rescue-request.service.spec.ts -t "manualOfferToOperator"
```

Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement `manualOfferToOperator`**

Add this method to `RescueRequestService`, near `expandRadiusNow` from Task 2. This mirrors `startDispatch`'s batch-offer message construction for a single operator, and schedules a timer identical in shape to the normal batch timer so it participates in the exact same resolution path:

```typescript
  /**
   * Admin action: offer this job directly to one specific operator,
   * bypassing findAndRankCandidates entirely. Implemented as an ordinary
   * single-operator dispatch round — the offer's expiresAt drives the same
   * processQuoteOrDecline/maybeResolveBatchEarly machinery every other
   * round uses, so no bespoke quote-handling is needed here.
   */
  async manualOfferToOperator(rescueRequestId: string, operatorId: string): Promise<void> {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
    });
    if (!rescueRequest || rescueRequest.status !== RescueRequestStatus.DISPATCHING) {
      throw new BadRequestException('Request is not currently DISPATCHING');
    }

    const operator = await this.prisma.operator.findUnique({ where: { id: operatorId } });
    if (!operator || operator.status !== 'ACTIVE') {
      throw new BadRequestException('Target is not an active operator');
    }

    await this.supersedeActiveRound(rescueRequestId);

    const MANUAL_OFFER_WINDOW_MS = 5 * 60 * 1000;
    const expiresAt = new Date(Date.now() + MANUAL_OFFER_WINDOW_MS);

    await this.prisma.dispatchOffer.create({
      data: { rescueRequestId, operatorId, expiresAt },
    });

    // Append, never replace — every other call site that touches
    // offeredOperatorIds spreads the existing list first (see e.g.
    // startDispatch's batch-tracking update); replacing it here would let
    // operators from earlier rounds become eligible for re-offering again.
    const session = await this.sessionStore.getOrCreate(rescueRequest.customerId);
    await this.sessionStore.update(rescueRequest.customerId, {
      offeredOperatorIds: [...(session.offeredOperatorIds ?? []), operatorId],
    });

    const lat = Number(rescueRequest.latitude);
    const lon = Number(rescueRequest.longitude);
    const vehicleLabel = rescueRequest.vehicleType
      ? formatVehicleType(rescueRequest.vehicleType as VehicleType)
      : 'Unknown';
    const destinationLabel = rescueRequest.destination ?? 'Not specified';

    await this.twilioService.sendWhatsAppMessage(
      toWhatsAppAddress(operator.phoneNumber),
      `🚨 *NEW RESCUE JOB*\n\nVehicle: ${vehicleLabel}\nDestination: ${destinationLabel}\nLocation: https://maps.google.com/?q=${lat},${lon}\n\n💰 Reply with your price to bid, e.g. "25000".\nReply *NO* to decline.\nYou have 5 minutes.`,
    );

    const timer = setTimeout(
      () => void this.resolveBatch(rescueRequestId, [operatorId], rescueRequest.customerId, 0),
      MANUAL_OFFER_WINDOW_MS,
    );
    this.batchTimers.set(rescueRequestId, timer);
  }
```

- [ ] **Step 4: Add the controller endpoint**

In `src/rescue-request/rescue-request.controller.ts`, add near `expand-radius` from Task 2:

```typescript
  @Post(':id/offer-to/:operatorId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async offerToOperator(@Param('id') id: string, @Param('operatorId') operatorId: string) {
    await this.rescueRequestService.manualOfferToOperator(id, operatorId);
    return { message: 'Offer sent' };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx jest rescue-request.service.spec.ts -t "manualOfferToOperator"
```

Expected: PASS, all three green.

- [ ] **Step 6: Verify TypeScript compiles and the full suite passes**

```bash
npx tsc --noEmit
npx jest
```

Expected: no errors; all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts src/rescue-request/rescue-request.controller.ts src/rescue-request/rescue-request.service.spec.ts
git commit -m "feat(dispatch-board): add admin manual-offer-to-operator action"
```

---

### Task 4: `lrr-web` — `useDispatchBoardApi` hook

**Files:**
- Create: `app/hooks/useDispatchBoardApi.ts`
- Modify: `app/hooks/index.ts`

**Interfaces:**
- Consumes: `GET /rescue-requests/dispatch-board`, `PATCH /:id/cancel` (existing, already used elsewhere via `useRescueRequestApi`), `POST /:id/expand-radius`, `POST /:id/offer-to/:operatorId` (Tasks 1-3).
- Produces: `DispatchBoardRow` type, `useDispatchBoardApi()` returning `{ fetchBoard, expandRadius, offerToOperator }` — consumed by `lrr-web` in Task 5.

- [ ] **Step 1: Write `useDispatchBoardApi.ts`**

Following the exact pattern established by `usePayoutApi.ts`:

```typescript
// app/hooks/useDispatchBoardApi.ts
import { useCallback, useState } from "react";
import { apiFetch } from "./api";

export interface DispatchBoardOffer {
  operatorId: string;
  businessName: string;
  status: string;
  quotedPrice: number | null;
  offeredAt: string;
  respondedAt: string | null;
}

export interface DispatchBoardRow {
  id: string;
  status: string;
  vehicleType: string | null;
  destination: string | null;
  round: number;
  createdAt: string;
  offers: DispatchBoardOffer[];
}

export function useDispatchBoardApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBoard = useCallback(async (): Promise<DispatchBoardRow[]> => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/rescue-requests/dispatch-board");
      return (res.data ?? []) as DispatchBoardRow[];
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch dispatch board";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const expandRadius = useCallback(async (id: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/rescue-requests/${id}/expand-radius`, { method: "POST" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to expand radius";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const offerToOperator = useCallback(async (id: string, operatorId: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      await apiFetch(`/rescue-requests/${id}/offer-to/${operatorId}`, { method: "POST" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send offer";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, error, fetchBoard, expandRadius, offerToOperator };
}
```

- [ ] **Step 2: Register the export**

Add to `app/hooks/index.ts`:

```typescript
export { useDispatchBoardApi } from "./useDispatchBoardApi";
export type { DispatchBoardRow, DispatchBoardOffer } from "./useDispatchBoardApi";
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/hooks/useDispatchBoardApi.ts app/hooks/index.ts
git commit -m "feat(dispatch-board): add useDispatchBoardApi hook"
```

---

### Task 5: `lrr-web` — `DispatchBoardTab.tsx` + route + nav

**Files:**
- Create: `app/components/tabs/DispatchBoardTab.tsx`
- Create: `app/(portal)/dispatch-board/page.tsx`
- Modify: `app/components/portal/nav.ts`

**Interfaces:**
- Consumes: `useDispatchBoardApi` (Task 4), `useRescueRequestApi().cancelRequest(id: string, reason: string)` (existing, `app/hooks/useRescueRequestApi.ts:152` — takes a plain string reason, not an object), `useOperatorApi()`'s `operators`/`fetchAll` (existing — `fetchAll()` populates the hook's own `operators` state array; it does not return the list, so consume `operators` directly from the hook's destructured return, exactly as `OperatorsTab.tsx:195` does).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Write `DispatchBoardTab.tsx`**

Following `PayoutsTab.tsx`'s polling-list-with-actions structure and `OperatorsTab.tsx`'s status-badge styling conventions:

```tsx
"use client";
import { useEffect, useState } from "react";
import { useDispatchBoardApi } from "../../hooks";
import type { DispatchBoardRow } from "../../hooks";
import { useRescueRequestApi, useOperatorApi } from "../../hooks";
import type { Operator } from "../../hooks";

const POLL_MS = 15_000;

const REQUEST_STATUS_LABELS: Record<string, string> = {
  DISPATCHING: "Dispatching",
  OPERATOR_ASSIGNED: "Assigned",
  CANCELLED: "Cancelled",
};

const OFFER_STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  PENDING: { bg: "#fff3cd", text: "#856404" },
  QUOTED: { bg: "#cfe2ff", text: "#084298" },
  SELECTED_PENDING_PAYMENT: { bg: "#cfe2ff", text: "#084298" },
  ACCEPTED: { bg: "#d4edda", text: "#155724" },
  DECLINED: { bg: "#f8d7da", text: "#721c24" },
  NOT_SELECTED: { bg: "#e2e3e5", text: "#383d41" },
  TIMED_OUT: { bg: "#e2e3e5", text: "#383d41" },
};

function fmtTime(d: string) {
  return new Date(d).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" });
}

function OperatorPicker({ operators, onPick, onCancel }: {
  operators: Operator[];
  onPick: (operatorId: string) => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300 }} onClick={onCancel}>
      <div style={{ background: "#fff", borderRadius: 12, padding: "1.5rem", width: 420, maxHeight: "70vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 1rem" }}>Offer to which operator?</h3>
        {operators.filter((op) => op.status === "ACTIVE").map((op) => (
          <button
            key={op.id}
            onClick={() => onPick(op.id)}
            style={{ display: "block", width: "100%", textAlign: "left", padding: "0.6rem", marginBottom: 6, border: "1px solid #dde8f8", borderRadius: 8, background: "#fff", cursor: "pointer" }}
          >
            <strong>{op.businessName}</strong>
            <div style={{ fontSize: "0.8rem", color: "#666" }}>
              {op.truckClasses.join(", ") || "No truck classes set"} · {op.address}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function DispatchBoardTab() {
  const { fetchBoard, expandRadius, offerToOperator } = useDispatchBoardApi();
  const { cancelRequest } = useRescueRequestApi();
  const { operators, fetchAll } = useOperatorApi();

  const [rows, setRows] = useState<DispatchBoardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const board = await fetchBoard();
    setRows(board);
  }

  useEffect(() => {
    load().finally(() => setLoading(false));
    fetchAll();
    const poll = setInterval(load, POLL_MS);
    return () => clearInterval(poll);
  }, []);

  async function handleCancel(id: string) {
    if (!confirm("Cancel this dispatch?")) return;
    setBusy(id);
    try {
      await cancelRequest(id, "Cancelled by admin from dispatch board");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function handleExpandRadius(id: string) {
    setBusy(id);
    try {
      await expandRadius(id);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function handleOfferTo(id: string, operatorId: string) {
    setBusy(id);
    setPickerFor(null);
    try {
      await offerToOperator(id, operatorId);
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div>Loading dispatch board…</div>;
  if (rows.length === 0) return <p style={{ color: "#999" }}>No active or recent dispatches.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {rows.map((row) => {
        const isLive = row.status === "DISPATCHING";
        return (
          <div key={row.id} style={{ background: "#fff", borderRadius: 10, border: "1px solid #dde8f8", padding: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
              <div>
                <strong>{row.vehicleType ?? "Unknown vehicle"}</strong>
                <span style={{ color: "#999", marginLeft: 8 }}>{row.destination ?? "No destination"}</span>
                <span style={{ marginLeft: 8, fontSize: "0.8rem", color: "#666" }}>Round {row.round}</span>
              </div>
              <span style={{ fontSize: "0.82rem", fontWeight: 600, color: isLive ? "#084298" : "#666" }}>
                {REQUEST_STATUS_LABELS[row.status] ?? row.status}
              </span>
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: isLive ? "0.75rem" : 0 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #f0f8ff" }}>
                  {["Operator", "Status", "Quote", "Offered", "Responded"].map((h) => (
                    <th key={h} style={{ textAlign: "left", fontSize: "0.78rem", color: "#999", padding: "0.3rem" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {row.offers.map((o) => {
                  const st = OFFER_STATUS_STYLES[o.status] ?? { bg: "#e2e3e5", text: "#383d41" };
                  return (
                    <tr key={o.operatorId}>
                      <td style={{ padding: "0.3rem", fontSize: "0.85rem" }}>{o.businessName}</td>
                      <td style={{ padding: "0.3rem" }}>
                        <span style={{ background: st.bg, color: st.text, padding: "0.15rem 0.5rem", borderRadius: 4, fontSize: "0.78rem", fontWeight: 600 }}>{o.status}</span>
                      </td>
                      <td style={{ padding: "0.3rem", fontSize: "0.85rem" }}>{o.quotedPrice ? `₦${(o.quotedPrice / 100).toLocaleString()}` : "—"}</td>
                      <td style={{ padding: "0.3rem", fontSize: "0.8rem", color: "#999" }}>{fmtTime(o.offeredAt)}</td>
                      <td style={{ padding: "0.3rem", fontSize: "0.8rem", color: "#999" }}>{o.respondedAt ? fmtTime(o.respondedAt) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {isLive && (
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => handleCancel(row.id)} disabled={busy === row.id} style={{ padding: "0.4rem 0.8rem", background: "#f8d7da", color: "#721c24", border: "none", borderRadius: 6, cursor: "pointer", fontSize: "0.82rem", fontWeight: 600 }}>
                  Cancel
                </button>
                <button onClick={() => handleExpandRadius(row.id)} disabled={busy === row.id} style={{ padding: "0.4rem 0.8rem", background: "#cfe2ff", color: "#084298", border: "none", borderRadius: 6, cursor: "pointer", fontSize: "0.82rem", fontWeight: 600 }}>
                  Expand radius
                </button>
                <button onClick={() => setPickerFor(row.id)} disabled={busy === row.id} style={{ padding: "0.4rem 0.8rem", background: "#003DB4", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontSize: "0.82rem", fontWeight: 600 }}>
                  Offer to operator
                </button>
              </div>
            )}
          </div>
        );
      })}

      {pickerFor && (
        <OperatorPicker
          operators={operators}
          onPick={(operatorId) => handleOfferTo(pickerFor, operatorId)}
          onCancel={() => setPickerFor(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create the `/dispatch-board` route**

Create `app/(portal)/dispatch-board/page.tsx`, following `app/(portal)/payouts/page.tsx`'s exact pattern:

```tsx
"use client";
/** /dispatch-board — live dispatch operations view. Admins only. */
import RequireRole from "../../components/portal/RequireRole";
import DispatchBoardTab from "../../components/tabs/DispatchBoardTab";

export default function DispatchBoardPage() {
  return (
    <RequireRole roles={["ADMIN", "SUPER_ADMIN"]}>
      <DispatchBoardTab />
    </RequireRole>
  );
}
```

- [ ] **Step 3: Register the nav item**

In `app/components/portal/nav.ts`, add to `PORTAL_NAV`, alongside `Operators`:

```typescript
  { label: "Dispatch Board", href: "/dispatch-board", icon: "sirens", section: "Management", roles: ADMINS },
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Manual verification**

With the backend running, log in as admin, open Dispatch Board. Send a real (or test) rescue request through to the DISPATCHING state and confirm it appears with its offered operators. Click Cancel and confirm it disappears from the live section (still visible read-only for the 60-minute history window). Trigger another dispatch and click Expand Radius, confirm a new round starts (new offers appear, round number increments). Click Offer to operator, pick one, confirm they receive the WhatsApp message and the row updates.

- [ ] **Step 6: Commit**

```bash
git add app/components/tabs/DispatchBoardTab.tsx "app/(portal)/dispatch-board/page.tsx" app/components/portal/nav.ts
git commit -m "feat(admin): add live dispatch board with cancel/expand-radius/manual-offer"
```

---

## Post-implementation

After all 5 tasks: use `superpowers:finishing-a-development-branch` — push both repos to `origin/staging`, verify `lrr-service`'s GitHub Actions ECS deploy goes green (`lrr-web` deploys via Vercel with no equivalent CI to watch, same as prior features this session).
