/**
 * Single source of truth for every Twilio WhatsApp Content Template this
 * app sends — one entry per `TWILIO_*_TEMPLATE_SID` env var used across
 * the codebase (grep for the env var name to find the call site).
 *
 * Why this file exists: each template has to be created twice — once in
 * the LRR Stage Twilio subaccount, once in LRR Prod — by hand, in the
 * Twilio console. Nothing enforces that the two copies say the same
 * thing. We found a real case of this: `arrived_prompt`'s actual live
 * body ("tap ARRIVED") didn't match this codebase's own reconstructed
 * guess ("send *ARRIVED*") until someone checked the console directly.
 *
 * This file is the thing to copy FROM when creating/checking a template
 * in either subaccount — not the other way around. It is reference data
 * only; nothing in the app imports or sends from it (every real send
 * still goes through the plain `env.TWILIO_X_TEMPLATE_SID` + a
 * `Record<string, string>` of numbered variables, same as before).
 *
 * `source: 'confirmed'` means this body was copied directly from a
 * template open in the Twilio console — the strongest guarantee this file
 * offers. `source: 'reconstructed'` means it was derived from this
 * codebase's own freeform fallback text (the `else` branch used when the
 * env var is unset) and has NOT been checked against the live template —
 * treat the variable shape (count/order) as reliable (verified by reading
 * the call site's own code), but verify the literal wording against the
 * console before trusting it. `source: 'designed'` means this exact text
 * was handed off to be typed into the console to CREATE a new template —
 * it is the intended wording, not an independent read of what's actually
 * live, and whoever created it may have changed something in the
 * process. Don't call it `'confirmed'` until someone has actually opened
 * the created template and checked it matches.
 *
 * When you confirm or correct an entry against the console, update it
 * here and flip its `source` to `'confirmed'`.
 *
 * Two conventions for a job reference variable, never mix them up (this
 * is exactly where the previous version of this file got it wrong):
 *  - "bare" ref: the call site does `.replace('Job #', '')` before
 *    passing the variable — the static body text MUST write `Job #{{N}}`
 *    itself, or the `#` never appears.
 *  - "full" ref: the call site passes `formatJobRef(...)` untouched —
 *    the variable already IS `"Job #A1B2C3"`, so the static body text
 *    must NOT prepend `Job` or `Job #` again.
 */

export type TwilioContentTemplateDefinition = {
  /** The env var holding this template's Content SID, e.g. TWILIO_DISPUTE_TEMPLATE_SID. */
  envVar: string;
  /** Twilio/Meta category — every template in this app is UTILITY (operational, not promotional). */
  category: 'UTILITY';
  contentType: 'text' | 'quick-reply';
  /** Each numbered variable, in the exact order the template declares them (index 0 = {{1}}). */
  variables: string[];
  /** The approved body, with {{N}} placeholders — see the file header for what `source` means here. */
  body: string;
  buttons?: { title: string }[];
  source: 'confirmed' | 'reconstructed' | 'designed';
};

export const TWILIO_CONTENT_TEMPLATES: Record<
  string,
  TwilioContentTemplateDefinition
> = {
  new_rescue_job: {
    envVar: 'TWILIO_DISPATCH_OFFER_TEMPLATE_SID',
    category: 'UTILITY',
    contentType: 'text',
    // Variable mapping is live-verified (see dispatch.service.ts's own
    // comment: checked against GET https://content.twilio.com/v1/Content/{sid}).
    // Two non-obvious things: {{4}} carries distance AND eta combined (no
    // separate eta slot), and the disambiguation line in the body reuses
    // {{1}} rather than being an 8th variable.
    // {{1}} is a BARE ref (writeRound strips 'Job #' before building
    // PendingOffer.jobRef) — the body's static text must write "Job #{{1}}".
    variables: [
      'bareJobRef',
      'vehicle',
      'destination',
      'distanceAndEta',
      'location',
      'mediaSection (or "No photos, video, or audio attached.")',
      'responseWindow',
    ],
    body: '(exact prose not transcribed — see Twilio console; variable count/order above is live-verified; must read "Job #{{1}}" not "Job {{1}}" per the bare-ref convention above)',
    source: 'reconstructed',
  },

  quote_countdown: {
    envVar: 'TWILIO_QUOTE_COUNTDOWN_TEMPLATE_SID',
    category: 'UTILITY',
    contentType: 'text',
    variables: ['bareJobRef', 'timeRemaining'],
    body: '⏱ *Countdown started* — Job #{{1}}\n\nAnother operator just placed a bid. You have *{{2}}* left to submit your price if you still want this job.',
    source: 'reconstructed',
  },

  dispute_raised_alert: {
    // Note: this template is named `dispute_notification_template` in the
    // LRR Stage subaccount and `dispute_raised_alert` in LRR Prod — same
    // SID-per-env-var, different console label. Harmless (the code never
    // reads the name), but worth fixing for your own sanity next time
    // either one is touched.
    envVar: 'TWILIO_DISPUTE_TEMPLATE_SID',
    category: 'UTILITY',
    contentType: 'text',
    variables: ['bareJobRef', 'dashboardLink'],
    body: '🚨 New dispute raised — Job #{{1}}\n\nLog in to view: {{2}}',
    source: 'reconstructed',
  },

  payout_sent: {
    envVar: 'TWILIO_PAYOUT_SENT_TEMPLATE_SID',
    category: 'UTILITY',
    contentType: 'text',
    variables: ['bareJobRef', 'nairaAmount'],
    body: '💰 Payment sent — Job #{{1}}. ₦{{2}} has been transferred to your registered bank account.',
    source: 'reconstructed',
  },

  payout_bank_details_needed: {
    envVar: 'TWILIO_PAYOUT_BANK_DETAILS_TEMPLATE_SID',
    category: 'UTILITY',
    contentType: 'text',
    variables: ['bareJobRef', 'nairaAmount', 'settingsUrl'],
    body: "💰 You've earned ₦{{2}} for Job #{{1}}. We don't have your bank details yet — add them at {{3}} to receive your payment.",
    source: 'reconstructed',
  },

  // arrived_prompt/arrived_reminder/done_prompt/done_reminder: these 4 are
  // always sent inside an active 24h WhatsApp session with the operator
  // (they're job-in-progress follow-ups, not business-initiated opens —
  // see sendWhatsAppTemplateMessage's own docs for the distinction), so
  // Meta's template-approval requirement never applied to them and none
  // were originally submitted for review. Submitted for approval anyway
  // on 2026-10-23, as a safety net: a long interstate job can legitimately
  // run past 24h between ACCEPTED and ARRIVED, or ARRIVED and DONE — the
  // request is never auto-cancelled while in progress (confirmed: no
  // reconciler check transitions OPERATOR_ASSIGNED/IN_PROGRESS/ARRIVED to
  // CANCELLED on a timer) — and if the session window happens to close in
  // that gap, an approved template still sends where an unapproved one
  // would be rejected. Approval status doesn't change any code path here:
  // sendWhatsAppTemplateMessage is called identically either way, so
  // nothing needs updating once these clear review.

  arrived_prompt: {
    envVar: 'TWILIO_ARRIVED_PROMPT_TEMPLATE_SID',
    category: 'UTILITY',
    contentType: 'quick-reply',
    variables: ['fullJobRef', 'customerPhone', 'vehicleLabel', 'location'],
    // Confirmed by screenshot of the live LRR Stage template's "General
    // info" preview, 2026-10-22. Note {{1}} is the FULL ref ("Job
    // #A1B2C3"), not stripped — unlike most other templates in this
    // file, there is no static "Job " before {{1}}.
    body: '💰 Payment confirmed — job is live! — {{1}}\n\nCustomer: {{2}}\nVehicle: {{3}}\nLocation: {{4}}\n\nHead over now and tap ARRIVED when you reach them.',
    buttons: [{ title: 'ARRIVED' }],
    source: 'confirmed',
  },

  arrived_reminder: {
    envVar: 'TWILIO_ARRIVED_REMINDER_TEMPLATE_SID',
    category: 'UTILITY',
    contentType: 'quick-reply',
    // {{1}} is the FULL job ref, same reasoning as arrived_prompt — the
    // call site passes formatJobRef(...) with no .replace('Job #', '').
    variables: ['fullJobRef'],
    // Confirmed by screenshot of the live LRR Stage template's "General
    // info" preview, 2026-10-22.
    body: '📍 {{1}} — tap ARRIVED when you reach the customer location so we can notify them.',
    buttons: [{ title: 'ARRIVED' }],
    source: 'confirmed',
  },

  done_prompt: {
    envVar: 'TWILIO_DONE_PROMPT_TEMPLATE_SID',
    category: 'UTILITY',
    contentType: 'quick-reply',
    variables: ['fullJobRef'],
    // Confirmed by screenshot of the live LRR Stage template's "General
    // info" preview, 2026-10-22.
    body: '✅ {{1}} — Arrival confirmed! The customer has been notified. Tap DONE when the job is complete.',
    buttons: [{ title: 'DONE' }],
    source: 'confirmed',
  },

  done_reminder: {
    envVar: 'TWILIO_DONE_REMINDER_TEMPLATE_SID',
    category: 'UTILITY',
    contentType: 'quick-reply',
    variables: ['fullJobRef'],
    // Confirmed by screenshot of the live LRR Stage template's "General
    // info" preview, 2026-10-22.
    body: "✅ {{1}} — tap DONE when the job is complete. The customer will confirm and you'll both be notified.",
    buttons: [{ title: 'DONE' }],
    source: 'confirmed',
  },

  new_request_staff_alert: {
    envVar: 'TWILIO_NEW_REQUEST_ALERT_TEMPLATE_SID',
    category: 'UTILITY',
    contentType: 'text',
    variables: [
      'bareJobRef',
      'vehicleLabel',
      'issueLabel',
      'destination',
      'customerPhone',
    ],
    // Deliberately omits "#" before {{1}} ("Job {{1}}" not "Job #{{1}}") —
    // unlike the customer/operator-facing templates above, this is staff
    // only, and the missing "#" was judged not worth an edit + possible
    // Meta re-approval. Don't "fix" this to match the bare-ref convention
    // note at the top of this file without checking first.
    //
    // The original template (SID HXa663e7a0af121b0780c7e450ca24c6cc,
    // body: '🆕 New request Job {{1}}: {{2}}, {{3}} → {{4}}. Customer:
    // {{5}}.') was REJECTED by WhatsApp on 2026-10-22: "This template has
    // too many variables for its length. Reduce the number of variables
    // or increase the message length." — also flagged ineligible for
    // WhatsApp-business-initiated specifically, which this alert needs
    // (staff haven't messaged first). Replaced below with the same 5
    // variables, same order/meaning, more static text to dilute the
    // variable-to-length ratio — no code change needed, only the SID.
    // New SIDs: staging HX7226fad2f9310c33316ca09b87e3e58e, production
    // HX467858004413d4197f9d6d6b07a162c6.
    //
    // source is 'designed', not 'confirmed': this is the text that was
    // handed off to create the new template — no one has reopened it in
    // the console to verify this is exactly what it says, or that it
    // actually cleared WhatsApp review this time. Flip to 'confirmed'
    // once someone has.
    body: '🆕 A new rescue request just came in — Job {{1}}. Vehicle type: {{2}}. Issue reported: {{3}}. Heading to: {{4}}. Customer contact: {{5}}. Please review and assign as needed.',
    source: 'designed',
  },

  low_rating_staff_alert: {
    envVar: 'TWILIO_LOW_RATING_ALERT_TEMPLATE_SID',
    category: 'UTILITY',
    contentType: 'text',
    variables: ['score', 'bareJobRef', 'whoRatedWhom'],
    // Same deliberate "#"-less choice as new_request_staff_alert, same
    // reasoning — staff-only, not worth an edit + possible re-approval.
    // source is 'designed', not 'confirmed' — same reasoning as
    // new_request_staff_alert above.
    body: '⚠️ Low rating ({{1}}/5) on Job {{2}} — {{3}} low. Please review.',
    source: 'designed',
  },
};
