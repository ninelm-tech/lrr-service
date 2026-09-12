# LRR Full System Test Plan

**Date:** 2026-09-10 · **Last updated:** 2026-09-12 (added §13 after a live test pass found stale-state bugs)
**Scope:** Every customer/operator/staff-facing flow currently implemented, on staging. Manual, WhatsApp + admin dashboard driven — the automated Jest suite (292 tests, `lrr-service`) already covers unit-level logic; this plan verifies the real, end-to-end experience a real user would have.

**How to use this:** Work top to bottom. Each numbered case has Setup → Steps → Expected Result. Check the box when the actual result matches. If it doesn't, stop, note what actually happened, and file it rather than continuing past a failure in that flow — later cases often assume the earlier ones worked.

**Do not reset between scenarios.** Run the whole plan as one continuous session with the same test operator and motorist numbers. A run that starts clean each time will pass while real users fail: the bugs found on 2026-09-12 were all cases where state from an earlier job leaked into a later one, and none of them are reachable on a first pass. §13 exists specifically to test that accumulated history, so leave it until last.

**You'll need:**
- A test motorist WhatsApp number (not staff, not an existing operator)
- A test operator WhatsApp number, registered and `ACTIVE` in the admin Operators tab
- Admin dashboard access (ADMIN or SUPER_ADMIN role)
- `disputeAlertPhoneNumber` set in Platform Settings, and access to that number's WhatsApp — it now receives dispute alerts, low-rating alerts, *and* stalled-confirmation alerts
- A real (or test-mode) Paystack card for payment steps

---

## 1. Request Creation & Media

- [ ] **1.1 — Start a request**
  Send `SOS` from the test motorist number.
  **Expected:** Bot asks for a location pin.

- [ ] **1.2 — Share location**
  Share a live or dropped pin.
  **Expected:** Bot asks for issue type (breakdown/accident/flat tyre/fuel).

- [ ] **1.3 — Pick issue type, vehicle type, destination**
  Follow prompts through to destination.
  **Expected:** Bot asks for photo/video evidence.

- [ ] **1.4 — Upload media, then type `DONE`**
  Send 1-2 photos, then `DONE`.
  **Expected:** Bot proceeds to deposit/dispatch (exact next step depends on subscriber status — see §2).

- [ ] **1.5 — Missing location, text-only landmark**
  Restart a fresh request; when asked for location, send a text landmark instead of a pin.
  **Expected:** Bot explicitly asks for a pin drop rather than silently accepting text as the location.

---

## 2. Deposit Payment

- [ ] **2.1 — Initial deposit message wording**
  Reach the deposit-payment step.
  **Expected:** Message says **"You have 5 minutes"** (not 30) before the request is cancelled.

- [ ] **2.2 — First reminder (real 5-minute mark)**
  Wait 5 real minutes without paying.
  **Expected:** A reminder arrives saying **"You have 5 more minutes to complete payment"**.

- [ ] **2.3 — Second reminder (15-minute mark)**
  Continue waiting to the 15-minute mark.
  **Expected:** A reminder arrives with no specific number of minutes mentioned.

- [ ] **2.4 — Final warning (25-minute mark)**
  Continue to the 25-minute mark.
  **Expected:** Reminder arrives with **"Your request will be cancelled soon"**, still no exact number.

- [ ] **2.5 — Hard cutoff (30-minute mark)**
  Continue to 30 minutes without paying.
  **Expected:** Request is cancelled; motorist told payment wasn't received in time; operator told the job is no longer available.

- [ ] **2.6 — Successful payment**
  On a fresh request, pay the deposit within the window.
  **Expected:** Motorist gets operator confirmation; operator gets "payment confirmed, job is live."

- [ ] **2.7 — Re-prompt if motorist messages before paying**
  On a fresh request, send any random text before paying (don't use the payment link).
  **Expected:** Bot re-sends the "please pay" prompt, mentioning 5 minutes.

---

## 3. Dispatch & Bidding

- [ ] **3.1 — Operator receives offer**
  With a fresh request reaching dispatch, confirm the test operator receives a dispatch-offer message with vehicle type, destination, distance, and media link.

- [ ] **3.2 — Operator quotes**
  Reply with a bare number (e.g. `50000`).
  **Expected:** Motorist receives the quote in their shortlist.

- [ ] **3.3 — Operator declines**
  On a separate request/offer, reply `no` or `decline`.
  **Expected:** Operator is told the decline was recorded; motorist's shortlist doesn't include this operator.

---

## 4. Operator Selection & Assignment

- [ ] **4.1 — Motorist selects a quote**
  Reply with the shortlist number of a quote.
  **Expected:** "Operator selected!" message, deposit link, "You have 5 minutes" (same wording check as §2.1, this is the actual trigger point).

---

## 5. Masked Chat Relay (CHAT DRIVER) — new this pass

- [ ] **5.1 — Start a chat before deposit is paid**
  Right after selecting a quote (before paying deposit), send `CHAT DRIVER` as the motorist.
  **Expected:** Both motorist and operator get "You're now connected... Reply END CHAT anytime to stop."

- [ ] **5.2 — Messages relay correctly**
  As the motorist, send a plain message (e.g. "Are you close?").
  **Expected:** The operator receives it as `Customer: Are you close?` — from LRR's number, not the motorist's real number.

- [ ] **5.3 — Reverse direction**
  As the operator, reply with a plain message.
  **Expected:** The motorist receives it as `Driver: ...` — from LRR's number, not the operator's real number.

- [ ] **5.4 — Commands are swallowed during relay, not executed**
  While still in the chat, have the operator send `arrived`.
  **Expected:** This is relayed as a chat message (`Driver: arrived`) to the motorist — it does **not** trigger the real ARRIVED flow. (This is deliberate — confirms the explicit-exit design is working, not a bug.)

- [ ] **5.5 — END CHAT exits for both sides**
  Either party sends `END CHAT`.
  **Expected:** Both sides receive "Chat ended." Operator can now send `arrived` and have it work as a real command (see §6).

- [ ] **5.6 — No operator assigned yet**
  On a brand new request before any operator is selected, send `CHAT DRIVER`.
  **Expected:** Bot replies that no operator is assigned yet — no relay starts.

---

## 6. Dispatch & En-Route

- [ ] **6.1 — Operator sends ARRIVED**
  With deposit paid and outside any active chat relay, operator sends `arrived`.
  **Expected:** Motorist is notified their operator has arrived.

- [ ] **6.2 — ARRIVED rejected in wrong state**
  Have a different, unassigned operator try `arrived`.
  **Expected:** Told they don't have an active job.

---

## 7. Completion & Confirmation

- [ ] **7.1 — Operator sends DONE**
  Operator sends `done`.
  **Expected:** Motorist gets "job is done, reply CONFIRM or DISPUTE."

- [ ] **7.2 — Motorist confirms**
  Reply `CONFIRM`.
  **Expected:** Status moves to Completed immediately (check admin dashboard); balance payment link sent.

- [ ] **7.3 — Stalled confirmation → staff alert, NOT auto-complete**
  On a fresh DONE, don't reply for 30 real minutes.
  **Expected:** `disputeAlertPhoneNumber` receives an alert ("customer hasn't confirmed... please check on them"). Confirm in the admin dashboard the request status is **still `Arrived`**, not auto-completed, and the operator was **not** told to release the vehicle.

---

## 8. Dispute Intake & Resolution

- [ ] **8.1 — Raise a dispute**
  After a DONE, reply `DISPUTE` instead of `CONFIRM`.
  **Expected:** Status becomes `In Dispute` (check admin dashboard). Motorist told to expect contact, asked for their side. Operator told **not to release the vehicle**, asked for their side (confirm this goes to the *operator*, not repeated to the motorist).

- [ ] **8.2 — Both statements captured**
  As motorist, send a free-text explanation. As operator, send a free-text explanation.
  **Expected:** Both appear on the request detail in the admin dashboard, correctly labeled "Customer said" / "Operator said."

- [ ] **8.3 — Staff resolve with an adjustment**
  In the admin dashboard, open the disputed request, enter a resolution note and a settlement percentage (e.g. 60).
  **Expected:** A payment link for the adjusted amount is sent to the motorist. Status is still `In Dispute` (not yet Completed). Operator gets a message confirming the settlement amount.

- [ ] **8.4 — Payment completes the disputed job**
  Motorist pays the settled amount.
  **Expected:** Status becomes `Completed`. Both original and settled balance amounts are visible on the request detail.

- [ ] **8.5 — Confirm during an unresolved dispute is blocked**
  On a fresh dispute (before staff resolve it), have the motorist reply `CONFIRM`.
  **Expected:** Told the request is still under dispute review — job does **not** complete, no payment link sent.

- [ ] **8.6 — Confirm after resolution, before payment**
  After staff resolve (8.3) but before paying, have the motorist reply `CONFIRM` again.
  **Expected:** Told to use the payment link already sent — does **not** trigger a second link or complete the job early.

- [ ] **8.7 — Reopen a resolved dispute**
  On an already-resolved-but-unpaid dispute, motorist replies `DISPUTE` again.
  **Expected:** Dispute reopens; staff re-alerted; motorist told it's reopened (not a fresh "logged" message).

---

## 9. Balance Payment & Vehicle Release

- [ ] **9.1 — Successful balance payment (undisputed job)**
  Complete a normal (non-disputed) job through to balance payment.
  **Expected:** Motorist gets payment confirmation + rating prompt. Operator gets "release the vehicle" + rating prompt.

---

## 10. Payout

- [ ] **10.1 — Successful payout**
  With an operator who has bank details on file, confirm a payout fires after balance payment.
  **Expected:** Operator receives "payment sent" with the amount; payout shows `SUCCESS` in the admin Payouts tab.

- [ ] **10.2 — Missing bank details**
  Repeat with an operator who has no bank details on file.
  **Expected:** Payout shows `PENDING` with reason "No bank details on file" in the admin Payouts tab; operator is notified to add bank details.

- [ ] **10.3 — Retry after fixing bank details**
  Add bank details for the blocked operator, then click Retry in the admin Payouts tab.
  **Expected:** Payout proceeds to `SUCCESS`.

- [ ] **10.4 — Payout on a disputed request shows the dispute badge**
  Find a payout tied to a request that was disputed (from §8).
  **Expected:** The Payouts tab shows a "Disputed" or "Dispute Resolved" badge next to that job.

---

## 11. Rating & Low-Rating Flagging — new this pass

- [ ] **11.1 — Normal rating (3+ stars)**
  As motorist, rate the operator 4 or 5.
  **Expected:** Thank-you message with a feedback link. No staff alert.

- [ ] **11.2 — Low rating from motorist triggers a flag + alert**
  On a different completed job, rate the operator 1 or 2.
  **Expected:** `disputeAlertPhoneNumber` receives an alert ("Customer rated the operator low"). In the admin dashboard, opening that request shows a red "Flagged" badge on the rating.

- [ ] **11.3 — Low rating from operator triggers a flag + alert**
  As the operator, rate the motorist 1 or 2.
  **Expected:** Same alert pattern, message says "Operator rated the customer low." Flag visible in the dashboard.

- [ ] **11.4 — Mark a flagged rating reviewed**
  In the admin dashboard, click "Mark Reviewed" on a flagged rating.
  **Expected:** Badge turns green ("Reviewed"), the button disappears, the flag record persists (doesn't just vanish).

---

## 12. Cross-Cutting Checks

- [ ] **12.1 — Admin dashboard dispute visibility (regression)**
  Confirm the Requests tab actually shows the "In Dispute" status and "Was Disputed" history correctly — this was previously silently broken (fields existed in the DB but weren't returned by the API) and was fixed this pass. Don't skip this check.

- [ ] **12.2 — Duplicate SOS while a request is open**
  Send `SOS` again while an existing request is still active.
  **Expected:** Told about the existing active request rather than starting a second one.

- [ ] **12.3 — Cancel an active request**
  Send `CANCEL` at various stages (before deposit, after deposit, mid-dispatch).
  **Expected:** Cancels cleanly each time; no charge if deposit wasn't paid; assigned operator (if any) notified.

---

## 13. Stale State Across Sequential Jobs

This whole section exists because of a real failure found on 2026-09-12. Running the plan top to bottom means the same test operator accumulates history — finished jobs, cancelled jobs, offers they never replied to. Several bugs only appear on the *second or third* run through a flow, never the first, so a clean single pass will not catch them.

**Setup for this section:** you need the test operator to have been through at least three earlier scenarios — one completed, one cancelled, and at least one where the operator was sent an offer and simply never replied to it. If you've worked through §1–§12 in order, you already have this.

- [ ] **13.1 — Open-job list contains only genuinely live jobs**
  Get a fresh offer out to the test operator, then reply with a bare price (e.g. `28000`).
  **Expected:** Either the quote is accepted outright (if this is their only live offer), or the "you have N jobs open at once" list appears containing **only** jobs that are actually still live. A completed or cancelled job must never appear in that list.
  *This is the exact bug found on 2026-09-12: three old jobs were listed as open after they'd already ended.*

- [ ] **13.2 — Abandoned request releases the operator's offer**
  Start a request, let the operator receive the offer, and have the operator reply *nothing at all*. Let the request run until it auto-cancels (no operators left to try).
  **Expected:** Once the motorist is told the request was cancelled, that job no longer counts as open for the operator — verify by triggering 13.1 again and confirming it's absent from the list.

- [ ] **13.3 — Motorist-cancelled request releases the operator's offer**
  Same as 13.2, but the motorist sends `CANCEL` while the operator's offer is still unanswered.
  **Expected:** Same — the job disappears from the operator's open-job list immediately, not minutes later.

- [ ] **13.4 — Admin-cancelled request releases the operator's offer**
  Same again, but cancel from the admin dashboard (both the Cancel action and a manual status change to Cancelled) while the operator's offer is unanswered.
  **Expected:** Same as 13.3.

- [ ] **13.5 — Declining a new offer while a rating is still owed**
  Complete a job so the operator is prompted to rate the motorist, and **do not reply to that prompt**. Then send the operator a fresh dispatch offer for a different job and reply `NO` to decline it.
  **Expected:** The decline is recorded against the new job. The operator must **not** be told "please reply with a number from 1 to 5" — the outstanding rating prompt must not swallow the decline.
  *Found 2026-09-12: the stale rating prompt intercepted the decline and recorded a 1-star rating on the old job instead.*

- [ ] **13.6 — Quoting while a rating is still owed**
  Same setup as 13.5, but reply with a price (e.g. `30000`) instead of `NO`.
  **Expected:** Treated as a quote on the new job, not as a star rating on the old one.

- [ ] **13.7 — Rating still works once no offer is live**
  With the rating prompt still outstanding and **no** live offers, reply with a number 1–5.
  **Expected:** Recorded as a rating as normal. (13.5/13.6 must not have broken the ordinary rating path.)

- [ ] **13.8 — Every operator-facing message names its job**
  Working through a job end to end, check each message the operator receives: dispatch offer, countdown notice, arrival confirmation, DONE/ARRIVED reminders, "payment received / release the vehicle", the rating prompt, and any "this job has already ended" reply.
  **Expected:** Every one of them names the job reference (e.g. `Job #UH8DF7`). An operator juggling several jobs must never get a message that just says "the job" or "this customer" with no way to tell which. Motorist-facing messages don't need this — a motorist only ever has one active request.

---

## Known Gaps — Not Testable Yet (features not built)

These will fail if tested, because they don't exist. Don't file these as bugs — they're tracked separately as open product decisions:

- `LOCATION ISSUE` keyword / masked voice calling
- Motorist no-show auto-cancel + operator fuel compensation after ARRIVED
- Off-platform settlement detection
- Blacklisting a customer who stalls on payment
