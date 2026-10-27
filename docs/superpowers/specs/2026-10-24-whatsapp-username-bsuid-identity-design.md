# WhatsApp Username / BSUID Identity Handling — Design

**Spec status:** drafted from a brainstorming conversation on 2026-10-24,
covering live test evidence against the production WhatsApp number.

## Intent and why

WhatsApp is rolling out optional usernames (Meta/Twilio formalized this as
of a Feb 2026 Twilio changelog, "starting June 2026"). Once a WhatsApp user
sets a username, Twilio stops delivering their real phone number in the
`From` field of inbound webhooks and instead sends a **BSUID**
(Business-Scoped User ID, format `whatsapp:CC.<alphanumeric>`, e.g.
`CA.1234567890123456`) — an opaque identifier scoped to LRR's own WhatsApp
Business Account, not a dialable number.

This is not hypothetical: it was confirmed live on 2026-10-24 against
LRR's production WhatsApp number. A test customer with a Canadian number
and a WhatsApp username set sent an SOS; it was accepted, intake proceeded
normally, and the resulting request (`#PZ6VYM`) shows `CA.1234567890123456`
in the admin portal's "Customer" column — a BSUID stored verbatim as if it
were a phone number. A second test number without a username set still
delivered a real number (`+15550100003`) as expected.

**`User.phoneNumber` / `Operator.phoneNumber` is the identity key almost
everywhere in this codebase** — OTP routing, dispatch offers, dispute
alerts, admin search, Paystack customer identity, reply delivery, display
formatting all assume it is a real MSISDN.
`WhatsAppInboundService.handleIncomingWhatsAppMessage` currently does
`body.From.replace(/^whatsapp:/i, '')` with no validation and uses the
result directly as `phoneNumber`, so a BSUID corrupts that assumption the
instant it's stored.

Two distinct, different-severity failures follow from this, both already
reachable today for any non-NG WhatsApp sender (Nigerian numbers have not
had usernames rolled out to them yet, confirmed by direct testing on
2026-10-24 — this buys real runway, but no advance warning when it ends):

1. **Operators** (more severe): the inbound router's operator lookup is an
   exact match — `prisma.operator.findUnique({ where: { phoneNumber } })`.
   If an *already-registered* operator's WhatsApp account later gets a
   username, their replies (e.g. `ARRIVED`, `DONE`) arrive as a BSUID,
   the lookup silently misses, and the router falls through to the
   *customer* flow instead. Their actual in-progress job goes silently
   stuck — no exception, no Sentry entry, nothing to alert on. It looks
   like the operator just went quiet.
2. **Customers**: a fresh SOS from a BSUID-only sender creates a real
   `User`/`RescueRequest` keyed on the BSUID string as `phoneNumber`,
   breaking every later assumption that it's a real number (payments,
   receipts, admin search, any future phone call).

## Goals

- Never write a BSUID into the `phoneNumber` column, for either role.
- An already-registered operator whose inbound message arrives masked
  must still be recognized and routed to the operator flow, continuing
  whatever job/session they were already in — not silently misrouted.
- A customer whose WhatsApp account has no visible phone number must
  still be able to start and carry an SOS all the way through intake
  with **no added friction** at the point they're describing an
  emergency — that's the worst possible moment to introduce a blocking
  step.
- By the time LRR needs a real, verified phone number (deposit payment,
  linking the request to a customer portal account, any future outbound
  call), the system has one.
- A returning WhatsApp sender — recognized by BSUID or by phone number,
  whichever we're given — resolves back to the same account they used
  before, not a duplicate.

## Non-goals / anti-goals

- **Not fixing the current WhatsApp Business registration/verification
  issue blocking some outbound sends.** That's an account-administration
  matter with Meta/Twilio support, not a code change, and is explicitly
  out of scope here.
- **Not using the BSUID as the `User.id` primary key.** Considered and
  rejected during brainstorming: Meta regenerates a user's BSUID if they
  ever change their underlying phone number, and every table referencing
  `User.id` (`RescueRequest`, `Rating`, `WhatsAppSession`,
  `OperatorMember`) would need to follow a primary-key change — a far
  riskier operation than a new indexed column. The same one-step lookup
  convenience ("find by BSUID or phone number") is available from a
  separate column without that risk.
- **Not building a general-purpose multi-identity system for every
  role.** This is scoped specifically to how `WhatsAppInboundService`
  resolves a sender. Admin/Staff/Product login is untouched.
- **Not configuring Meta's Contact Book feature itself** (the automatic,
  free mechanism that keeps surfacing a known contact's real phone number
  in webhooks even after they set a username, once LRR has seen it once).
  That's a Meta Business Suite setting to confirm is enabled, not code —
  called out as a recommended parallel action, not part of this plan.
- **Not asking for a typed phone number with a round-tripped OTP code.**
  Corrected 2026-10-24: earlier drafts of this document assumed Twilio
  didn't support Meta's native "request contact info" consent button and
  reached for a typed-number-plus-OTP fallback instead. That assumption
  was wrong — see "Decided design" below. A tapped consent response is
  Meta's own account data, the same trust tier as a normal `From` field,
  so there is nothing left to verify with a code, and no BSP migration is
  needed to get it.

## Constraints

- BSP is Twilio, not Meta's Cloud API directly. Twilio's `ExternalUserId`
  field carries the BSUID on **every** WhatsApp webhook, whether or not
  the sender has a visible phone number — this is the reliable field to
  read, not `From` (which sometimes holds a BSUID and sometimes a real
  number depending on sender state).
- `User.phoneNumber` is already `String? @unique` — nullable today, no
  migration needed to allow a customer to exist without one.
- Operators are always created via the lrr-web registration form with an
  OTP-verified real phone number first — the BSUID problem for operators
  is purely about *recognizing* an existing operator's later messages,
  never about their registration.
- Customers have no equivalent web registration step — WhatsApp is their
  only channel, so for a first-ever BSUID-only contact, LRR genuinely has
  nothing else about them until they're asked directly.
- NG numbers are unaffected today (confirmed 2026-10-24). This buys time
  to build this properly but gives no advance signal for when NG rollout
  starts.

## Decided design

**Schema:** add one new column —
`User.whatsappExternalUserId String? @unique` — the BSUID (Twilio's
`ExternalUserId`, with the leading `whatsapp:` prefix stripped the same
way `phoneNumber` already strips it; the `CC.` segment stays as part of
the value, since it's part of what Meta guarantees unique).

**A single parsing choice point:** one small utility function decides,
from the raw `From` value, whether it is a real phone number or a BSUID
(format `CC.<alphanumeric>`, no leading `+`). This is the one place that
makes that call — nothing downstream re-implements the distinction.

**Passive BSUID capture applies to both roles, not just operators.**
Every inbound webhook already carries `ExternalUserId`, phone-masked or
not. Opportunistically record it against the sender's `User` row on
*every* message where we can already identify them by their real
`phoneNumber` — operator or customer alike. This is what makes the Goals
section's "a returning WhatsApp sender... resolves back to the same
account, not a duplicate" actually true for customers too: without this,
a long-standing customer whose account later goes BSUID-only for the
first time would get a brand-new blank account instead of being
recognized. It's cheap (the value is handed to us on every webhook
regardless) and privacy-neutral, so there's no reason to withhold it from
either role.

**Operator-side routing** (`WhatsAppInboundService`):
- Benefits from the passive capture above, so LRR starts building the
  BSUID↔operator link now, well before NG rollout ever begins.
- When `From` resolves to a phone number and matches a known
  `Operator.phoneNumber`: unchanged, today's behavior.
- When `From` resolves to a BSUID: look up by
  `whatsappExternalUserId` first. If it resolves to a `User` with an
  active `OperatorMember`, route to the operator flow using their
  existing, undisturbed session — their job was never touched under a
  wrong identity, so nothing needs to be "recovered," just correctly
  found.
- If the BSUID matches nothing (first-ever masked message from this
  sender, no prior link captured): do **not** fall through to the
  customer flow. Reply with a clear, actionable message and alert staff
  (same phone-alert pattern `alertStaffManualFallback` already uses) so a
  human can intervene on what's likely a stuck job.
  - **Resolved recovery path (2026-10-24)**: the staff alert is the
    passive half, not the main mechanism — by construction, the system
    has no way to know *which* operator or job this is at that moment, so
    a vague "something's stuck" alert alone isn't a real fix. The reply
    sent directly to the operator ("call LRR support") is what actually
    matters, since the operator — unlike staff — knows exactly which job
    and business this is. The expected path is: operator calls in → staff
    look them up by their real, on-file phone number → staff need a way
    to manually move that job forward.
    - **No new admin tooling needed, one small guard change instead.**
      The manual-arrived/manual-done actions already built for
      non-WhatsApp operators (`claimManualArrived` in
      `rescue-request-admin.service.ts`) already do exactly this kind of
      staff-driven status override — but their claim is currently gated
      on `assignedOperator: { whatsappEnabled: false }`, which excludes
      this operator (their `whatsappEnabled` is still `true`; only their
      *current* message is unreachable). That condition needs a
      deliberate, narrow widening to also permit a staff-confirmed
      transition when the operator's WhatsApp identity can't be matched
      right now — a human staff action is inherently verified either
      way, regardless of *why* the normal WhatsApp channel broke down for
      this one job.
    - Dedicated tooling (a standalone "unrecognized WhatsApp sender"
      admin view) is explicitly **not** needed given the above, and this
      path is expected to get rare over time anyway — once an operator
      has sent even one unmasked message after this ships, passive
      capture links them and this failure mode never triggers for them
      again.

**Customer-side routing:**
- `From` resolves to a phone number: unchanged, today's behavior.
- `From` resolves to a BSUID: look up by `whatsappExternalUserId` first
  (returning sender). If not found, find-or-create a `User` keyed on
  `whatsappExternalUserId` with `phoneNumber: null`, and let SOS intake
  proceed exactly as normal — no extra question, no blocking step.
- **Deferred phone-number resolution, via `REQUEST_CONTACT_INFO`**: the
  first point in the flow that already naturally asks for
  contact-adjacent information is the deposit payment step. If
  `customer.phoneNumber` is still null when a request reaches that point,
  send a `twilio/call-to-action` template with a `REQUEST_CONTACT_INFO`
  action — a native WhatsApp button, not typed text. The customer taps
  it, WhatsApp shares their real number directly (the same trust tier as
  a normal `From` field — this is Meta's own account data, not a
  user-typed claim), and `User.phoneNumber` is backfilled from that
  response before checkout completes. No OTP, no typing, no typo risk by
  construction.
  - Send alongside it (or as the template's own body, per whatever
    Twilio's template-authoring constraints allow — left to the plan) a
    short explanation of *why*, so it doesn't feel arbitrary: *"We're on
    WhatsApp with you, but your account has a username set, so WhatsApp
    isn't sharing your phone number with us automatically — that's a
    WhatsApp privacy setting, not something we're choosing. Tap below to
    share it, so you can find this request if you sign up on the LRR
    portal later."*
  - **Known gap, must be verified early in implementation, not assumed**:
    Twilio documents how to *send* a `REQUEST_CONTACT_INFO` button, but
    not what the inbound webhook looks like when a customer taps it and
    shares their number — no field names, no example payload found in
    Twilio's docs as of 2026-10-24. The plan must include an early,
    real test (send the button to a real test number, tap it, inspect
    the raw webhook in Twilio Console) before any code assumes a
    response shape.
  - **Fallback if the button goes untapped or the customer's WhatsApp
    client doesn't support it**: not specified here — left to the plan,
    but should degrade to *something* rather than leaving the request
    stuck forever (e.g. a timeout that re-sends the button, or escalates
    to staff).
  - **Collision with an existing account**: `User.phoneNumber` is
    `@unique`, and the shared number could already belong to a different
    `User` row — most plausibly the *same* real customer's older account,
    since a BSUID isn't permanent (Meta regenerates it on various account
    changes), so the same phone number staying put while the BSUID
    changes between visits is plausibly the common case. The BSUID-only
    `User` row this session just created has no history of its own yet
    (this is its first request) — there's nothing real to merge, so
    **attach this request to the existing account** (point this
    request's `customerId` at it) rather than blocking with a "contact
    support" wall. This is now even safer than earlier drafts of this
    document assumed: a `REQUEST_CONTACT_INFO` response is stronger proof
    of ownership than a typed-and-OTP'd number ever was, since it comes
    straight from the WhatsApp account itself.
- **0%-deposit requests** have no payment checkpoint to hang this on —
  ask the same question once the request reaches an operator-assigned,
  genuinely-confirmed state instead (not at idle/inquiry time).
- If a BSUID-identified customer's `From` ever *does* later carry a real
  phone number again (Contact Book recognizing them, or NG rollout never
  affecting them in the first place), prefer and store it — don't treat
  someone as permanently BSUID-only once seen that way.

**Outbound sends during the pre-payment phase** (while `phoneNumber` is
still null) need to target the BSUID (`whatsapp:CC.BSUID`) as the
destination address instead of a phone-based one. **Confirmed, not just
assumed**: Twilio's own WhatsApp usernames/BSUID changelog documents this
exact addressing form with a worked example —
`to: whatsapp:BR.1A2B...`, `from: whatsapp:+1800555XXXX` — for a business
sending to a username-only user. The protocol-level support is real.

What's **not** yet true is that this codebase's own phone-formatting
helpers tolerate it: `normalizePhone` hard-rejects anything that isn't a
10-digit NG number, and `toWhatsAppAddress`/`sendWhatsAppMessage` are
called from roughly 15 sites assuming a real E.164 number throughout.
This is not a design risk requiring a fallback architecture — it's a
concrete implementation requirement: every destination-building call in
the pre-payment customer path needs to branch on what kind of identifier
it's holding (BSUID → send `whatsapp:<bsuid>` as-is, untouched by
`normalizePhone`; phone number → today's existing pipeline, unchanged).
The plan should enumerate those ~15 call sites and confirm each one is
reachable in the pre-payment, BSUID-only window or not — only the ones
that are need the branch.

**Display:** anywhere `phoneNumber` is rendered for a human (admin
Requests list, receipts, any formatter like
`toNigerianDisplayPhoneNumber`) must handle a null `phoneNumber` with
clear copy (e.g. "No phone on file yet") rather than attempting to format
`null`, or — as seen in the live test — silently rendering a raw BSUID
string as if it were a phone number.

## What's left to the plan-writer

- The exact BSUID-vs-phone-number detection regex/utility, and its tests
  against real example values from this design doc and Twilio's
  documentation.
- Whether `OperatorMembershipService` or any other operator-lookup path
  besides the inbound router's own `prisma.operator.findUnique` call
  needs the same phone-or-BSUID-aware resolution.
- The exact wording/flow for the deferred phone-number question at
  checkout, and for the 0%-deposit fallback trigger point.
- Verifying (not assuming) that Twilio's outbound send accepts a BSUID
  destination address from this codebase's existing Twilio integration
  layer, with a real test against it before relying on it.
- Whether/how to backfill the one bad row already created by the live
  test (`CA.1234567890123456` on request `#PZ6VYM`) — left as a decision
  for whoever executes the plan, not specified here since it's test data,
  not a real customer.
- A recommendation (not a requirement of this plan) to confirm Meta's
  Contact Book feature is enabled in Business Suite settings for LRR's
  WABA, since it reduces how often the deferred-ask path is ever reached
  at all, for free.
