# Motorist Receipt View — Design

## Background

The PRD (Motorist "Account & History" stakeholder scope) describes
motorists being able to "view job history, track past payments, and
download receipts." Today, customers have **zero** detail-view access to
their own requests at all — `detailForUser`'s `CUSTOMER` branch
unconditionally throws `UnauthorizedException('Customers do not have
access to rescue request details')`. The customer-facing `RequestsTab.tsx`
in `lrr-web` is a flat, non-interactive table (service, operator, date,
status) with no row click, no payment amounts, and no vehicle/destination
info — the list endpoint only returns `depositPaid`/`balancePaid`
booleans, never the actual amounts.

This is item 7 of the PRD gap backlog, split into two independent
sub-features during brainstorming (receipt download, and continuous
live-tracking). This spec covers **receipts only** — the smaller,
self-contained half.

## Goal

A motorist can click a completed, fully-paid request in their Requests tab
and see a receipt: service/vehicle type, destination, operator, dates,
deposit/balance amounts, total, and payment status — with a way to print
it (browser print-to-PDF covers "download").

## Non-goals

- Live/continuous operator tracking — separate spec, not covered here.
- A generated PDF file or new file-download endpoint — the browser's own
  print dialog (`window.print()`) covers the "download a copy" need
  without a PDF library or backend streaming endpoint.
- A new nav entry or dedicated "Receipts" page — this lives inside the
  existing Requests tab, one click per already-visible row.
- Receipts for anything other than `COMPLETED` + fully-paid requests — an
  in-progress or partially-paid request gets no click action, exactly as
  today.

## Backend changes (`lrr-service`)

### `detailForUser` (`rescue-request.service.ts`)

The `CUSTOMER` branch currently reads:

```typescript
throw new UnauthorizedException('Customers do not have access to rescue request details');
```

This becomes an ownership-scoped access branch, mirroring the existing
`OPERATOR` branch's pattern (which checks the caller belongs to the
assigned operator before returning data):

```typescript
if (role === 'CUSTOMER') {
  if (raw.customerId !== userId) {
    throw new UnauthorizedException('You do not have access to this rescue request');
  }
  return { data: this.mapToDetailDto(raw) };
}
```

This reuses the exact `RescueRequestDetailDto` shape already built for the
admin quote-compliance view (`vehicleType`, `destination`, `mediaLinks`,
`depositAmount`, `balanceAmount`, etc.) — no DTO changes needed.
`mapToDetailDto(raw)` called with no second argument means `offers` stays
`undefined` for this role, identical to how `OPERATOR` already works — a
customer must never see operator quote data, and this requires no new
code to enforce since the existing gating already defaults that way.

This is a real capability upgrade beyond receipts specifically: it's the
first time customers get any detail-view access to their own requests at
all. No other consumer of `detailForUser` is affected — this only adds a
previously-impossible case (`CUSTOMER` used to always fail), which cannot
break the `ADMIN`/`OPERATOR` branches above it.

## Frontend changes (`lrr-web`)

### `app/components/customer/RequestsTab.tsx`

- Determine per-row whether a receipt is available:
  `r.status === "COMPLETED" && r.depositPaid && r.balancePaid`. Rows where
  this is false render exactly as they do today — no visual change, no
  click handler.
- Eligible rows get a click handler that fetches fresh detail (`fetchDetail`,
  the same hook method the admin modal now uses, already fixed to unwrap
  `.data` correctly) and opens a receipt modal.
- **The list table's "Service" column (currently `r.issueType`) is dropped
  entirely** — UI-only change, no backend involved. The table becomes
  Operator / Date / Status (+ the "Receipt →" hint on eligible rows). The
  list endpoint already doesn't need to change for this — it's purely
  removing a column from the render, not adding a replacement field.
- **Visual design (approved via the visual-companion mockup session,
  2026-08-10):** a classic paper-receipt style, not a plain data grid —
  letterhead with the real LRR logo (`public/lrr-logo.png`), dashed
  section dividers, monospace-flavored itemization, and a bold "TOTAL"
  line with a rule above it. Layout, top to bottom:
  1. Centered letterhead: LRR logo, "Receipt · #\<id-prefix\>" in muted
     text, dashed border below.
  2. Detail rows (label left, value right, muted label color): Service
     (`vehicleType` — no `issueType` fallback, per the column removal
     above), Destination, Operator, Date.
  3. Dashed divider, then itemized Deposit / Balance rows, then a bold
     TOTAL row (deposit + balance) with a solid rule above it.
  4. A green "✓ PAID IN FULL" banner below the total.
  5. Print / Close buttons.
- A "Print" button calls `window.print()`. A `@media print` CSS rule
  (scoped via a wrapper class on the modal content) hides the portal
  chrome/nav and the modal's backdrop, so only the receipt card prints.

## Testing

- Backend: unit test on `detailForUser` confirming a `CUSTOMER` whose
  `userId` matches `raw.customerId` gets data back, and a `CUSTOMER` whose
  `userId` does NOT match gets `UnauthorizedException` — mirrors the
  existing `OPERATOR` ownership test pattern from the admin
  quote-compliance work.
- Frontend: manual verification (no dedicated test infra for modal
  components in this codebase today, consistent with existing tabs).

## Rollout

No migration, no new env vars, no new endpoint — purely an authorization
relaxation on an existing endpoint plus a frontend modal, both additive.
