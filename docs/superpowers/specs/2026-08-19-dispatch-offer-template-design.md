# Dispatch Offer WhatsApp Template — Design

**Goal:** Stop dispatch offers from silently failing (Twilio error 63016 — "Outside messaging window") whenever an operator hasn't messaged the current WhatsApp Business number within the last 24 hours, by sending the offer through an approved UTILITY-category Content Template instead of a freeform message.

**Status:** Approved by user 2026-08-19, implemented 2026-08-19. Template `new_rescue_job`, SID `HX52908fb16d9f48269b6376b8313f72d5` (`TWILIO_DISPATCH_OFFER_TEMPLATE_SID`).

**Debugging history (2026-08-21)** — three deploys, all failing with Twilio **21656** ("The Content Variables parameter is invalid"). The first two "fixes" were guesses built on a hand-transcribed copy of the template body and did nothing:
1. Remapped variables assuming `{{8}}` repeats the job ref — no effect.
2. Assumed WhatsApp rejects newlines inside template parameters — unverified, also no effect. **Reverted.**
3. **Actual fix:** fetched the template's real definition from `GET https://content.twilio.com/v1/Content/{sid}` — it declares exactly **seven** variables (`1`–`7`), and its body reuses `{{1}}` in the disambiguation line rather than having an `{{8}}`. We were sending an 8th key the template doesn't declare, which fails the entire send.

**Lesson worth keeping:** the Content API is the only authoritative source for a template's variable set — reading the body text (or a copy of it) is not, since a repeated placeholder like `{{1}}` doesn't add a variable. Verify against the API before mapping. Twilio does not ignore extra keys or degrade gracefully.

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

**Body — verbatim from the Content API** (`GET https://content.twilio.com/v1/Content/HX52908fb16d9f48269b6376b8313f72d5`, 2026-08-21). This, not a transcription of it, is the authoritative shape:

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

📌 If you have more than one job open at once, reply "{{1}} 25000" instead of just the price, so we know which job you mean.
```

Two structural facts that differ from the freeform message, and are easy to get wrong by eye:
- **No separate ETA slot** — distance and ETA share `{{4}}` as two lines inside one variable.
- **The disambiguation line reuses `{{1}}`** — it is *not* an 8th variable. The API's `variables` map declares exactly `1`–`7`; sending a key `8` fails the whole send with 21656.

**Variables** (exactly seven — must match the API's declared set):

| # | Content | `startDispatch` (batch) | `manualOfferToOperator` |
|---|---|---|---|
| 1 | bare job ref (also fills the disambiguation line) | `formatJobRef(id).replace('Job #','')` | same |
| 2 | vehicle label | `vehicleLabel` | same |
| 3 | destination | `destinationLabel` | same |
| 4 | distance + ETA, combined | `Distance: ${op.distance.toFixed(1)} km\nEst. ETA: ~${estimateEtaMinutes(op.distance)} min based on your registered location.` | `Distance: N/A` (this path computes neither today — out of scope to add) |
| 5 | location | `locationSection` (unchanged) | same |
| 6 | media | `mediaSection` if non-empty, else `No photos, video, or audio attached.` | same |
| 7 | response window | `${config.dispatchWindowMinutes} minute(s)` | `5 minutes` |

**Sample values currently stored on the template** (from the same API response — these are what Meta reviewed):

`{{1}}` `3X8M8O` · `{{2}}` `Sedan` · `{{3}}` `Ikeja` · `{{4}}` `Distance: 21.1 km\nEst. ETA: ~63 min based on your registered location.` · `{{5}}` `4 Wilmot Point Rd, Victoria Island, Lagos 106104, Lagos, Nigeria\n📍 https://maps.google.com/?q=6.42169134,3.40915073` · `{{6}}` `📎 Photos/Video/Audio:\nhttps://api-staging.lrr.ninelm.com/api/v1/media/cmt0j7r6x000501kq89ts2f6s` · `{{7}}` `10 minutes`

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
