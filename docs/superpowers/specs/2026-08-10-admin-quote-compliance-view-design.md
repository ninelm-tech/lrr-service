# Admin Quote-Compliance View — Design

## Background

The PRD (USER-10) describes an LRR Ops Admin need: *"review incoming tow
operator quotes alongside the motorist's incident media and location, so
that I can ensure price compliance against field benchmarks without having
to manually calculate or set the fare myself."*

Today, admin has no visibility into a request's quotes at all. The admin
detail modal in `lrr-web` (`RescueRequestsTabAdmin.tsx`) shows status,
customer, and timestamps, but the `RescueRequestDetailDto` it's built from
predates both the truck-class-matching and operator-quotes features — it
still carries the old `issueType` field and has no `vehicleType`,
`destination`, `media`, or offer/quote data at all. `DispatchOffer` rows
(added by the operator-quotes plan) are never surfaced to admin anywhere.

## Goal

Let admin open a request's existing detail modal and see every dispatch
offer for it — operator, status, raw quoted price, motorist-facing total,
and timing — alongside the vehicle type, destination, and media links the
motorist submitted. Purely a monitoring view: admin observes, doesn't act
on individual quotes.

## Non-goals

- No new admin actions on individual quotes (no flagging, no manual
  override-selection). The existing assign-operator action in the same
  modal already covers manual dispatch intervention if ever needed.
- No new page or navigation entry — this extends the existing per-request
  detail modal in `RescueRequestsTabAdmin.tsx`.
- No cross-request/global quotes view (e.g. "all quotes this week") — this
  is scoped to one request's detail view. Reporting/analytics across
  requests is a separate, larger effort (ties to the PRD's "Pricing
  Intelligence Goal", explicitly out of scope here).
- Operators and customers never see this data — `offers` is admin-only in
  the response; an operator must not see a competitor's price.

## Data model changes

None. `DispatchOffer` and `RescueRequest.media` already exist; this is
purely a read path change (DTO + query), no schema migration.

## Backend changes (`lrr-service`)

### `RescueRequestDetailDto` (`src/rescue-request/dto/rescue-request-response.dto.ts`)

Add:

```typescript
export class DispatchOfferAdminDto {
  operatorId: string;
  businessName: string;
  status: DispatchOfferStatus;
  quotedPrice?: number;           // raw operator quote, kobo — null until QUOTED
  motoristFacingTotal?: number;   // quotedPrice + service-fee markup, kobo — null until QUOTED
  offeredAt: Date;
  respondedAt?: Date;
}
```

Extend `RescueRequestDetailDto` with:

```typescript
  vehicleType?: VehicleType;
  destination?: string;
  mediaLinks: string[];
  offers?: DispatchOfferAdminDto[];  // present only for ADMIN/SUPER_ADMIN
```

### `detailForUser` (`rescue-request.service.ts`)

- Extend the Prisma query's `include` with `dispatchOffers: { include: {
  operator: { select: { id: true, businessName: true } } } }` and `media:
  { select: { id: true } }`.
- `mapToDetailDto` computes `mediaLinks` the same way `sendQuoteShortlist`
  already does (`${API_BASE_URL}/api/v1/media/${m.id}`), and
  `motoristFacingTotal` the same way the shortlist does
  (`quotedPrice + round(quotedPrice * serviceFeePercent / 100)`) — reusing
  `PlatformConfigService.getConfig()`, already available via the
  constructor.
- The `offers` array is built and attached **only** when `role` is
  `ADMIN`/`SUPER_ADMIN` (mirrors the existing role branch already in
  `detailForUser`); operator and customer response paths get
  `vehicleType`/`destination`/`mediaLinks` but never `offers`.
- Sort `offers` by `offeredAt` ascending, so admin sees them in the order
  they went out.

## Frontend changes (`lrr-web`)

### `RescueRequestsTabAdmin.tsx`

- `openModal(req)` currently just sets `selectedRequest` to the list item
  already in memory. Change it to also fetch fresh detail —
  `GET /rescue-requests/:id` via the existing `useRescueRequestApi` hook —
  and merge the result into `selectedRequest` (or hold it as a second piece
  of state, `selectedRequestDetail`). Show a lightweight loading state in
  the modal while that fetch resolves; the modal's existing fields (status,
  customer, actions) render immediately from the list item as they do
  today, so this only delays the new section.
- Add a "Quotes" section to the modal body: one row per offer — operator
  business name, a status badge (reuse the existing status-badge color
  pattern already used for the request's own status), raw quote (₦, or
  "—" if not yet quoted), motorist-facing total, offered/responded
  timestamps.
- Add vehicle type and destination to the existing details list (next to
  the current "Issue"/"Customer"/"Created" rows); render media links the
  same way `PendingOffers.tsx` already does (numbered "Photo N" links).

## Testing

- Backend: unit test on `mapToDetailDto` (or `detailForUser`) confirming
  `offers` is present for ADMIN/SUPER_ADMIN and absent for OPERATOR and
  CUSTOMER roles, and that `motoristFacingTotal` matches the same formula
  used in `sendQuoteShortlist`.
- Frontend: manual verification (no dedicated test infra for modal
  components in this codebase today, consistent with existing tabs).

## Rollout

No migration, no new env vars, no feature flag needed — purely additive to
an existing authenticated admin-only response path.
