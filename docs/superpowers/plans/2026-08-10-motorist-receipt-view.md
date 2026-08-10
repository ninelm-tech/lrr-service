# Motorist Receipt View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A motorist can click a completed, fully-paid request in their Requests tab and see a printable receipt (service/vehicle, destination, operator, dates, deposit/balance amounts, total, payment status).

**Architecture:** Backend relaxes `detailForUser`'s `CUSTOMER` branch from an unconditional throw to an ownership check, reusing the existing `RescueRequestDetailDto`/`mapToDetailDto` unchanged (built for the admin quote-compliance view). Frontend adds a click handler on eligible rows in the customer `RequestsTab.tsx` that fetches fresh detail and opens a receipt modal with a `window.print()` button.

**Tech Stack:** NestJS + Prisma (`lrr-service`), Next.js + React, no CSS framework — inline `style={{}}` objects (`lrr-web`).

## Global Constraints

- A receipt is only offered for rows where `status === "COMPLETED" && depositPaid && balancePaid` — every other row keeps today's exact behavior (no click, no visual change). (Design spec, "Non-goals".)
- No PDF library, no new file-download endpoint — `window.print()` + `@media print` CSS covers "download a copy". (Design spec, "Non-goals".)
- No new nav entry or route — this lives inside the existing customer `RequestsTab.tsx`. (Design spec, "Non-goals".)
- `offers` must stay absent from the customer's response — verify this is still true after the change (it already defaults to `undefined` since `mapToDetailDto` is called with no second argument for this role, same as `OPERATOR` today).

---

### Task 1: Backend — let customers view their own request detail

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts` (`detailForUser`)
- Test: `src/rescue-request/rescue-request.service.spec.ts`

**Interfaces:**
- Consumes: nothing new — reuses `RescueRequestDetailDto`/`mapToDetailDto` exactly as built for the admin quote-compliance view (Task 1 of `2026-08-10-admin-quote-compliance-view.md`).
- Produces: `GET /rescue-requests/:id` now succeeds for `CUSTOMER` role when `raw.customerId === userId`, returning the same DTO shape OPERATOR already gets (no `offers`). Task 2 (frontend) consumes this.

- [ ] **Step 1: Replace the `CUSTOMER` branch**

Find, at the end of `detailForUser` in `src/rescue-request/rescue-request.service.ts`:

```typescript
    throw new UnauthorizedException('Customers do not have access to rescue request details');
  }
```

Replace with:

```typescript
    if (role === 'CUSTOMER') {
      if (raw.customerId !== userId) {
        throw new UnauthorizedException('You do not have access to this rescue request');
      }
      return { data: this.mapToDetailDto(raw) };
    }

    throw new UnauthorizedException('Access denied');
  }
```

(The final `throw` is now an unreachable-in-practice fallback for any role outside `SUPER_ADMIN`/`ADMIN`/`OPERATOR`/`CUSTOMER` — kept for defense in depth, matching the style already used elsewhere in this file, e.g. the end of `listForUser`.)

- [ ] **Step 2: Write the failing tests**

Add to `src/rescue-request/rescue-request.service.spec.ts`, inside the existing `describe('detailForUser — quote-compliance data', ...)` block (it already has the `detailService`/`prisma`/`platformConfigService` mocks and `baseRaw` fixture set up in its `beforeEach` — reuse that exact setup, don't duplicate it):

```typescript
    it('returns data for a CUSTOMER who owns the request', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        customerId: 'cust-1',
      });

      const result = await detailService.detailForUser({ role: 'CUSTOMER', userId: 'cust-1' }, 'req-1');

      expect(result.data.vehicleType).toBe('SEDAN');
      expect(result.data.offers).toBeUndefined();
    });

    it('rejects a CUSTOMER who does not own the request', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        customerId: 'cust-1',
      });

      await expect(
        detailService.detailForUser({ role: 'CUSTOMER', userId: 'someone-else' }, 'req-1'),
      ).rejects.toThrow('You do not have access to this rescue request');
    });
```

Note: `baseRaw` (defined earlier in that `describe` block) doesn't currently set `customerId` — check it first; if it's missing, the two tests above override it explicitly via the spread, so no change to `baseRaw` itself is needed.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx jest rescue-request.service.spec.ts -t "CUSTOMER"
```

Expected: FAIL — both tests throw `'Customers do not have access to rescue request details'` instead of the expected behavior, since Step 1 hasn't been applied yet (reorder freely if you did Step 1 first; either order reaches the same state before Step 4).

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx jest rescue-request.service.spec.ts -t "CUSTOMER"
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
git add src/rescue-request/rescue-request.service.ts src/rescue-request/rescue-request.service.spec.ts
git commit -m "feat(rescue-request): let customers view their own completed request detail"
```

---

### Task 2: Frontend — receipt modal on completed, fully-paid requests

**Files:**
- Modify: `app/types.ts`
- Modify: `app/components/customer/RequestsTab.tsx`

**Interfaces:**
- Consumes: `fetchDetail` from `useRescueRequestApi` (already exported, already fixed to unwrap `.data` — see Task 2 of `2026-08-10-admin-quote-compliance-view.md`), `RescueRequestDetail` type (already has `vehicleType`/`destination`/`mediaLinks` from that same prior work).
- Produces: nothing consumed elsewhere — this is the final consumer.

- [ ] **Step 1: Add `depositAmount`/`balanceAmount` to `RescueRequestDetail`**

`RescueRequestDetail` (in `app/types.ts`) has never declared these fields, even though the backend `RescueRequestDetailDto` has always returned them — this task's receipt modal is the type's first real consumer of them, so the gap needs closing now or `tsc` will fail on Step 4 below.

Find, in `app/types.ts`:

```typescript
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

Replace with:

```typescript
export interface RescueRequestDetail extends RescueRequestListItem {
  description?: string;
  adminNotes?: string;
  vehicleType?: string;
  destination?: string;
  mediaLinks: string[];
  offers?: DispatchOfferAdmin[];
  depositAmount?: number;
  balanceAmount?: number;
  timeline?: {
    status: RescueRequestStatus;
    timestamp: string;
    updatedBy?: string;
  }[];
}
```

- [ ] **Step 2: Add state and the `fetchDetail` import**

Find, near the top of `app/components/customer/RequestsTab.tsx`:

```typescript
import { useCallback, useEffect, useState } from "react";
import { useRescueRequestApi } from "../../hooks";
import type { RescueRequestListItem, RescueRequestListResponse } from "../../types";
```

Replace with:

```typescript
import { useCallback, useEffect, useState } from "react";
import { useRescueRequestApi } from "../../hooks";
import type { RescueRequestListItem, RescueRequestListResponse, RescueRequestDetail } from "../../types";
```

Find:

```typescript
export default function RequestsTab() {
  const { fetchMyRequests } = useRescueRequestApi();
  const [rows, setRows]       = useState<RescueRequestListItem[]>([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [loading, setLoading] = useState(true);
```

Replace with:

```typescript
export default function RequestsTab() {
  const { fetchMyRequests, fetchDetail } = useRescueRequestApi();
  const [rows, setRows]       = useState<RescueRequestListItem[]>([]);
  const [total, setTotal]     = useState(0);
  const [page, setPage]       = useState(1);
  const [loading, setLoading] = useState(true);
  const [receipt, setReceipt] = useState<RescueRequestDetail | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);
```

- [ ] **Step 3: Add the eligibility check and click handler**

Find, directly after the `pages` calculation and before the `return`:

```typescript
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
```

Replace with:

```typescript
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function hasReceipt(r: RescueRequestListItem): boolean {
    return r.status === "COMPLETED" && r.depositPaid && r.balancePaid;
  }

  function openReceipt(r: RescueRequestListItem) {
    if (!hasReceipt(r)) return;
    setReceiptLoading(true);
    fetchDetail(r.id)
      .then(setReceipt)
      .catch(() => {})
      .finally(() => setReceiptLoading(false));
  }

  return (
```

- [ ] **Step 4: Make eligible rows clickable**

Find the row rendering:

```typescript
            ) : rows.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid #f7f9fc" }}>
                <td style={{ padding: "0.9rem 0", fontSize: "0.92rem", color: navy, fontWeight: 500 }}>
                  {r.issueType?.replace(/_/g, " ") ?? "Assistance"}
                </td>
                <td style={{ padding: "0.9rem 0", fontSize: "0.92rem", color: "#6c7890" }}>
                  {r.assignedOperator?.businessName ?? "—"}
                </td>
                <td style={{ padding: "0.9rem 0", fontSize: "0.92rem", color: "#6c7890", whiteSpace: "nowrap" }}>
                  {new Date(r.createdAt).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}
                </td>
                <td style={{ padding: "0.9rem 0" }}>{statusPill(r.status)}</td>
              </tr>
            ))}
```

Replace with:

```typescript
            ) : rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => openReceipt(r)}
                style={{
                  borderBottom: "1px solid #f7f9fc",
                  cursor: hasReceipt(r) ? "pointer" : "default",
                }}
              >
                <td style={{ padding: "0.9rem 0", fontSize: "0.92rem", color: navy, fontWeight: 500 }}>
                  {r.issueType?.replace(/_/g, " ") ?? "Assistance"}
                </td>
                <td style={{ padding: "0.9rem 0", fontSize: "0.92rem", color: "#6c7890" }}>
                  {r.assignedOperator?.businessName ?? "—"}
                </td>
                <td style={{ padding: "0.9rem 0", fontSize: "0.92rem", color: "#6c7890", whiteSpace: "nowrap" }}>
                  {new Date(r.createdAt).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}
                </td>
                <td style={{ padding: "0.9rem 0" }}>
                  {statusPill(r.status)}
                  {hasReceipt(r) && (
                    <span style={{ marginLeft: 8, fontSize: "0.78rem", color: blue, fontWeight: 600 }}>Receipt →</span>
                  )}
                </td>
              </tr>
            ))}
```

- [ ] **Step 5: Add the receipt modal**

Find the component's closing — the outermost `</div>` right before the final `);` and `}`:

```typescript
      {pages > 1 && (
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, marginTop: "1rem" }}>
          <button
            onClick={() => load(page - 1)}
            disabled={page <= 1 || loading}
            style={{ padding: "0.4rem 0.9rem", borderRadius: 8, border: "1px solid #dde8f8", background: "#fff", color: page <= 1 ? "#c3cbda" : blue, fontWeight: 600, fontSize: "0.85rem", cursor: page <= 1 ? "not-allowed" : "pointer", fontFamily: dm }}
          >
            ← Prev
          </button>
          <span style={{ color: "#6c7890", fontSize: "0.85rem" }}>Page {page} of {pages}</span>
          <button
            onClick={() => load(page + 1)}
            disabled={page >= pages || loading}
            style={{ padding: "0.4rem 0.9rem", borderRadius: 8, border: "1px solid #dde8f8", background: "#fff", color: page >= pages ? "#c3cbda" : blue, fontWeight: 600, fontSize: "0.85rem", cursor: page >= pages ? "not-allowed" : "pointer", fontFamily: dm }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
```

Replace with:

```typescript
      {pages > 1 && (
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12, marginTop: "1rem" }}>
          <button
            onClick={() => load(page - 1)}
            disabled={page <= 1 || loading}
            style={{ padding: "0.4rem 0.9rem", borderRadius: 8, border: "1px solid #dde8f8", background: "#fff", color: page <= 1 ? "#c3cbda" : blue, fontWeight: 600, fontSize: "0.85rem", cursor: page <= 1 ? "not-allowed" : "pointer", fontFamily: dm }}
          >
            ← Prev
          </button>
          <span style={{ color: "#6c7890", fontSize: "0.85rem" }}>Page {page} of {pages}</span>
          <button
            onClick={() => load(page + 1)}
            disabled={page >= pages || loading}
            style={{ padding: "0.4rem 0.9rem", borderRadius: 8, border: "1px solid #dde8f8", background: "#fff", color: page >= pages ? "#c3cbda" : blue, fontWeight: 600, fontSize: "0.85rem", cursor: page >= pages ? "not-allowed" : "pointer", fontFamily: dm }}
          >
            Next →
          </button>
        </div>
      )}

      {(receiptLoading || receipt) && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
          className="lrr-receipt-backdrop"
          onClick={() => setReceipt(null)}
        >
          <div
            className="lrr-receipt-card"
            style={{ background: "#fff", borderRadius: 16, padding: "2rem", width: "100%", maxWidth: 440, boxShadow: "0 8px 40px rgba(0,0,0,0.18)", fontFamily: dm }}
            onClick={e => e.stopPropagation()}
          >
            {receiptLoading ? (
              <p style={{ color: "#999", fontSize: "0.9rem" }}>Loading receipt…</p>
            ) : receipt && (
              <>
                <h2 style={{ margin: "0 0 1.25rem 0", color: blue, fontSize: "1.15rem" }}>Receipt</h2>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem 1.5rem", marginBottom: "1.5rem" }}>
                  {[
                    ["Service", receipt.vehicleType ?? receipt.issueType ?? "—"],
                    ["Destination", receipt.destination ?? "—"],
                    ["Operator", receipt.assignedOperator?.businessName ?? "—"],
                    ["Date", new Date(receipt.createdAt).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })],
                    ["Deposit", `₦${((receipt.depositAmount ?? 0) / 100).toLocaleString()}`],
                    ["Balance", `₦${((receipt.balanceAmount ?? 0) / 100).toLocaleString()}`],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <p style={{ margin: 0, fontSize: "0.75rem", color: "#999", fontWeight: 600, textTransform: "uppercase" }}>{label}</p>
                      <p style={{ margin: "2px 0 0 0", fontWeight: 600, color: "#333", fontSize: "0.9rem" }}>{value}</p>
                    </div>
                  ))}
                </div>
                <div style={{ padding: "1rem", background: "#e8f8f0", borderRadius: 10, marginBottom: "1.5rem", textAlign: "center" }}>
                  <p style={{ margin: 0, fontWeight: 700, color: "#19a56b", fontSize: "1rem" }}>
                    Total paid: ₦{(((receipt.depositAmount ?? 0) + (receipt.balanceAmount ?? 0)) / 100).toLocaleString()}
                  </p>
                  <p style={{ margin: "4px 0 0 0", fontSize: "0.82rem", color: "#19a56b" }}>✓ Paid in full</p>
                </div>
                <div className="lrr-receipt-actions" style={{ display: "flex", gap: 10 }}>
                  <button
                    onClick={() => window.print()}
                    style={{ flex: 1, padding: "0.65rem", background: blue, color: "#fff", border: "none", borderRadius: 8, fontWeight: 600, cursor: "pointer", fontFamily: dm }}
                  >
                    Print
                  </button>
                  <button
                    onClick={() => setReceipt(null)}
                    style={{ flex: 1, padding: "0.65rem", background: "#dde8f8", color: blue, border: "none", borderRadius: 8, fontWeight: 600, cursor: "pointer", fontFamily: dm }}
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <style jsx global>{`
        @media print {
          body * { visibility: hidden; }
          .lrr-receipt-card, .lrr-receipt-card * { visibility: visible; }
          .lrr-receipt-backdrop { position: absolute !important; background: none !important; }
          .lrr-receipt-card { position: absolute; top: 0; left: 0; box-shadow: none !important; }
          .lrr-receipt-actions { display: none !important; }
        }
      `}</style>
    </div>
  );
}
```

(`RescueRequestListItem` already has `assignedOperator`/`createdAt`/`status`/`depositPaid`/`balancePaid` — this plan only adds new fields to the richer `RescueRequestDetail` type the modal reads from, via `fetchDetail`.)

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Manual verification**

Log in as a customer whose test account has at least one `COMPLETED` request with both `depositPaid`/`balancePaid` true (e.g. the E2E test flow from the operator-quotes work). Confirm: rows without full payment show no "Receipt →" hint and clicking does nothing; the fully-paid completed row shows the hint, and clicking opens the modal with correct vehicle/destination/operator/dates/amounts and the "✓ Paid in full" total. Click Print and confirm the browser print preview shows only the receipt card, not the page chrome. Click Close and confirm the modal dismisses.

- [ ] **Step 8: Commit**

```bash
git add app/types.ts app/components/customer/RequestsTab.tsx
git commit -m "feat(customer): add printable receipt view for completed, paid requests"
```

---
