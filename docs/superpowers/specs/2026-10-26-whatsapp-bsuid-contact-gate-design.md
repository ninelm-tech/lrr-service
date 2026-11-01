# WhatsApp BSUID contact-info gate (revised Tasks 11/12/13/16)

**Supersedes**, for the sections named below only, parts of
`docs/superpowers/plans/2026-10-24-whatsapp-username-bsuid-identity.md` and
its matching spec. Tasks 1–10 of that plan are shipped (commit `0f482fc`,
2026-10-25) and unaffected — this document only revises **Task 11**
(gate checkout on a real phone number), **Task 12** (stale-request
reconciler), **Task 13** (0%-deposit fallback ask), and **Task 16**
(end-to-end integration test). The original plan is left in place as the
historical record of what was first decided and reviewed; it is not
deleted.

## Why this revision exists

The original Task 11 placed the `REQUEST_CONTACT_INFO` gate immediately
before the Paystack customer-creation call inside `handleQuoteSelected` —
i.e. *after* operator assignment, right before payment. That placement was
itself a correction of an even earlier draft that gated before dispatch
entirely (rejected in multi-LLM review for skipping operator assignment).

This session re-opened that same question, with the benefit of two new
facts the original plan didn't have:

1. **A live spike already proved the real webhook shape** (not guessed):
   tapping "Share Contact" arrives as `MessageType: "contacts"`, with the
   phone number inside a vCard at `MediaUrl0`, tied back to our template by
   `ChannelMetadata.data.context.Origin === "contact_request"`. Masking
   itself was confirmed reproducible on Stage, decided once at first
   contact based on whether a username was already set at that moment.
2. **The late-placement crash already happened for real**, not
   hypothetically: `LRR-SERVICE-10`, a `TypeError` in
   `paystack-customer.service.ts:33` when a masked customer with no
   email and no phone reaches `customerFor()`. Reproducing it showed the
   practical cost of the late gate: the request was already committed to
   `WAITING_FOR_DEPOSIT` before the crash, leaving the customer stuck
   getting "continue or it will be cancelled" reconciler nags against a
   payment that could never be created.

Given that, the user explicitly re-decided the placement question (see
Decision below) after being shown the trade-off the original review had
already surfaced for the symmetric Task 13 case (ask early vs. ask late),
rather than carrying the old placement forward by default.

## Decision: gate placement

**The contact-info ask fires right after the photo/media step, before
dispatch — not after operator assignment.** Concretely (corrected after
review — the first draft of this doc described this transition wrongly):
the `WAITING_FOR_MEDIA` step's "continue to dispatch" branch
(`message === '2'`, `whatsapp-customer-flow.service.ts:595-612`) calls
`handleMediaFinished` directly today, which sets `RescueRequestStatus.DISPATCHING`
and session state `REQUEST_CONFIRMED` — `WAITING_FOR_QUOTE_SELECTION` is a
separate, *later* state, reached only once a quote shortlist arrives; it
is not part of this transition at all. The new check goes in front of that
`handleMediaFinished` call: if the customer has no `phoneNumber` on file,
send `REQUEST_CONTACT_INFO` and hold in a new `WAITING_FOR_CONTACT_INFO`
state instead of calling it. If they already have a phone number, nothing
changes — zero behavior difference for any non-masked customer.

This was a real trade-off, not a clear win either way, and was decided
with both costs visible:

- **Chosen (early):** no operator time is ever spent waiting on a
  customer who ghosts the contact prompt. Cost: every BSUID-only customer
  gets this step, including ones whose job would have auto-cancelled for
  lack of an operator anyway (seen live this session — `LRR-SERVICE-5`,
  "Auto-cancelled: no operator after 4 rounds" — and would never have
  needed a phone number at all).
- **Rejected (late, original plan):** no added step for jobs that fail to
  dispatch. Cost: an assigned operator could sit on an unreachable
  customer, which is exactly why the original plan needed Task 12's
  reconciler-and-escalate mechanism as a backstop.

**Consequence for scope, not separately decided — follow directly from the
placement choice:**

- **Task 13 (0%-deposit fallback ask) is now unnecessary and dropped.**
  It existed only because the original late gate never fired for a
  0%-deposit job (no Paystack call happens for one). The new gate fires
  for *every* BSUID-only customer before dispatch, regardless of what the
  deposit percentage later turns out to be — there's no separate case
  left for Task 13 to cover.
- **A separate, unrelated bug (review finding [HIGH #3]) is explicitly
  out of scope too: `handleMediaFinished` has no idempotency guard** — it
  unconditionally sets `DISPATCHING` and sends the "Searching..."
  message plus staff alerts, with no conditional-update check against
  current status. A concurrent duplicate webhook delivery (Twilio's
  documented at-least-once redelivery) could double-trigger it. Verified
  this is pre-existing, not introduced by this revision: the current
  `message === '2'` path already calls the same unguarded function
  today, under the same risk, for the same reason — this task's new
  `WAITING_FOR_CONTACT_INFO` handler just calls into the same existing
  gap from a second call site. Flagged as a separate, standalone cleanup
  (same "flag, don't fix" treatment as `LRR-SERVICE-10` below), not
  something this task introduces or is responsible for closing.
- **Task 12 (stale-request reconciler) is dropped, not revised.** Its
  entire reason to exist was an operator sitting idle on an unanswered
  contact request. Under the new placement, nobody is ever dispatched
  before the gate clears, so an unanswered prompt just leaves the customer
  mid-intake — the same unescalated, un-special-cased state as someone who
  abandons at the location or photo step today (confirmed: no existing
  step has stale-session escalation; this introduces no new gap relative
  to the rest of intake).
- **`LRR-SERVICE-10` and the `PaymentVerifyCheck` escalation gap (flagged
  in prior multi-LLM review) are not touched by this task.** Both become
  structurally unreachable — not just unlikely — once this gate exists,
  because no BSUID-only customer can reach `handleQuoteSelected` without
  a phone number already on file. The one existing crashed test record on
  Stage (Habeebat's) is disposable; nothing is in production yet.
- **`completeDepositForRequest` extraction (original Task 11's main
  interface) is unnecessary.** The original design needed it because
  `handleQuoteSelected` partially committed state before the gate could
  run, requiring a resumable tail. Here, the gate clears *before*
  `handleQuoteSelected` is ever reached — once a phone number is on file,
  the rest of the existing pipeline (dispatch, quote selection, payment)
  runs completely unchanged, exactly as it already does for a non-masked
  customer. This is the main reason the new placement is narrower, not
  just different: it touches one boundary (the media-step transition) and
  adds one new state, instead of modifying payment-path internals.

## Goals

- A BSUID-only customer (no `User.phoneNumber`) who finishes the photo
  step is asked, via WhatsApp's native "Share Contact," for their real
  phone number — framed as the next ordinary intake step, not a side
  request.
- The real phone number is parsed out of the vCard Twilio delivers
  (`MediaUrl0`, Twilio Basic Auth GET) and written to `User.phoneNumber`.
- **Revised after plan-stage review:** email/address are no longer
  captured at all, opportunistically or otherwise. This gate's only job
  is the phone number. (The original "capture opportunistically" goal
  turned out to need a `User.address` column that doesn't exist, and a
  "best-effort" email write that doesn't actually work the way a first
  draft of the plan assumed — a unique-email conflict inside a Postgres
  transaction aborts the whole transaction regardless of try/catch. Not
  worth the complexity for a field nothing in this flow consumes.)
- Off-script replies at this step re-prompt in place (re-sending
  `REQUEST_CONTACT_INFO`), matching the existing pattern every other
  intake step already uses (location, vehicle type, issue type, media) —
  no new UX idiom introduced. **There is no fallback path for a customer
  who can't or won't use Share Contact** (old client, refusal, or a
  template-send failure) — same handling as every other blocking step in
  this flow already has for an undeliverable requirement: keep
  re-prompting, and the customer can reply `CANCEL` if they're unable or
  unwilling to continue. This was a deliberate choice, not an oversight:
  a typed-phone-number fallback was considered and rejected, since a
  typed number carries even less proof of ownership than a shared
  contact card and reopens the same trust question as the collision
  handling below.
- **Identity-collision handling (review finding [HIGH #2], confirmed and
  bigger than the original plan's Review Focus bullet described):**
  `User.phoneNumber` and `Operator.phoneNumber` are both `@unique` but on
  separate tables (verified in schema) — nothing at the DB level stops a
  shared vCard's phone number from colliding with either one, and the
  two collision cases get different handling:
  - **Collides with a registered `Operator.phoneNumber`:** the share is
    treated as invalid input, not backfilled — re-prompt the same as any
    other off-script reply. (Writing it would make this customer's own
    future messages misroute into the operator flow via the router's
    `Operator.phoneNumber` lookup, `whatsapp-inbound.service.ts:90-93`.)
  - **Collides with an existing `User.phoneNumber` that already has its
    own, different `whatsappExternalUserId`:** this is the real
    account-merge case the original plan's Review Focus flagged ("must
    attach the request to that account and transfer the BSUID link
    itself"). Do not build new merge logic for this from scratch — the
    shipped Tasks 1–10 work already went through multi-LLM review for a
    related identity-conflict gap in `findOrCreateBySender`; the plan
    stage must confirm exactly what that fix does today and whether this
    gate's backfill can call it directly, before deciding whether any
    new code is needed here at all.
  - Twilio's documented at-least-once delivery means the whole
    contact-info step — collision handling and whatever follows it
    (see the `handleMediaFinished` idempotency note above) — must
    tolerate the same webhook arriving twice without double-running
    either.
- **`RescueRequestStatus` stays `WAITING_FOR_MEDIA` for the entire time
  the session sits in the new `WAITING_FOR_CONTACT_INFO` state** (review
  finding [MED #4], confirmed) — only the session-level `WhatsAppFlowState`
  changes, not the request-level status. This is a deliberate no-op, not
  an omission: the duplicate-SOS auto-cancel check
  (`whatsapp-customer-flow.service.ts:335-337`) is hardcoded to
  `WAITING_FOR_MEDIA`, so leaving the request status there means a
  customer who abandons the contact-info prompt and sends a fresh SOS
  gets the existing stale-request auto-cancel behavior for free, with no
  new code.
- A customer who already has a phone number on file sees no behavior
  change whatsoever.

## Non-goals

- Fixing `LRR-SERVICE-10` defensively in `paystack-customer.service.ts`.
- Changing `PaymentVerifyCheck`'s escalation behavior.
- Any reconciler/escalation for an unanswered contact-info prompt (see
  Task 12 above).
- A 0%-deposit-specific ask (see Task 13 above).
- Rolling `request_contact_info` out to the production Twilio
  subaccount/number — this plan builds and tests against LRR Stage
  (the LRR Stage Twilio subaccount, its WhatsApp sender,
  Content Template `TWILIO_CONTACT_INFO_REQUEST_TEMPLATE_SID`) only. Production
  rollout (creating the template in the prod subaccount, submitting for
  whatever approval turns out to actually matter there) is a separate,
  later task.

## Anti-goals

- Must not fire this step for a customer who already has a phone number —
  misdetecting "masked" would add friction for everyone.
- Must not overwrite an existing, different phone number on a `User` row
  from vCard data — this step only ever fills a null.
- Must never write a BSUID into `User.phoneNumber` (standing constraint
  from the original plan, still applies).
- **A shared contact only satisfies this gate if it actually contains a
  phone number.** WhatsApp lets the customer uncheck fields before
  sharing (confirmed live this session — a tester unchecked everything
  but phone). A vCard with only an email and/or address, no `TEL` field
  at all, must be treated exactly like any other off-script reply:
  re-prompt, stay in `WAITING_FOR_CONTACT_INFO`, write nothing. This
  product has no email-only account concept to fall back to — it's
  entirely WhatsApp/phone-driven throughout, so there is no lesser
  acceptable substitute for a real phone number here, now or as a
  "for now" compromise.

## Constraints

- No Meta/WhatsApp template approval is required to send
  `REQUEST_CONTACT_INFO` within an active 24h session — confirmed
  empirically this session (sent, `status: queued`, no error, rendered
  and worked on the recipient's phone). Do not gate implementation on an
  approval check.
- `ExternalUserId` (BSUID) is the one field that's always present and
  reliable regardless of masking state — already the identity key used
  throughout the shipped Tasks 1–10 work. `From`/`WaId` must never be
  trusted as a phone-number source; the vCard is the only reliable source
  for this flow.
- Media fetch can transiently 404 (`Twilio media attachment was
  unavailable`, observed live this session on an unrelated photo upload)
  — the vCard fetch needs to tolerate that rather than crash or silently
  drop the customer's response.
- Codebase conventions (CLAUDE.md, binding): `dto/` for request/response
  shapes, `domain/` for pure framework-free logic (mirrors the existing
  `src/rescue-request/domain/vehicle-truck-mapping.ts` precedent found
  this session), large constants in their own file, service/controller
  files contain only the class.
- No shared "blocking step" abstraction exists in
  `whatsapp-customer-flow.service.ts` — every state is a hand-coded
  `if (session.state === X)` block with its own inline validation and
  re-prompt. The new `WAITING_FOR_CONTACT_INFO` block follows that same
  pattern; the closest existing precedent for "derive gate state from
  data rather than a stored flag" is the media step's live
  `RequestMedia` count check.

## Decided so far (the how)

- New `WhatsAppFlowState.WAITING_FOR_CONTACT_INFO` value
  (`whatsapp-session.types.ts`), entered from the `WAITING_FOR_MEDIA`
  step's `message === '2'` branch (`whatsapp-customer-flow.service.ts:595`),
  in place of calling `handleMediaFinished` directly.
- Gate check lives right before that existing `handleMediaFinished` call:
  if `phoneNumber` is null, send the template and transition to the new
  state instead of calling it.
- `WAITING_FOR_CONTACT_INFO` handler: on inbound message, check
  `MessageType === 'contacts' && ChannelMetadata.data.context.Origin ===
  'contact_request'`. If matched: resolve the collision cases above,
  fetch the vCard, parse it, backfill `User`, then call the same
  `handleMediaFinished(phoneNumber, userId, session, rescueRequestId)`
  the existing `message === '2'` branch already calls — not
  `WAITING_FOR_QUOTE_SELECTION`, which is unrelated to this transition.
  If not matched: re-prompt, stay in state — same shape as every
  neighboring block.
- vCard parsing is pure/framework-free logic →
  `src/rescue-request/domain/parse-vcard.ts`, matching the
  `vehicle-truck-mapping.ts` precedent. A `ParsedContact` interface DTO →
  `src/rescue-request/dto/parsed-contact.dto.ts`.
- The Twilio media GET (Basic Auth) is an integration concern →
  `src/integrations/twilio/`, following that module's existing `dto/`
  pattern.
- Task 10 of the original plan (widening `TwilioContentTemplateDefinition`
  for `twilio/call-to-action`, adding the `request_contact_info` template
  entry and its env var) is assumed already shipped, since it's numbered
  below the unshipped 11/12/13/16 — **verify this when the plan is
  written**, don't assume blindly.

## Task 16 acceptance scenarios

Revised per review finding [MED #6] — the original text named Task 16 as
revised without saying what it should now cover. The end-to-end test must
exercise, at minimum:

1. Masked happy path: BSUID-only sender → SOS → intake → photos →
   `REQUEST_CONTACT_INFO` sent → Share Contact → `phoneNumber` backfilled
   → `handleMediaFinished` runs → dispatch proceeds normally.
2. Already-has-phone no-op: a non-masked customer never sees the new
   state at all; behavior is byte-for-byte identical to today.
3. Off-script reply at the contact-info step re-prompts and stays in
   state (text instead of a shared contact, or no media at all).
3a. A shared contact with no `TEL` field at all (e.g. only email/address
    left checked) re-prompts and stays in state, same as 3 — the phone
    number is the one thing this step can't accept a substitute for.
4. vCard fetch failure (media 404, observed live this session on an
   unrelated upload) is tolerated, not a crash — re-prompt or retry per
   whatever the plan stage decides.
5. Shared phone number collides with a registered `Operator.phoneNumber`
   → rejected, re-prompted, never written to `User.phoneNumber`.
6. Shared phone number collides with an existing `User` that already has
   a different `whatsappExternalUserId` → whatever resolution the plan
   stage settles on for the collision case above.
7. The same contact-info webhook delivered twice does not double-run the
   backfill, the collision handling, or `handleMediaFinished`'s
   dispatch-start side effects.
8. A customer who never responds can still `CANCEL` out, same as at any
   other blocking step.

## Left to the builder (plan stage)

- Exact vCard parsing approach: simple line-based `TEL` extraction vs. a
  small library — the format is simple enough this is likely a non-issue
  either way.
- Which phone number to use if the shared vCard contains more than one
  `TEL` line (take the first, unless the plan stage finds a reason not
  to).
- Format validation of the extracted `TEL` value before it's trusted as
  `User.phoneNumber` — a vCard can store a number with dashes, spaces, an
  extension, or garbage. "A `TEL` field exists" (see Anti-goals) is not
  the same check as "it's a usable phone number." The original plan's
  own constraint says `normalizePhone` (`src/common/phone.util.ts`) must
  never receive a BSUID — but a vCard-extracted value is a real
  user-supplied phone string, not a BSUID, so check at plan stage
  whether `normalizePhone` is actually the right tool to validate/format
  it here, or whether that constraint's intent rules it out for a
  different reason.
- Exact retry behavior for a transient vCard-media 404 — immediate retry,
  or treat as "not yet available" and re-prompt the customer to resend.
- Confirming where the existing identity-collision-on-unmask logic (if
  any already exists from the shipped Tasks 1–10 work — the prior
  multi-LLM review flagged a related gap in `findOrCreateBySender`) lives
  today, and whether this gate's backfill can call it directly or needs
  its own version.
- Confirming Task 10's env var/template-definition work is in fact
  already shipped before assuming it.
- Exact re-prompt copy text for the new state, matching the tone of the
  existing neighboring prompts.
