# Truck-Class ↔ Vehicle-Type Hard Matching — Design

Status: Approved (pending final review)
Date: 2026-08-07

## Background

Field research surfaced two gaps in the current SOS → dispatch flow:

1. Operators are broadcast SOS requests regardless of whether their truck can
   physically carry the stranded vehicle (e.g. a Light-Duty operator being
   offered a job that needs a Low-Bed/Hiab). Operators still set their own
   price — this is purely a "who gets offered the job" problem, not a
   pricing problem.
2. The motorist's destination (where they want the car towed to) is never
   captured, even though the original data model called for it.

This spec covers both. Media (photo/video/audio) capture and forwarding to
operators is explicitly out of scope — it is a separate, later spec ("spec
B") because it is a bigger, independently shippable pipeline (Twilio media
fetch → storage → forwarding) with no dependency on this work.

## Goal

Stop broadcasting SOS requests to operators whose trucks can't carry the
stranded vehicle, and capture the motorist's destination.

## Non-goals

- Media (photo/video/audio) capture or forwarding — deferred to spec B.
- Any change to pricing/quoting — operators keep pricing their own jobs.
- Changing dispatch batch size (stays at 3 operators per round).
- Building out multi-service-type dispatch (mechanic, fuel delivery,
  jumpstart-by-individual) — the pilot is tow-only. The design should not
  make that harder to add later, but nothing new is built for it now.
- Re-adding the issue-type question to the WhatsApp flow. The column stays
  in the schema (other code reads it) but the flow stops asking for it.

## Data model changes (`prisma/schema.prisma`)

- New enum `TruckClass`: `LIGHT_DUTY`, `TEN_TYRE`, `LOW_BED`, `HIAB`.
- New enum `VehicleType`: `SEDAN`, `SUV`, `ARMORED_LUXURY`, `HEAVY_TRAILER`.
- `Operator.truckClasses TruckClass[]` — an operator's fleet capability,
  captured at signup/onboarding. Defaults to an empty array on migration.
- `RescueRequest.vehicleType VehicleType?` — captured during the WhatsApp SOS
  flow.
- `RescueRequest.destination String?` — free-text address captured during
  the WhatsApp SOS flow.
- `RescueRequest.issueType` stays as-is (existing column, existing readers)
  but no new requests populate it once the flow change ships.

A static, code-level lookup (not a DB table) maps `VehicleType` to the
`TruckClass[]` eligible to carry it, e.g.:

```
SEDAN, SUV        -> LIGHT_DUTY, TEN_TYRE
ARMORED_LUXURY     -> LOW_BED, HIAB
HEAVY_TRAILER      -> LOW_BED, HIAB
```

(Exact mapping to be finalized with LRR Ops field knowledge — the table
above is the starting default.)

## WhatsApp flow changes

Old flow: `Location → Issue Type → (dispatch/deposit)`

New flow: `Location → Vehicle Type → Destination → (dispatch/deposit)`

- `WAITING_FOR_ISSUE_TYPE` state is removed from the active flow path (code
  is not deleted outright, since `issueType` is still read elsewhere — it
  simply isn't reachable from the new flow, and can be revived when
  multi-service-type dispatch is built).
- New `WAITING_FOR_VEHICLE_TYPE` state: numbered-reply prompt, same UX
  pattern as the current issue-type prompt, listing the four `VehicleType`
  options.
- New `WAITING_FOR_DESTINATION` state: free-text prompt ("Where would you
  like the car towed to?"), stored verbatim as `RescueRequest.destination`.

## Dispatch/matching changes (`operator.service.ts`, `rescue-request.service.ts`)

- `startDispatch` resolves `vehicleType → eligible TruckClass[]` via the
  static lookup, then calls `findAndRankCandidates(..., type)` — the hard
  Prisma `where: { truckClasses: { hasSome: eligibleClasses } }` filter
  mechanism already exists in `OperatorService` (currently unused by any
  caller); this wires it in.
- No-match behavior: unchanged existing radius-expansion retry loop, with
  the truck-class filter remaining hard through every round. After the
  existing 2-failed-rounds threshold, the existing admin-alert path fires —
  no new alerting mechanism.
- `destination` is included in the text of the dispatch offer message sent
  to the matched operator (alongside pickup location), but is **not** used
  in matching logic.

## Operator portal changes

- Registration/profile form gains a required multi-select "fleet / truck
  classes" field, backed by the new `TruckClass` enum.

## Rollout / migration

- Migration adds `Operator.truckClasses` defaulting to `[]`. No
  auto-defaulting to a guessed class.
- Operators with an empty `truckClasses` array will never match any
  vehicle type and so drop out of dispatch rotation until LRR Ops backfills
  their fleet via the portal. This is a known, accepted gap at rollout —
  the operator list is small enough to backfill manually before/at launch.

## Forward-compatibility notes (not built now)

- `OperatorType` and the matching code stay generic enough that adding a
  `JUMPSTART` service type, reviving `issueType`-based routing for
  mechanic/fuel-delivery jobs, and onboarding individual (non-business)
  providers later should be additive changes, not rewrites. No schema hooks
  are added for this today (YAGNI).
