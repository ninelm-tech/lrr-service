# Truck-Class ↔ Vehicle-Type Hard Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop broadcasting WhatsApp SOS requests to tow operators whose truck fleet can't carry the stranded vehicle, and capture the motorist's destination — without touching operator-owned pricing.

**Architecture:** Add a `TruckClass[]` fleet field to `Operator` and a `VehicleType`/`destination` pair to `RescueRequest` and the WhatsApp session. A new pure mapping module resolves which truck classes can carry a given vehicle type; `OperatorService.findAndRankCandidates` gains a hard Prisma filter on that; the WhatsApp flow asks for vehicle type + destination instead of issue type before dispatching.

**Tech Stack:** NestJS + Prisma (Postgres) backend (`lrr-service`), Next.js frontend (`lrr-web`), Jest for tests.

## Global Constraints

- Operators keep setting their own price. Nothing in this plan touches pricing/quoting.
- Dispatch batch size stays at 3 (`BATCH_SIZE` in `rescue-request.service.ts`) — do not change it.
- The WhatsApp flow stops asking for issue type. The `issueType` column and `IssueType` enum/type stay in the schema/codebase (other code reads them) but no new `RescueRequest` gets one populated.
- No auto-defaulting of `Operator.truckClasses` on migration — it defaults to an empty array; operators with an empty fleet simply stop matching until backfilled via the portal. This is expected, not a bug to fix in this plan.
- Media (photo/video/audio) capture/forwarding is out of scope entirely — a separate future spec.
- Two repos are touched: `lrr-service` (backend, tasks 1–7) and `lrr-web` (frontend, tasks 8–11). Commit separately in each repo.
- Follow the `dto/`-file convention from the root `CLAUDE.md` for any DTO you create or touch: request DTOs are `class`es with `class-validator` decorators in their own file under the module's `dto/` folder, never declared inline in a service or controller file. Domain/pure logic goes in a `domain/` folder.

---

## Task 1: Prisma schema — new enums and fields

**Files:**
- Modify: `lrr-service/prisma/schema.prisma`

**Interfaces:**
- Produces: Prisma enums `TruckClass` (`LIGHT_DUTY`, `TEN_TYRE`, `LOW_BED`, `HIAB`) and `VehicleType` (`SEDAN`, `SUV`, `ARMORED_LUXURY`, `HEAVY_TRAILER`); `Operator.truckClasses: TruckClass[]`; `RescueRequest.vehicleType: VehicleType | null`; `RescueRequest.destination: string | null`; `WhatsAppSession.vehicleType: string | null`; `WhatsAppSession.destination: string | null`. All later tasks depend on these Prisma Client types.

- [ ] **Step 1: Add the two new enums**

Add directly below the existing `IssueType` enum (schema.prisma lines 72–77):

```prisma
enum TruckClass {
  LIGHT_DUTY
  TEN_TYRE
  LOW_BED
  HIAB
}

enum VehicleType {
  SEDAN
  SUV
  ARMORED_LUXURY
  HEAVY_TRAILER
}
```

- [ ] **Step 2: Add `truckClasses` to `Operator`**

In the `Operator` model, add the field right after `type`:

```prisma
model Operator {
  id            String         @id @default(cuid())

  type          OperatorType   @default(TOW_TRUCK)
  truckClasses  TruckClass[]   @default([])

  businessName  String
  contactName   String
  phoneNumber   String         @unique
  email         String?
  ...
```

(Only the `type`/`truckClasses` lines change; the rest of the model is unchanged.)

- [ ] **Step 3: Add `vehicleType` and `destination` to `RescueRequest`**

In the `RescueRequest` model, add both fields right after `issueType`:

```prisma
model RescueRequest {
  id                 String              @id @default(cuid())

  customerId         String
  customer           User                @relation(fields: [customerId], references: [id])

  status             RescueRequestStatus @default(WAITING_FOR_LOCATION)

  latitude           Decimal?
  longitude          Decimal?

  issueType          IssueType?
  vehicleType        VehicleType?
  destination        String?

  depositPaid        Boolean             @default(false)
  ...
```

- [ ] **Step 4: Add `vehicleType` and `destination` to `WhatsAppSession`**

In the `WhatsAppSession` model, add both fields right after the existing `issueType` column:

```prisma
model WhatsAppSession {
  id      String @id @default(cuid())

  userId  String @unique
  user    User   @relation(fields: [userId], references: [id])

  state   String @default("IDLE")

  latitude    Decimal?
  longitude   Decimal?

  issueType   String?
  vehicleType String?
  destination String?

  // Linked rescue request once created
  ...
```

- [ ] **Step 5: Generate Prisma client and create the migration**

```bash
cd lrr-service
npx prisma generate
npx prisma migrate dev --name add_truck_class_vehicle_matching
```

Expected: migration runs cleanly against the local dev database; `npx prisma generate` reports the new `TruckClass`/`VehicleType` enums and fields available on `PrismaClient`.

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no new errors (existing code doesn't yet reference the new fields, so this should be clean).

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): add TruckClass/VehicleType enums and matching fields"
```

---

## Task 2: Vehicle-type ↔ truck-class domain mapping

**Files:**
- Create: `lrr-service/src/rescue-request/domain/vehicle-truck-mapping.ts`
- Test: `lrr-service/src/rescue-request/domain/vehicle-truck-mapping.spec.ts`

**Interfaces:**
- Consumes: `VehicleType`, `TruckClass` from `@prisma/client` (Task 1).
- Produces: `getEligibleTruckClasses(vehicleType: VehicleType): TruckClass[]`, `mapVehicleTypeReply(message: string): VehicleType | undefined`, `formatVehicleType(vehicleType: VehicleType): string`. Task 5 (dispatch filter) and Task 6 (WhatsApp flow) both import from this file.

- [ ] **Step 1: Write the failing test**

```typescript
// lrr-service/src/rescue-request/domain/vehicle-truck-mapping.spec.ts
import { TruckClass, VehicleType } from '@prisma/client';
import {
  getEligibleTruckClasses,
  mapVehicleTypeReply,
  formatVehicleType,
} from './vehicle-truck-mapping';

describe('getEligibleTruckClasses', () => {
  it('maps SEDAN to light-duty and 10-tyre trucks', () => {
    expect(getEligibleTruckClasses(VehicleType.SEDAN)).toEqual([
      TruckClass.LIGHT_DUTY,
      TruckClass.TEN_TYRE,
    ]);
  });

  it('maps SUV to light-duty and 10-tyre trucks', () => {
    expect(getEligibleTruckClasses(VehicleType.SUV)).toEqual([
      TruckClass.LIGHT_DUTY,
      TruckClass.TEN_TYRE,
    ]);
  });

  it('maps ARMORED_LUXURY to low-bed and hiab trucks', () => {
    expect(getEligibleTruckClasses(VehicleType.ARMORED_LUXURY)).toEqual([
      TruckClass.LOW_BED,
      TruckClass.HIAB,
    ]);
  });

  it('maps HEAVY_TRAILER to low-bed and hiab trucks', () => {
    expect(getEligibleTruckClasses(VehicleType.HEAVY_TRAILER)).toEqual([
      TruckClass.LOW_BED,
      TruckClass.HIAB,
    ]);
  });
});

describe('mapVehicleTypeReply', () => {
  it('maps numbered replies 1-4 to the four vehicle types', () => {
    expect(mapVehicleTypeReply('1')).toBe(VehicleType.SEDAN);
    expect(mapVehicleTypeReply('2')).toBe(VehicleType.SUV);
    expect(mapVehicleTypeReply('3')).toBe(VehicleType.ARMORED_LUXURY);
    expect(mapVehicleTypeReply('4')).toBe(VehicleType.HEAVY_TRAILER);
  });

  it('maps text aliases case-insensitively', () => {
    expect(mapVehicleTypeReply('sedan')).toBe(VehicleType.SEDAN);
    expect(mapVehicleTypeReply('SUV')).toBe(VehicleType.SUV);
  });

  it('returns undefined for unrecognised input', () => {
    expect(mapVehicleTypeReply('banana')).toBeUndefined();
    expect(mapVehicleTypeReply('5')).toBeUndefined();
  });
});

describe('formatVehicleType', () => {
  it('formats enum values as readable labels', () => {
    expect(formatVehicleType(VehicleType.SEDAN)).toBe('Sedan');
    expect(formatVehicleType(VehicleType.ARMORED_LUXURY)).toBe('Armored/Luxury');
    expect(formatVehicleType(VehicleType.HEAVY_TRAILER)).toBe('Heavy Trailer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/rescue-request/domain/vehicle-truck-mapping.spec.ts
```

Expected: FAIL — `Cannot find module './vehicle-truck-mapping'`.

- [ ] **Step 3: Write the implementation**

```typescript
// lrr-service/src/rescue-request/domain/vehicle-truck-mapping.ts
import { TruckClass, VehicleType } from '@prisma/client';

const VEHICLE_TYPE_TO_TRUCK_CLASSES: Record<VehicleType, TruckClass[]> = {
  [VehicleType.SEDAN]:          [TruckClass.LIGHT_DUTY, TruckClass.TEN_TYRE],
  [VehicleType.SUV]:            [TruckClass.LIGHT_DUTY, TruckClass.TEN_TYRE],
  [VehicleType.ARMORED_LUXURY]: [TruckClass.LOW_BED, TruckClass.HIAB],
  [VehicleType.HEAVY_TRAILER]:  [TruckClass.LOW_BED, TruckClass.HIAB],
};

export function getEligibleTruckClasses(vehicleType: VehicleType): TruckClass[] {
  return VEHICLE_TYPE_TO_TRUCK_CLASSES[vehicleType];
}

const REPLY_TO_VEHICLE_TYPE: Record<string, VehicleType> = {
  '1': VehicleType.SEDAN,
  '2': VehicleType.SUV,
  '3': VehicleType.ARMORED_LUXURY,
  '4': VehicleType.HEAVY_TRAILER,
  'sedan': VehicleType.SEDAN,
  'suv': VehicleType.SUV,
  'armored': VehicleType.ARMORED_LUXURY,
  'luxury': VehicleType.ARMORED_LUXURY,
  'trailer': VehicleType.HEAVY_TRAILER,
  'heavy trailer': VehicleType.HEAVY_TRAILER,
};

export function mapVehicleTypeReply(message: string): VehicleType | undefined {
  return REPLY_TO_VEHICLE_TYPE[message.trim().toLowerCase()];
}

const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  [VehicleType.SEDAN]:          'Sedan',
  [VehicleType.SUV]:            'SUV',
  [VehicleType.ARMORED_LUXURY]: 'Armored/Luxury',
  [VehicleType.HEAVY_TRAILER]:  'Heavy Trailer',
};

export function formatVehicleType(vehicleType: VehicleType): string {
  return VEHICLE_TYPE_LABELS[vehicleType];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/rescue-request/domain/vehicle-truck-mapping.spec.ts
```

Expected: PASS, all 4 describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add src/rescue-request/domain/vehicle-truck-mapping.ts src/rescue-request/domain/vehicle-truck-mapping.spec.ts
git commit -m "feat(rescue-request): add vehicle-type to truck-class matching rules"
```

---

## Task 3: `OperatorService.findAndRankCandidates` — hard truck-class filter

**Files:**
- Modify: `lrr-service/src/operator/operator.service.ts:130-144` (the query inside `findAndRankCandidates`)
- Modify: `lrr-service/src/operator/operator.service.spec.ts` (currently a placeholder — replace with a real test)

**Interfaces:**
- Consumes: `TruckClass` from `@prisma/client` (Task 1).
- Produces: `findAndRankCandidates(latitude, longitude, excludeIds?, extraRadiusKm?, type?, truckClasses?: TruckClass[])`. Task 6's `startDispatch` calls this with a `truckClasses` argument.

- [ ] **Step 1: Write the failing test**

Replace the entire placeholder content of `operator.service.spec.ts`:

```typescript
// lrr-service/src/operator/operator.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { OperatorService } from './operator.service';
import { PrismaService } from '../prisma/prisma.service';
import { TruckClass } from '@prisma/client';

describe('OperatorService', () => {
  let service: OperatorService;
  let prisma: {
    operator: { findMany: jest.Mock };
    dispatchOffer: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      operator: { findMany: jest.fn() },
      dispatchOffer: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperatorService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<OperatorService>(OperatorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAndRankCandidates truck-class filtering', () => {
    it('passes a hasSome truckClasses filter into the Prisma query when truckClasses is provided', async () => {
      prisma.operator.findMany.mockResolvedValue([]);

      await service.findAndRankCandidates(
        6.5, 3.4, [], 0, undefined,
        [TruckClass.LOW_BED, TruckClass.HIAB],
      );

      expect(prisma.operator.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            truckClasses: { hasSome: [TruckClass.LOW_BED, TruckClass.HIAB] },
          }),
        }),
      );
    });

    it('omits the truckClasses filter entirely when not provided', async () => {
      prisma.operator.findMany.mockResolvedValue([]);

      await service.findAndRankCandidates(6.5, 3.4, [], 0);

      const callArgs = prisma.operator.findMany.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('truckClasses');
    });

    it('omits the truckClasses filter when given an empty array', async () => {
      prisma.operator.findMany.mockResolvedValue([]);

      await service.findAndRankCandidates(6.5, 3.4, [], 0, undefined, []);

      const callArgs = prisma.operator.findMany.mock.calls[0][0];
      expect(callArgs.where).not.toHaveProperty('truckClasses');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/operator/operator.service.spec.ts
```

Expected: the two new `truckClasses` tests FAIL (the `where` clause has no `truckClasses` key yet because the parameter doesn't exist); the pre-existing `should be defined` test passes.

- [ ] **Step 3: Add the `truckClasses` parameter and filter**

In `lrr-service/src/operator/operator.service.ts`, change the `findAndRankCandidates` signature and `where` clause (lines ~130–144):

```typescript
  async findAndRankCandidates(
    latitude: number,
    longitude: number,
    excludeIds: string[] = [],
    extraRadiusKm: number = 0,
    type?: OperatorType,
    truckClasses?: TruckClass[],
  ): Promise<ScoredOperator[]> {
    const operators = await this.prisma.operator.findMany({
      where: {
        status:      OperatorStatus.ACTIVE,
        isAvailable: true,
        ...(excludeIds.length > 0 && { id: { notIn: excludeIds } }),
        ...(type && { type }),
        ...(truckClasses && truckClasses.length > 0 && {
          truckClasses: { hasSome: truckClasses },
        }),
      },
    });
```

Add `TruckClass` to the existing Prisma import at the top of the file:

```typescript
import { OperatorStatus, OperatorType, UserRole, OperatorMemberRole, TruckClass } from '@prisma/client';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/operator/operator.service.spec.ts
```

Expected: PASS, all tests green.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no new errors (existing callers of `findAndRankCandidates`/`findNearestAvailableExcluding`/`findNearestAvailable` don't pass the new parameter, which is fine since it's optional).

- [ ] **Step 6: Commit**

```bash
git add src/operator/operator.service.ts src/operator/operator.service.spec.ts
git commit -m "feat(operator): hard-filter dispatch candidates by truck class"
```

---

## Task 4: `WhatsAppSession` — new flow states and vehicle/destination fields

**Files:**
- Modify: `lrr-service/src/rescue-request/state/whatsapp-session.types.ts`
- Modify: `lrr-service/src/rescue-request/state/whatsapp-session.store.ts`
- Test: `lrr-service/src/rescue-request/state/whatsapp-session.store.spec.ts` (new file — none exists today)

**Interfaces:**
- Produces: `WhatsAppFlowState.WAITING_FOR_VEHICLE_TYPE`, `WhatsAppFlowState.WAITING_FOR_DESTINATION`; `WhatsAppSession.vehicleType?: string`, `WhatsAppSession.destination?: string`; `WhatsAppSessionStore.update()` persists both. Task 6 (flow handlers) sets/reads these.

- [ ] **Step 1: Add the new states and session fields**

In `whatsapp-session.types.ts`, add two new enum members right after `WAITING_FOR_LOCATION`:

```typescript
export enum WhatsAppFlowState {
  IDLE = 'IDLE',
  WAITING_FOR_LOCATION = 'WAITING_FOR_LOCATION',
  WAITING_FOR_VEHICLE_TYPE = 'WAITING_FOR_VEHICLE_TYPE',
  WAITING_FOR_DESTINATION = 'WAITING_FOR_DESTINATION',
  WAITING_FOR_ISSUE_TYPE = 'WAITING_FOR_ISSUE_TYPE',
  WAITING_FOR_DEPOSIT = 'WAITING_FOR_DEPOSIT',
  REQUEST_CONFIRMED = 'REQUEST_CONFIRMED',
  ...
```

(`WAITING_FOR_ISSUE_TYPE` stays in the enum — it's simply unreachable from the active flow after Task 6 — do not delete it.)

Add `vehicleType`/`destination` to the `WhatsAppSession` interface, right after `issueType`:

```typescript
export interface WhatsAppSession {
  userId: string;
  state: WhatsAppFlowState;
  latitude?: number;
  longitude?: number;
  issueType?: IssueType;
  vehicleType?: string;
  destination?: string;
  rescueRequestId?: string;
  ...
```

- [ ] **Step 2: Write the failing test for the store**

```typescript
// lrr-service/src/rescue-request/state/whatsapp-session.store.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { WhatsAppSessionStore } from './whatsapp-session.store';
import { PrismaService } from '../../prisma/prisma.service';
import { WhatsAppFlowState } from './whatsapp-session.types';

describe('WhatsAppSessionStore', () => {
  let store: WhatsAppSessionStore;
  let prisma: { whatsAppSession: { update: jest.Mock; upsert: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      whatsAppSession: {
        update: jest.fn(),
        upsert: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsAppSessionStore,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    store = module.get<WhatsAppSessionStore>(WhatsAppSessionStore);
  });

  it('persists vehicleType and destination when updating a session', async () => {
    prisma.whatsAppSession.update.mockResolvedValue({
      userId: 'user-1',
      state: WhatsAppFlowState.WAITING_FOR_DESTINATION,
      latitude: null,
      longitude: null,
      issueType: null,
      vehicleType: 'SEDAN',
      destination: '123 Workshop Road',
      rescueRequestId: null,
      depositReference: null,
      dispatchRound: 0,
      offeredOperatorIds: '[]',
      updatedAt: new Date(),
    });

    const result = await store.update('user-1', {
      vehicleType: 'SEDAN',
      destination: '123 Workshop Road',
    });

    expect(prisma.whatsAppSession.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { vehicleType: 'SEDAN', destination: '123 Workshop Road' },
    });
    expect(result.vehicleType).toBe('SEDAN');
    expect(result.destination).toBe('123 Workshop Road');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx jest src/rescue-request/state/whatsapp-session.store.spec.ts
```

Expected: FAIL — `update` call doesn't include `vehicleType`/`destination` in `data` yet, and `result.vehicleType`/`result.destination` are `undefined`.

- [ ] **Step 4: Wire the new fields through the store**

In `whatsapp-session.store.ts`, add handling in `update()`:

```typescript
  async update(
    userId: string,
    updates: Partial<WhatsAppSession>,
  ): Promise<WhatsAppSession> {
    const data: Record<string, any> = {};

    if (updates.state !== undefined)            data.state = updates.state;
    if (updates.latitude !== undefined)         data.latitude = updates.latitude;
    if (updates.longitude !== undefined)        data.longitude = updates.longitude;
    if (updates.issueType !== undefined)        data.issueType = updates.issueType;
    if (updates.vehicleType !== undefined)      data.vehicleType = updates.vehicleType;
    if (updates.destination !== undefined)      data.destination = updates.destination;
    if (updates.rescueRequestId !== undefined)  data.rescueRequestId = updates.rescueRequestId;
    if (updates.depositReference !== undefined) data.depositReference = updates.depositReference;
    if (updates.dispatchRound !== undefined)    data.dispatchRound = updates.dispatchRound;
    if (updates.offeredOperatorIds !== undefined) {
      data.offeredOperatorIds = JSON.stringify(updates.offeredOperatorIds);
    }

    const row = await this.prisma.whatsAppSession.update({
      where:  { userId },
      data,
    });

    return this.rowToSession(row);
  }
```

And in `rowToSession()`:

```typescript
  private rowToSession(row: any): WhatsAppSession {
    return {
      userId: row.userId,
      state: row.state as WhatsAppFlowState,
      latitude: row.latitude != null ? Number(row.latitude) : undefined,
      longitude: row.longitude != null ? Number(row.longitude) : undefined,
      issueType: row.issueType ?? undefined,
      vehicleType: row.vehicleType ?? undefined,
      destination: row.destination ?? undefined,
      rescueRequestId: row.rescueRequestId ?? undefined,
      depositReference: row.depositReference ?? undefined,
      dispatchRound: row.dispatchRound ?? 0,
      offeredOperatorIds: row.offeredOperatorIds
        ? JSON.parse(row.offeredOperatorIds)
        : [],
      updatedAt: row.updatedAt,
    };
  }
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx jest src/rescue-request/state/whatsapp-session.store.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rescue-request/state/whatsapp-session.types.ts src/rescue-request/state/whatsapp-session.store.ts src/rescue-request/state/whatsapp-session.store.spec.ts
git commit -m "feat(rescue-request): add vehicleType/destination to WhatsApp session state"
```

---

## Task 5: WhatsApp flow — vehicle type + destination replace issue type

**Files:**
- Modify: `lrr-service/src/rescue-request/rescue-request.service.ts`

**Interfaces:**
- Consumes: `WhatsAppFlowState.WAITING_FOR_VEHICLE_TYPE`/`WAITING_FOR_DESTINATION` (Task 4), `mapVehicleTypeReply`/`formatVehicleType`/`getEligibleTruckClasses` (Task 2), `findAndRankCandidates(..., truckClasses?)` (Task 3).
- Produces: `RescueRequest` rows now created with `vehicleType`/`destination` set and `issueType: undefined`. This is the last task in the chain — nothing downstream depends on new exports from here.

This task has no isolated unit-testable surface of its own beyond what Tasks 2–4 already cover (the state machine's correctness is exercised end-to-end via manual WhatsApp sandbox testing, called out in the Manual Verification section below) — but it does have one important regression to guard: the operator/customer-facing messages must not crash when `issueType` is `null`. That's covered by Step 4 below.

- [ ] **Step 1: Update imports**

At the top of `rescue-request.service.ts`, add the new imports:

```typescript
import { RescueRequestStatus, UserRole, VehicleType } from '@prisma/client';
```

(replacing the existing `import { RescueRequestStatus, UserRole } from '@prisma/client';` line)

```typescript
import {
  getEligibleTruckClasses,
  mapVehicleTypeReply,
  formatVehicleType,
} from './domain/vehicle-truck-mapping';
```

- [ ] **Step 2: Change the location handler to ask for vehicle type instead of issue type**

Replace the `WAITING_FOR_LOCATION` block (current lines 190–203):

```typescript
    // ── Step 1: Waiting for location ───────────────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_LOCATION) {
      if (!latitude || !longitude) {
        return this.reply(
          `📍 Please share your location using WhatsApp's location pin — not a typed address.`,
        );
      }
      await this.sessionStore.update(userId, {
        latitude,
        longitude,
        state: WhatsAppFlowState.WAITING_FOR_VEHICLE_TYPE,
      });
      return this.reply(
        `📍 Location received!\n\nWhat type of vehicle is it?\n\n1️⃣ Sedan\n2️⃣ SUV\n3️⃣ Armored/Luxury\n4️⃣ Heavy Trailer`,
      );
    }

    // ── Step 2: Waiting for vehicle type ───────────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_VEHICLE_TYPE) {
      const vehicleType = mapVehicleTypeReply(message);
      if (!vehicleType) {
        return this.reply(`Please reply with a number 1-4 to select the vehicle type.`);
      }
      await this.sessionStore.update(userId, {
        vehicleType,
        state: WhatsAppFlowState.WAITING_FOR_DESTINATION,
      });
      return this.reply(
        `🚗 ${formatVehicleType(vehicleType)} noted!\n\nWhere would you like the car towed to? (e.g. a workshop name or address)`,
      );
    }

    // ── Step 3: Waiting for destination ────────────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_DESTINATION) {
      const destination = message.trim();
      if (!destination) {
        return this.reply(`Please type where you'd like the car towed to.`);
      }
      return this.handleDestinationProvided(
        phoneNumber, userId, session, session.vehicleType as VehicleType, destination,
      );
    }
```

Remove the old `WAITING_FOR_ISSUE_TYPE` block that immediately follows (current lines 207–213):

```typescript
    // ── Step 2: Waiting for issue type ─────────────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_ISSUE_TYPE) {
      const issueType = this.mapIssueType(message);
      if (!issueType) {
        return this.reply(`Please reply with a number 1-4 to select the issue type.`);
      }
      return this.handleIssueTypeSelected(phoneNumber, userId, session, issueType);
    }
```

Delete this block entirely — it's now unreachable, and leaving dead code that references a removed call site would be confusing.

- [ ] **Step 3: Rename and rewrite `handleIssueTypeSelected` as `handleDestinationProvided`**

Replace the full `handleIssueTypeSelected` method (current lines 376–467) with:

```typescript
  private async handleDestinationProvided(
    phoneNumber: string,
    userId: string,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    vehicleType: VehicleType,
    destination: string,
  ) {
    const customer = await this.findOrCreateCustomer(phoneNumber);
    const subscription = await this.getActiveSubscription(customer.id);

    if (subscription) {
      const towsLeft = subscription.towsIncludedPerMonth - subscription.towsUsedThisMonth;

      if (towsLeft > 0) {
        // Subscriber with remaining allowance — skip deposit
        const rescueRequest = await this.prisma.rescueRequest.create({
          data: {
            customerId:  customer.id,
            status:      RescueRequestStatus.DISPATCHING,
            latitude:    session.latitude,
            longitude:   session.longitude,
            vehicleType,
            destination,
            depositPaid: true,
          },
        });

        await this.prisma.subscription.update({
          where: { id: subscription.id },
          data: { towsUsedThisMonth: { increment: 1 } },
        });

        await this.sessionStore.update(customer.id, {
          vehicleType,
          destination,
          rescueRequestId:    rescueRequest.id,
          state:              WhatsAppFlowState.REQUEST_CONFIRMED,
          dispatchRound:      0,
          offeredOperatorIds: [],
        });

        const greet = customer.name ? `Hi ${customer.name}! ` : '';
        await this.twilioService.sendWhatsAppMessage(
          phoneNumber,
          `${greet}✅ Subscriber recognised!\n\nVehicle: ${formatVehicleType(vehicleType)}\nDestination: ${destination}\nTows remaining this month: ${towsLeft - 1}\n\nFinding nearest operator...`,
        );

        void this.startDispatch(rescueRequest.id, customer.id);
        return this.xmlOk();
      }

      // Subscriber tows exhausted — fall through to dispatch-first flow with full amount
    }

    // ── Dispatch-first: find an operator BEFORE charging the customer ─────────
    const isExhaustedSubscriber = !!subscription;
    const depositAmount = isExhaustedSubscriber ? FULL_AMOUNT_KOBO : DEPOSIT_AMOUNT_KOBO;

    const rescueRequest = await this.prisma.rescueRequest.create({
      data: {
        customerId:    customer.id,
        status:        RescueRequestStatus.DISPATCHING,
        latitude:      session.latitude,
        longitude:     session.longitude,
        vehicleType,
        destination,
        depositAmount,
      },
    });

    await this.sessionStore.update(customer.id, {
      vehicleType,
      destination,
      rescueRequestId:    rescueRequest.id,
      state:              WhatsAppFlowState.REQUEST_CONFIRMED,
      dispatchRound:      0,
      offeredOperatorIds: [],
    });

    const greet     = customer.name ? `Hi ${customer.name.split(' ')[0]}! ` : '';
    const costNote  = isExhaustedSubscriber
      ? `ℹ️ Monthly tow allowance used up. A one-time fee of ₦50,000 will apply.\n`
      : ``;
    const costBreak = depositAmount === FULL_AMOUNT_KOBO
      ? `💰 Fee if assigned: *₦50,000* (paid in full at confirmation)`
      : `💰 Total if assigned: *₦50,000* (₦5,000 now · ₦45,000 on completion)`;

    await this.twilioService.sendWhatsAppMessage(
      phoneNumber,
      `${greet}🔍 ${costNote}Searching for the nearest tow operator...\n\nVehicle: ${formatVehicleType(vehicleType)}\nDestination: ${destination}\n${costBreak}\n\n⏳ You will *only be charged once an operator is confirmed*. Reply CANCEL at any time.`,
    );

    void this.startDispatch(rescueRequest.id, customer.id);
    return this.xmlOk();
  }
```

- [ ] **Step 4: Fix the two dispatch/confirmation messages that referenced `issueType`, and wire the truck-class filter into `startDispatch`**

In `startDispatch` (current lines 654–825), change the candidate lookup to filter by eligible truck classes:

```typescript
    const eligibleTruckClasses = rescueRequest.vehicleType
      ? getEligibleTruckClasses(rescueRequest.vehicleType as VehicleType)
      : undefined;

    // Get all ranked candidates (excluding already-offered operators)
    const candidates = await this.operatorService.findAndRankCandidates(
      lat, lon, alreadyOffered, extraRadiusKm, undefined, eligibleTruckClasses,
    );
```

Replace the `issueLabel` line and the operator-facing offer message (current lines ~806–819):

```typescript
    const vehicleLabel = rescueRequest.vehicleType
      ? formatVehicleType(rescueRequest.vehicleType as VehicleType)
      : 'Unknown';
    const destinationLabel = rescueRequest.destination ?? 'Not specified';

    await Promise.all(
      batch.map((op) =>
        this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(op.phoneNumber),
          `🚨 *NEW RESCUE JOB*\n\nVehicle: ${vehicleLabel}\nDestination: ${destinationLabel}\nDistance: ${op.distance.toFixed(1)} km\nLocation: https://maps.google.com/?q=${lat},${lon}\n\nReply *YES* to accept or *NO* to decline.\nYou have ${windowSeconds} seconds.`,
        ),
      ),
    );
```

Find the two customer-facing confirmation messages elsewhere in the file (around lines 571 and 587 per the earlier audit) that read `${this.formatIssueType(rescueRequest.issueType as IssueType)}` — since `issueType` is now always `null` on new requests, this cast-and-call would throw (`formatIssueType` calls `.replace` on `undefined`). Replace both occurrences of:

```typescript
Issue: ${this.formatIssueType(rescueRequest.issueType as IssueType)}
```

with:

```typescript
Vehicle: ${rescueRequest.vehicleType ? formatVehicleType(rescueRequest.vehicleType as VehicleType) : 'Unknown'}
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. If `mapIssueType`/`formatIssueType`/`IssueType` become unused imports/methods after this change, leave them in place (per the spec, they may be revived for future service types) — but double check the compiler doesn't flag unused-import errors under this project's `tsconfig.json` (`noUnusedLocals`); if it does, keep the methods but remove only the now-truly-dead `IssueType` import from `whatsapp-session.types.ts` if nothing else in the file references it, and re-add it as a type-only import where `formatIssueType`'s signature still needs it.

- [ ] **Step 6: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts
git commit -m "feat(rescue-request): replace issue-type prompt with vehicle-type+destination flow and hard-filter dispatch"
```

---

## Task 6: Operator DTOs — extract to `dto/` files and add `truckClasses`

**Files:**
- Create: `lrr-service/src/operator/dto/create-operator.dto.ts`
- Create: `lrr-service/src/operator/dto/update-operator-profile.dto.ts`
- Modify: `lrr-service/src/operator/operator.service.ts` (remove inline DTOs, import from `dto/`, wire `truckClasses` into `create`/`updateProfile`)
- Modify: `lrr-service/src/operator/operator.controller.ts` (remove inline `CreateOperatorDto`, import both DTOs from `dto/`)

**Interfaces:**
- Produces: `CreateOperatorDto.truckClasses: TruckClass[]`, `UpdateOperatorProfileDto.truckClasses?: TruckClass[]`. No later backend task depends on these; the frontend (Tasks 8–11) sends this field over the wire.

- [ ] **Step 1: Create `create-operator.dto.ts`**

```typescript
// lrr-service/src/operator/dto/create-operator.dto.ts
import { IsArray, IsEmail, IsEnum, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';
import { OperatorType, TruckClass } from '@prisma/client';

export class CreateOperatorDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsEnum(OperatorType)
  @IsOptional()
  type?: OperatorType;

  @IsString()
  @IsNotEmpty()
  businessName: string;

  @IsString()
  @IsNotEmpty()
  contactName: string;

  @IsString()
  @IsNotEmpty()
  phoneNumber: string;

  @IsString()
  @IsNotEmpty()
  address: string;

  @IsNumber()
  latitude: number;

  @IsNumber()
  longitude: number;

  @IsNumber()
  @IsOptional()
  serviceRadius?: number;

  @IsArray()
  @IsEnum(TruckClass, { each: true })
  truckClasses: TruckClass[];
}
```

- [ ] **Step 2: Create `update-operator-profile.dto.ts`**

```typescript
// lrr-service/src/operator/dto/update-operator-profile.dto.ts
import { IsArray, IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { OperatorType, TruckClass } from '@prisma/client';

export class UpdateOperatorProfileDto {
  @IsString()
  @IsOptional()
  businessName?: string;

  @IsString()
  @IsOptional()
  contactName?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  phoneNumber?: string;

  @IsString()
  @IsOptional()
  address?: string;

  @IsNumber()
  @IsOptional()
  latitude?: number;

  @IsNumber()
  @IsOptional()
  longitude?: number;

  @IsEnum(OperatorType)
  @IsOptional()
  type?: OperatorType;

  @IsNumber()
  @IsOptional()
  serviceRadius?: number;

  @IsArray()
  @IsEnum(TruckClass, { each: true })
  @IsOptional()
  truckClasses?: TruckClass[];
}
```

- [ ] **Step 3: Wire the DTOs and `truckClasses` field into `operator.service.ts`**

Remove the inline `interface CreateOperatorDto` and `export interface UpdateOperatorProfileDto` (current lines 7–31) and replace the top of the file with:

```typescript
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorStatus, OperatorType, UserRole, OperatorMemberRole, TruckClass } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { normalizePhone } from '../common/phone.util';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { UpdateOperatorProfileDto } from './dto/update-operator-profile.dto';

// ── Scoring weights ────────────────────────────────────────────────────────────
```

(everything from `// ── Scoring weights` onward is unchanged)

In `create()` (current lines 75–114), add `truckClasses` to the `tx.operator.create` payload:

```typescript
      const operator = await tx.operator.create({
        data: {
          type:          data.type ?? OperatorType.TOW_TRUCK,
          truckClasses:  data.truckClasses,
          businessName:  data.businessName,
          contactName:   data.contactName,
          phoneNumber:   data.phoneNumber,
          email:         data.email,
          address:       data.address,
          latitude:      data.latitude,
          longitude:     data.longitude,
          serviceRadius: data.serviceRadius ?? 10,
          status:        OperatorStatus.PENDING,
        },
      });
```

In `updateProfile()` (current lines 371–425), add truck-class handling right after the existing `type` block:

```typescript
    if (dto.type !== undefined) {
      if (!Object.values(OperatorType).includes(dto.type)) {
        throw new BadRequestException(`Invalid operator type: ${dto.type}`);
      }
      data.type = dto.type;
    }

    if (dto.truckClasses !== undefined) {
      const invalid = dto.truckClasses.filter((tc) => !Object.values(TruckClass).includes(tc));
      if (invalid.length > 0) {
        throw new BadRequestException(`Invalid truck class(es): ${invalid.join(', ')}`);
      }
      data.truckClasses = dto.truckClasses;
    }
```

- [ ] **Step 4: Wire the DTOs into `operator.controller.ts`**

Remove the inline `class CreateOperatorDto { ... }` (current lines 21–33) and the two import lines, replacing lines 14–19 with:

```typescript
import { OperatorService } from './operator.service';
import { CreateOperatorDto } from './dto/create-operator.dto';
import { UpdateOperatorProfileDto } from './dto/update-operator-profile.dto';
import { OperatorMemberRole, OperatorStatus, OperatorType, UserRole } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run the operator service/controller test suites**

```bash
npx jest src/operator
```

Expected: PASS (the placeholder `operator.controller.spec.ts` and the real `operator.service.spec.ts` from Task 3 both still pass — the controller spec doesn't reference the removed inline `CreateOperatorDto`, so it's unaffected).

- [ ] **Step 7: Commit**

```bash
git add src/operator/dto src/operator/operator.service.ts src/operator/operator.controller.ts
git commit -m "refactor(operator): extract DTOs to dto/ and add required truckClasses field"
```

---

## Task 7: Backend rollout verification

**Files:** none (verification-only task)

- [ ] **Step 1: Run the full backend test suite**

```bash
cd lrr-service
npx jest
```

Expected: all tests pass, including the new suites from Tasks 2–4.

- [ ] **Step 2: Run the full TypeScript build**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Confirm existing operators are excluded from matching until backfilled**

```bash
npx prisma studio
```

Open the `Operator` table and confirm all pre-existing rows show `truckClasses: []`. This is expected — per the spec, LRR Ops must backfill each operator's fleet via the portal (Task 9) before they receive dispatches again. No code action needed here; this step is just to confirm the migration didn't silently guess a default.

---

## Task 8: Frontend types — `TruckClass` enum and request/response shapes

**Files:**
- Modify: `lrr-web/app/types.ts`

**Interfaces:**
- Produces: `TruckClass` enum, `TRUCK_CLASSES: Record<TruckClass, string>` label map, `RegisterOperatorRequest.truckClasses: TruckClass[]`, `OperatorResponse.truckClasses: TruckClass[]`. Tasks 9–11 consume these.

- [ ] **Step 1: Add the `TruckClass` enum and label map**

Add directly after the existing `OPERATOR_TYPES` map (after line 47):

```typescript
export enum TruckClass {
  LIGHT_DUTY = "LIGHT_DUTY",
  TEN_TYRE = "TEN_TYRE",
  LOW_BED = "LOW_BED",
  HIAB = "HIAB",
}

export const TRUCK_CLASSES: Record<TruckClass, string> = {
  [TruckClass.LIGHT_DUTY]: "Light Duty",
  [TruckClass.TEN_TYRE]: "10-Tyre",
  [TruckClass.LOW_BED]: "Low Bed",
  [TruckClass.HIAB]: "Hiab",
};
```

- [ ] **Step 2: Add `truckClasses` to `RegisterOperatorRequest` and `OperatorResponse`**

```typescript
export interface RegisterOperatorRequest {
  businessName: string;
  contactName: string;
  phoneNumber: string;
  email: string;
  password: string;
  type: OperatorType;
  address: string;
  latitude: number;
  longitude: number;
  truckClasses: TruckClass[];
}
```

Find the `OperatorResponse` interface (starting at line 61 per the earlier audit) and add `truckClasses: TruckClass[];` alongside its other fields (matching whatever field ordering already exists there — add it directly after the `type` field).

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd lrr-web
npx tsc --noEmit
```

Expected: errors will appear at every call site that constructs a `RegisterOperatorRequest` without `truckClasses` — this is expected and gets fixed in Task 9. Confirm the only errors are in `app/register/page.tsx`.

- [ ] **Step 4: Commit**

```bash
git add app/types.ts
git commit -m "feat(types): add TruckClass enum and wire into operator request/response types"
```

---

## Task 9: Frontend — truck-class multi-select on operator registration

**Files:**
- Modify: `lrr-web/app/register/page.tsx`

**Interfaces:**
- Consumes: `TruckClass`, `TRUCK_CLASSES` (Task 8).

There is no existing multi-select/checkbox-group pattern anywhere in this codebase (confirmed by audit — every enum-backed field today is a single `<select>`). This task introduces the first one, styled to match the existing form's visual conventions (same `labelStyle`/border/radius/padding values used by the adjacent `operatorType` select).

- [ ] **Step 1: Add `truckClasses` to form state**

In the `useState` block (current lines 16–24), add the field:

```typescript
  const [formData, setFormData] = useState({
    businessName: "",
    contactName: "",
    phoneNumber: "",
    operatorType: OperatorType.TOW_TRUCK,
    truckClasses: [] as TruckClass[],
    serviceRadius: "50",
    email: "",
    password: "",
    confirmPassword: "",
  });
```

Update the import line to bring in `TruckClass`/`TRUCK_CLASSES`:

```typescript
import { OperatorType, OPERATOR_TYPES, TruckClass, TRUCK_CLASSES } from "../types";
```

- [ ] **Step 2: Add a toggle handler**

Add a new handler function near `handleInputChange` (current line ~40):

```typescript
  function handleTruckClassToggle(truckClass: TruckClass) {
    setFormData((prev) => {
      const isSelected = prev.truckClasses.includes(truckClass);
      return {
        ...prev,
        truckClasses: isSelected
          ? prev.truckClasses.filter((tc) => tc !== truckClass)
          : [...prev.truckClasses, truckClass],
      };
    });
  }
```

- [ ] **Step 3: Add validation in `handleSubmit`**

In `handleSubmit` (current lines 73–ish), add a check alongside the existing field validations, before the `setLoading(true)` call:

```typescript
    if (formData.truckClasses.length === 0) {
      setError("Please select at least one truck class your fleet can operate");
      return;
    }
```

Add `truckClasses` to the payload construction:

```typescript
      const payload: RegisterOperatorRequest = {
        businessName: formData.businessName,
        contactName: formData.contactName,
        phoneNumber: formData.phoneNumber,
        type: formData.operatorType,
        email: formData.email,
        password: formData.password,
        address: address,
        latitude: latLng?.lat || 0,
        longitude: latLng?.lng || 0,
        truckClasses: formData.truckClasses,
      };
```

- [ ] **Step 4: Add the checkbox group to the form UI**

Insert this block directly after the existing "Operator Type" `<select>` field (current lines 262–287):

```tsx
              <div>
                <label style={{ display: "block", fontSize: "0.95rem", fontWeight: 600, color: "#333", marginBottom: 8 }}>
                  Fleet / Truck Classes *
                </label>
                <p style={{ fontSize: "0.8rem", color: "#666", margin: "0 0 8px" }}>
                  Select every truck class in your fleet — this determines which jobs you're offered.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {Object.entries(TRUCK_CLASSES).map(([value, label]) => (
                    <label key={value} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "0.95rem", color: "#333" }}>
                      <input
                        type="checkbox"
                        checked={formData.truckClasses.includes(value as TruckClass)}
                        onChange={() => handleTruckClassToggle(value as TruckClass)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors remaining in `app/register/page.tsx`.

- [ ] **Step 6: Manual verification**

```bash
npm run dev
```

Navigate to `/register`, fill the form, confirm the "Fleet / Truck Classes" checkbox group renders below "Operator Type", that submitting without checking any box shows the validation error, and that checking boxes toggles correctly.

- [ ] **Step 7: Commit**

```bash
git add app/register/page.tsx
git commit -m "feat(register): capture operator fleet truck classes at signup"
```

---

## Task 10: Frontend — `useOperatorApi` truck-class support

**Files:**
- Modify: `lrr-web/app/hooks/useOperatorApi.ts`

**Interfaces:**
- Consumes: `TruckClass` (Task 8).
- Produces: `Operator.truckClasses: TruckClass[]`; `updateOperator()` accepts `truckClasses` in its partial payload. Task 11 depends on both.

- [ ] **Step 1: Add `truckClasses` to the `Operator` interface**

```typescript
export interface Operator {
  id:            string;
  businessName:  string;
  contactName:   string;
  phoneNumber:   string;
  email:         string | null;
  type:          string;
  truckClasses:  string[];
  address:       string;
  latitude:      number;
  longitude:     number;
  serviceRadius: number;
  status:        OperatorStatus;
  isAvailable:   boolean;
  verifiedAt:    string | null;
  createdAt:     string;
  updatedAt:     string;
  members?: OperatorMember[];
}
```

- [ ] **Step 2: Add `truckClasses` to the `updateOperator` accepted fields**

```typescript
  const updateOperator = useCallback(async (id: string, data: Partial<Pick<Operator,
    "businessName" | "contactName" | "email" | "phoneNumber" | "address" | "latitude" | "longitude" | "type" | "serviceRadius" | "truckClasses"
  >>): Promise<Operator> => {
```

(only the `Pick<...>` union changes — the rest of the method body is unchanged, since it already just spreads `data` into the request body)

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd lrr-web
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/hooks/useOperatorApi.ts
git commit -m "feat(hooks): expose truckClasses on Operator and updateOperator"
```

---

## Task 11: Frontend — truck-class editing on the operator profile form

**Files:**
- Modify: `lrr-web/app/components/OperatorProfileForm.tsx`

**Interfaces:**
- Consumes: `Operator.truckClasses`, `updateOperator()` (Task 10), `TruckClass`/`TRUCK_CLASSES` (Task 8).

- [ ] **Step 1: Import the shared truck-class types and remove the local duplicated `OPERATOR_TYPES`... note**

Add the import (this file currently has no import from `../types` at all — it hardcodes its own `OPERATOR_TYPES` array, a pre-existing drift issue noted by the audit but out of scope to fix here beyond what's needed for `truckClasses`):

```typescript
import { useEffect, useState } from "react";
import { useOperatorApi } from "../hooks";
import type { Operator } from "../hooks";
import { TruckClass, TRUCK_CLASSES } from "../types";
```

- [ ] **Step 2: Add `truckClasses` state**

After the existing `const [serviceRadius, setServiceRadius] = useState("10");` line:

```typescript
  const [truckClasses, setTruckClasses] = useState<TruckClass[]>([]);
```

In the `fetchMe().then(...)` block, after `setServiceRadius(String(op.serviceRadius ?? 10));`:

```typescript
        setTruckClasses((op.truckClasses ?? []) as TruckClass[]);
```

- [ ] **Step 3: Add a toggle handler**

```typescript
  function handleTruckClassToggle(truckClass: TruckClass) {
    setTruckClasses((prev) =>
      prev.includes(truckClass)
        ? prev.filter((tc) => tc !== truckClass)
        : [...prev, truckClass],
    );
  }
```

- [ ] **Step 4: Include `truckClasses` in the save payload**

```typescript
      const updated = await updateOperator(operator.id, {
        businessName:  businessName.trim(),
        contactName:   contactName.trim(),
        email:         email.trim(),
        phoneNumber:   phone.trim(),
        address:       address.trim(),
        type,
        serviceRadius: Number(serviceRadius) || operator.serviceRadius,
        truckClasses,
      });
```

- [ ] **Step 5: Add the checkbox group to the form UI**

Insert this block directly after the closing `</div>` of the "Service type" / "Service radius" grid `<div>` (after line 149, before the outer `</div>` that closes the field-stack `<div>` at line 150):

```tsx
        <div>
          <label style={labelStyle}>Fleet / truck classes</label>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {Object.entries(TRUCK_CLASSES).map(([value, label]) => (
              <label key={value} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "0.92rem", fontFamily: dm, color: navy }}>
                <input
                  type="checkbox"
                  checked={truckClasses.includes(value as TruckClass)}
                  onChange={() => handleTruckClassToggle(value as TruckClass)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Manual verification**

```bash
npm run dev
```

Log in as an existing operator, open the dashboard "My Profile" tab, confirm the "Fleet / truck classes" checkbox group renders with whatever the operator's current `truckClasses` are pre-checked (empty for pre-existing operators, per Task 7's expected state), toggle a few, save, and confirm the change persists on reload.

- [ ] **Step 8: Commit**

```bash
git add app/components/OperatorProfileForm.tsx
git commit -m "feat(profile): let operators edit their fleet truck classes"
```

---

## Manual Verification (after all tasks)

- [ ] Register a brand-new test operator via `/register` with `truckClasses: [LOW_BED, HIAB]`.
- [ ] Send a WhatsApp "HELP" message from a test number, share a location pin, and confirm the flow now asks for vehicle type (not issue type), then destination.
- [ ] Select "Heavy Trailer" as the vehicle type and confirm the operator created in the previous step (Low-Bed/Hiab fleet) receives the dispatch offer, while a Light-Duty-only test operator does not.
- [ ] Select "Sedan" as the vehicle type and confirm the Low-Bed/Hiab-only operator does NOT receive the offer (since Sedan maps to Light-Duty/10-Tyre).
- [ ] Confirm the destination text you typed appears in the operator's WhatsApp offer message.
- [ ] Confirm the customer-facing "Searching..." and "Payment confirmed" messages show vehicle type instead of issue type and don't crash/error.
