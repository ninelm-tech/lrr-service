# Admin Quote-Compliance View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admin see every dispatch offer (operator, status, raw quote, motorist-facing total, timing) for a request, alongside its vehicle type, destination, and media links, inside the existing per-request detail modal — read-only, admin-only.

**Architecture:** Backend extends the existing `GET /rescue-requests/:id` response (`RescueRequestDetailDto`) with `vehicleType`, `destination`, `mediaLinks`, and an admin-only `offers` array, computed the same way `sendQuoteShortlist` already computes motorist-facing totals. Frontend fixes a latent unwrap bug in the currently-uncalled `fetchDetail`, wires it into the admin modal's `openModal`, and renders a new "Quotes" section plus two new info-grid rows.

**Tech Stack:** NestJS + Prisma (`lrr-service`), Next.js + React, no CSS framework — inline `style={{}}` objects (`lrr-web`).

## Global Constraints

- `offers` is present in the response **only** for `ADMIN`/`SUPER_ADMIN` roles — an operator or customer must never see another operator's price. (Design spec, "Non-goals".)
- `motoristFacingTotal` uses the exact same formula as `sendQuoteShortlist` in `rescue-request.service.ts`: `quotedPrice + round(quotedPrice * config.serviceFeePercent / 100)`. Do not introduce a second formula.
- No schema migration — `DispatchOffer`, `RescueRequest.media`, `RescueRequest.vehicleType`, `RescueRequest.destination` all already exist.
- No new admin actions (no flag, no manual quote override) — purely a read addition. (Design spec, "Non-goals".)
- No new page/route — this extends the existing modal in `RescueRequestsTabAdmin.tsx`, no new navigation entry.

---

### Task 1: Backend — surface offers, vehicleType, destination, mediaLinks on request detail

**Important discovery, read before starting:** `mapToDetailDto` has **7** call sites in `rescue-request.service.ts`, not just the two inside `detailForUser` (verify yourself: `grep -n "mapToDetailDto(" src/rescue-request/rescue-request.service.ts` before touching anything). The other 5 call it synchronously and assign the result directly to `data:` — if `mapToDetailDto` becomes `async`, those 5 would silently receive an unresolved `Promise` instead of the DTO. **Do not make `mapToDetailDto` async.** Instead, compute the `offers` array in `detailForUser` itself (which is already `async`) and pass it into `mapToDetailDto` as a plain, already-resolved parameter.

Also: there is an existing **dead** method, `adminDetail(id: string)` (around line 1573), that already does almost exactly what this task needs — fetches `dispatchOffers` with `operator.businessName`, ordered by `offeredAt` — but it is never called by the controller or anywhere else (verify: `grep -n "adminDetail" src/rescue-request/rescue-request.controller.ts src/rescue-request/rescue-request.service.ts` shows only its own declaration). This looks like an abandoned earlier attempt at this same feature. Reuse its query shape (the `orderBy: { offeredAt: 'asc' }` on the `dispatchOffers` include is worth keeping — it means `mapToDetailDto` never needs to sort) and delete the orphaned method as part of this task rather than leaving two parallel, half-built paths.

**Files:**
- Modify: `src/rescue-request/dto/rescue-request-response.dto.ts`
- Modify: `src/rescue-request/rescue-request.service.ts` (`detailForUser`, `mapToDetailDto`; delete `adminDetail`)
- Test: `src/rescue-request/rescue-request.service.spec.ts`

**Interfaces:**
- Consumes: `PlatformConfigService.getConfig()` (already injected into `RescueRequestService`'s constructor since Task 7 of the operator-quotes plan — no new wiring needed).
- Produces: `RescueRequestDetailDto` gains `vehicleType?: VehicleType`, `destination?: string`, `mediaLinks: string[]`, `offers?: DispatchOfferAdminDto[]`. `mapToDetailDto`'s signature becomes `mapToDetailDto(raw: any, offers?: DispatchOfferAdminDto[]): RescueRequestDetailDto` — still synchronous, unchanged for its other 5 callers (they simply don't pass a second argument, so `offers` stays `undefined` for them, exactly matching today's behavior). Task 2 (frontend) consumes the resulting response shape.

- [ ] **Step 1: Add `DispatchOfferAdminDto` and extend `RescueRequestDetailDto`**

Open `src/rescue-request/dto/rescue-request-response.dto.ts`. Change the top import line from:

```typescript
import { RescueRequestStatus, IssueType } from '@prisma/client';
```

to:

```typescript
import { RescueRequestStatus, IssueType, VehicleType, DispatchOfferStatus } from '@prisma/client';
```

Add this new class directly above `RescueRequestDetailDto`:

```typescript
export class DispatchOfferAdminDto {
  operatorId: string;
  businessName: string;
  status: DispatchOfferStatus;
  quotedPrice?: number;
  motoristFacingTotal?: number;
  offeredAt: Date;
  respondedAt?: Date;
}
```

Then extend `RescueRequestDetailDto` — find:

```typescript
export class RescueRequestDetailDto {
  id: string;
  status: RescueRequestStatus;
  issueType?: IssueType;
  latitude?: number;
  longitude?: number;
```

Replace with:

```typescript
export class RescueRequestDetailDto {
  id: string;
  status: RescueRequestStatus;
  issueType?: IssueType;
  vehicleType?: VehicleType;
  destination?: string;
  mediaLinks: string[];
  latitude?: number;
  longitude?: number;
```

And find the closing of the same class:

```typescript
  createdAt: Date;
  updatedAt: Date;
}

export class PaginationMetaDto {
```

Replace with:

```typescript
  createdAt: Date;
  updatedAt: Date;
  offers?: DispatchOfferAdminDto[];
}

export class PaginationMetaDto {
```

- [ ] **Step 2: Delete the orphaned `adminDetail` method**

First confirm it's genuinely unreferenced:

```bash
grep -rn "adminDetail" src/
```

Expected: only its own `async adminDetail(id: string) {` declaration around line 1573, no controller route, no other caller anywhere. Delete the entire method (from `async adminDetail(id: string) {` through its closing `}`) from `rescue-request.service.ts`.

- [ ] **Step 3: Extend `detailForUser`'s Prisma query**

Find `detailForUser`:

```typescript
  async detailForUser(user: any, id: string): Promise<RescueRequestDetailResponseDto> {
    const { role, userId } = user;

    const raw = await this.prisma.rescueRequest.findUnique({
      where: { id },
      include: {
        customer:        { select: { id: true, phoneNumber: true, email: true, name: true } },
        assignedOperator: { select: { id: true, businessName: true, phoneNumber: true, email: true } },
      },
    });
    if (!raw) throw new UnauthorizedException('Rescue request not found');

    if (role === 'SUPER_ADMIN' || role === 'ADMIN') return { data: this.mapToDetailDto(raw) };

    if (role === 'OPERATOR') {
      const memberships = await this.prisma.operatorMember.findMany({
        where: { userId },
        select: { operatorId: true },
      });
      const operatorIds = memberships.map((m) => m.operatorId);
      if (!operatorIds.includes(raw.assignedOperatorId!)) {
        throw new UnauthorizedException('You do not have access to this rescue request');
      }
      return { data: this.mapToDetailDto(raw) };
    }

    throw new UnauthorizedException('Customers do not have access to rescue request details');
  }
```

Replace entirely with:

```typescript
  async detailForUser(user: any, id: string): Promise<RescueRequestDetailResponseDto> {
    const { role, userId } = user;

    const raw = await this.prisma.rescueRequest.findUnique({
      where: { id },
      include: {
        customer:        { select: { id: true, phoneNumber: true, email: true, name: true } },
        assignedOperator: { select: { id: true, businessName: true, phoneNumber: true, email: true } },
        media:            { select: { id: true } },
        dispatchOffers:   {
          include: { operator: { select: { id: true, businessName: true } } },
          orderBy: { offeredAt: 'asc' },
        },
      },
    });
    if (!raw) throw new UnauthorizedException('Rescue request not found');

    if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
      const config = await this.platformConfigService.getConfig();
      const offers: DispatchOfferAdminDto[] = raw.dispatchOffers.map((o: any) => ({
        operatorId:          o.operatorId,
        businessName:        o.operator.businessName,
        status:              o.status,
        quotedPrice:         o.quotedPrice ?? undefined,
        motoristFacingTotal: o.quotedPrice
          ? o.quotedPrice + Math.round((o.quotedPrice * config.serviceFeePercent) / 100)
          : undefined,
        offeredAt:   o.offeredAt,
        respondedAt: o.respondedAt ?? undefined,
      }));
      return { data: this.mapToDetailDto(raw, offers) };
    }

    if (role === 'OPERATOR') {
      const memberships = await this.prisma.operatorMember.findMany({
        where: { userId },
        select: { operatorId: true },
      });
      const operatorIds = memberships.map((m) => m.operatorId);
      if (!operatorIds.includes(raw.assignedOperatorId!)) {
        throw new UnauthorizedException('You do not have access to this rescue request');
      }
      return { data: this.mapToDetailDto(raw) };
    }

    throw new UnauthorizedException('Customers do not have access to rescue request details');
  }
```

Note the `OPERATOR` branch calls `mapToDetailDto(raw)` with no second argument — `offers` stays `undefined` for that role, exactly the "admin-only" gating the spec requires. `media` and `dispatchOffers` are still fetched in the query for the `OPERATOR`/other branches too (harmless — `mapToDetailDto` always computes `mediaLinks` from `raw.media` regardless of role, per the spec's decision that vehicleType/destination/media are visible to operators, just not `offers`).

- [ ] **Step 4: Extend `mapToDetailDto` — stays synchronous, takes `offers` as a parameter**

Find:

```typescript
  private mapToDetailDto(raw: any): RescueRequestDetailDto {
    return {
      id:               raw.id,
      status:           raw.status,
      issueType:        raw.issueType  ?? undefined,
      latitude:         raw.latitude   ? Number(raw.latitude)  : undefined,
      longitude:        raw.longitude  ? Number(raw.longitude) : undefined,
      depositPaid:      raw.depositPaid,
      depositAmount:    raw.depositAmount,
      depositReference: raw.depositReference,
      balancePaid:      raw.balancePaid,
      balanceAmount:    raw.balanceAmount,
      balanceReference: raw.balanceReference,
      customer: {
        id:          raw.customer.id,
        phoneNumber: raw.customer.phoneNumber,
        email:       raw.customer.email,
        name:        raw.customer.name,
      },
      assignedOperator: raw.assignedOperator
        ? {
            id:           raw.assignedOperator.id,
            businessName: raw.assignedOperator.businessName,
            phoneNumber:  raw.assignedOperator.phoneNumber,
            email:        raw.assignedOperator.email,
          }
        : undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }
```

Replace entirely with:

```typescript
  private mapToDetailDto(raw: any, offers?: DispatchOfferAdminDto[]): RescueRequestDetailDto {
    const apiBaseUrl = process.env.API_BASE_URL;
    const mediaLinks: string[] = raw.media && apiBaseUrl
      ? raw.media.map((m: { id: string }) => `${apiBaseUrl}/api/v1/media/${m.id}`)
      : [];

    return {
      id:               raw.id,
      status:           raw.status,
      issueType:        raw.issueType    ?? undefined,
      vehicleType:      raw.vehicleType  ?? undefined,
      destination:      raw.destination  ?? undefined,
      mediaLinks,
      latitude:         raw.latitude   ? Number(raw.latitude)  : undefined,
      longitude:        raw.longitude  ? Number(raw.longitude) : undefined,
      depositPaid:      raw.depositPaid,
      depositAmount:    raw.depositAmount,
      depositReference: raw.depositReference,
      balancePaid:      raw.balancePaid,
      balanceAmount:    raw.balanceAmount,
      balanceReference: raw.balanceReference,
      customer: {
        id:          raw.customer.id,
        phoneNumber: raw.customer.phoneNumber,
        email:       raw.customer.email,
        name:        raw.customer.name,
      },
      assignedOperator: raw.assignedOperator
        ? {
            id:           raw.assignedOperator.id,
            businessName: raw.assignedOperator.businessName,
            phoneNumber:  raw.assignedOperator.phoneNumber,
            email:        raw.assignedOperator.email,
          }
        : undefined,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      offers,
    };
  }
```

This signature change (`raw: any` → `raw: any, offers?: DispatchOfferAdminDto[]`) is backward-compatible with the other 5 existing call sites — they don't pass a second argument, so `offers` stays `undefined` for them, matching their current (offer-less) behavior exactly. No other call site needs to change.

Add the `DispatchOfferAdminDto` import alongside the existing DTO import at the top of `rescue-request.service.ts` — find the existing import block that includes `RescueRequestDetailDto` (search for `from './dto/rescue-request-response.dto'`) and add `DispatchOfferAdminDto` to that same import list.

- [ ] **Step 5: Re-verify all `mapToDetailDto` call sites compile clean**

```bash
grep -n "mapToDetailDto(" src/rescue-request/rescue-request.service.ts
```

Expected: exactly 6 remaining call sites (7 minus the deleted `adminDetail`'s one) — 2 inside `detailForUser` (one with `offers`, one without) and 4 unchanged elsewhere, all still passing only `raw`/`updated` as a single argument. `npx tsc --noEmit` (Step 8 below) is the real verification; this grep is just a quick sanity count first.

- [ ] **Step 6: Write the failing test**

Add to `src/rescue-request/rescue-request.service.spec.ts` (create the `describe` block if this exact one doesn't already exist — check the file first; this codebase's existing spec file already has a `RescueRequestService` test module with all dependencies mocked per the pattern from Task 7/9 of the operator-quotes plan):

```typescript
describe('detailForUser — quote-compliance data', () => {
  const baseRaw = {
    id: 'req-1',
    status: 'DISPATCHING',
    issueType: undefined,
    vehicleType: 'SEDAN',
    destination: 'Mainland',
    latitude: null,
    longitude: null,
    depositPaid: false,
    depositAmount: undefined,
    depositReference: undefined,
    balancePaid: false,
    balanceAmount: undefined,
    balanceReference: undefined,
    createdAt: new Date('2026-08-10T00:00:00Z'),
    updatedAt: new Date('2026-08-10T00:00:00Z'),
    customer: { id: 'cust-1', phoneNumber: '+2340000000000', email: null, name: null },
    assignedOperatorId: null,
    assignedOperator: null,
    media: [],
    dispatchOffers: [
      {
        operatorId: 'op-1',
        status: 'QUOTED',
        quotedPrice: 2500000,
        offeredAt: new Date('2026-08-10T00:00:00Z'),
        respondedAt: new Date('2026-08-10T00:05:00Z'),
        operator: { id: 'op-1', businessName: 'Swift Towing' },
      },
    ],
  };

  it('includes offers with computed motoristFacingTotal for ADMIN', async () => {
    (prisma.rescueRequest.findUnique as jest.Mock).mockResolvedValue(baseRaw);
    (platformConfigService.getConfig as jest.Mock).mockResolvedValue({ serviceFeePercent: 10, depositPercent: 10 });

    const result = await service.detailForUser({ role: 'ADMIN', userId: 'admin-1' }, 'req-1');

    expect(result.data.vehicleType).toBe('SEDAN');
    expect(result.data.destination).toBe('Mainland');
    expect(result.data.offers).toEqual([
      expect.objectContaining({
        operatorId: 'op-1',
        businessName: 'Swift Towing',
        quotedPrice: 2500000,
        motoristFacingTotal: 2750000,
      }),
    ]);
  });

  it('omits offers entirely for OPERATOR', async () => {
    (prisma.rescueRequest.findUnique as jest.Mock).mockResolvedValue({
      ...baseRaw,
      assignedOperatorId: 'op-1',
      assignedOperator: { id: 'op-1', businessName: 'Swift Towing', phoneNumber: '+2341111111111', email: null },
    });
    (prisma.operatorMember.findMany as jest.Mock).mockResolvedValue([{ operatorId: 'op-1' }]);

    const result = await service.detailForUser({ role: 'OPERATOR', userId: 'user-1' }, 'req-1');

    expect(result.data.offers).toBeUndefined();
  });
});
```

Check the top of `rescue-request.service.spec.ts` for how `prisma` and `platformConfigService` mocks are already named/injected in this file's existing `TestingModule` setup (established in Tasks 7/9 of the operator-quotes plan) — use those exact variable names rather than the placeholders `prisma`/`platformConfigService` above if they differ.

- [ ] **Step 7: Run the test to verify it fails**

```bash
npx jest rescue-request.service.spec.ts -t "quote-compliance"
```

Expected: FAIL — `offers`/`vehicleType`/`destination` undefined or `mapToDetailDto` type error, since the implementation isn't in place yet (do this step before Steps 1-5 if following strict TDD; the plan lists DTO/service changes first only because they're the shared shape the test asserts against — reorder freely, both orders reach the same end state before Step 8).

- [ ] **Step 8: Run the test to verify it passes**

```bash
npx jest rescue-request.service.spec.ts -t "quote-compliance"
```

Expected: PASS, both new tests green.

- [ ] **Step 9: Verify TypeScript compiles and the full suite passes**

```bash
npx tsc --noEmit
npx jest
```

Expected: no errors; all suites pass.

- [ ] **Step 10: Commit**

```bash
git add src/rescue-request/dto/rescue-request-response.dto.ts src/rescue-request/rescue-request.service.ts src/rescue-request/rescue-request.service.spec.ts
git commit -m "feat(rescue-request): surface quotes, vehicle type, destination, and media on admin request detail"
```

---

### Task 2: Frontend — fetch fresh detail on modal open, render Quotes section

**Files:**
- Modify: `app/types.ts`
- Modify: `app/hooks/useRescueRequestApi.ts`
- Modify: `app/components/tabs/RescueRequestsTabAdmin.tsx`

**Interfaces:**
- Consumes: `GET /rescue-requests/:id` response shape from Task 1 — `{ data: { ...RescueRequestDetailDto } }`, specifically `vehicleType`, `destination`, `mediaLinks: string[]`, `offers?: DispatchOfferAdmin[]`.
- Produces: no new exports consumed elsewhere — this is the final consumer of Task 1's shape.

- [ ] **Step 1: Extend `RescueRequestDetail` and add `DispatchOfferAdmin` in `app/types.ts`**

Find:

```typescript
export interface RescueRequestDetail extends RescueRequestListItem {
  description?: string;
  adminNotes?: string;
  timeline?: {
    status: RescueRequestStatus;
    timestamp: string;
    updatedBy?: string;
  }[];
}
```

Replace with:

```typescript
export interface DispatchOfferAdmin {
  operatorId: string;
  businessName: string;
  status: string;
  quotedPrice?: number;
  motoristFacingTotal?: number;
  offeredAt: string;
  respondedAt?: string;
}

export interface RescueRequestDetail extends RescueRequestListItem {
  description?: string;
  adminNotes?: string;
  vehicleType?: string;
  destination?: string;
  mediaLinks: string[];
  offers?: DispatchOfferAdmin[];
  timeline?: {
    status: RescueRequestStatus;
    timestamp: string;
    updatedBy?: string;
  }[];
}
```

- [ ] **Step 2: Fix `fetchDetail`'s response unwrap in `app/hooks/useRescueRequestApi.ts`**

`fetchDetail` has no current callers anywhere in the codebase (verify: `grep -rn "fetchDetail" app/ --include="*.tsx" --include="*.ts" | grep -v useRescueRequestApi.ts` returns nothing) — it casts the raw `apiFetch` result directly to `RescueRequestDetail`, but the backend wraps every response in `{ data: ... }` (confirmed: `rescue-request.controller.ts`'s `:id` route returns `detailForUser`'s result directly, which is typed `RescueRequestDetailResponseDto` = `{ data: RescueRequestDetailDto }`). This task is `fetchDetail`'s first real caller, so fix the unwrap now rather than shipping a broken first use.

Find:

```typescript
  const fetchDetail = useCallback(async (id: string): Promise<RescueRequestDetail> => {
    setLoading(true);
    setError(null);
    try {
      return await apiFetch(`/rescue-requests/${id}`) as RescueRequestDetail;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch request details";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);
```

Replace with:

```typescript
  const fetchDetail = useCallback(async (id: string): Promise<RescueRequestDetail> => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/rescue-requests/${id}`);
      return res.data as RescueRequestDetail;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to fetch request details";
      setError(msg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);
```

- [ ] **Step 3: Wire `fetchDetail` into `openModal` and add detail state**

In `app/components/tabs/RescueRequestsTabAdmin.tsx`, find the hook destructuring:

```typescript
  const {
    requests, loading, error, total, page, limit,
    fetchList, assignOperator, updateStatus, cancelRequest: cancel,
  } = useRescueRequestApi();
```

Replace with:

```typescript
  const {
    requests, loading, error, total, page, limit,
    fetchList, fetchDetail, assignOperator, updateStatus, cancelRequest: cancel,
  } = useRescueRequestApi();
```

Find the state declarations:

```typescript
  const [selectedRequest, setSelectedRequest] = useState<RescueRequestListItem | null>(null);
```

Add directly after it:

```typescript
  const [selectedDetail, setSelectedDetail] = useState<RescueRequestDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
```

Add `RescueRequestDetail` to the existing type import — find:

```typescript
import type { RescueRequestListItem, RescueRequestStatus } from "../../types";
```

Replace with:

```typescript
import type { RescueRequestListItem, RescueRequestStatus, RescueRequestDetail } from "../../types";
```

Find `openModal`:

```typescript
  const openModal = useCallback((req: RescueRequestListItem) => {
    setSelectedRequest(req);
    setSelectedOperatorId(req.assignedOperator?.id ?? "");
    setActionMsg(null);
    if (["DISPATCHING", "WAITING_FOR_DEPOSIT"].includes(req.status)) {
      loadAvailableOperators();
    }
  }, [loadAvailableOperators]);
```

Replace with:

```typescript
  const openModal = useCallback((req: RescueRequestListItem) => {
    setSelectedRequest(req);
    setSelectedDetail(null);
    setSelectedOperatorId(req.assignedOperator?.id ?? "");
    setActionMsg(null);
    if (["DISPATCHING", "WAITING_FOR_DEPOSIT"].includes(req.status)) {
      loadAvailableOperators();
    }
    setDetailLoading(true);
    fetchDetail(req.id)
      .then(setSelectedDetail)
      .catch(() => { /* modal still works with list-item data if detail fetch fails */ })
      .finally(() => setDetailLoading(false));
  }, [loadAvailableOperators, fetchDetail]);
```

Also find where the modal closes (`onClick={() => setSelectedRequest(null)}`, appears once for the backdrop) and clear the detail alongside it — replace:

```typescript
            onClick={() => setSelectedRequest(null)}
```

with:

```typescript
            onClick={() => { setSelectedRequest(null); setSelectedDetail(null); }}
```

- [ ] **Step 4: Add Vehicle/Destination rows to the info grid**

Find the info grid array:

```typescript
                {[
                  ["Issue", selectedRequest.issueType ?? "—"],
                  ["Customer", formatPhoneNumber(selectedRequest.customer?.phoneNumber ?? "")],
                  ["Created", formatTime(selectedRequest.createdAt)],
                  ["Updated", formatTime(selectedRequest.updatedAt)],
                  ["Deposit", selectedRequest.depositPaid ? "✓ Paid" : "✗ Pending"],
                  ["Balance", selectedRequest.balancePaid ? "✓ Paid" : "✗ Pending"],
                ].map(([label, value]) => (
```

Replace with:

```typescript
                {[
                  ["Issue", selectedRequest.issueType ?? "—"],
                  ["Vehicle", selectedDetail?.vehicleType ?? "—"],
                  ["Destination", selectedDetail?.destination ?? "—"],
                  ["Customer", formatPhoneNumber(selectedRequest.customer?.phoneNumber ?? "")],
                  ["Created", formatTime(selectedRequest.createdAt)],
                  ["Updated", formatTime(selectedRequest.updatedAt)],
                  ["Deposit", selectedRequest.depositPaid ? "✓ Paid" : "✗ Pending"],
                  ["Balance", selectedRequest.balancePaid ? "✓ Paid" : "✗ Pending"],
                ].map(([label, value]) => (
```

- [ ] **Step 5: Add the Quotes section and media links**

Find the Map link block's closing (search for `Open in Google Maps`) — directly after that block's closing `)}`, and before the `{/* ── Manual Assign ── */}` comment, insert:

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

              {/* ── Quotes (admin-only, read-only) ── */}
              {detailLoading && (
                <p style={{ color: "#999", fontSize: "0.88rem", marginBottom: "1.5rem" }}>Loading quotes…</p>
              )}
              {selectedDetail?.offers && selectedDetail.offers.length > 0 && (
                <div style={{ marginBottom: "1.5rem" }}>
                  <p style={{ margin: "0 0 0.75rem 0", fontWeight: 700, color: "#333", fontSize: "0.95rem" }}>
                    Quotes ({selectedDetail.offers.length})
                  </p>
                  <div style={{ border: "1px solid #dde8f8", borderRadius: 10, overflow: "hidden" }}>
                    {selectedDetail.offers.map((offer, i) => (
                      <div key={offer.operatorId + offer.offeredAt} style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "0.75rem 1rem", fontSize: "0.88rem",
                        borderTop: i === 0 ? "none" : "1px solid #f0f2f5",
                      }}>
                        <div>
                          <p style={{ margin: 0, fontWeight: 600, color: "#333" }}>{offer.businessName}</p>
                          <p style={{ margin: "2px 0 0 0", color: "#999", fontSize: "0.78rem" }}>
                            Offered {formatTime(offer.offeredAt)}
                            {offer.respondedAt ? ` · Responded ${formatTime(offer.respondedAt)}` : ""}
                          </p>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <p style={{ margin: 0, fontWeight: 700, color: "#003DB4" }}>
                            {offer.quotedPrice ? `₦${(offer.quotedPrice / 100).toLocaleString()}` : "—"}
                          </p>
                          {offer.motoristFacingTotal && (
                            <p style={{ margin: "2px 0 0 0", color: "#999", fontSize: "0.78rem" }}>
                              ₦{(offer.motoristFacingTotal / 100).toLocaleString()} to motorist
                            </p>
                          )}
                          <p style={{ margin: "2px 0 0 0", fontSize: "0.72rem", fontWeight: 700, color: "#6c7890" }}>
                            {offer.status}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Manual verification**

Start the dev server, log in as admin, open the Requests tab, click a request with at least one dispatch offer. Confirm: Vehicle/Destination rows show real values (or "—" if absent), media links render if present, a "Loading quotes…" flash appears briefly then the Quotes section populates with operator name, raw quote, motorist-facing total, and status. Open a request with zero offers — confirm the Quotes section simply doesn't render (no empty box).

- [ ] **Step 8: Commit**

```bash
git add app/types.ts app/hooks/useRescueRequestApi.ts app/components/tabs/RescueRequestsTabAdmin.tsx
git commit -m "feat(admin): show quotes, vehicle type, destination, and media on request detail"
```

---
