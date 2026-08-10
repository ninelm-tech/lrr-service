# Operator-Submitted Quotes & Shortlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed-price, first-accept-wins dispatch flow with operator-submitted quotes. Operators reply to the WhatsApp dispatch offer with a price; once the batch resolves, the motorist gets a shortlist ranked by price+ETA and picks one. LRR adds a configurable service fee on top; deposit is a configurable percentage — both frozen at selection time so a later config change never touches an in-flight job.

**Architecture:** New `PlatformConfig` singleton row holds `serviceFeePercent`/`depositPercent`, editable via a new admin API + dashboard tab. `DispatchOfferStatus` grows three values (`QUOTED`, `SELECTED_PENDING_PAYMENT`, `NOT_SELECTED`) so a motorist's selection is distinct from the job actually being awarded (which only happens once the deposit webhook confirms). Batch resolution — currently purely timeout-driven — gains an in-memory `Map`-based early-resolve path so a fully-responded batch doesn't wait out its timer, using the map itself as a simple single-process mutex against the timeout firing twice.

**Tech Stack:** NestJS + Prisma (Postgres) backend (`lrr-service`), Next.js frontend (`lrr-web`), Jest for tests.

## Global Constraints

- Operators reply with a single number (price only) — never a two-value reply. ETA is always the system's estimate, never operator-typed.
- Composite shortlist ranking uses price (60%) and ETA (40%) only — no ratings field exists anywhere in this codebase; do not add one.
- `serviceFeeAmount`/`depositAmount`/`balanceAmount` are computed once at motorist selection and persisted on `RescueRequest` — every later step (payment links, receipts) reads the persisted values, never re-reads `PlatformConfig`.
- The job is awarded (`DispatchOffer` → `ACCEPTED`, `RescueRequest` → `OPERATOR_ASSIGNED`) only when the deposit webhook confirms payment — not at the moment of motorist selection.
- Operator payout is always exactly `quotedPrice` — the service fee is pure LRR margin, added on top of what the motorist pays, never deducted from the operator.
- Subscriptions are out of scope for this flow — `handleMediaFinished` and the dispatch/payment path must not read `Subscription` or check tow allowances.
- No minimum quote count before showing a shortlist — one quote is enough.
- No portal-based quoting, no changes to truck-class matching or media capture.

---

## Task 1: Prisma schema — `PlatformConfig`, `DispatchOfferStatus`, new fields

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `PlatformConfig` model (`serviceFeePercent`, `depositPercent`); `DispatchOfferStatus.QUOTED`/`SELECTED_PENDING_PAYMENT`/`NOT_SELECTED`; `DispatchOffer.quotedPrice`; `RescueRequest.serviceFeeAmount`. All later tasks depend on these.

- [ ] **Step 1: Add the new `DispatchOfferStatus` values**

Find the enum (currently `PENDING`/`ACCEPTED`/`DECLINED`/`TIMED_OUT`) and add three values:

```prisma
enum DispatchOfferStatus {
  PENDING
  QUOTED
  SELECTED_PENDING_PAYMENT
  ACCEPTED
  DECLINED
  NOT_SELECTED
  TIMED_OUT
}
```

- [ ] **Step 2: Add `quotedPrice` to `DispatchOffer`**

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

(only the `quotedPrice Int?` line is new — insert directly after `status`.)

- [ ] **Step 3: Add `serviceFeeAmount` to `RescueRequest`**

Find the `depositAmount`/`balanceAmount` block and add `serviceFeeAmount` directly after `depositAmount`:

```prisma
  depositPaid        Boolean             @default(false)
  depositAmount      Int?
  serviceFeeAmount    Int?
  depositReference   String?
  balancePaid        Boolean             @default(false)
  balanceAmount      Int?
  balanceReference   String?
```

- [ ] **Step 4: Add the `PlatformConfig` model**

Add anywhere in the models section (e.g. directly after `RescueRequest`):

```prisma
// Singleton row — platform-wide pricing configuration, admin-editable.
// Read fresh at quote-selection time; never cached, never re-read after a
// job's amounts are persisted onto its RescueRequest.
model PlatformConfig {
  id                String   @id @default(cuid())
  serviceFeePercent Decimal  @default(10.0)
  depositPercent    Decimal  @default(10.0)
  updatedAt         DateTime @updatedAt
}
```

- [ ] **Step 5: Generate the migration and seed the singleton row**

```bash
cd lrr-service
npx prisma generate
npx prisma migrate dev --name add_operator_quotes_and_platform_config
```

After the migration file is generated, open it and append a seed insert at the end (Prisma migrations are plain SQL — this makes the singleton row exist from the moment the migration runs, so the app never has to handle a missing-row case):

```sql
-- Seed the one PlatformConfig row
INSERT INTO "PlatformConfig" ("id", "serviceFeePercent", "depositPercent", "updatedAt")
VALUES ('default', 10.0, 10.0, CURRENT_TIMESTAMP);
```

Then re-apply (the migration already ran once when generated — this edits the same migration file before it's shared, consistent with this being a pilot with no production data):

```bash
npx prisma migrate reset --force
```

This is a destructive local command (drops and recreates the local dev database from migrations) — if you're not comfortable running it, stop here and ask your human partner for explicit approval first, per this project's standing rule that AI agents must never run destructive database commands without explicit human consent.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): add PlatformConfig and quote-related DispatchOffer/RescueRequest fields"
```

---

## Task 2: Quote ranking domain module

**Files:**
- Create: `src/rescue-request/domain/quote-ranking.ts`
- Test: `src/rescue-request/domain/quote-ranking.spec.ts`

**Interfaces:**
- Produces: `estimateEtaMinutes(distanceKm: number): number`; `rankQuotes(quotes: QuoteForRanking[]): RankedQuote[]` where `QuoteForRanking = { offerId: string; operatorId: string; businessName: string; quotedPrice: number; etaMinutes: number }` and `RankedQuote = QuoteForRanking & { score: number }`, sorted highest score first. Task 6 (shortlist building) and Task 4 (offer message ETA estimate) both import this.

- [ ] **Step 1: Write the failing test**

```typescript
// src/rescue-request/domain/quote-ranking.spec.ts
import { estimateEtaMinutes, rankQuotes } from './quote-ranking';

describe('estimateEtaMinutes', () => {
  it('estimates minutes from distance at 20 km/h', () => {
    // 10 km at 20 km/h = 0.5h = 30 min
    expect(estimateEtaMinutes(10)).toBe(30);
  });

  it('rounds to the nearest minute', () => {
    // 3 km at 20 km/h = 0.15h = 9 min
    expect(estimateEtaMinutes(3)).toBe(9);
  });

  it('returns 0 for zero distance', () => {
    expect(estimateEtaMinutes(0)).toBe(0);
  });
});

describe('rankQuotes', () => {
  it('ranks a cheaper-but-slower quote above a pricier-but-faster one when price dominates the weighting', () => {
    const quotes = [
      { offerId: 'a', operatorId: 'op-a', businessName: 'Swift Towing', quotedPrice: 30000, etaMinutes: 20 },
      { offerId: 'b', operatorId: 'op-b', businessName: 'Lagos Rescue Co', quotedPrice: 20000, etaMinutes: 22 },
    ];

    const ranked = rankQuotes(quotes);

    expect(ranked).toHaveLength(2);
    expect(ranked[0].offerId).toBe('b'); // cheaper wins despite slightly slower ETA
    expect(ranked[1].offerId).toBe('a');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('ranks a much-faster quote above a slightly-cheaper one when ETA gap is large', () => {
    const quotes = [
      { offerId: 'a', operatorId: 'op-a', businessName: 'QuickHaul', quotedPrice: 26000, etaMinutes: 10 },
      { offerId: 'b', operatorId: 'op-b', businessName: 'Lagos Rescue Co', quotedPrice: 25000, etaMinutes: 30 },
    ];

    const ranked = rankQuotes(quotes);

    // price gap (26000 vs 25000, ~4% higher) is small relative to
    // the ETA gap (10 vs 30 min, 3x) — QuickHaul should win
    expect(ranked[0].offerId).toBe('a');
  });

  it('handles a single quote without dividing by zero', () => {
    const quotes = [
      { offerId: 'a', operatorId: 'op-a', businessName: 'Solo Towing', quotedPrice: 20000, etaMinutes: 15 },
    ];

    const ranked = rankQuotes(quotes);

    expect(ranked).toHaveLength(1);
    expect(Number.isFinite(ranked[0].score)).toBe(true);
  });

  it('returns an empty array for no quotes', () => {
    expect(rankQuotes([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/rescue-request/domain/quote-ranking.spec.ts
```

Expected: FAIL — `Cannot find module './quote-ranking'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/rescue-request/domain/quote-ranking.ts

const ASSUMED_AVG_SPEED_KMH = 20; // conservative urban-Lagos-traffic assumption

export function estimateEtaMinutes(distanceKm: number): number {
  return Math.round((distanceKm / ASSUMED_AVG_SPEED_KMH) * 60);
}

export interface QuoteForRanking {
  offerId: string;
  operatorId: string;
  businessName: string;
  quotedPrice: number;
  etaMinutes: number;
}

export interface RankedQuote extends QuoteForRanking {
  score: number;
}

const WEIGHT_PRICE = 0.6;
const WEIGHT_ETA = 0.4;

export function rankQuotes(quotes: QuoteForRanking[]): RankedQuote[] {
  if (quotes.length === 0) return [];

  const maxPrice = Math.max(...quotes.map((q) => q.quotedPrice), 1);
  const maxEta = Math.max(...quotes.map((q) => q.etaMinutes), 1);

  const scored: RankedQuote[] = quotes.map((quote) => {
    // Lower price/ETA is better — normalize so 1.0 = best in this set, 0.0 = worst.
    const priceScore = 1 - quote.quotedPrice / maxPrice;
    const etaScore = 1 - quote.etaMinutes / maxEta;

    const score = priceScore * WEIGHT_PRICE + etaScore * WEIGHT_ETA;

    return { ...quote, score };
  });

  return scored.sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/rescue-request/domain/quote-ranking.spec.ts
```

Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/rescue-request/domain/quote-ranking.ts src/rescue-request/domain/quote-ranking.spec.ts
git commit -m "feat(rescue-request): add price/ETA composite quote ranking"
```

---

## Task 3: `PlatformConfig` service + admin settings API

**Files:**
- Create: `src/platform-config/platform-config.service.ts`
- Create: `src/platform-config/platform-config.module.ts`
- Create: `src/platform-config/platform-config.controller.ts`
- Create: `src/platform-config/dto/update-platform-config.dto.ts`
- Test: `src/platform-config/platform-config.service.spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Produces: `PlatformConfigService.getConfig(): Promise<{ serviceFeePercent: number; depositPercent: number }>`, `PlatformConfigService.updateConfig(dto: { serviceFeePercent?: number; depositPercent?: number }): Promise<...>`. `GET /api/v1/admin/settings`, `PATCH /api/v1/admin/settings` (admin-guarded). Task 8 (motorist selection) consumes `getConfig()`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/platform-config/platform-config.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PlatformConfigService } from './platform-config.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PlatformConfigService', () => {
  let service: PlatformConfigService;
  let prisma: {
    platformConfig: { findFirst: jest.Mock; update: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      platformConfig: { findFirst: jest.fn(), update: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformConfigService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<PlatformConfigService>(PlatformConfigService);
  });

  describe('getConfig', () => {
    it('returns the singleton row as plain numbers', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({
        id: 'default',
        serviceFeePercent: { toNumber: () => 10 },
        depositPercent: { toNumber: () => 10 },
      });

      const result = await service.getConfig();

      expect(result).toEqual({ serviceFeePercent: 10, depositPercent: 10 });
    });
  });

  describe('updateConfig', () => {
    it('rejects a serviceFeePercent below 0', async () => {
      await expect(service.updateConfig({ serviceFeePercent: -1 })).rejects.toThrow(BadRequestException);
    });

    it('rejects a depositPercent above 100', async () => {
      await expect(service.updateConfig({ depositPercent: 101 })).rejects.toThrow(BadRequestException);
    });

    it('updates the singleton row when values are valid', async () => {
      prisma.platformConfig.findFirst.mockResolvedValue({ id: 'default' });
      prisma.platformConfig.update.mockResolvedValue({
        id: 'default',
        serviceFeePercent: { toNumber: () => 15 },
        depositPercent: { toNumber: () => 10 },
      });

      const result = await service.updateConfig({ serviceFeePercent: 15 });

      expect(prisma.platformConfig.update).toHaveBeenCalledWith({
        where: { id: 'default' },
        data: { serviceFeePercent: 15 },
      });
      expect(result).toEqual({ serviceFeePercent: 15, depositPercent: 10 });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/platform-config/platform-config.service.spec.ts
```

Expected: FAIL — `Cannot find module './platform-config.service'`.

- [ ] **Step 3: Write `update-platform-config.dto.ts`**

```typescript
// src/platform-config/dto/update-platform-config.dto.ts
import { IsNumber, IsOptional, Max, Min } from 'class-validator';

export class UpdatePlatformConfigDto {
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  serviceFeePercent?: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  depositPercent?: number;
}
```

- [ ] **Step 4: Write `platform-config.service.ts`**

```typescript
// src/platform-config/platform-config.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePlatformConfigDto } from './dto/update-platform-config.dto';

export interface PlatformConfigValues {
  serviceFeePercent: number;
  depositPercent: number;
}

@Injectable()
export class PlatformConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig(): Promise<PlatformConfigValues> {
    const row = await this.prisma.platformConfig.findFirst();
    return {
      serviceFeePercent: Number(row!.serviceFeePercent),
      depositPercent: Number(row!.depositPercent),
    };
  }

  async updateConfig(dto: UpdatePlatformConfigDto): Promise<PlatformConfigValues> {
    if (dto.serviceFeePercent !== undefined && (dto.serviceFeePercent < 0 || dto.serviceFeePercent > 100)) {
      throw new BadRequestException('serviceFeePercent must be between 0 and 100');
    }
    if (dto.depositPercent !== undefined && (dto.depositPercent < 0 || dto.depositPercent > 100)) {
      throw new BadRequestException('depositPercent must be between 0 and 100');
    }

    const existing = await this.prisma.platformConfig.findFirst();

    const data: Record<string, number> = {};
    if (dto.serviceFeePercent !== undefined) data.serviceFeePercent = dto.serviceFeePercent;
    if (dto.depositPercent !== undefined) data.depositPercent = dto.depositPercent;

    const updated = await this.prisma.platformConfig.update({
      where: { id: existing!.id },
      data,
    });

    return {
      serviceFeePercent: Number(updated.serviceFeePercent),
      depositPercent: Number(updated.depositPercent),
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx jest src/platform-config/platform-config.service.spec.ts
```

Expected: PASS, all 4 tests green.

- [ ] **Step 6: Write `platform-config.controller.ts`**

Mirrors the `rescue-request.controller.ts` admin-guard pattern (class-level `AuthGuard`, per-route `RolesGuard` + `Roles`):

```typescript
// src/platform-config/platform-config.controller.ts
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PlatformConfigService } from './platform-config.service';
import { UpdatePlatformConfigDto } from './dto/update-platform-config.dto';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@UseGuards(AuthGuard)
@Controller('admin/settings')
export class PlatformConfigController {
  constructor(private readonly platformConfigService: PlatformConfigService) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async getSettings() {
    const data = await this.platformConfigService.getConfig();
    return { data };
  }

  @Patch()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async updateSettings(@Body() dto: UpdatePlatformConfigDto) {
    const data = await this.platformConfigService.updateConfig(dto);
    return { data };
  }
}
```

- [ ] **Step 7: Write `platform-config.module.ts`**

```typescript
// src/platform-config/platform-config.module.ts
import { Module } from '@nestjs/common';
import { PlatformConfigService } from './platform-config.service';
import { PlatformConfigController } from './platform-config.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PlatformConfigController],
  providers: [PlatformConfigService],
  exports: [PlatformConfigService],
})
export class PlatformConfigModule {}
```

- [ ] **Step 8: Wire `PlatformConfigModule` into `AppModule`**

Add the import and add `PlatformConfigModule` to the `imports` array in `src/app.module.ts`, alongside the other feature modules (`MediaModule`, etc.).

- [ ] **Step 9: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/platform-config src/app.module.ts
git commit -m "feat(platform-config): add admin-editable service fee and deposit percentage settings"
```

---

## Task 4: Simplify `handleMediaFinished` — remove subscriber/fixed-pricing

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RescueRequest` transitions straight to `DISPATCHING` with no pricing fields set — pricing is deferred entirely to motorist quote selection (Task 8). Task 5/6/7/8 build on top of a `DISPATCHING` request with no `depositAmount` yet.

- [ ] **Step 1: Replace `handleMediaFinished`**

Find the current method (starts `private async handleMediaFinished(`) and replace its entire body with:

```typescript
  private async handleMediaFinished(
    phoneNumber: string,
    userId: string,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    rescueRequestId: string,
  ) {
    const [customer, rescueRequestRow] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.rescueRequest.findUnique({ where: { id: rescueRequestId } }),
    ]);
    if (!customer || !rescueRequestRow) {
      await this.sessionStore.update(userId, { state: WhatsAppFlowState.IDLE });
      return this.reply(`Sorry, we lost track of your request. Please send SOS to start again.`);
    }
    const vehicleType = rescueRequestRow.vehicleType as VehicleType;
    const destination = rescueRequestRow.destination as string;

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { status: RescueRequestStatus.DISPATCHING },
    });

    await this.sessionStore.update(userId, {
      state:              WhatsAppFlowState.REQUEST_CONFIRMED,
      dispatchRound:      0,
      offeredOperatorIds: [],
    });

    const greet = customer.name ? `Hi ${customer.name.split(' ')[0]}! ` : '';
    await this.twilioService.sendWhatsAppMessage(
      phoneNumber,
      `${greet}🔍 Searching for nearby tow operators...\n\nVehicle: ${formatVehicleType(vehicleType)}\nDestination: ${destination}\n\nOperators will submit their price and ETA — you'll get a shortlist to choose from shortly. Reply CANCEL at any time.`,
    );

    void this.startDispatch(rescueRequestId, customer.id);
    return this.xmlOk();
  }
```

This removes: the `getActiveSubscription` call, the subscriber-with-allowance branch, the `FULL_AMOUNT_KOBO`/`DEPOSIT_AMOUNT_KOBO` price-note logic, and setting `depositAmount`/`depositPaid` at this stage — pricing is now determined entirely by quote selection (Task 8).

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: `getActiveSubscription`, `DEPOSIT_AMOUNT_KOBO`, `FULL_AMOUNT_KOBO` may now show as unused if nothing else references them yet — that's expected at this point in the plan; later tasks (5, 8, 9) reference/remove the constants. If `tsc` reports them as errors (not just warnings) due to `noUnusedLocals`, leave them for now — Task 9 removes the constants entirely once all usages are gone.

- [ ] **Step 3: Run the full rescue-request test suite**

```bash
npx jest src/rescue-request
```

Expected: PASS — no existing test covers `handleMediaFinished` directly (per this file's established precedent of leaving full state-machine coverage to manual verification), so this is a compile-and-no-regression check.

- [ ] **Step 4: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts
git commit -m "feat(rescue-request): defer all pricing to quote selection, remove subscriber-skip path"
```

---

## Task 5: Operator WhatsApp quote reply

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts`

**Interfaces:**
- Consumes: `estimateEtaMinutes` (Task 2).
- Produces: `DispatchOffer.status` reaches `QUOTED` with `quotedPrice` set when an operator replies with a number. Task 6 (batch resolution) consumes offers in this state.

- [ ] **Step 1: Add the import**

Add to the existing imports in `rescue-request.service.ts`:

```typescript
import { estimateEtaMinutes } from './domain/quote-ranking';
```

- [ ] **Step 2: Update the dispatch offer message text in `startDispatch`**

Find the `Promise.all(batch.map((op) => this.twilioService.sendWhatsAppMessage(...)))` block (the one building the `🚨 *NEW RESCUE JOB*` message) and replace the message template:

```typescript
    // Notify all batch operators simultaneously
    await Promise.all(
      batch.map((op) =>
        this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(op.phoneNumber),
          `🚨 *NEW RESCUE JOB*\n\nVehicle: ${vehicleLabel}\nDestination: ${destinationLabel}\nDistance: ${op.distance.toFixed(1)} km\nLocation: https://maps.google.com/?q=${lat},${lon}${mediaSection}\n\n💰 Reply with your price to bid, e.g. "25000".\nEst. ETA: ~${estimateEtaMinutes(op.distance)} min based on your registered location.\nReply *NO* to decline.\nYou have ${windowSeconds} seconds.`,
        ),
      ),
    );
```

(only the closing paragraph of the template literal changes — everything before `💰 Reply with your price...` is unchanged from the current code.)

- [ ] **Step 3: Add quote-reply parsing to `handleOperatorMessage`**

Find the existing accept/decline branch:

```typescript
    // ── Dispatch accept / decline ──────────────────────────────────────────
    if (message === 'yes' || message === 'accept') {
      return this.handleOperatorResponse(phoneNumber, userId, true);
    }
    if (message === 'no' || message === 'decline') {
      return this.handleOperatorResponse(phoneNumber, userId, false);
    }
```

Replace it with:

```typescript
    // ── Dispatch quote / decline ─────────────────────────────────────────
    if (message === 'no' || message === 'decline') {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, undefined);
    }
    if (/^\d+$/.test(message)) {
      return this.handleOperatorQuoteOrDecline(phoneNumber, userId, Number(message) * 100);
    }
```

(`quotedPriceKobo` of `undefined` signals decline; a parsed number signals a quote. `YES`/`ACCEPT` are no longer valid replies for a dispatch offer — operators now always quote a price or decline.)

- [ ] **Step 4: Add the channel-agnostic quote/decline core, plus a thin WhatsApp wrapper**

Add these two new private methods directly after the modified `handleOperatorMessage` (before `handleOperatorArrived`). `processQuoteOrDecline` is the shared core — Task 12 (dashboard quote submission) calls it directly with an offer it already looked up via the operator's dashboard membership, without going through phone-number lookup at all:

```typescript
  /**
   * Channel-agnostic core: an operator submitted a price (quote) or declined
   * a specific PENDING offer. `quotedPriceKobo` is undefined for a decline.
   * Used by both the WhatsApp reply handler below and the dashboard quote
   * endpoint (Task 12) — the only thing that differs between channels is how
   * the caller resolves `offer` in the first place.
   */
  private async processQuoteOrDecline(
    offer: { id: string; rescueRequestId: string; expiresAt: Date },
    quotedPriceKobo: number | undefined,
  ): Promise<{ quoted: boolean; message: string }> {
    if (quotedPriceKobo === undefined) {
      await this.prisma.dispatchOffer.update({
        where: { id: offer.id },
        data: { status: 'DECLINED', respondedAt: new Date() },
      });
      await this.maybeResolveBatchEarly(offer.rescueRequestId, offer.expiresAt);
      return { quoted: false, message: `Understood. We'll offer this job to another operator.` };
    }

    await this.prisma.dispatchOffer.update({
      where: { id: offer.id },
      data: { status: 'QUOTED', quotedPrice: quotedPriceKobo, respondedAt: new Date() },
    });
    await this.maybeResolveBatchEarly(offer.rescueRequestId, offer.expiresAt);

    return {
      quoted: true,
      message: `✅ Quote of ₦${(quotedPriceKobo / 100).toLocaleString()} submitted! We'll notify you if you're selected.`,
    };
  }

  /**
   * Operator replied to a dispatch offer with either a price (quote) or NO
   * (decline) over WhatsApp. `quotedPriceKobo` is undefined for a decline.
   */
  private async handleOperatorQuoteOrDecline(
    operatorPhone: string,
    operatorUserId: string,
    quotedPriceKobo: number | undefined,
  ) {
    const operator = await this.prisma.operator.findUnique({
      where: { phoneNumber: operatorPhone },
    });
    if (!operator) return this.xmlOk();

    const offer = await this.prisma.dispatchOffer.findFirst({
      where: { operatorId: operator.id, status: 'PENDING' },
      orderBy: { offeredAt: 'desc' },
    });
    if (!offer) return this.xmlOk();

    const result = await this.processQuoteOrDecline(offer, quotedPriceKobo);
    return this.reply(result.message);
  }
```

(`maybeResolveBatchEarly` is added in Task 6 — this task will not compile cleanly until Task 6 lands; that's expected for these two tightly-coupled tasks.)

- [ ] **Step 5: Delete the now-dead `handleOperatorResponse` method**

Step 3 removed the only call site of `handleOperatorResponse` (the old WhatsApp `YES`/`NO` branch). Confirm it has no other callers, then delete it entirely:

```bash
grep -n "handleOperatorResponse" src/rescue-request/rescue-request.service.ts
```

Expected: only the method's own declaration remains (`private async handleOperatorResponse(...)`), no call sites — the dashboard path (`respondToOffer`) calls `processOfferResponse` directly, not through this method. Delete the whole method.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: an error referencing `maybeResolveBatchEarly` not existing yet — this is expected per Step 4's note. Do not attempt to fix it in this task; Task 6 resolves it.

- [ ] **Step 7: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts
git commit -m "feat(rescue-request): accept operator price quotes instead of YES/NO"
```

---

## Task 6: Batch resolution rework — early-resolve + shortlist trigger

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts`

**Interfaces:**
- Consumes: `handleOperatorQuoteOrDecline`'s call to `maybeResolveBatchEarly` (Task 5).
- Produces: `resolveBatch(rescueRequestId, batchOperatorIds, customerId, extraRadiusKm)` — the batch-finalization logic (renamed/reworked from `handleBatchTimeout`), and `maybeResolveBatchEarly(rescueRequestId, expiresAt)` — the early-check entry point. When quotes exist, this hands off to `sendQuoteShortlist` (Task 7); when none exist, it behaves exactly as `handleBatchTimeout` does today (mark stragglers `TIMED_OUT`, call `startDispatch` again).

- [ ] **Step 1: Add the `batchTimers` field**

In the class body, directly after the constructor, add:

```typescript
  /**
   * In-memory map from rescueRequestId to the pending batch-window timer.
   * Doubles as a simple single-process mutex: whichever code path (the
   * timer firing, or an operator's response completing the batch early)
   * finds and deletes the entry first is the one that resolves the batch;
   * the other finds it already gone and returns immediately. Fine for a
   * single-instance pilot deployment — not a distributed lock.
   */
  private readonly batchTimers = new Map<string, NodeJS.Timeout>();
```

- [ ] **Step 2: Replace the `setTimeout` call in `startDispatch`**

Find the final lines of `startDispatch`:

```typescript
    // Single timeout covers the entire batch
    setTimeout(
      () => void this.handleBatchTimeout(rescueRequestId, batchOperatorIds, customerId, extraRadiusKm),
      windowSeconds * 1000,
    );
  }
```

Replace with:

```typescript
    // Single timeout covers the entire batch — stored so an early-resolved
    // batch (Step below) can prevent this from firing a second time.
    const timer = setTimeout(
      () => void this.resolveBatch(rescueRequestId, batchOperatorIds, customerId, extraRadiusKm),
      windowSeconds * 1000,
    );
    this.batchTimers.set(rescueRequestId, timer);
  }
```

- [ ] **Step 3: Rename `handleBatchTimeout` to `resolveBatch` and add the QUOTED branch**

Find the existing `handleBatchTimeout` method and replace it entirely:

```typescript
  private async resolveBatch(
    rescueRequestId: string,
    batchOperatorIds: string[],
    customerId: string,
    extraRadiusKm: number,
  ) {
    // Mutex: only the caller that finds (and removes) the timer entry proceeds.
    const timer = this.batchTimers.get(rescueRequestId);
    if (!timer) return; // already resolved by the other path
    clearTimeout(timer);
    this.batchTimers.delete(rescueRequestId);

    // Race condition guard — skip if the request moved on for any other reason
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: { status: true },
    });
    if (
      !rescueRequest ||
      rescueRequest.status === RescueRequestStatus.OPERATOR_ASSIGNED ||
      rescueRequest.status === RescueRequestStatus.WAITING_FOR_DEPOSIT ||
      rescueRequest.status === RescueRequestStatus.COMPLETED ||
      rescueRequest.status === RescueRequestStatus.CANCELLED
    ) return;

    // Mark all still-pending offers in this batch as timed out
    await this.prisma.dispatchOffer.updateMany({
      where: {
        rescueRequestId,
        operatorId: { in: batchOperatorIds },
        status: 'PENDING',
      },
      data: { status: 'TIMED_OUT', respondedAt: new Date() },
    });

    const quotedOffers = await this.prisma.dispatchOffer.findMany({
      where: { rescueRequestId, status: 'QUOTED' },
    });

    if (quotedOffers.length > 0) {
      await this.sendQuoteShortlist(rescueRequestId, customerId);
      return;
    }

    // No quotes at all this round — move to next batch (same radius; untried
    // operators may still be available), exactly as before.
    void this.startDispatch(rescueRequestId, customerId, extraRadiusKm);
  }

  /**
   * Called after each operator quote/decline. If every operator in the
   * current batch has now responded, resolves the batch immediately instead
   * of waiting out the rest of the window.
   */
  private async maybeResolveBatchEarly(rescueRequestId: string, batchExpiresAt: Date) {
    const batchOffers = await this.prisma.dispatchOffer.findMany({
      where: { rescueRequestId, expiresAt: batchExpiresAt },
      select: { operatorId: true, status: true },
    });
    const stillPending = batchOffers.some((o) => o.status === 'PENDING');
    if (stillPending) return;

    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      select: { customerId: true },
    });
    if (!rescueRequest) return;

    const batchOperatorIds = batchOffers.map((o) => o.operatorId);
    // extraRadiusKm isn't tracked per-batch outside the session; 0 is correct
    // here because an early-resolved batch (all responded) never needed a
    // radius expansion to find candidates — expansion only happens when
    // zero candidates exist at all, a separate path in startDispatch.
    void this.resolveBatch(rescueRequestId, batchOperatorIds, rescueRequest.customerId, 0);
  }
```

(`sendQuoteShortlist` is added in Task 7 — this task will not compile cleanly until Task 7 lands, same tightly-coupled situation as Task 5.)

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: an error referencing `sendQuoteShortlist` not existing yet — expected, resolved by Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts
git commit -m "feat(rescue-request): resolve dispatch batches early once all operators respond"
```

---

## Task 7: Motorist shortlist — build and send

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts`
- Modify: `src/rescue-request/rescue-request.module.ts`
- Modify: `src/rescue-request/state/whatsapp-session.types.ts`

**Interfaces:**
- Consumes: `rankQuotes`, `estimateEtaMinutes` (Task 2); `PlatformConfigService.getConfig()` (Task 3) — needed here because the shortlist must display marked-up totals, not raw quotes.
- Produces: `WhatsAppFlowState.WAITING_FOR_QUOTE_SELECTION`; `sendQuoteShortlist(rescueRequestId, customerId): Promise<void>`; `platformConfigService` added to the constructor (Task 8 reuses it, no further wiring needed there). Task 8 (motorist selection) reads the session field this sets and handles the new state.

- [ ] **Step 1: Add `PlatformConfigService` to the constructor**

```typescript
  constructor(
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
    private readonly operatorService: OperatorService,
    private readonly s3Service: S3Service,
    private readonly platformConfigService: PlatformConfigService,
  ) {}
```

Add the import at the top of the file:

```typescript
import { PlatformConfigService } from '../platform-config/platform-config.service';
```

- [ ] **Step 2: Wire `PlatformConfigModule` into `RescueRequestModule`**

```typescript
// src/rescue-request/rescue-request.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RescueRequestService } from './rescue-request.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { PrismaModule } from '../prisma/prisma.module';
import { RescueRequestController } from './rescue-request.controller';
import { PaystackModule } from '../integrations/paystack/paystack.module';
import { TwilioModule } from '../integrations/twilio/twilio.module';
import { S3Module } from '../integrations/s3/s3.module';
import { OperatorModule } from '../operator/operator.module';
import { PlatformConfigModule } from '../platform-config/platform-config.module';
import { AuthGuard } from '../auth/auth.guard';

@Module({
  imports: [
    PrismaModule,
    PaystackModule,
    TwilioModule,
    S3Module,
    OperatorModule,
    PlatformConfigModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key',
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [RescueRequestController],
  providers: [RescueRequestService, WhatsAppSessionStore, AuthGuard],
  exports: [RescueRequestService],
})
export class RescueRequestModule {}
```

- [ ] **Step 3: Add the new flow state**

In `whatsapp-session.types.ts`, add directly after `WAITING_FOR_MEDIA`:

```typescript
export enum WhatsAppFlowState {
  IDLE = 'IDLE',
  WAITING_FOR_LOCATION = 'WAITING_FOR_LOCATION',
  WAITING_FOR_VEHICLE_TYPE = 'WAITING_FOR_VEHICLE_TYPE',
  WAITING_FOR_DESTINATION = 'WAITING_FOR_DESTINATION',
  WAITING_FOR_MEDIA = 'WAITING_FOR_MEDIA',
  WAITING_FOR_QUOTE_SELECTION = 'WAITING_FOR_QUOTE_SELECTION',
  WAITING_FOR_ISSUE_TYPE = 'WAITING_FOR_ISSUE_TYPE',
  WAITING_FOR_DEPOSIT = 'WAITING_FOR_DEPOSIT',
  REQUEST_CONFIRMED = 'REQUEST_CONFIRMED',
  ...
```

- [ ] **Step 4: Add `sendQuoteShortlist`**

Add this new private method in `rescue-request.service.ts`, directly after `resolveBatch`/`maybeResolveBatchEarly` (from Task 6):

```typescript
  private readonly QUOTE_SELECTION_WINDOW_MS = 5 * 60 * 1000;

  private async sendQuoteShortlist(rescueRequestId: string, customerId: string) {
    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true },
    });
    if (!rescueRequest) return;

    const quotedOffers = await this.prisma.dispatchOffer.findMany({
      where: { rescueRequestId, status: 'QUOTED' },
      include: { operator: true },
    });
    if (quotedOffers.length === 0) return;

    const lat = Number(rescueRequest.latitude);
    const lon = Number(rescueRequest.longitude);

    const forRanking = quotedOffers.map((offer) => {
      const distance = this.operatorService['calculateDistance'](
        lat, lon, Number(offer.operator.latitude), Number(offer.operator.longitude),
      );
      return {
        offerId: offer.id,
        operatorId: offer.operatorId,
        businessName: offer.operator.businessName,
        quotedPrice: offer.quotedPrice!,
        etaMinutes: estimateEtaMinutes(distance),
      };
    });

    const ranked = rankQuotes(forRanking); // ranks by raw quotedPrice — markup is a uniform % and never changes order

    const config = await this.platformConfigService.getConfig();
    const lines = ranked.map((q, i) => {
      const numberEmoji = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'][i] ?? `${i + 1}.`;
      // Motorist-facing amount is ALWAYS quotedPrice + service fee — never the raw quote.
      // This must exactly match what handleQuoteSelected (Task 8) later charges, so the
      // motorist never sees one number here and a different one at payment.
      const displayTotal = q.quotedPrice + Math.round((q.quotedPrice * config.serviceFeePercent) / 100);
      const priceNaira = (displayTotal / 100).toLocaleString();
      return `${numberEmoji} ₦${priceNaira} · ETA ${q.etaMinutes} min · ${q.businessName}`;
    });

    const customerPhone = rescueRequest.customer.phoneNumber;
    if (customerPhone) {
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `🚗 *Operator quotes received!*\n\n${lines.join('\n')}\n\nReply with the number of your choice.`,
      );
    }

    await this.sessionStore.update(customerId, {
      state: WhatsAppFlowState.WAITING_FOR_QUOTE_SELECTION,
    });

    setTimeout(async () => {
      const fresh = await this.sessionStore.getOrCreate(customerId);
      if (fresh.state !== WhatsAppFlowState.WAITING_FOR_QUOTE_SELECTION) return; // already selected

      // Timed out — release every quoting operator and let the motorist retry.
      await this.prisma.dispatchOffer.updateMany({
        where: { rescueRequestId, status: 'QUOTED' },
        data: { status: 'TIMED_OUT', respondedAt: new Date() },
      });
      await this.prisma.rescueRequest.update({
        where: { id: rescueRequestId },
        data: { status: RescueRequestStatus.CANCELLED },
      });
      await this.sessionStore.clear(customerId);

      if (customerPhone) {
        await this.twilioService.sendWhatsAppMessage(
          customerPhone,
          `⏰ You didn't choose a quote in time. Your request has been cancelled — send SOS to start again.`,
        );
      }
      await Promise.all(
        quotedOffers.map((offer) =>
          this.twilioService.sendWhatsAppMessage(
            toWhatsAppAddress(offer.operator.phoneNumber),
            `⏰ The customer didn't respond in time. You've been released. Watch for new offers!`,
          ),
        ),
      );
    }, this.QUOTE_SELECTION_WINDOW_MS);
  }
```

Note: `this.operatorService['calculateDistance'](...)` calls a private method via bracket-notation access — this is a pragmatic reuse of the existing Haversine-distance helper already on `OperatorService` rather than duplicating the formula. If TypeScript's strictness rejects this even with bracket notation, make `calculateDistance` `public` on `OperatorService` instead (a one-word visibility change, not a behavior change) and call it as `this.operatorService.calculateDistance(...)`.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors now that both `maybeResolveBatchEarly`'s call into `resolveBatch` and `resolveBatch`'s call into `sendQuoteShortlist` resolve. If `calculateDistance` access fails, apply the visibility fix noted in Step 4 and re-check.

- [ ] **Step 6: Run the full rescue-request test suite**

```bash
npx jest src/rescue-request
```

Expected: PASS — existing suites unaffected; no dedicated new test for this task (state-machine/timer logic, consistent with this file's established precedent of relying on manual verification for timer-driven flows).

- [ ] **Step 7: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts src/rescue-request/rescue-request.module.ts src/rescue-request/state/whatsapp-session.types.ts
git commit -m "feat(rescue-request): build and send the motorist quote shortlist"
```

---

## Task 8: Motorist quote selection

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts`

**Interfaces:**
- Consumes: `PlatformConfigService.getConfig()` (Task 3, wired into the constructor in Task 7).
- Produces: on selection, `DispatchOffer` → `SELECTED_PENDING_PAYMENT`, `RescueRequest` → `WAITING_FOR_DEPOSIT` with `serviceFeeAmount`/`depositAmount`/`balanceAmount` persisted. Task 9 (payment webhook) reads these persisted amounts and completes the award.

`platformConfigService` is already available on `this` — Task 7 added it to the constructor (it needed it first, for the shortlist's displayed-total calculation) and wired `PlatformConfigModule` into `RescueRequestModule`. No further wiring needed here.

- [ ] **Step 1: Add the `WAITING_FOR_QUOTE_SELECTION` branch to `handleIncomingWhatsAppMessage`**

Find the `WAITING_FOR_MEDIA` block's closing `}` in `handleIncomingWhatsAppMessage` and add directly after it:

```typescript
    // ── Step 3c: Waiting for quote selection ───────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_QUOTE_SELECTION) {
      const choice = Number(message);
      if (!Number.isInteger(choice) || choice < 1) {
        return this.reply(`Please reply with the number of the quote you'd like to choose.`);
      }
      return this.handleQuoteSelected(phoneNumber, userId, choice);
    }
```

- [ ] **Step 2: Add `handleQuoteSelected`**

Add this new private method directly after `sendQuoteShortlist` (Task 7):

```typescript
  private async handleQuoteSelected(phoneNumber: string, userId: string, choice: number) {
    const session = await this.sessionStore.getOrCreate(userId);
    const rescueRequestId = session.rescueRequestId;
    if (!rescueRequestId) {
      await this.sessionStore.update(userId, { state: WhatsAppFlowState.IDLE });
      return this.reply(`Sorry, we lost track of your request. Please send SOS to start again.`);
    }

    const rescueRequest = await this.prisma.rescueRequest.findUnique({
      where: { id: rescueRequestId },
      include: { customer: true },
    });
    if (!rescueRequest) {
      return this.reply(`Sorry, we lost track of your request. Please send SOS to start again.`);
    }

    const quotedOffers = await this.prisma.dispatchOffer.findMany({
      where: { rescueRequestId, status: 'QUOTED' },
      include: { operator: true },
    });
    if (quotedOffers.length === 0) {
      return this.reply(`Sorry, those quotes are no longer available.`);
    }

    const lat = Number(rescueRequest.latitude);
    const lon = Number(rescueRequest.longitude);
    const forRanking = quotedOffers.map((offer) => ({
      offerId: offer.id,
      operatorId: offer.operatorId,
      businessName: offer.operator.businessName,
      quotedPrice: offer.quotedPrice!,
      etaMinutes: estimateEtaMinutes(
        this.operatorService['calculateDistance'](lat, lon, Number(offer.operator.latitude), Number(offer.operator.longitude)),
      ),
    }));
    const ranked = rankQuotes(forRanking);

    const selected = ranked[choice - 1];
    if (!selected) {
      return this.reply(`That's not one of the options. Please reply with a valid number from the list.`);
    }

    // Atomic claim — only proceeds if the request is still DISPATCHING.
    const claimed = await this.prisma.rescueRequest.updateMany({
      where: { id: rescueRequestId, status: RescueRequestStatus.DISPATCHING },
      data: { status: RescueRequestStatus.WAITING_FOR_DEPOSIT },
    });
    if (claimed.count === 0) {
      return this.reply(`Sorry, this request has already moved on.`);
    }

    const config = await this.platformConfigService.getConfig();
    const serviceFeeAmount = Math.round((selected.quotedPrice * config.serviceFeePercent) / 100);
    const total = selected.quotedPrice + serviceFeeAmount;
    const depositAmount = Math.round((total * config.depositPercent) / 100);
    const balanceAmount = total - depositAmount;

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { serviceFeeAmount, depositAmount, balanceAmount, assignedOperatorId: selected.operatorId },
    });

    const selectedOffer = quotedOffers.find((o) => o.id === selected.offerId)!;
    await this.prisma.dispatchOffer.update({
      where: { id: selectedOffer.id },
      data: { status: 'SELECTED_PENDING_PAYMENT', respondedAt: new Date() },
    });
    await this.prisma.dispatchOffer.updateMany({
      where: { rescueRequestId, status: 'QUOTED', id: { not: selectedOffer.id } },
      data: { status: 'NOT_SELECTED', respondedAt: new Date() },
    });

    // Notify the operators who weren't picked.
    await Promise.all(
      quotedOffers
        .filter((o) => o.id !== selectedOffer.id)
        .map((o) =>
          this.twilioService.sendWhatsAppMessage(
            toWhatsAppAddress(o.operator.phoneNumber),
            `Sorry, the customer chose another quote — thanks for bidding!`,
          ),
        ),
    );

    await this.sessionStore.update(userId, { state: WhatsAppFlowState.OPERATOR_FOUND_WAITING_PAYMENT });

    const operator = selectedOffer.operator;
    const reference = this.paystackService.generateReference('DEP');
    const email = rescueRequest.customer.email ?? `${phoneNumber.replace(/\D/g, '')}@lrr.ng`;

    const paymentResponse = await this.paystackService.initializePayment({
      email,
      amount: depositAmount,
      reference,
      metadata: {
        rescueRequestId,
        customerId: rescueRequest.customerId,
        phoneNumber,
        type: 'deposit',
      },
    });

    if (!paymentResponse.status) {
      console.error('Failed to create deposit payment link:', paymentResponse);
      return this.reply(`⚠️ We couldn't generate a payment link. Our team has been alerted. Reply CANCEL to cancel.`);
    }

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { depositReference: reference },
    });

    const depositNaira = (depositAmount / 100).toLocaleString();
    const balanceNaira = (balanceAmount / 100).toLocaleString();

    void this.twilioService.sendWhatsAppMessage(
      phoneNumber,
      `🚗 *Operator selected!*\n\nBusiness: ${operator.businessName}\n💰 Deposit: *₦${depositNaira}* now · ₦${balanceNaira} balance on completion\n\n⏳ You have *5 minutes* to confirm:\n\n${paymentResponse.data.authorization_url}\n\nThe operator is standing by. Reply CANCEL to cancel (no charge).`,
    );

    const DEPOSIT_WINDOW_MS = 5 * 60 * 1000;
    setTimeout(async () => {
      const fresh = await this.prisma.rescueRequest.findUnique({
        where: { id: rescueRequestId },
        select: { status: true },
      });
      if (fresh?.status !== RescueRequestStatus.WAITING_FOR_DEPOSIT) return;

      await this.prisma.dispatchOffer.update({
        where: { id: selectedOffer.id },
        data: { status: 'TIMED_OUT', respondedAt: new Date() },
      });
      await this.prisma.rescueRequest.update({
        where: { id: rescueRequestId },
        data: { assignedOperatorId: null, status: RescueRequestStatus.DISPATCHING },
      });
      const freshSession = await this.sessionStore.getOrCreate(rescueRequest.customerId);
      await this.sessionStore.update(rescueRequest.customerId, {
        state: WhatsAppFlowState.REQUEST_CONFIRMED,
        offeredOperatorIds: [...(freshSession.offeredOperatorIds ?? []), operator.id],
      });
      await this.twilioService.sendWhatsAppMessage(
        phoneNumber,
        `⏰ Payment window expired. Looking for the next available operator...`,
      );
      void this.startDispatch(rescueRequestId, rescueRequest.customerId);
      await this.twilioService.sendWhatsAppMessage(
        toWhatsAppAddress(operator.phoneNumber),
        `⏰ The customer did not pay within 5 minutes. You have been released. Watch for new offers!`,
      );
    }, DEPOSIT_WINDOW_MS);

    return this.xmlOk();
  }
```

Add the two new imports at the top of the file (alongside the existing `quote-ranking` import from Task 5, if not already grouped):

```typescript
import { rankQuotes } from './domain/quote-ranking';
```

(`estimateEtaMinutes` is already imported from Task 5.)

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run the full rescue-request test suite**

```bash
npx jest src/rescue-request
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts
git commit -m "feat(rescue-request): handle motorist quote selection with frozen pricing"
```

---

## Task 9: Payment webhook gating — award the job on payment, not selection

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts`

**Interfaces:**
- Consumes: `RescueRequest.serviceFeeAmount`/`depositAmount`/`balanceAmount` (Task 8).
- Produces: `DispatchOffer` reaches `ACCEPTED` only here (deposit webhook), completing the "award on payment" behavior described throughout this plan.

- [ ] **Step 1: Update `handleDepositPaymentConfirmed`**

Find the method and add the offer-status flip. Locate this block:

```typescript
    // Mark deposit paid and fully confirm the operator assignment
    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data:  { depositPaid: true, status: RescueRequestStatus.OPERATOR_ASSIGNED },
    });

    const operator = rescueRequest.assignedOperator;
```

Replace with:

```typescript
    // Mark deposit paid and fully confirm the operator assignment
    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data:  { depositPaid: true, status: RescueRequestStatus.OPERATOR_ASSIGNED },
    });

    // The offer is only actually awarded now that payment is confirmed —
    // selection alone (Task 8) only reached SELECTED_PENDING_PAYMENT.
    if (rescueRequest.assignedOperatorId) {
      await this.prisma.dispatchOffer.updateMany({
        where: {
          rescueRequestId: rescueRequest.id,
          operatorId: rescueRequest.assignedOperatorId,
          status: 'SELECTED_PENDING_PAYMENT',
        },
        data: { status: 'ACCEPTED' },
      });
    }

    const operator = rescueRequest.assignedOperator;
```

- [ ] **Step 2: Make `sendBalancePaymentLink` use the persisted `balanceAmount`**

Find `sendBalancePaymentLink` and replace the hardcoded `BALANCE_AMOUNT_KOBO` usage:

```typescript
  private async sendBalancePaymentLink(rescueRequest: any) {
    const customerPhone = rescueRequest.customer.phoneNumber;
    if (!customerPhone) return;

    const balanceAmount = rescueRequest.balanceAmount;
    if (!balanceAmount) {
      console.error('No balanceAmount persisted for rescue request:', rescueRequest.id);
      Sentry.captureMessage(`sendBalancePaymentLink: missing balanceAmount for ${rescueRequest.id}`, 'error');
      return;
    }

    const reference = this.paystackService.generateReference('BAL');
    const email = rescueRequest.customer.email || `${customerPhone.replace(/\D/g, '')}@lrr.ng`;

    const paymentResponse = await this.paystackService.initializePayment({
      email,
      amount: balanceAmount,
      reference,
      metadata: {
        rescueRequestId: rescueRequest.id,
        customerId:      rescueRequest.customerId,
        phoneNumber:     customerPhone,
        type: 'balance',
      },
    });

    if (!paymentResponse.status) {
      console.error('Failed to create balance payment link:', paymentResponse);
      return;
    }

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequest.id },
      data:  { balanceReference: reference },
    });

    const balanceNaira = (balanceAmount / 100).toLocaleString();
    await this.twilioService.sendWhatsAppMessage(
      customerPhone,
      `✅ Your tow is complete!\n\nPlease pay the ₦${balanceNaira} balance:\n\n${paymentResponse.data.authorization_url}\n\nThank you for using Lagos Roadside Rescue 🚗`,
    );
  }
```

(the amount now comes from `rescueRequest.balanceAmount`, already persisted at selection time in Task 8, rather than the fixed `BALANCE_AMOUNT_KOBO`; `data: { balanceAmount: BALANCE_AMOUNT_KOBO, ... }` is removed from the update since the field is already set.)

- [ ] **Step 3: Update `handleBalancePaymentConfirmed`'s message text**

Find this line in `handleBalancePaymentConfirmed`:

```typescript
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `✅ Payment of ₦45,000 confirmed! Thank you for using Lagos Roadside Rescue 🙏\n\nHow was your experience? Reply 1–5 to rate your operator.`,
      );
```

Replace with (using the persisted `balanceAmount`, and dropping the "reply 1–5 to rate" line since no ratings system exists — this was already dead functionality, out of scope to build here per this plan's Non-goals):

```typescript
      const balanceNaira = ((rescueRequest.balanceAmount ?? 0) / 100).toLocaleString();
      await this.twilioService.sendWhatsAppMessage(
        customerPhone,
        `✅ Payment of ₦${balanceNaira} confirmed! Thank you for using Lagos Roadside Rescue 🙏`,
      );
```

- [ ] **Step 4: Do NOT delete the old fixed-price constants — they're still reachable**

It's tempting to remove `DEPOSIT_AMOUNT_KOBO`/`BALANCE_AMOUNT_KOBO`/`FULL_AMOUNT_KOBO` now that Task 4/8 stopped using them in the WhatsApp quote flow. **Leave them in place.** Confirm why first:

```bash
grep -n "sendDepositRequestToCustomer\|DEPOSIT_AMOUNT_KOBO\|FULL_AMOUNT_KOBO" src/rescue-request/rescue-request.service.ts
```

This will show `processOfferResponse` (the shared accept/decline handler still used by the operator **dashboard's** pending-offers view — `respondToOffer`/`listMyPendingOffers`, untouched by this plan per its Non-goals) still calls `sendDepositRequestToCustomer`, which still reads `DEPOSIT_AMOUNT_KOBO`/`FULL_AMOUNT_KOBO`. That dashboard path was never updated to the new quote/shortlist model in this plan — it's explicitly out of scope (updating it is a flagged follow-up) — so it still operates on the old fixed-price assumption. Deleting the constants or `sendDepositRequestToCustomer` would break that still-reachable code path. Leave `initiateDeposit`, `sendDepositRequestToCustomer`, and all three constants exactly as they are; they're dead from the WhatsApp SOS flow's perspective but alive from the dashboard's.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run the full test suite**

```bash
npx jest
```

Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts
git commit -m "feat(rescue-request): award the job on deposit payment, use persisted quote-based amounts"
```

---

## Task 10: `lrr-web` — `useSettingsApi` hook

**Files:**
- Create: `app/hooks/useSettingsApi.ts`
- Modify: `app/hooks/index.ts`

**Interfaces:**
- Produces: `useSettingsApi()` returning `{ settings, loading, error, fetchSettings, updateSettings }` where `settings: { serviceFeePercent: number; depositPercent: number } | null`. Task 11 (Settings page) consumes this.

- [ ] **Step 1: Write `useSettingsApi.ts`**

Follows the exact pattern established by `useOperatorApi.ts` (local `useState`, `useCallback`-wrapped actions, `apiFetch` for HTTP, try/catch/finally):

```typescript
// app/hooks/useSettingsApi.ts
import { useCallback, useState } from "react";
import { apiFetch } from "./api";

export interface PlatformSettings {
  serviceFeePercent: number;
  depositPercent: number;
}

export function useSettingsApi() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async (): Promise<PlatformSettings> => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/admin/settings");
      const data = res.data as PlatformSettings;
      setSettings(data);
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch settings";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const updateSettings = useCallback(async (data: Partial<PlatformSettings>): Promise<PlatformSettings> => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const updated = res.data as PlatformSettings;
      setSettings(updated);
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update settings";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { settings, loading, error, fetchSettings, updateSettings };
}
```

- [ ] **Step 2: Register the export**

Add to `app/hooks/index.ts`:

```typescript
export { useSettingsApi } from "./useSettingsApi";
export type { PlatformSettings } from "./useSettingsApi";
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd lrr-web
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/hooks/useSettingsApi.ts app/hooks/index.ts
git commit -m "feat(hooks): add useSettingsApi for platform config"
```

---

## Task 11: `lrr-web` — Admin Platform Settings page

**Files:**
- Create: `app/components/tabs/PlatformSettingsTab.tsx`
- Create: `app/(portal)/platform-settings/page.tsx`
- Modify: `app/components/portal/nav.ts`

**Interfaces:**
- Consumes: `useSettingsApi` (Task 10).
- Produces: a new `/platform-settings` route, admin-only, with a form to view/edit `serviceFeePercent`/`depositPercent`.

- [ ] **Step 1: Add the nav entry**

In `app/components/portal/nav.ts`, add a new entry to `PORTAL_NAV` (the existing `/settings` entry is personal account settings for every role — this is a distinct, admin-only platform-config route):

```typescript
  { label: "Platform Settings", href: "/platform-settings", icon: "settings", section: "Management", roles: ADMINS },
```

(insert it in the `Management` section, alongside `Operators`/`Manage Users`.)

- [ ] **Step 2: Write `PlatformSettingsTab.tsx`**

Follows the structural pattern of `PaymentsTab.tsx` (`"use client"`, hook-driven state, `useEffect` fetch-on-mount, inline `style={{}}` objects — no CSS framework in this codebase):

```tsx
// app/components/tabs/PlatformSettingsTab.tsx
"use client";
import { useEffect, useState } from "react";
import { useSettingsApi } from "../../hooks";

export default function PlatformSettingsTab() {
  const { settings, loading, error, fetchSettings, updateSettings } = useSettingsApi();
  const [serviceFeePercent, setServiceFeePercent] = useState("");
  const [depositPercent, setDepositPercent] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (settings) {
      setServiceFeePercent(String(settings.serviceFeePercent));
      setDepositPercent(String(settings.depositPercent));
    }
  }, [settings]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    await updateSettings({
      serviceFeePercent: Number(serviceFeePercent),
      depositPercent: Number(depositPercent),
    });
    setSaved(true);
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "1rem" }}>Platform Settings</h2>
      <p style={{ color: "#666", marginBottom: "1.5rem" }}>
        These percentages apply to every new quote a motorist selects going forward.
        Jobs already in progress keep the terms the motorist originally agreed to.
      </p>
      <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div>
          <label style={{ display: "block", fontSize: "0.95rem", fontWeight: 600, marginBottom: 8 }}>
            Service fee (%)
          </label>
          <input
            type="number"
            min={0}
            max={100}
            step="0.1"
            value={serviceFeePercent}
            onChange={(e) => setServiceFeePercent(e.target.value)}
            style={{ width: "100%", padding: "0.75rem", border: "1.5px solid #dde8f8", borderRadius: 8 }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontSize: "0.95rem", fontWeight: 600, marginBottom: 8 }}>
            Deposit (%)
          </label>
          <input
            type="number"
            min={0}
            max={100}
            step="0.1"
            value={depositPercent}
            onChange={(e) => setDepositPercent(e.target.value)}
            style={{ width: "100%", padding: "0.75rem", border: "1.5px solid #dde8f8", borderRadius: 8 }}
          />
        </div>
        {error && <p style={{ color: "#c00" }}>{error}</p>}
        {saved && !error && <p style={{ color: "#0a0" }}>Saved.</p>}
        <button
          type="submit"
          disabled={loading}
          style={{ padding: "0.75rem 1.5rem", background: "#07152f", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer" }}
        >
          {loading ? "Saving..." : "Save"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Write the route page**

```tsx
// app/(portal)/platform-settings/page.tsx
"use client";
/** /platform-settings — admin-only platform pricing config (service fee %, deposit %). */
import RequireRole from "../../components/portal/RequireRole";
import PlatformSettingsTab from "../../components/tabs/PlatformSettingsTab";

export default function PlatformSettingsPage() {
  return (
    <RequireRole roles={["ADMIN", "SUPER_ADMIN"]}>
      <PlatformSettingsTab />
    </RequireRole>
  );
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/components/tabs/PlatformSettingsTab.tsx app/\(portal\)/platform-settings/page.tsx app/components/portal/nav.ts
git commit -m "feat(admin): add Platform Settings page for service fee and deposit percentages"
```

---

## Task 12: Dashboard quote submission — backend

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts`
- Modify: `src/rescue-request/rescue-request.controller.ts`

**Interfaces:**
- Consumes: `processQuoteOrDecline` (Task 5).
- Produces: `listMyPendingOffers` now includes `vehicleType`, `destination`, and `mediaLinks` per offer; `respondToOffer(userId, offerId, priceKobo?: number)` now submits a quote (or declines when `priceKobo` is omitted) via the shared core instead of instant-accepting. Task 13 (dashboard frontend) consumes both.

- [ ] **Step 1: Extend `listMyPendingOffers` with pricing-relevant job details**

Find the method and replace its `dispatchOffer.findMany`/mapping to include what an operator needs to price a job — vehicle type, destination, and media links (mirroring the same `{API_BASE_URL}/api/v1/media/{id}` link format already sent over WhatsApp):

```typescript
  /** List PENDING dispatch offers for all operators this user belongs to. */
  async listMyPendingOffers(userId: string) {
    const memberships = await this.prisma.operatorMember.findMany({
      where: { userId },
      select: { operatorId: true },
    });
    if (memberships.length === 0) return { data: [] };

    const offers = await this.prisma.dispatchOffer.findMany({
      where: {
        operatorId: { in: memberships.map((m) => m.operatorId) },
        status: 'PENDING',
        expiresAt: { gte: new Date() },
      },
      include: {
        rescueRequest: {
          select: {
            id: true, latitude: true, longitude: true, createdAt: true,
            vehicleType: true, destination: true,
            media: { select: { id: true } },
          },
        },
      },
      orderBy: { offeredAt: 'desc' },
    });

    const apiBaseUrl = process.env.API_BASE_URL;

    // Note: customer contact details are deliberately NOT exposed before acceptance.
    return {
      data: offers.map((o) => ({
        id:        o.id,
        offeredAt: o.offeredAt,
        expiresAt: o.expiresAt,
        request: {
          id:          o.rescueRequest.id,
          vehicleType: o.rescueRequest.vehicleType,
          destination: o.rescueRequest.destination,
          latitude:    o.rescueRequest.latitude,
          longitude:   o.rescueRequest.longitude,
          createdAt:   o.rescueRequest.createdAt,
          mediaLinks: apiBaseUrl
            ? o.rescueRequest.media.map((m) => `${apiBaseUrl}/api/v1/media/${m.id}`)
            : [],
        },
      })),
    };
  }
```

- [ ] **Step 2: Rewrite `respondToOffer` to submit a quote instead of instant-accepting**

Find the method and replace it entirely:

```typescript
  /** Submit a price quote (or decline) for a pending offer from the dashboard. */
  async respondToOffer(userId: string, offerId: string, priceKobo?: number) {
    const memberships = await this.prisma.operatorMember.findMany({
      where: { userId },
      select: { operatorId: true },
    });
    const operatorIds = memberships.map((m) => m.operatorId);

    const offer = await this.prisma.dispatchOffer.findUnique({
      where: { id: offerId },
    });

    if (!offer || !operatorIds.includes(offer.operatorId)) {
      throw new NotFoundException('Offer not found');
    }
    if (offer.status !== 'PENDING') {
      throw new BadRequestException('This offer is no longer available.');
    }

    const result = await this.processQuoteOrDecline(offer, priceKobo);
    return { data: result };
  }
```

Confirm `NotFoundException`/`BadRequestException` are already imported at the top of the file (they were used by the old version of this method) — if not, add:

```typescript
import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
```

(merge into whatever the existing `@nestjs/common` import line already contains, rather than duplicating the import.)

- [ ] **Step 3: Update the controller endpoint's request body shape**

In `rescue-request.controller.ts`, find `respondToOffer` and update the body it reads and passes through:

```typescript
  /** Submit a quote or decline a pending offer from the dashboard. */
  @Post('offers/:offerId/respond')
  @UseGuards(RolesGuard)
  @Roles(UserRole.OPERATOR)
  async respondToOffer(
    @Req() req: Request,
    @Param('offerId') offerId: string,
    @Body() body: { priceNaira?: number },
  ) {
    const priceKobo = body.priceNaira !== undefined ? Math.round(body.priceNaira * 100) : undefined;
    return this.rescueRequestService.respondToOffer(
      (req.user as any).userId,
      offerId,
      priceKobo,
    );
  }
```

(the request body field renames from `accept: boolean` to `priceNaira?: number` — a quote is submitted by including a price; a decline is submitted by omitting it entirely.)

- [ ] **Step 4: Delete the now-dead `processOfferResponse` method**

Step 2 removed `respondToOffer`'s only remaining call to `processOfferResponse` (`handleOperatorResponse`, its other caller, was already deleted in Task 5). Confirm it's now unreferenced, then delete the whole method:

```bash
grep -n "processOfferResponse" src/rescue-request/rescue-request.service.ts
```

Expected: only the method's own declaration remains. Delete it entirely — this removes the last piece of the old instant-accept-at-fixed-price flow from the dispatch-offer path (`sendDepositRequestToCustomer` and the three fixed-price constants stay, per Task 9's note, since nothing else calls them anymore either — but leave those alone here; that was already decided and doesn't need re-verifying in this task).

Wait — re-check this against Task 9's finding before deleting: Task 9 established that `processOfferResponse` was the reason `sendDepositRequestToCustomer`/`DEPOSIT_AMOUNT_KOBO`/`FULL_AMOUNT_KOBO` had to stay alive (it was their only remaining caller). Now that `processOfferResponse` itself is being deleted here, re-run the same check for those before deleting `processOfferResponse`:

```bash
grep -n "sendDepositRequestToCustomer\|DEPOSIT_AMOUNT_KOBO\|FULL_AMOUNT_KOBO" src/rescue-request/rescue-request.service.ts
```

If `processOfferResponse` was their only remaining caller/reference (expected — `initiateDeposit` also references `DEPOSIT_AMOUNT_KOBO`'s sibling amount concept but not the constant itself, check the actual grep output rather than assuming), then deleting `processOfferResponse` makes `sendDepositRequestToCustomer` dead too — delete it in the same pass, along with `DEPOSIT_AMOUNT_KOBO`/`BALANCE_AMOUNT_KOBO`/`FULL_AMOUNT_KOBO` if the grep confirms zero remaining references to each individually. Delete only what the grep actually shows as unreferenced — don't assume; verify each one.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run the full backend test suite**

```bash
npx jest
```

Expected: all suites pass.

- [ ] **Step 7: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts src/rescue-request/rescue-request.controller.ts
git commit -m "feat(rescue-request): let operators submit quotes from the dashboard, not just WhatsApp"
```

---

## Task 13: Dashboard quote submission — frontend

**Files:**
- Modify: `app/hooks/useRescueRequestApi.ts`
- Modify: `app/components/PendingOffers.tsx`

**Interfaces:**
- Consumes: the updated `GET /rescue-requests/offers/mine` and `POST /rescue-requests/offers/:offerId/respond` (Task 12).
- Produces: operators can view job details (vehicle/destination/media) and submit a price directly from the dashboard, replacing the old Accept/Decline buttons.

- [ ] **Step 1: Update the `PendingOffer` type and `respondToOffer` hook**

In `useRescueRequestApi.ts`, replace the `PendingOffer` interface:

```typescript
export interface PendingOffer {
  id: string;
  offeredAt: string;
  expiresAt: string;
  request: {
    id: string;
    vehicleType: string | null;
    destination: string | null;
    latitude: string;
    longitude: string;
    createdAt: string;
    mediaLinks: string[];
  };
}
```

Find `respondToOffer` and update its signature and body:

```typescript
  const respondToOffer = useCallback(async (offerId: string, priceNaira?: number): Promise<{ quoted: boolean; message: string }> => {
    const res = await apiFetch(`/rescue-requests/offers/${encodeURIComponent(offerId)}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priceNaira }),
    });
    return res.data as { quoted: boolean; message: string };
  }, []);
```

(match the existing surrounding code style for `apiFetch` calls in this file exactly — only the parameter list, request body, and return type change; keep whatever error-handling wrapper the current `respondToOffer` already uses.)

- [ ] **Step 2: Replace the Accept/Decline UI with a quote form**

In `PendingOffers.tsx`, replace the per-offer action buttons block and `handleRespond` function. The new version shows vehicle type, destination, and media links, and replaces "Accept" with a price input:

```tsx
"use client";
/**
 * PendingOffers
 * -------------
 * Live dispatch offers for the logged-in operator. Operators submit a price
 * quote or decline — both WhatsApp and the dashboard share the same backend
 * quote/decline logic, so whichever channel responds first wins.
 *
 * Polls every 15s while mounted (offers expire in minutes, so freshness matters).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRescueRequestApi } from "../hooks";
import type { PendingOffer } from "../hooks";

const dm = "var(--font-dm-sans), sans-serif";
const navy = "#07152f";
const POLL_MS = 15_000;

function secondsLeft(expiresAt: string) {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

export default function PendingOffers() {
  const { fetchMyOffers, respondToOffer } = useRescueRequestApi();
  const [offers, setOffers]     = useState<PendingOffer[]>([]);
  const [prices, setPrices]     = useState<Record<string, string>>({});
  const [busy, setBusy]         = useState<string | null>(null); // offerId being responded to
  const [outcome, setOutcome]   = useState<{ msg: string; ok: boolean } | null>(null);
  const [, forceTick]           = useState(0); // re-render for countdowns
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const data = await fetchMyOffers();
    if (mounted.current) setOffers(data.filter((o) => secondsLeft(o.expiresAt) > 0));
  }, [fetchMyOffers]);

  useEffect(() => {
    mounted.current = true;
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => { mounted.current = false; clearInterval(poll); clearInterval(tick); };
  }, [load]);

  async function handleQuote(offer: PendingOffer) {
    const priceNaira = Number(prices[offer.id]);
    if (!priceNaira || priceNaira <= 0) {
      setOutcome({ msg: "Enter a price before submitting a quote.", ok: false });
      return;
    }
    setBusy(offer.id);
    setOutcome(null);
    try {
      const res = await respondToOffer(offer.id, priceNaira);
      setOutcome({ msg: res.message, ok: res.quoted });
    } catch (err) {
      setOutcome({ msg: err instanceof Error ? err.message : "Failed to submit quote — try again.", ok: false });
    } finally {
      setBusy(null);
      load();
    }
  }

  async function handleDecline(offer: PendingOffer) {
    setBusy(offer.id);
    setOutcome(null);
    try {
      const res = await respondToOffer(offer.id, undefined);
      setOutcome({ msg: res.message, ok: true });
    } catch (err) {
      setOutcome({ msg: err instanceof Error ? err.message : "Failed to decline — try again.", ok: false });
    } finally {
      setBusy(null);
      load();
    }
  }

  if (offers.length === 0 && !outcome) return null;

  return (
    <div style={{
      background: "#fff", borderRadius: 18, padding: "1.5rem 1.75rem",
      border: "2px solid #003DB4", fontFamily: dm, marginBottom: "1.25rem",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "1rem" }}>
        <span style={{
          width: 10, height: 10, borderRadius: "50%", background: "#dc2626",
          display: "inline-block", animation: "lrr-pulse 1.2s ease-in-out infinite",
        }} />
        <h3 style={{ margin: 0, fontWeight: 700, fontSize: "1.05rem", color: navy }}>
          New job offer{offers.length > 1 ? "s" : ""}
        </h3>
      </div>
      <style>{`@keyframes lrr-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>

      {offers.map((offer) => {
        const secs = secondsLeft(offer.expiresAt);
        return (
          <div
            key={offer.id}
            style={{
              display: "flex", flexDirection: "column", gap: 8,
              padding: "0.9rem 0", borderTop: "1px solid #f0f2f5",
            }}
          >
            <div>
              <p style={{ margin: "0 0 2px", fontWeight: 700, color: navy, fontSize: "0.95rem" }}>
                {offer.request.vehicleType ?? "Vehicle"} → {offer.request.destination ?? "Destination not specified"}
              </p>
              <p style={{ margin: 0, color: "#6c7890", fontSize: "0.82rem" }}>
                Offered {new Date(offer.offeredAt).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" })}
                {" · "}
                <span style={{ color: secs <= 30 ? "#dc2626" : "#d97706", fontWeight: 600 }}>
                  {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")} left
                </span>
              </p>
              {offer.request.mediaLinks.length > 0 && (
                <p style={{ margin: "4px 0 0", fontSize: "0.82rem" }}>
                  {offer.request.mediaLinks.map((link, i) => (
                    <a key={link} href={link} target="_blank" rel="noreferrer" style={{ marginRight: 8, color: "#003DB4" }}>
                      Photo {i + 1}
                    </a>
                  ))}
                </p>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                type="number"
                min={0}
                placeholder="Price (₦)"
                value={prices[offer.id] ?? ""}
                onChange={(e) => setPrices((prev) => ({ ...prev, [offer.id]: e.target.value }))}
                disabled={busy !== null || secs === 0}
                style={{
                  padding: "0.55rem 0.8rem", border: "1px solid #dde8f8", borderRadius: 10,
                  fontFamily: dm, fontSize: "0.88rem", width: 140,
                }}
              />
              <button
                onClick={() => handleQuote(offer)}
                disabled={busy !== null || secs === 0}
                style={{
                  padding: "0.55rem 1.2rem", background: "#19a56b", color: "#fff",
                  border: "none", borderRadius: 10, fontWeight: 700, fontSize: "0.88rem", fontFamily: dm,
                  cursor: busy ? "not-allowed" : "pointer", opacity: busy === offer.id ? 0.6 : 1,
                }}
              >
                {busy === offer.id ? "…" : "Submit Quote"}
              </button>
              <button
                onClick={() => handleDecline(offer)}
                disabled={busy !== null || secs === 0}
                style={{
                  padding: "0.55rem 1.2rem", background: "#fff", color: "#dc2626",
                  border: "1px solid #f3d4d4", borderRadius: 10, fontWeight: 600, fontSize: "0.88rem", fontFamily: dm,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                Decline
              </button>
            </div>
          </div>
        );
      })}

      {outcome && (
        <p style={{
          margin: "0.75rem 0 0", fontSize: "0.88rem", fontWeight: 600, whiteSpace: "pre-line",
          color: outcome.ok ? "#19a56b" : "#dc2626",
        }}>
          {outcome.msg}
        </p>
      )}
    </div>
  );
}
```

(the previous version's `formatIssue` helper is removed — `issueType` is no longer part of `PendingOffer.request`, replaced by `vehicleType`/`destination`.)

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/hooks/useRescueRequestApi.ts app/components/PendingOffers.tsx
git commit -m "feat(operator): let operators submit price quotes from the dashboard"
```

---

## Task 14: Rollout verification

**Files:** none (verification-only task)

- [ ] **Step 1: Run the full backend test suite**

```bash
cd lrr-service
npx jest
```

Expected: all suites pass, including every suite added/modified in Tasks 1-12.

- [ ] **Step 2: Run the full backend TypeScript build**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run the full frontend TypeScript build**

```bash
cd ../lrr-web
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Confirm the migration is additive and rollout-safe**

```bash
cd ../lrr-service
cat prisma/migrations/*add_operator_quotes_and_platform_config*/migration.sql
```

Expected: only `CREATE TABLE`/`ALTER TABLE ... ADD COLUMN`/enum-value-add/`INSERT` statements, no drops.

## Manual Verification (after all tasks)

- [ ] Send SOS through the full flow (location/vehicle/destination/media) and confirm the confirmation message no longer mentions a fixed price.
- [ ] As two or more test operators, reply to the same dispatch offer with different prices — confirm both create `QUOTED` `DispatchOffer` rows, and that once all batched operators respond, the shortlist arrives immediately (not after the full window).
- [ ] Confirm the shortlist is ranked by the price/ETA composite, not strictly cheapest-first, by choosing quotes where a cheaper-but-slower and pricier-but-faster quote would rank differently under a pure price sort.
- [ ] Select a quote — confirm the chosen `DispatchOffer` is `SELECTED_PENDING_PAYMENT` (not yet `ACCEPTED`) and the other operators receive a "not selected" message.
- [ ] Confirm the deposit payment link amount equals `round((quotedPrice × (1 + serviceFeePercent/100)) × depositPercent/100)` for the currently-configured percentages.
- [ ] Pay the deposit (or simulate the webhook) — confirm the offer becomes `ACCEPTED` and the request becomes `OPERATOR_ASSIGNED` only at this point, not at selection.
- [ ] Change `serviceFeePercent` via `PATCH /api/v1/admin/settings`, then check an already-in-progress job's `RescueRequest.depositAmount`/`balanceAmount` — confirm they did NOT change.
- [ ] Let a deposit payment window expire without paying — confirm the offer is released, dispatch restarts, and the operator is notified.
- [ ] Let a full batch time out with zero quotes — confirm dispatch moves to the next batch exactly as before this plan.
- [ ] Log in as an admin in `lrr-web`, navigate to Platform Settings, change and save both percentages, refresh, and confirm the saved values persist.
- [ ] Log in as an operator in `lrr-web`, view a pending offer, confirm vehicle type, destination, and media links are visible, and confirm submitting a price there creates a `QUOTED` offer identical in effect to a WhatsApp quote (visible in the eventual shortlist).
- [ ] Confirm declining from the dashboard (empty price field) behaves identically to replying `NO` on WhatsApp.
- [ ] Confirm there is no remaining way to instantly accept a job at a fixed price from either channel — WhatsApp only accepts a number-as-quote or `NO`, and the dashboard only accepts a price or an empty decline.
