# Dispatch Offer WhatsApp Template — Design

**Goal:** Stop dispatch offers from silently failing (Twilio error 63016 — "Outside messaging window") whenever an operator hasn't messaged the current WhatsApp Business number within the last 24 hours, by sending the offer through an approved UTILITY-category Content Template instead of a freeform message.

**Status:** Approved by user 2026-08-19, implemented 2026-08-19. Template SID: `HX52908fb16d9f48269b6376b8313f72d5` (`TWILIO_DISPATCH_OFFER_TEMPLATE_SID`). **Corrected 2026-08-21** after the first deployment hit Twilio error 21656 ("The Content Variables parameter is invalid") — the code's variable mapping didn't match the *actual* approved template body (see below); code fixed to match the real template rather than resubmitting it.

## Background

- `DispatchService.startDispatch()` (batch offers) and `DispatchService.manualOfferToOperator()` (admin single offers) both currently send the "🚨 NEW RESCUE JOB" message via `TwilioService.sendWhatsAppMessage` — a freeform body, which WhatsApp only allows if the recipient has an open 24h session with the sending number.
- Confirmed via Twilio Console (Monitor → Logs → Messaging) on 2026-08-19: a dispatch offer to an operator failed with error **63016** ("Outside messaging window. For WhatsApp, use a Message Template instead") — operators had a session with the *old* WhatsApp number from months of replying to job offers, but none have messaged the *new* number yet. See memory `lrr-whatsapp-number-migration-dispatch-broken`.
- This exact problem was already solved once for dispute alerts: `DisputeService.sendStaffDisputeAlert()` checks `process.env.TWILIO_DISPUTE_TEMPLATE_SID` — if set, sends via `TwilioService.sendWhatsAppTemplateMessage(to, templateSid, variables)`; if unset, falls back to a freeform send (for local/sandbox testing before the template exists). This design reuses that exact pattern.
- Unlike the OTP flows (`otpUpgradeEnabled`/`otpPasswordResetEnabled`), this is a **UTILITY**-category template, not AUTHENTICATION — Meta approves UTILITY templates in roughly a day, not weeks/months, and it's a separate, independent approval track.

## Design

### One template, reused by both call sites

Both `startDispatch`'s batch loop and `manualOfferToOperator` send the same category of message today (near-identical bodies, `manualOfferToOperator`'s just omits the distance/ETA line). One template covers both — variables are always non-empty (Meta rejects empty template variables), so the batch/manual difference is handled by what each call site passes in, not by two templates.

**Template name:** `dispatch_offer` (UTILITY category)
**Env var:** `TWILIO_DISPATCH_OFFER_TEMPLATE_SID`

**Body — the actual approved template** (confirmed from Twilio Console 2026-08-21; supersedes the initial draft in this doc's earlier revisions, which had incorrectly split distance and ETA into separate variables):

```
🚨 NEW RESCUE JOB – Job #{{1}}

Vehicle: {{2}}
Destination: {{3}}
{{4}}
Location: {{5}}
{{6}}

⚠️ ACTION NEEDED – reply with your price to bid, e.g. "25000".
Reply NO to decline.
You have {{7}} to respond.

📌 If you have more than one job open at once, reply "{{8}} 25000" instead of just the price, so we know which job you mean.
```

Two things that differ from the freeform message's structure, both driven by what got approved rather than by choice:
- **No separate ETA line** — distance and ETA are combined into `{{4}}` (two lines within one variable), not split across two variables.
- **`{{8}}` repeats the job ref** — `{{1}}` (header) and `{{8}}` (disambiguation-reply example) carry the same value; they are not sequential distinct content.

**Variables**:

| # | Content | `startDispatch` (batch) | `manualOfferToOperator` |
|---|---|---|---|
| 1 | bare job ref | `formatJobRef(id).replace('Job #','')` | same |
| 2 | vehicle label | `vehicleLabel` | same |
| 3 | destination | `destinationLabel` | same |
| 4 | distance + ETA, combined | `Distance: ${op.distance.toFixed(1)} km\nEst. ETA: ~${estimateEtaMinutes(op.distance)} min based on your registered location.` | `Distance: N/A` (this path doesn't compute either today — out of scope to add) |
| 5 | location | `locationSection` (unchanged) | same |
| 6 | media | `mediaSection` if non-empty, else `No photos, video, or audio attached.` | same |
| 7 | response window | `${config.dispatchWindowMinutes} minute(s)` | `5 minutes` |
| 8 | bare job ref (same value as `{{1}}`) | same as `{{1}}` | same as `{{1}}` |

**Sample variables** (for Twilio's Content Template Builder submission):

Batch scenario: `{{1}}` `3X8M8O` · `{{2}}` `Sedan` · `{{3}}` `Ikeja` · `{{4}}` `Distance: 21.1 km` · `{{5}}` `4 Wilmot Point Rd, Victoria Island, Lagos 106104, Lagos, Nigeria\n📍 https://maps.google.com/?q=6.42169134,3.40915073` · `{{6}}` `📎 Photos/Video/Audio:\nhttps://api-staging.lrr.ninelm.com/api/v1/media/cmt0j7r6x000501kq89ts2f6s\nhttps://api-staging.lrr.ninelm.com/api/v1/media/abc123` (submit with 2+ links — unconfirmed whether Meta accepts multi-line body variables, worth surfacing at review time) · `{{7}}` `Est. ETA: ~63 min based on your registered location.` · `{{8}}` `10 minutes`

Manual-offer scenario: `{{4}}` `Distance: N/A` · `{{7}}` `ETA: N/A` · `{{8}}` `5 minutes`

### Code changes

- **New:** private helper `DispatchService.sendDispatchOfferMessage(operatorPhone, variables)` — checks `TWILIO_DISPATCH_OFFER_TEMPLATE_SID`; if set, calls `sendWhatsAppTemplateMessage`; if unset, reconstructs the exact freeform message (today's behavior, unchanged) via `sendWhatsAppMessage`. Mirrors `sendStaffDisputeAlert`'s branching exactly.
- **Modify:** `startDispatch`'s `Promise.all(batch.map(...))` block and `manualOfferToOperator`'s single send both call this new helper instead of `sendWhatsAppMessage` directly.
- No schema changes, no new DTOs (this is internal messaging plumbing, not a request/response shape).

### Also fixing while touching this code (approved as part of the same change)

The `Promise.all` in `startDispatch`'s batch-notify step has no `.catch` — one operator's send failure currently becomes an unhandled rejection that can abort the whole batch. Switched to `Promise.allSettled`, logging any per-operator failure via `Sentry.captureException` (currently these fail silently — `console.error` isn't Sentry-captured, which is why this outage was invisible in the earlier investigation). `manualOfferToOperator`'s single send is wrapped in try/catch that logs to Sentry and re-throws — unlike the batch path, this is a single admin-triggered action and the admin needs to see the failure, not have it silently swallowed.

## Testing

- `dispatch.service.spec.ts`: new tests for `sendDispatchOfferMessage` — template-configured path (calls `sendWhatsAppTemplateMessage` with the right variables), unconfigured path (falls back to freeform, exact same string as today's tests already assert). Existing `startDispatch`/`manualOfferToOperator` tests updated only where they assert on the exact `sendWhatsAppMessage` call — they'll now go through the new helper, but with no template SID configured in tests (matching current test env), the freeform fallback keeps their assertions valid unchanged.
- One new test: a failed send for one operator in a batch doesn't prevent the others from being attempted (`Promise.allSettled` behavior) and gets reported via `Sentry.captureException`.

## Out of scope

- Computing a real distance/ETA for `manualOfferToOperator` (currently doesn't have one; `{{4}}` is `"Distance: N/A"` for that path) — not requested, would touch unrelated logic.
- Building/submitting the actual template in Twilio's Content Template Builder and getting Meta approval — that's a manual console step for the user, not code. `TWILIO_DISPATCH_OFFER_TEMPLATE_SID` stays unset (freeform fallback active, today's exact behavior) until that's done.
- Any change to the dispute-alert template or OTP flows — this only touches dispatch-offer messaging.
