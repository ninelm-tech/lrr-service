# Dispatch Offer Delivery Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track whether a dispatch-offer WhatsApp message actually reached an
operator's phone, by capturing Twilio's Message SID at send time and
recording the async delivery status Twilio reports back via a new webhook —
surfaced in the admin Requests UI so "confirmed undelivered" is no longer
indistinguishable from "delivered but ignored."

**Architecture:** `TwilioService`'s send methods start returning the Twilio
Message SID instead of discarding it. Each dispatch-offer send carries a
`statusCallback` URL with `?offerId=<DispatchOffer.id>` — the offer row's
own primary key, known *before* the send happens, not something fetched
back after. This is deliberate: an earlier draft of this plan tried to
correlate Twilio's async callback to a row via the Message SID alone,
persisted only after the send resolved — multi-llm review (Codex + Gemini +
a fresh Claude reviewer) caught that this has a real race (a fast callback
can arrive before its SID is even in the DB, and gets silently dropped) and
a missing-index cost. Keying the callback URL on `offerId` — covered by
Twilio's own request signature, so it can't be tampered with — sidesteps
both: the webhook updates by primary key directly, with zero dependency on
send-side persistence timing. `DispatchService` still persists the SID too
(a secondary, best-effort debugging aid — see Task 3), but nothing
correctness-critical depends on it landing before any callback arrives. A
new, separate webhook route receives Twilio's async status callback,
validated via Twilio's own request-signature check, and updates that same
row. The admin API and UI surface the result. Two repos: `lrr-service`
(Tasks 1–5) and `lrr-web` (Task 6).

**Tech Stack:** NestJS + Prisma (lrr-service), Next.js (lrr-web), Twilio
WhatsApp SDK (`twilio` npm package, v6), Jest (unit + real-Postgres
integration tests).

**Spec:** `docs/superpowers/specs/2026-10-20-dispatch-offer-delivery-status-design.md`

## Global Constraints

- Scope is dispatch-offer sends **only** — no other outbound WhatsApp send
  (OTP, payment reminders, staff alerts, countdown notices) gets this
  treatment.
- No backfill. Historical `DispatchOffer` rows are never retroactively
  updated; the new columns are nullable and simply stay `null` for them.
- No dispatch-behavior change. A confirmed `undelivered`/`failed` status
  never skips an operator in a later round, expands the radius, or retries
  anything. Visibility only.
- `deliveryStatus` stores Twilio's own status string verbatim (`sent`,
  `delivered`, `read`, `undelivered`, `failed`, etc.) — not a Prisma enum.
- The new webhook route (`POST /api/v1/webhooks/twilio-status`) is
  registered as the `statusCallback` only on dispatch-offer sends, built
  from the existing `API_BASE_URL` env var — never a Twilio Console-level
  default, so other send types never hit it. **Note the `/api/v1` prefix**:
  `main.ts` calls `app.setGlobalPrefix('api/v1')`, so every route in this
  app — including this one — is actually served under that prefix. Both the
  URL registered as the `statusCallback` and the URL reconstructed for
  signature verification must include it, or the callback 404s and the
  signature check fails even on a genuine request.
- The existing inbound webhook's missing Twilio-signature validation is a
  separate, pre-existing gap — not touched by this plan.
- Every "Commit" step in this plan means: stage the files, run `git diff
  --cached` and show it in full along with a proposed commit message, then
  **stop and wait for explicit approval before running `git commit`**. This
  repo's CLAUDE.md requires per-commit approval for every commit, with no
  exception for plan/task-automation commits — never run `git commit`
  without that approval having been given for that specific diff.

## Review Focus

- A status callback's `offerId` matches no `DispatchOffer` (a stale/replayed
  callback, a tampered query param that still passes signature validation
  for some other reason, or an id from before this shipped) — must no-op,
  not error.
- The status callback's signature fails validation (forged or malformed
  request, including a missing `X-Twilio-Signature` header) — must be
  rejected cleanly, never trusted or allowed to write. (Verified against the
  installed `twilio` package's actual source: `validateRequest` defaults a
  missing header to `""` before any further processing, so this fails
  validation rather than throwing — no special null-check needed in our own
  code, just a test proving the behavior.)
- `API_BASE_URL` is unset (e.g. local dev) — the dispatch-offer send must
  still succeed, just without a `statusCallback`, matching the existing
  best-effort pattern already used elsewhere in this file for the same env
  var.
- Persisting a SID onto one offer's row fails (e.g. a transient DB error)
  independently of the Twilio send succeeding — must not block persisting
  the SID for any other offer in the same batch. (Lower stakes than in an
  earlier draft of this plan: the webhook no longer depends on this SID
  being persisted to find the row, so a failure here only loses the
  debugging convenience of cross-referencing Twilio's own dashboard, not
  any delivery-status tracking.)
- Callbacks for the same offer can arrive out of order (network delays,
  Twilio retries) — a later callback reporting an *earlier* lifecycle stage
  than what's already recorded (e.g. a delayed `sent` arriving after
  `undelivered` was already stored) must not overwrite the more-advanced,
  more-informative status, and must not reset `deliveryErrorCode` to null
  in the process.
- A `MessageStatus` value that isn't `undelivered`/`failed` (e.g. `sent`,
  `delivered`, `read`, or any future Twilio status) — must persist verbatim
  with no special-casing or crash, and must not trigger the Sentry alert
  reserved for confirmed failures, *as long as it isn't a stale out-of-order
  callback per the point above*.

---

### Task 1: Schema migration — delivery-status columns on `DispatchOffer`

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_dispatch_offer_delivery_status/migration.sql`

**Interfaces:**
- Produces: `DispatchOffer.twilioMessageSid: string | null`,
  `DispatchOffer.deliveryStatus: string | null`,
  `DispatchOffer.deliveryErrorCode: number | null` — every later task reads
  or writes these exact field names via the generated Prisma client.

- [ ] **Step 1: Add the three columns to the schema**

In `prisma/schema.prisma`, find the `DispatchOffer` model:

```prisma
model DispatchOffer {
  id String @id @default(cuid())

  rescueRequestId String
  rescueRequest   RescueRequest @relation(fields: [rescueRequestId], references: [id])

  operatorId String
  operator   Operator @relation(fields: [operatorId], references: [id])

  status                 DispatchOfferStatus @default(PENDING)
  quotedPrice            Int?
  depositPercentSnapshot Decimal?
  offeredAt              DateTime            @default(now())
  respondedAt            DateTime?
  expiresAt              DateTime

  batchId String

  dispatchRound Int

  @@index([rescueRequestId])
  @@index([operatorId])
  @@index([status])
  @@index([rescueRequestId, batchId])
}
```

Add the three new fields after `expiresAt` (keep existing alignment style —
don't run `prisma format` on the whole file, it reformats unrelated models;
hand-align just this block):

```prisma
model DispatchOffer {
  id String @id @default(cuid())

  rescueRequestId String
  rescueRequest   RescueRequest @relation(fields: [rescueRequestId], references: [id])

  operatorId String
  operator   Operator @relation(fields: [operatorId], references: [id])

  status                 DispatchOfferStatus @default(PENDING)
  quotedPrice            Int?
  depositPercentSnapshot Decimal?
  offeredAt              DateTime            @default(now())
  respondedAt            DateTime?
  expiresAt              DateTime

  // Set once the send resolves with a SID (Task 3) — nullable because
  // historical rows predate this feature and some sends may never resolve.
  twilioMessageSid String?
  // Twilio's own status string, verbatim (sent/delivered/read/undelivered/
  // failed/...) — not an enum, so a future Twilio status needs no code
  // change to keep recording. Set by the status-callback webhook (Task 4).
  deliveryStatus String?
  // Twilio's numeric error code (e.g. 63024) when deliveryStatus is
  // undelivered/failed — lets staff debug without a Twilio console trip.
  deliveryErrorCode Int?

  batchId String

  dispatchRound Int

  @@index([rescueRequestId])
  @@index([operatorId])
  @@index([status])
  @@index([rescueRequestId, batchId])
}
```

- [ ] **Step 2: Generate the migration against the Docker test Postgres**

```bash
docker compose -f docker-compose.test.yml up -d
# wait for healthy:
until docker compose -f docker-compose.test.yml ps postgres-test --format json | grep -q '"Health":"healthy"'; do sleep 2; done
DATABASE_URL=postgresql://lrr:lrr@localhost:5433/lrr_test npx prisma migrate dev --name dispatch_offer_delivery_status
```

Expected: a new `prisma/migrations/<timestamp>_dispatch_offer_delivery_status/migration.sql`
containing exactly three `ALTER TABLE "DispatchOffer" ADD COLUMN ...`
statements (nullable, no default needed — no data-carry-forward concern
here, unlike the earlier `disputeAlertPhoneNumbers` migration). No hand
edits needed; these are pure additive nullable columns.

- [ ] **Step 3: Regenerate the Prisma client and verify**

```bash
npx prisma generate
npx tsc --noEmit
```

Expected: clean typecheck. `docker compose -f docker-compose.test.yml down -v`
once done.

- [ ] **Step 4: Stage and present for commit approval**

```bash
git add prisma/schema.prisma prisma/migrations/
git diff --cached
```

Show the full staged diff and this proposed message, then **stop — do not
run `git commit` until the user explicitly approves this diff**:

```
Add delivery-status columns to DispatchOffer
```

---

### Task 2: `TwilioService` — return the SID, accept a status callback, verify signatures

**Files:**
- Modify: `src/integrations/twilio/twilio.service.ts`
- Test: `src/integrations/twilio/twilio.service.spec.ts`

**Interfaces:**
- Produces: `sendWhatsAppMessage(to: string, message: string, options?: { statusCallback?: string }): Promise<{ sid: string }>`,
  `sendWhatsAppTemplateMessage(to: string, contentSid: string, variables: Record<string, string>, options?: { statusCallback?: string }): Promise<{ sid: string }>`,
  `verifyStatusCallbackSignature(signature: string, url: string, params: Record<string, string>): boolean`.
  Task 3 and Task 4 both call these exact signatures.

The existing 13 other call sites of `sendWhatsAppMessage`/
`sendWhatsAppTemplateMessage` (everything except `sendDispatchOfferMessage`,
touched in Task 3) need **no changes** — none of them destructure the
return value today, and the new `options` parameter is optional.

- [ ] **Step 1: Write the failing tests**

Add a manual mock for the `twilio` package at the top of
`src/integrations/twilio/twilio.service.spec.ts`, and the new test cases.
Replace the full file with:

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TwilioMediaDownloadError, TwilioService } from './twilio.service';

const mockMessagesCreate = jest.fn();
const mockValidateRequest = jest.fn();

jest.mock('twilio', () => ({
  Twilio: jest.fn().mockImplementation(() => ({
    messages: { create: mockMessagesCreate },
  })),
  validateRequest: (...args: unknown[]) => mockValidateRequest(...args),
}));

describe('TwilioService', () => {
  let service: TwilioService;

  beforeEach(async () => {
    mockMessagesCreate.mockReset();
    mockValidateRequest.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TwilioService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const values: Record<string, string> = {
                TWILIO_ACCOUNT_SID: 'ACtest',
                TWILIO_AUTH_TOKEN: 'test-token',
                TWILIO_WHATSAPP_FROM: '+14155238886',
              };
              return values[key];
            },
          },
        },
      ],
    }).compile();

    service = module.get<TwilioService>(TwilioService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('sendWhatsAppMessage', () => {
    it('returns the Twilio-assigned SID', async () => {
      mockMessagesCreate.mockResolvedValue({ sid: 'SM123' });

      const result = await service.sendWhatsAppMessage(
        '+2348012345678',
        'hello',
      );

      expect(result).toEqual({ sid: 'SM123' });
    });

    it('passes statusCallback through to Twilio when given', async () => {
      mockMessagesCreate.mockResolvedValue({ sid: 'SM123' });

      await service.sendWhatsAppMessage('+2348012345678', 'hello', {
        statusCallback: 'https://api.example.com/webhooks/twilio-status',
      });

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCallback: 'https://api.example.com/webhooks/twilio-status',
        }),
      );
    });

    it('omits statusCallback from the Twilio call when not given', async () => {
      mockMessagesCreate.mockResolvedValue({ sid: 'SM123' });

      await service.sendWhatsAppMessage('+2348012345678', 'hello');

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.not.objectContaining({ statusCallback: expect.anything() }),
      );
    });
  });

  describe('sendWhatsAppTemplateMessage', () => {
    it('returns the Twilio-assigned SID', async () => {
      mockMessagesCreate.mockResolvedValue({ sid: 'SM456' });

      const result = await service.sendWhatsAppTemplateMessage(
        '+2348012345678',
        'HXtest',
        { '1': 'a' },
      );

      expect(result).toEqual({ sid: 'SM456' });
    });

    it('passes statusCallback through to Twilio when given', async () => {
      mockMessagesCreate.mockResolvedValue({ sid: 'SM456' });

      await service.sendWhatsAppTemplateMessage(
        '+2348012345678',
        'HXtest',
        { '1': 'a' },
        { statusCallback: 'https://api.example.com/webhooks/twilio-status' },
      );

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCallback: 'https://api.example.com/webhooks/twilio-status',
        }),
      );
    });
  });

  describe('verifyStatusCallbackSignature', () => {
    it('delegates to Twilio\'s validateRequest with the configured auth token', () => {
      mockValidateRequest.mockReturnValue(true);

      const result = service.verifyStatusCallbackSignature(
        'sig123',
        'https://api.example.com/webhooks/twilio-status',
        { MessageSid: 'SM123', MessageStatus: 'delivered' },
      );

      expect(result).toBe(true);
      expect(mockValidateRequest).toHaveBeenCalledWith(
        'test-token',
        'sig123',
        'https://api.example.com/webhooks/twilio-status',
        { MessageSid: 'SM123', MessageStatus: 'delivered' },
      );
    });

    it('returns false when validateRequest rejects the signature', () => {
      mockValidateRequest.mockReturnValue(false);

      const result = service.verifyStatusCallbackSignature(
        'bad-sig',
        'https://api.example.com/webhooks/twilio-status',
        { MessageSid: 'SM123' },
      );

      expect(result).toBe(false);
    });
  });

  describe('downloadMedia', () => {
    it('fetches the URL with Basic Auth using the Twilio credentials and returns a Buffer', async () => {
      const fakeBytes = new Uint8Array([1, 2, 3]);
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => fakeBytes.buffer,
      });
      global.fetch = fetchMock as any;

      const result = await service.downloadMedia(
        'https://api.twilio.com/media/ME123',
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.twilio.com/media/ME123',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Basic ${Buffer.from('ACtest:test-token').toString('base64')}`,
          }),
        }),
      );
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(Array.from(result)).toEqual([1, 2, 3]);
    });

    it('throws if the fetch response is not ok', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });

      await expect(
        service.downloadMedia('https://api.twilio.com/media/missing'),
      ).rejects.toMatchObject({
        name: 'TwilioMediaDownloadError',
        status: 404,
      } satisfies Partial<TwilioMediaDownloadError>);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
yarn test src/integrations/twilio/twilio.service.spec.ts
```

Expected: FAIL — `sendWhatsAppMessage` returns `undefined` (not
`{ sid: ... }`), `verifyStatusCallbackSignature` doesn't exist yet. Also
expect `mockMessagesCreate` to never actually have been invoked correctly
since the real constructor runs through the mocked `Twilio` — confirm the
failures are about missing return values / missing method, not a mock
wiring error (if `mockMessagesCreate` was never called at all, the mock
isn't wired right — fix that before moving on).

- [ ] **Step 3: Implement**

Replace the full file content of `src/integrations/twilio/twilio.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
import { Twilio, validateRequest } from 'twilio';

export class TwilioMediaDownloadError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly statusText: string,
  ) {
    super(`Failed to download Twilio media: ${status}`);
    this.name = 'TwilioMediaDownloadError';
  }
}

@Injectable()
export class TwilioService {
  private readonly client: Twilio;
  private readonly whatsappFrom: string;
  private readonly accountSid: string;
  private readonly authToken: string;

  constructor(private readonly configService: ConfigService) {
    this.accountSid =
      this.configService.get<string>('TWILIO_ACCOUNT_SID') || '';
    this.authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN') || '';
    this.whatsappFrom =
      this.configService.get<string>('TWILIO_WHATSAPP_FROM') || '';

    this.client = new Twilio(this.accountSid, this.authToken);
  }

  /**
   * Send a WhatsApp message to a user. Returns the Twilio Message SID so a
   * caller that cares (currently only dispatch-offer sends — see
   * DispatchService.deliverOffers) can persist it to correlate a later
   * delivery-status webhook callback back to the right row. `statusCallback`
   * is passed through to Twilio as-is; omit it for sends that shouldn't be
   * tracked (every call site except dispatch offers).
   */
  async sendWhatsAppMessage(
    to: string,
    message: string,
    options?: { statusCallback?: string },
  ): Promise<{ sid: string }> {
    try {
      // Accept either "+234..." or "whatsapp:+234..." — normalise here
      const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
      const result = await this.client.messages.create({
        from: `whatsapp:${this.whatsappFrom}`,
        to: formattedTo,
        body: message,
        ...(options?.statusCallback && {
          statusCallback: options.statusCallback,
        }),
      });
      console.log('WhatsApp message sent:', result.sid);
      return { sid: result.sid };
    } catch (error) {
      console.error('Failed to send WhatsApp message:', error);
      throw error;
    }
  }

  /**
   * Send a WhatsApp message using an approved Content Template.
   * Required for any business-initiated message outside a 24-hour customer
   * session window (e.g. an OTP code, a staff alert) — Meta rejects a
   * freeform `sendWhatsAppMessage` body in that case. `variables` maps
   * template placeholder numbers to values, e.g. { "1": "A1B2C3", "2": "https://..." }
   * for a template body using {{1}} and {{2}}. See `sendWhatsAppMessage` for
   * what `statusCallback`/the returned SID are for.
   */
  async sendWhatsAppTemplateMessage(
    to: string,
    contentSid: string,
    variables: Record<string, string>,
    options?: { statusCallback?: string },
  ): Promise<{ sid: string }> {
    try {
      const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
      const result = await this.client.messages.create({
        from: `whatsapp:${this.whatsappFrom}`,
        to: formattedTo,
        contentSid,
        contentVariables: JSON.stringify(variables),
        ...(options?.statusCallback && {
          statusCallback: options.statusCallback,
        }),
      });
      console.log('WhatsApp template message sent:', result.sid);
      return { sid: result.sid };
    } catch (error) {
      // Twilio's RestException carries the fields that actually identify
      // the problem (e.g. 21656 = ContentVariables don't match the
      // template's declared variables). error.message alone just says
      // "The Content Variables parameter is invalid", which is not enough
      // to tell a variable-shape bug from a bad ContentSid — attach the
      // structured fields, plus which SID and variable keys we sent.
      const twilioError = error as {
        code?: number;
        status?: number;
        moreInfo?: string;
        details?: unknown;
      };
      console.error('Failed to send WhatsApp template message:', {
        code: twilioError.code,
        status: twilioError.status,
        moreInfo: twilioError.moreInfo,
        details: twilioError.details,
        contentSid,
        sentVariableKeys: Object.keys(variables),
        error,
      });
      Sentry.captureException(error, {
        extra: {
          twilioCode: twilioError.code,
          twilioStatus: twilioError.status,
          twilioMoreInfo: twilioError.moreInfo,
          twilioDetails: twilioError.details,
          contentSid,
          sentVariableKeys: Object.keys(variables),
        },
      });
      throw error;
    }
  }

  /**
   * Verifies an inbound request really came from Twilio, for the
   * dispatch-offer delivery-status webhook (see WebhooksController). Unlike
   * Paystack's HMAC-over-raw-bytes check, Twilio's algorithm signs the
   * sorted, concatenated parsed params appended to the exact callback URL —
   * no raw-body access needed, just the parsed body and the same URL that
   * was registered as the statusCallback.
   */
  verifyStatusCallbackSignature(
    signature: string,
    url: string,
    params: Record<string, string>,
  ): boolean {
    return validateRequest(this.authToken, signature, url, params);
  }

  /**
   * Download media (photo/video/audio) from a Twilio-hosted MediaUrl.
   * Twilio media URLs require HTTP Basic Auth with the account SID/auth token.
   */
  async downloadMedia(url: string): Promise<Buffer> {
    const credentials = Buffer.from(
      `${this.accountSid}:${this.authToken}`,
    ).toString('base64');
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${credentials}` },
    });

    if (!response.ok) {
      throw new TwilioMediaDownloadError(
        url,
        response.status,
        response.statusText,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
yarn test src/integrations/twilio/twilio.service.spec.ts
```

Expected: all PASS.

- [ ] **Step 5: Full-project typecheck**

```bash
npx tsc --noEmit
```

Expected: clean — the other 13 call sites of `sendWhatsAppMessage`/
`sendWhatsAppTemplateMessage` compile unchanged since they never
destructured the previous `void` return.

- [ ] **Step 6: Stage and present for commit approval**

```bash
git add src/integrations/twilio/twilio.service.ts src/integrations/twilio/twilio.service.spec.ts
git diff --cached
```

Show the full staged diff and this proposed message, then **stop — do not
run `git commit` until the user explicitly approves this diff**:

```
TwilioService: return the Message SID, accept statusCallback, verify status-callback signatures
```

---

### Task 3: `DispatchService` — correlate, send, and persist the SID for dispatch offers

**Files:**
- Modify: `src/rescue-request/dto/pending-offer.dto.ts`
- Modify: `src/rescue-request/dispatch.service.ts`
- Test: `src/rescue-request/dispatch.service.spec.ts`
- Test: `test/integration/dispatch-round-state.int-spec.ts`

**Interfaces:**
- Consumes: `TwilioService.sendWhatsAppMessage`/`sendWhatsAppTemplateMessage`
  returning `Promise<{ sid: string }>` and accepting `options?.statusCallback`
  (Task 2).
- Produces: `PendingOffer.offerId: string` — not consumed by any later task,
  but changes the shape every existing test in the `startDispatch` describe
  block constructs/asserts against. Also produces
  `DispatchService.sendDispatchOfferMessage`'s new second parameter,
  `offerId: string` — Task 4's webhook relies on this same id appearing as
  the `?offerId=` query param on every dispatch-offer `statusCallback`.

**Design note — why `offerId`, not just the Twilio SID:** an earlier draft
of this plan correlated a status callback to a `DispatchOffer` row purely
by looking up the Twilio Message SID, persisted onto the row only after
the send resolved. Multi-llm review caught a real race in that: a fast
callback (exactly the near-instant failures, e.g. error 63024, this
feature exists to catch) can arrive before its SID is even written to the
DB, and would be silently dropped as unmatched. Putting the `DispatchOffer`
row's own `id` — known *before* the send, not fetched back after — directly
in the `statusCallback` URL as `?offerId=...` removes the race entirely:
the webhook updates by primary key, with no dependency on send-side
persistence timing at all. Twilio signs the complete callback URL
including its query string, so `offerId` can't be tampered with by
anything that doesn't also hold the Twilio auth token. The SID is still
captured and persisted (this task, Steps 6 and 12) as a secondary
debugging aid — useful for cross-referencing Twilio's own dashboard — but
nothing about the feature's correctness depends on that write landing
before any callback arrives.

- [ ] **Step 1: Add `offerId` to `PendingOffer`**

In `src/rescue-request/dto/pending-offer.dto.ts`, add the field:

```typescript
/**
 * A dispatch offer that has been written to the database but not yet sent.
 *
 * `prepareNextRound` returns these so its caller can commit the offer rows
 * inside its own transaction and send the WhatsApp messages only afterwards
 * — offers are exactly-once, messages are best-effort.
 */
export interface PendingOffer {
  /** The DispatchOffer row's own id — needed to persist the Twilio SID
   * back onto it once the send resolves (see DispatchService.deliverOffers). */
  offerId: string;
  operatorId: string;
  operatorPhone: string;
  jobRef: string;
  vehicle: string;
  destination: string;
  /** '' or 'Distance: X km\n' — trailing newline included. */
  distanceLine: string;
  /**
   * '' or 'Issue: X\n' — trailing newline included, informational only
   * (never used to filter or route dispatch). Freeform-send only for now —
   * see the comment on sendDispatchOfferMessage's templateVariables map.
   */
  issueLine: string;
  location: string;
  /** '' or the '\n\n📎 Photos/Video/Audio:\n...' block. */
  mediaSection: string;
  /** '' or 'Est. ETA: ~N min based on your registered location.\n'. */
  etaLine: string;
  window: string;
}
```

- [ ] **Step 2: Write the failing tests in `dispatch.service.spec.ts`**

These go inside the existing `describe('startDispatch — batch operator
notification', ...)` block (starts at line 1259). First, extend the
block's existing `afterEach`-based env-var restore to also cover
`API_BASE_URL` — new tests below mutate it, and restoring inline after
each test's own assertions (rather than in `afterEach`) would leak a
changed value into later tests whenever an assertion throws first. Find
(near the top of the describe block, just before the `candidateA`/
`candidateB` fixtures):

```typescript
    let sharedService: { formatLocationSection: jest.Mock };
    const originalTemplateSid = process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;

    const candidateA = {
```

and, a little further down:

```typescript
    afterEach(() => {
      if (originalTemplateSid === undefined)
        delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
      else process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = originalTemplateSid;
    });
```

Replace the first with (adds the new `const`, nothing else changes):

```typescript
    let sharedService: { formatLocationSection: jest.Mock };
    const originalTemplateSid = process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
    const originalApiBaseUrl = process.env.API_BASE_URL;

    const candidateA = {
```

Replace the second with (adds the matching restore):

```typescript
    afterEach(() => {
      if (originalTemplateSid === undefined)
        delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
      else process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = originalTemplateSid;
      if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
      else process.env.API_BASE_URL = originalApiBaseUrl;
    });
```

Next, update the shared `beforeEach` mocks that every test in this block
needs — without this, every existing test in the block breaks the moment
Task 3's implementation lands, because `deliverOffers` will start reading
`.sid` off whatever `sendWhatsAppMessage`/`sendWhatsAppTemplateMessage`
resolve to.

Find this block (around line 1309–1346):

```typescript
      prisma = {
        rescueRequest: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'req-1',
            status: 'DISPATCHING',
            vehicleType: 'SEDAN',
            destination: 'Lekki',
            latitude: 6.5,
            longitude: 3.4,
            // Dispatch progression is read from the request now, not the session.
            dispatchRound: 0,
            offeredOperatorIds: [],
            quoteCollectionDeadline: null,
            biddingClosedAt: null,
            customer: { phoneNumber: '+2348000000000' },
          }),
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ quoteCollectionDeadline: null }),
          update: jest.fn(),
        },
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ phoneNumber: '+2348000000000' }),
        },
        operator: { count: jest.fn() },
        dispatchOffer: {
          createMany: jest.fn(),
          count: jest.fn().mockResolvedValue(0),
          updateMany: jest.fn(),
        },
        requestMedia: { findMany: jest.fn().mockResolvedValue([]) },
        whatsAppSession: { updateMany: jest.fn() },
        // Offers and the offeredOperatorIds append commit together now, so
        // the callback runs against this same mock as its transaction client.
        $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      };
```

Replace with (adds `dispatchOffer.findMany` and `dispatchOffer.update`, and
a default `findMany` implementation that returns one row per operator the
test batch actually offers — matching by `operatorId` since that's what
`writeRound`'s new lookup groups by):

```typescript
      prisma = {
        rescueRequest: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'req-1',
            status: 'DISPATCHING',
            vehicleType: 'SEDAN',
            destination: 'Lekki',
            latitude: 6.5,
            longitude: 3.4,
            // Dispatch progression is read from the request now, not the session.
            dispatchRound: 0,
            offeredOperatorIds: [],
            quoteCollectionDeadline: null,
            biddingClosedAt: null,
            customer: { phoneNumber: '+2348000000000' },
          }),
          findUniqueOrThrow: jest
            .fn()
            .mockResolvedValue({ quoteCollectionDeadline: null }),
          update: jest.fn(),
        },
        user: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ phoneNumber: '+2348000000000' }),
        },
        operator: { count: jest.fn() },
        dispatchOffer: {
          createMany: jest.fn(),
          // Returns one row per distinct operatorId createMany was last
          // called with, so writeRound's offerId lookup always resolves —
          // the synthetic id just needs to be stable per operator, not
          // globally unique, for these tests.
          findMany: jest.fn().mockImplementation(() => {
            const lastCall =
              prisma.dispatchOffer.createMany.mock.calls.at(-1)?.[0];
            const operatorIds = (lastCall?.data ?? []).map(
              (d: { operatorId: string }) => d.operatorId,
            );
            return Promise.resolve(
              operatorIds.map((operatorId: string) => ({
                id: `offer-${operatorId}`,
                operatorId,
              })),
            );
          }),
          count: jest.fn().mockResolvedValue(0),
          update: jest.fn(),
          updateMany: jest.fn(),
        },
        requestMedia: { findMany: jest.fn().mockResolvedValue([]) },
        whatsAppSession: { updateMany: jest.fn() },
        // Offers and the offeredOperatorIds append commit together now, so
        // the callback runs against this same mock as its transaction client.
        $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      };
```

Next, find the `twilioService` mock a few lines down (around line 1363):

```typescript
      twilioService = {
        sendWhatsAppMessage: jest.fn(),
        sendWhatsAppTemplateMessage: jest.fn(),
      };
```

Replace with (default resolved value now includes a SID, since every
existing test's sends need to resolve to something `deliverOffers` can read
`.sid` off of):

```typescript
      twilioService = {
        sendWhatsAppMessage: jest.fn().mockResolvedValue({ sid: 'SM_default' }),
        sendWhatsAppTemplateMessage: jest
          .fn()
          .mockResolvedValue({ sid: 'SM_default' }),
      };
```

Now find the one existing test whose mock implementation explicitly
resolves to nothing, at line ~1604–1620
(`'one operator send failing does not block the others in the batch, and is
reported instead of thrown'`):

```typescript
    it('one operator send failing does not block the others in the batch, and is reported instead of thrown', async () => {
      twilioService.sendWhatsAppMessage.mockImplementation((to: string) => {
        if (to.includes('+2349011111111'))
          return Promise.reject(new Error('63016: outside messaging window'));
        return Promise.resolve();
      });

      await expect(
        batchService.startDispatch('req-1', 'cust-1'),
      ).resolves.toBeUndefined();

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledTimes(2); // both attempted
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349022222222'),
        expect.any(String),
      ); // the other operator still got theirs
    });
```

Change `return Promise.resolve();` to
`return Promise.resolve({ sid: 'SM_ok' });` — that's the only change this
test needs.

Now add four new tests at the end of the `startDispatch — batch operator
notification` block, right before its closing `});` (after the last
existing test, `'sends the shortlist instead of auto-cancelling when
candidates run out but a quote already exists — LRR-SERVICE-5'`):

```typescript
    it("persists the Twilio SID onto each offer's own row once its send resolves", async () => {
      twilioService.sendWhatsAppMessage.mockImplementation((to: string) =>
        Promise.resolve({
          sid: to.includes('+2349011111111') ? 'SM-op-a' : 'SM-op-b',
        }),
      );

      await batchService.startDispatch('req-1', 'cust-1');

      expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
        where: { id: 'offer-op-a' },
        data: { twilioMessageSid: 'SM-op-a' },
      });
      expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
        where: { id: 'offer-op-b' },
        data: { twilioMessageSid: 'SM-op-b' },
      });
    });

    it('persisting the SID for one offer failing does not block persisting it for the others', async () => {
      prisma.dispatchOffer.update.mockImplementation(
        (args: { where: { id: string } }) => {
          if (args.where.id === 'offer-op-a')
            return Promise.reject(new Error('db down'));
          return Promise.resolve();
        },
      );

      await expect(
        batchService.startDispatch('req-1', 'cust-1'),
      ).resolves.toBeUndefined();

      expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
        where: { id: 'offer-op-b' },
        data: { twilioMessageSid: 'SM_default' },
      });
    });

    it("includes a statusCallback URL built from API_BASE_URL, the /api/v1 global prefix, and this offer's own id", async () => {
      // /api/v1 matters: main.ts calls app.setGlobalPrefix('api/v1'), so
      // every route — including this webhook — is actually served under
      // it. A URL missing this prefix 404s in production; this test is
      // what catches that regression before it ships again.
      process.env.API_BASE_URL = 'https://api.example.com';

      await batchService.startDispatch('req-1', 'cust-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349011111111'),
        expect.any(String),
        {
          statusCallback:
            'https://api.example.com/api/v1/webhooks/twilio-status?offerId=offer-op-a',
        },
      );
      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.stringContaining('+2349022222222'),
        expect.any(String),
        {
          statusCallback:
            'https://api.example.com/api/v1/webhooks/twilio-status?offerId=offer-op-b',
        },
      );
    });

    it('sends successfully with no statusCallback argument at all when API_BASE_URL is unset', async () => {
      // Deliberately a 2-arg call, not a 3-arg call with an explicit
      // `undefined` third argument — see this task's Step 5 design note on
      // why the third argument is conditionally omitted rather than always
      // passed. A 3-arg assertion here would also silently diverge from
      // every pre-existing 2-arg assertion elsewhere in this file for the
      // exact same mock, which multi-llm review caught as a real breakage.
      delete process.env.API_BASE_URL;

      await expect(
        batchService.startDispatch('req-1', 'cust-1'),
      ).resolves.toBeUndefined();

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
      );
    });
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
yarn test src/rescue-request/dispatch.service.spec.ts -t "startDispatch"
```

Expected: FAIL. The 4 new tests fail because `writeRound` never calls
`dispatchOffer.findMany`, `offerId` is `undefined` on every `PendingOffer`,
`deliverOffers` never calls `dispatchOffer.update`, and
`sendDispatchOfferMessage` never passes a third `options` argument. The
pre-existing tests in this block should still PASS at this point (the
`beforeEach`/one-test mock-shape updates above don't depend on the
production code changing yet — they're compatible with both the old and new
`deliverOffers` behavior). If any pre-existing test now fails, stop and
check whether the mock changes accidentally changed its asserted call
shape rather than just its resolved value.

- [ ] **Step 4: Implement — `writeRound`'s offerId lookup**

In `src/rescue-request/dispatch.service.ts`, find (around line 682–690):

```typescript
    await tx.dispatchOffer.createMany({
      data: batch.map((op) => ({
        rescueRequestId,
        operatorId: op.id,
        expiresAt,
        batchId,
        dispatchRound: round,
      })),
    });
```

Add immediately after it:

```typescript
    await tx.dispatchOffer.createMany({
      data: batch.map((op) => ({
        rescueRequestId,
        operatorId: op.id,
        expiresAt,
        batchId,
        dispatchRound: round,
      })),
    });

    // createMany doesn't return the created rows, and no DispatchOffer.id
    // exists until this point — deliverOffers (after this transaction
    // commits) needs each row's own id to persist its Twilio SID onto the
    // right one. batchId is a fresh UUID generated above, unique to this
    // call, so this find can only return the rows just created.
    const createdOffers = await tx.dispatchOffer.findMany({
      where: { rescueRequestId, batchId },
      select: { id: true, operatorId: true },
    });
    const offerIdByOperatorId = new Map(
      createdOffers.map((o) => [o.operatorId, o.id]),
    );
```

Then find the function's final return statement (around line 726–741):

```typescript
    return batch.map((op) => ({
      operatorId: op.id,
      operatorPhone: op.phoneNumber,
      jobRef: jobRef.replace('Job #', ''),
      vehicle: vehicleLabel,
      destination: destinationLabel,
      distanceLine: `Distance: ${op.distance.toFixed(1)} km\n`,
      issueLine,
      location: locationSection,
      mediaSection,
      etaLine: `Est. ETA: ~${estimateEtaMinutes(op.distance)} min based on your registered location.\n`,
      // From the offer's ACTUAL expiry, not the configured window: an offer
      // created inside phase 2 may only have ninety seconds, and the message
      // must not claim otherwise.
      window: this.formatRemaining(expiresAt),
    }));
```

Add `offerId` as the first field:

```typescript
    return batch.map((op) => ({
      // Non-null: offerIdByOperatorId was built from the exact rows
      // createMany just inserted for this batch, keyed by the same op.id.
      offerId: offerIdByOperatorId.get(op.id)!,
      operatorId: op.id,
      operatorPhone: op.phoneNumber,
      jobRef: jobRef.replace('Job #', ''),
      vehicle: vehicleLabel,
      destination: destinationLabel,
      distanceLine: `Distance: ${op.distance.toFixed(1)} km\n`,
      issueLine,
      location: locationSection,
      mediaSection,
      etaLine: `Est. ETA: ~${estimateEtaMinutes(op.distance)} min based on your registered location.\n`,
      // From the offer's ACTUAL expiry, not the configured window: an offer
      // created inside phase 2 may only have ninety seconds, and the message
      // must not claim otherwise.
      window: this.formatRemaining(expiresAt),
    }));
```

- [ ] **Step 5: Implement — `sendDispatchOfferMessage` takes an `offerId`, returns the SID, passes a statusCallback**

Find (around line 103–179):

```typescript
  private async sendDispatchOfferMessage(
    operatorPhone: string,
    variables: {
      jobRef: string;
      vehicle: string;
      destination: string;
      /** '' or 'Distance: X km\n' — trailing newline included, absent when there's nothing to show (manualOfferToOperator). */
      distanceLine: string;
      /** '' or 'Issue: X\n' — trailing newline included, informational only. Freeform path only, see below. */
      issueLine: string;
      location: string;
      /** '' or the '\n\n📎 Photos/Video/Audio:\n...' block from buildMediaLinksSection — used as-is. */
      mediaSection: string;
      /** '' or 'Est. ETA: ~N min based on your registered location.\n' — trailing newline included. */
      etaLine: string;
      window: string;
    },
  ): Promise<void> {
    const templateSid = process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
    const to = toWhatsAppAddress(operatorPhone);

    if (templateSid) {
```

Change the return type, add an `offerId` parameter, and add the
`statusCallback` construction right after `const to = ...`:

```typescript
  private async sendDispatchOfferMessage(
    operatorPhone: string,
    // The DispatchOffer row's own id — embedded in the statusCallback URL
    // below so the webhook can find the right row with zero dependency on
    // whether/when its Twilio SID gets persisted. See this task's design
    // note at the top.
    offerId: string,
    variables: {
      jobRef: string;
      vehicle: string;
      destination: string;
      /** '' or 'Distance: X km\n' — trailing newline included, absent when there's nothing to show (manualOfferToOperator). */
      distanceLine: string;
      /** '' or 'Issue: X\n' — trailing newline included, informational only. Freeform path only, see below. */
      issueLine: string;
      location: string;
      /** '' or the '\n\n📎 Photos/Video/Audio:\n...' block from buildMediaLinksSection — used as-is. */
      mediaSection: string;
      /** '' or 'Est. ETA: ~N min based on your registered location.\n' — trailing newline included. */
      etaLine: string;
      window: string;
    },
  ): Promise<{ sid: string }> {
    const templateSid = process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
    const to = toWhatsAppAddress(operatorPhone);
    // Best-effort, same pattern as every other API_BASE_URL use in this
    // file: if it's unset (e.g. local/sandbox), the send still goes out,
    // just without delivery-status tracking. /api/v1 matches main.ts's
    // app.setGlobalPrefix('api/v1') — every route in this app, including
    // this webhook, is actually served under that prefix; omitting it
    // here means Twilio POSTs to a 404 and no status is ever recorded.
    // Twilio signs the full callback URL including the query string, so
    // offerId can't be tampered with by anything that doesn't also hold
    // the Twilio auth token.
    const apiBaseUrl = process.env.API_BASE_URL;
    // Deliberately a plain string, not `{ statusCallback } | undefined` —
    // whether the TwilioService call below gets a 3rd argument AT ALL is
    // decided per-call just below, not by passing `undefined` as a real
    // argument. Multi-llm review caught that `sendWhatsAppMessage(to, msg,
    // undefined)` is a 3-argument call as far as Jest's `toHaveBeenCalledWith`
    // is concerned — it does not match a 2-argument assertion — which would
    // have broken roughly a dozen pre-existing assertions elsewhere in this
    // file for a mock this same method change touches.
    const statusCallback = apiBaseUrl
      ? `${apiBaseUrl}/api/v1/webhooks/twilio-status?offerId=${offerId}`
      : undefined;

    if (templateSid) {
```

Then find the two `await this.twilioService...` calls inside the `if`/`else`
(around line 164–177):

```typescript
      await this.twilioService.sendWhatsAppTemplateMessage(
        to,
        templateSid,
        templateVariables,
      );
    } else {
      // Matches the original freeform layout exactly: Distance sits right
      // after Destination (before Location); ETA is its own line after the
      // bid prompt (before "Reply NO") — do not reorder these to "tidy up"
      // the message, the wording/order is what's already familiar to operators.
      await this.twilioService.sendWhatsAppMessage(
        to,
        `🚨 *NEW RESCUE JOB* — Job #${variables.jobRef}\n\nVehicle: ${variables.vehicle}\nDestination: ${variables.destination}\n${variables.issueLine}${variables.distanceLine}Location: ${variables.location}${variables.mediaSection}\n\n⚠️ *ACTION NEEDED* — reply with your price to bid, e.g. "25000".\n${variables.etaLine}Reply *NO* to decline.\nYou have ${variables.window} to respond.\n\n📌 If you have more than one job open at once, reply "${variables.jobRef} 25000" instead of just the price, so we know which job you mean.`,
      );
    }
  }
```

Change both to `return`, and only pass a 3rd argument when `statusCallback`
is actually set — never pass `{ statusCallback: undefined }` or a bare
`undefined` as a real 3rd positional argument:

```typescript
      return statusCallback
        ? this.twilioService.sendWhatsAppTemplateMessage(
            to,
            templateSid,
            templateVariables,
            { statusCallback },
          )
        : this.twilioService.sendWhatsAppTemplateMessage(
            to,
            templateSid,
            templateVariables,
          );
    } else {
      // Matches the original freeform layout exactly: Distance sits right
      // after Destination (before Location); ETA is its own line after the
      // bid prompt (before "Reply NO") — do not reorder these to "tidy up"
      // the message, the wording/order is what's already familiar to operators.
      const message = `🚨 *NEW RESCUE JOB* — Job #${variables.jobRef}\n\nVehicle: ${variables.vehicle}\nDestination: ${variables.destination}\n${variables.issueLine}${variables.distanceLine}Location: ${variables.location}${variables.mediaSection}\n\n⚠️ *ACTION NEEDED* — reply with your price to bid, e.g. "25000".\n${variables.etaLine}Reply *NO* to decline.\nYou have ${variables.window} to respond.\n\n📌 If you have more than one job open at once, reply "${variables.jobRef} 25000" instead of just the price, so we know which job you mean.`;
      return statusCallback
        ? this.twilioService.sendWhatsAppMessage(to, message, {
            statusCallback,
          })
        : this.twilioService.sendWhatsAppMessage(to, message);
    }
  }
```

(The freeform message is pulled into a local `const message` here so it
isn't duplicated across the two-way conditional — the string itself is
unchanged from before.)

- [ ] **Step 6: Implement — `deliverOffers` persists the SID per offer**

Find (around line 751–771):

```typescript
  async deliverOffers(offers: PendingOffer[]): Promise<void> {
    const results = await Promise.allSettled(
      offers.map((offer) =>
        this.sendDispatchOfferMessage(offer.operatorPhone, offer),
      ),
    );
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(
          `Failed to send dispatch offer to operator ${offers[i].operatorId}:`,
          result.reason,
        );
        Sentry.captureException(result.reason, {
          extra: {
            rescueRequestId: offers[i].jobRef,
            operatorId: offers[i].operatorId,
          },
        });
      }
    });
  }
```

Replace with (note the call site now also passes `offer.offerId` as the
second argument, matching Step 5's new signature):

```typescript
  async deliverOffers(offers: PendingOffer[]): Promise<void> {
    const results = await Promise.allSettled(
      offers.map((offer) =>
        this.sendDispatchOfferMessage(offer.operatorPhone, offer.offerId, offer),
      ),
    );
    await Promise.all(
      results.map(async (result, i) => {
        if (result.status === 'rejected') {
          console.error(
            `Failed to send dispatch offer to operator ${offers[i].operatorId}:`,
            result.reason,
          );
          Sentry.captureException(result.reason, {
            extra: {
              rescueRequestId: offers[i].jobRef,
              operatorId: offers[i].operatorId,
            },
          });
          return;
        }
        // Independent per offer — one row's update failing (e.g. a
        // transient DB error) must not stop the SID being persisted for
        // the others.
        try {
          await this.prisma.dispatchOffer.update({
            where: { id: offers[i].offerId },
            data: { twilioMessageSid: result.value.sid },
          });
        } catch (error) {
          console.error(
            `Failed to persist Twilio SID for offer ${offers[i].offerId}:`,
            error,
          );
          Sentry.captureException(error, {
            extra: {
              rescueRequestId: offers[i].jobRef,
              operatorId: offers[i].operatorId,
              offerId: offers[i].offerId,
            },
          });
        }
      }),
    );
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
yarn test src/rescue-request/dispatch.service.spec.ts -t "startDispatch"
```

Expected: all PASS — both the new tests and every pre-existing test in the
`startDispatch` block.

```bash
grep -rn "operatorPhone:" src/rescue-request/*.spec.ts
```

If this turns up a `PendingOffer`-shaped object literal anywhere outside
the `startDispatch` block already updated above, add `offerId: 'offer-test'`
(or similar) to it — TypeScript's compiler (Step 14) will also catch any
missed literal.

**Multi-llm review also caught a real gap not covered by anything above:**
every Twilio mock in this repo's unit tests is hand-written per describe
block, but `test/integration/dispatch-round-state.int-spec.ts` is the only
place `startDispatch`/`deliverOffers` run against a real Postgres rather
than a mocked `PrismaService` — and its Twilio stub still resolves
`undefined`, which Step 5/6's new code treats as a `{ sid: string }`. The
next two steps fix this, and use the real database to prove something the
unit tests' own mocked `findMany` can't: that the `offerId` `writeRound`
(Step 4) hands back is an id that actually exists in the `DispatchOffer`
table, not just a value the test double was told to return.

- [ ] **Step 8: Update `dispatch-round-state.int-spec.ts`'s Twilio mocks and assert the SID round-trips through Postgres**

Find in `test/integration/dispatch-round-state.int-spec.ts` (around line
36–40):

```typescript
    const twilio = {
      sendWhatsAppMessage: jest.fn().mockResolvedValue(undefined),
      sendWhatsAppTemplateMessage: jest.fn().mockResolvedValue(undefined),
    };
```

Replace with (Step 5 changes both methods' return type to
`Promise<{ sid: string }>` — leaving this resolving `undefined` would make
`deliverOffers`'s new `result.value.sid` read `undefined.sid` and throw,
failing every test in this file):

```typescript
    const twilio = {
      sendWhatsAppMessage: jest.fn().mockResolvedValue({ sid: 'SM_test' }),
      sendWhatsAppTemplateMessage: jest
        .fn()
        .mockResolvedValue({ sid: 'SM_test' }),
    };
```

Then extend the first test (`records the round and the operators offered
on the REQUEST, not the session`, around line 109–113) — it already loads
`offers` for its own assertion; add one more line to the same block:

```typescript
    const offers = await prisma.dispatchOffer.findMany({
      where: { rescueRequestId: request.id },
    });
    expect(offers).toHaveLength(1);
    expect(offers[0].dispatchRound).toBe(after.dispatchRound);
    expect(offers[0].twilioMessageSid).toBe('SM_test');
```

The new line is the proof: `deliverOffers` only reaches that `update` call
if the `offerId` on the `PendingOffer` it received resolved to a real row
in this table — a mocked `findMany` in the unit tests can return any
string and the mock would never notice if `writeRound` had the lookup
wrong.

- [ ] **Step 9: Run the integration suite to verify it still passes**

```bash
yarn test:integration:up
yarn test:integration test/integration/dispatch-round-state.int-spec.ts
yarn test:integration:down
```

Expected: all 3 tests PASS, including the new `twilioMessageSid` assertion.

- [ ] **Step 10: Write the failing tests for `manualOfferToOperator`**

In the `describe('manualOfferToOperator', ...)` block, first extend its
existing `afterEach`-based env-var restore to also cover `API_BASE_URL` —
same reasoning as Task 3 Step 2's identical change to the `startDispatch`
block: a new test below mutates it, and restoring inline after that test's
own assertions (rather than in `afterEach`) would leak a changed value
into later tests whenever an assertion throws first. Find (near the top of
this describe block):

```typescript
    let sharedService: { formatLocationSection: jest.Mock };
    const originalTemplateSid = process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;

    afterEach(() => {
      if (originalTemplateSid === undefined)
        delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
      else process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = originalTemplateSid;
    });
```

Replace with:

```typescript
    let sharedService: { formatLocationSection: jest.Mock };
    const originalTemplateSid = process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
    const originalApiBaseUrl = process.env.API_BASE_URL;

    afterEach(() => {
      if (originalTemplateSid === undefined)
        delete process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID;
      else process.env.TWILIO_DISPATCH_OFFER_TEMPLATE_SID = originalTemplateSid;
      if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
      else process.env.API_BASE_URL = originalApiBaseUrl;
    });
```

Next, extend its `prisma.dispatchOffer` mock type and the `beforeEach` that
builds it — find:

```typescript
      dispatchOffer: { create: jest.Mock; updateMany: jest.Mock };
```

Replace with:

```typescript
      dispatchOffer: {
        create: jest.Mock;
        update: jest.Mock;
        updateMany: jest.Mock;
      };
```

Find, in the `beforeEach`:

```typescript
        dispatchOffer: { create: jest.fn(), updateMany: jest.fn() },
```

Replace with:

```typescript
        dispatchOffer: {
          create: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn(),
        },
```

Find the `twilioService` mock a few lines below:

```typescript
      twilioService = {
        sendWhatsAppMessage: jest.fn(),
        sendWhatsAppTemplateMessage: jest.fn(),
      };
```

Replace with (same reasoning as the `startDispatch` block: once
`sendDispatchOfferMessage` returns `{ sid }`, every existing test's send
needs to resolve to something real):

```typescript
      twilioService = {
        sendWhatsAppMessage: jest.fn().mockResolvedValue({ sid: 'SM_manual_default' }),
        sendWhatsAppTemplateMessage: jest
          .fn()
          .mockResolvedValue({ sid: 'SM_manual_default' }),
      };
```

Every existing happy-path test in this block already sets
`prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-1' })` itself —
no change needed there; the implementation step below reads that same
`id` back.

Now add two new tests, anywhere after the existing
`'creates a single-operator round: offer created and recorded in one
transaction, WhatsApp sent'` test:

```typescript
    it("persists the Twilio SID onto the manually-created offer's own row", async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        status: 'ACTIVE',
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-manual-1' });
      twilioService.sendWhatsAppMessage.mockResolvedValue({
        sid: 'SM-manual-1',
      });

      await manualService.manualOfferToOperator('req-1', 'op-1');

      expect(prisma.dispatchOffer.update).toHaveBeenCalledWith({
        where: { id: 'offer-manual-1' },
        data: { twilioMessageSid: 'SM-manual-1' },
      });
    });

    it('includes the offerId query param on the statusCallback URL for a manual offer', async () => {
      process.env.API_BASE_URL = 'https://api.example.com';
      prisma.rescueRequest.findUnique.mockResolvedValue({
        id: 'req-1',
        status: 'DISPATCHING',
        customerId: 'cust-1',
        vehicleType: 'SEDAN',
        destination: 'Lekki',
        latitude: 6.5,
        longitude: 3.4,
      });
      prisma.operator.findUnique.mockResolvedValue({
        id: 'op-1',
        status: 'ACTIVE',
        businessName: 'Swift Towing',
        phoneNumber: '+2349012345678',
      });
      prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });
      prisma.dispatchOffer.create.mockResolvedValue({ id: 'offer-manual-1' });

      await manualService.manualOfferToOperator('req-1', 'op-1');

      expect(twilioService.sendWhatsAppMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        {
          statusCallback:
            'https://api.example.com/api/v1/webhooks/twilio-status?offerId=offer-manual-1',
        },
      );
      // Restored by this block's afterEach, not inline here — an assertion
      // throwing above would otherwise leave API_BASE_URL set for later
      // tests.
    });
```

- [ ] **Step 11: Run the new tests to verify they fail**

```bash
yarn test src/rescue-request/dispatch.service.spec.ts -t "manualOfferToOperator"
```

Expected: FAIL — `manualOfferToOperator` doesn't capture the created
offer's id or pass it to `sendDispatchOfferMessage` yet, and never persists
the returned SID. Every pre-existing test in this block should still PASS.

- [ ] **Step 12: Implement — capture the offer id and persist the SID in `manualOfferToOperator`**

Find (around line 1130–1153 before this task's other edits shifted line
numbers):

```typescript
    await this.prisma.$transaction(async (tx) => {
      const { dispatchRound } = await tx.rescueRequest.findUniqueOrThrow({
        where: { id: rescueRequestId },
        select: { dispatchRound: true },
      });

      await tx.dispatchOffer.create({
        data: {
          rescueRequestId,
          operatorId,
          expiresAt,
          batchId,
          dispatchRound,
        },
      });

      // `push` rather than a read-modify-write: an automatic round appending
      // concurrently must not silently drop this operator, which would let
      // them be offered the same job twice.
      await tx.rescueRequest.update({
        where: { id: rescueRequestId },
        data: { offeredOperatorIds: { push: [operatorId] } },
      });
    });
```

Replace with (captures the created row and returns it out of the
transaction — `create()`, unlike `createMany()`, already returns the row,
so no extra lookup is needed here the way Task 3 Step 4 needed one for the
batch path):

```typescript
    const createdOffer = await this.prisma.$transaction(async (tx) => {
      const { dispatchRound } = await tx.rescueRequest.findUniqueOrThrow({
        where: { id: rescueRequestId },
        select: { dispatchRound: true },
      });

      const offer = await tx.dispatchOffer.create({
        data: {
          rescueRequestId,
          operatorId,
          expiresAt,
          batchId,
          dispatchRound,
        },
      });

      // `push` rather than a read-modify-write: an automatic round appending
      // concurrently must not silently drop this operator, which would let
      // them be offered the same job twice.
      await tx.rescueRequest.update({
        where: { id: rescueRequestId },
        data: { offeredOperatorIds: { push: [operatorId] } },
      });

      return offer;
    });
```

Then find the `sendDispatchOfferMessage` call further down:

```typescript
    try {
      await this.sendDispatchOfferMessage(operator.phoneNumber!, {
        jobRef: formatJobRef(rescueRequestId).replace('Job #', ''),
        vehicle: vehicleLabel,
        destination: destinationLabel,
        distanceLine: '', // not computed for a manual single-operator offer
        issueLine,
        location: locationSection,
        mediaSection,
        etaLine: '', // not computed for a manual single-operator offer
        window: this.formatRemaining(expiresAt), // true remaining time, clamped or not
      });
    } catch (error) {
      // Unlike the batch path (allSettled — a failed send must not block
      // the other operators in the round), this is a single admin-triggered
      // offer: the admin needs to see it failed, so re-throw after logging
      // for visibility — don't silently succeed.
      console.error(
        `Failed to send manual dispatch offer to operator ${operatorId}:`,
        error,
      );
      Sentry.captureException(error, {
        extra: { rescueRequestId, operatorId },
      });
      throw error;
    }
```

Replace with (passes `createdOffer.id`, then persists the SID in its own
try/catch — a failure here must not undo the fact that the message was
already sent, so it's logged and reported but never re-thrown, unlike a
send failure above it):

```typescript
    try {
      const { sid } = await this.sendDispatchOfferMessage(
        operator.phoneNumber!,
        createdOffer.id,
        {
          jobRef: formatJobRef(rescueRequestId).replace('Job #', ''),
          vehicle: vehicleLabel,
          destination: destinationLabel,
          distanceLine: '', // not computed for a manual single-operator offer
          issueLine,
          location: locationSection,
          mediaSection,
          etaLine: '', // not computed for a manual single-operator offer
          window: this.formatRemaining(expiresAt), // true remaining time, clamped or not
        },
      );
      try {
        await this.prisma.dispatchOffer.update({
          where: { id: createdOffer.id },
          data: { twilioMessageSid: sid },
        });
      } catch (error) {
        console.error(
          `Failed to persist Twilio SID for manual offer ${createdOffer.id}:`,
          error,
        );
        Sentry.captureException(error, {
          extra: { rescueRequestId, operatorId, offerId: createdOffer.id },
        });
      }
    } catch (error) {
      // Unlike the batch path (allSettled — a failed send must not block
      // the other operators in the round), this is a single admin-triggered
      // offer: the admin needs to see it failed, so re-throw after logging
      // for visibility — don't silently succeed.
      console.error(
        `Failed to send manual dispatch offer to operator ${operatorId}:`,
        error,
      );
      Sentry.captureException(error, {
        extra: { rescueRequestId, operatorId },
      });
      throw error;
    }
```

- [ ] **Step 13: Run the tests to verify they pass**

```bash
yarn test src/rescue-request/dispatch.service.spec.ts
```

Expected: all PASS — every test in the file, not just the two blocks
touched above (`writeRound`/`deliverOffers`/`manualOfferToOperator` are the
only callers of `sendDispatchOfferMessage`, but run the whole file to be
sure nothing else was missed).

- [ ] **Step 14: Full-project typecheck and lint**

```bash
npx tsc --noEmit
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 527
```

Expected: both clean. If the warning count is over 527, follow the
`merge-to-staging` skill's diff-against-baseline approach to find exactly
which warnings are new before fixing them — don't raise the ceiling.

- [ ] **Step 15: Stage and present for commit approval**

```bash
git add src/rescue-request/dto/pending-offer.dto.ts src/rescue-request/dispatch.service.ts src/rescue-request/dispatch.service.spec.ts test/integration/dispatch-round-state.int-spec.ts
git diff --cached
```

Show the full staged diff and this proposed message, then **stop — do not
run `git commit` until the user explicitly approves this diff**:

```
DispatchService: correlate dispatch-offer delivery status by offerId, capture and persist the Twilio SID
```

---

### Task 4: Delivery-status webhook

**Files:**
- Modify: `src/rescue-request/dispatch.service.ts`
- Modify: `src/webhooks/webhooks.controller.ts`
- Create: `src/webhooks/dto/twilio-status-callback.dto.ts`
- Test: `src/rescue-request/dispatch.service.spec.ts`
- Test: `src/webhooks/webhooks.controller.spec.ts` (new file)

**Interfaces:**
- Consumes: `TwilioService.verifyStatusCallbackSignature` (Task 2);
  `DispatchOffer.twilioMessageSid`/`deliveryStatus`/`deliveryErrorCode`
  (Task 1); `offerId` appearing on every dispatch-offer `statusCallback` URL
  as `?offerId=...` (Task 3).
- Produces: `DispatchService.handleDeliveryStatusUpdate(offerId: string, messageSid: string, status: string, errorCode: number | undefined): Promise<void>` —
  not consumed elsewhere in this plan, but is the method Task 5/6 implicitly
  rely on having run for `deliveryStatus` to ever be non-null.

- [ ] **Step 1: Write the failing `DispatchService` tests**

Add a new `describe` block to `src/rescue-request/dispatch.service.spec.ts`,
anywhere at the top level alongside the other `describe` blocks (e.g. right
after `describe('deliverQuoteShortlist', ...)`, which starts at line 1661):

```typescript
  describe('handleDeliveryStatusUpdate', () => {
    let service: DispatchService;
    let prisma: {
      dispatchOffer: { findUnique: jest.Mock; updateMany: jest.Mock };
    };
    let sentryCapture: jest.SpyInstance;

    beforeEach(async () => {
      prisma = {
        dispatchOffer: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'offer-1',
            rescueRequestId: 'req-1',
            operatorId: 'op-1',
          }),
          // count: 1 is the default "the write took" case most tests want.
          // A dedicated test below overrides this to count: 0 to exercise
          // the "guard rejected it" / stale-callback path.
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      sentryCapture = jest
        .spyOn(Sentry, 'captureMessage')
        .mockImplementation(() => '');

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DispatchService,
          { provide: PrismaService, useValue: prisma },
          { provide: TwilioService, useValue: {} },
          { provide: OperatorService, useValue: {} },
          { provide: PlatformConfigService, useValue: {} },
          { provide: WhatsAppSessionStore, useValue: {} },
          { provide: RescueRequestSharedService, useValue: {} },
          { provide: OperatorMembershipService, useValue: {} },
        ],
      }).compile();

      service = module.get<DispatchService>(DispatchService);
    });

    afterEach(() => {
      sentryCapture.mockRestore();
    });

    it('persists the SID, status, and error code via one atomic conditional update, tagged by the offer\'s own id', async () => {
      await service.handleDeliveryStatusUpdate(
        'offer-1',
        'SM123',
        'undelivered',
        63024,
      );

      expect(prisma.dispatchOffer.findUnique).toHaveBeenCalledWith({
        where: { id: 'offer-1' },
        select: { id: true, rescueRequestId: true, operatorId: true },
      });
      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'offer-1' }),
          data: {
            twilioMessageSid: 'SM123',
            deliveryStatus: 'undelivered',
            deliveryErrorCode: 63024,
          },
        }),
      );
    });

    it('persists a status with no error code (e.g. delivered) as deliveryErrorCode: null', async () => {
      await service.handleDeliveryStatusUpdate(
        'offer-1',
        'SM123',
        'delivered',
        undefined,
      );

      expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            twilioMessageSid: 'SM123',
            deliveryStatus: 'delivered',
            deliveryErrorCode: null,
          },
        }),
      );
    });

    it('no-ops when no offer matches the offerId, rather than throwing', async () => {
      prisma.dispatchOffer.findUnique.mockResolvedValue(null);

      await expect(
        service.handleDeliveryStatusUpdate(
          'offer-unknown',
          'SM-unknown',
          'undelivered',
          63024,
        ),
      ).resolves.toBeUndefined();

      expect(prisma.dispatchOffer.updateMany).not.toHaveBeenCalled();
    });

    describe('alerting — gated on whether the atomic update actually wrote anything', () => {
      it('fires a Sentry alert for an undelivered status when the update reports count: 1 (the write took)', async () => {
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'undelivered',
          63024,
        );

        expect(sentryCapture).toHaveBeenCalledWith(
          expect.stringContaining('undelivered'),
          expect.objectContaining({
            level: 'error',
            extra: expect.objectContaining({
              rescueRequestId: 'req-1',
              operatorId: 'op-1',
              messageSid: 'SM123',
              errorCode: 63024,
            }),
          }),
        );
      });

      it('fires a Sentry alert for a failed status', async () => {
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'failed',
          30008,
        );

        expect(sentryCapture).toHaveBeenCalled();
      });

      it('does not alert on a non-failure status (sent/delivered/read)', async () => {
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'delivered',
          undefined,
        );
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'read',
          undefined,
        );
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'sent',
          undefined,
        );

        expect(sentryCapture).not.toHaveBeenCalled();
      });

      it('does not alert when the atomic update reports count: 0 — the guard rejected a stale/out-of-order callback, nothing was actually written', async () => {
        // This is the case the old read-then-write design couldn't express
        // atomically: the real DB's WHERE clause is what decides whether
        // this write "counts," not a value this process read earlier.
        prisma.dispatchOffer.updateMany.mockResolvedValue({ count: 0 });

        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'undelivered',
          63024,
        );

        expect(sentryCapture).not.toHaveBeenCalled();
      });
    });

    describe('out-of-order guard construction', () => {
      // These test the WHERE clause DispatchService builds, not Prisma's
      // own filtering (that's covered by the real-Postgres integration
      // test added alongside this task — see Task 3's dispatch-round-state
      // integration-spec update). Assertions are content-based
      // (arrayContaining), not exact-order, since the guard's job is "which
      // statuses are/aren't in the allowed set," not array ordering.

      it('allows overwriting only a not-more-advanced existing status for a recognized incoming status', async () => {
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'sent',
          undefined,
        );

        const call = prisma.dispatchOffer.updateMany.mock.calls[0][0];
        expect(call.where.id).toBe('offer-1');
        const allowedExisting = call.where.OR.find(
          (clause: { deliveryStatus?: { in?: string[] } }) =>
            clause.deliveryStatus?.in,
        )?.deliveryStatus.in;
        // 'sent' only ranks above queued/accepted/sending.
        expect(allowedExisting).toEqual(
          expect.arrayContaining(['queued', 'accepted', 'sending', 'sent']),
        );
        expect(allowedExisting).not.toEqual(
          expect.arrayContaining(['delivered', 'read', 'undelivered', 'failed']),
        );
      });

      it('always allows a null existing deliveryStatus to be overwritten (the first-ever callback for an offer)', async () => {
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'sent',
          undefined,
        );

        const call = prisma.dispatchOffer.updateMany.mock.calls[0][0];
        expect(call.where.OR).toEqual(
          expect.arrayContaining([{ deliveryStatus: null }]),
        );
      });

      it('always allows overwriting an existing status this process does not recognize, for a recognized incoming status', async () => {
        // An unrecognized already-recorded status can't be ranked against
        // anything — rather than permanently block every future write to
        // this offer, the guard explicitly carves this out.
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'delivered',
          undefined,
        );

        const call = prisma.dispatchOffer.updateMany.mock.calls[0][0];
        const notInClause = call.where.OR.find(
          (clause: { deliveryStatus?: { notIn?: string[] } }) =>
            clause.deliveryStatus?.notIn,
        );
        expect(notInClause.deliveryStatus.notIn).toEqual(
          expect.arrayContaining([
            'queued',
            'sent',
            'delivered',
            'read',
            'undelivered',
            'failed',
          ]),
        );
      });

      it('applies no ranking constraint at all when the incoming status itself is unrecognized — never silently dropped', async () => {
        // Contrast with the old (pre-fix) design, which defaulted an
        // unrecognized status to rank 0 — the lowest possible — meaning it
        // would almost always lose to anything already recorded. Multi-llm
        // review caught that this contradicted the plan's own promise that
        // deliveryStatus is a raw string specifically so a future Twilio
        // status needs no code change to keep recording correctly.
        await service.handleDeliveryStatusUpdate(
          'offer-1',
          'SM123',
          'some-future-status',
          undefined,
        );

        expect(prisma.dispatchOffer.updateMany).toHaveBeenCalledWith({
          where: { id: 'offer-1' },
          data: {
            twilioMessageSid: 'SM123',
            deliveryStatus: 'some-future-status',
            deliveryErrorCode: null,
          },
        });
      });
    });
  });
```

`dispatch.service.spec.ts` does not import Sentry today (confirmed: no
match for `from '@sentry/node'` in the file) — add
`import * as Sentry from '@sentry/node';` to its import block at the top of
the file.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
yarn test src/rescue-request/dispatch.service.spec.ts -t "handleDeliveryStatusUpdate"
```

Expected: FAIL — `handleDeliveryStatusUpdate` doesn't exist on
`DispatchService` yet.

- [ ] **Step 3: Implement `handleDeliveryStatusUpdate`**

**Design note — why an atomic conditional update, not read-then-write:**
an earlier draft of this plan read the existing `deliveryStatus` first,
compared ranks in application code, and only then wrote. Multi-llm review
caught that this isn't actually race-free: Twilio routinely fires two
callbacks (e.g. `sent` then `delivered`) within milliseconds of each other
as separate HTTP requests, and two concurrent calls to this method can both
read the same stale `deliveryStatus` before either writes — the guard's
decision becomes stale the instant a second callback is also mid-flight,
which is exactly the regression it was meant to prevent. Folding the rank
check directly into the `updateMany`'s own `WHERE` clause makes the
database the single source of truth for "is this safe to write" at the
moment of the write itself — the same pattern this file already uses in
`claimOfferInTx`'s atomic offer claim.

**Design note — why unrecognized statuses get no ranking constraint at
all:** multi-llm review also caught that defaulting an unrecognized status
to rank 0 (as an earlier draft did) silently breaks two promises this plan
makes elsewhere: an unrecognized status *arriving* after any known status
would always lose and get dropped, and an unrecognized status *already
recorded* could be overwritten by literally anything. Since there's no way
to meaningfully rank a status this code doesn't recognize, the guard simply
doesn't apply the ranking comparison when either side is unrecognized —
only ranks statuses against each other when both are known.

In `src/rescue-request/dispatch.service.ts`, add this constant near the
file's other config constants at the top (alongside
`MAX_FAILED_ROUNDS_BEFORE_ALERT` etc.):

```typescript
// Ranks a Twilio delivery-status callback's lifecycle stage, so an
// out-of-order callback (arriving late over the network) can never
// overwrite a more-advanced, more-informative status already recorded —
// see handleDeliveryStatusUpdate. Terminal states (read/undelivered/
// failed) share the top rank; nothing legitimately follows any of them.
// A status not in this map (incoming OR already-recorded) is never ranked
// against anything — see handleDeliveryStatusUpdate's own comment on why
// guessing a rank for an unrecognized status is worse than not comparing
// it at all.
const DELIVERY_STATUS_RANK: Record<string, number> = {
  queued: 0,
  accepted: 0,
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  undelivered: 3,
  failed: 3,
};
```

Then add this method to `DispatchService` — a sensible spot is right after
`deliverOffers` (so the send-and-track-delivery logic for dispatch offers
stays grouped together):

```typescript
  /**
   * Called by the /webhooks/twilio-status route once Twilio reports a
   * dispatch offer's async delivery outcome. Visibility only — this never
   * changes dispatch behavior (no retry, no reroute, no radius expansion).
   * Looked up by the offer's own id (embedded in the statusCallback URL at
   * send time, see sendDispatchOfferMessage), not the Twilio SID — no
   * timing dependency on when/whether that SID gets persisted. An id
   * matching no offer (a stale/replayed callback, or one predating this
   * feature) is not an error.
   */
  async handleDeliveryStatusUpdate(
    offerId: string,
    messageSid: string,
    status: string,
    errorCode: number | undefined,
  ): Promise<void> {
    const offer = await this.prisma.dispatchOffer.findUnique({
      where: { id: offerId },
      select: { id: true, rescueRequestId: true, operatorId: true },
    });
    if (!offer) return;

    const incomingRank = DELIVERY_STATUS_RANK[status];
    // No ranking constraint at all when the incoming status itself isn't
    // one we recognize — see this step's design note above. When it IS
    // recognized, the existing row can only be overwritten if its current
    // deliveryStatus is null, is itself a recognized status ranked no
    // higher than the incoming one, or is a status we don't recognize
    // (can't rank it, so don't let it permanently block future writes).
    const guard =
      incomingRank === undefined
        ? {}
        : {
            OR: [
              { deliveryStatus: null },
              {
                deliveryStatus: {
                  in: Object.entries(DELIVERY_STATUS_RANK)
                    .filter(([, rank]) => rank <= incomingRank)
                    .map(([recognizedStatus]) => recognizedStatus),
                },
              },
              {
                deliveryStatus: {
                  notIn: Object.keys(DELIVERY_STATUS_RANK),
                },
              },
            ],
          };

    // Atomic: the guard is part of the WHERE clause itself, so two
    // concurrent callbacks for the same offer can never both read a stale
    // deliveryStatus and race each other — only one write can ever match a
    // given row's current state at a time.
    const result = await this.prisma.dispatchOffer.updateMany({
      where: { id: offerId, ...guard },
      data: {
        twilioMessageSid: messageSid,
        deliveryStatus: status,
        deliveryErrorCode: errorCode ?? null,
      },
    });
    // count: 0 means the guard rejected this write — a stale/out-of-order
    // callback, or the offerId didn't exist in the window between the
    // findUnique above and this update (vanishingly unlikely, never a
    // reason to alert). Nothing was written, so nothing to alert about.
    if (result.count === 0) return;

    if (status === 'undelivered' || status === 'failed') {
      Sentry.captureMessage(
        `Dispatch offer ${status} — ${formatJobRef(offer.rescueRequestId)}`,
        {
          level: 'error',
          extra: {
            rescueRequestId: offer.rescueRequestId,
            operatorId: offer.operatorId,
            messageSid,
            errorCode,
          },
        },
      );
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
yarn test src/rescue-request/dispatch.service.spec.ts -t "handleDeliveryStatusUpdate"
```

Expected: all PASS.

- [ ] **Step 5: Create the webhook payload DTO**

Create `src/webhooks/dto/twilio-status-callback.dto.ts`:

```typescript
/**
 * The parts of a Twilio status-callback payload we actually read.
 *
 * Deliberately partial and deliberately optional, same reasoning as
 * PaystackWebhookBody: this is untrusted input arriving over HTTP. The
 * signature (verified in WebhooksController before this is ever read)
 * proves it came from Twilio, not that any particular field is present.
 */
export interface TwilioStatusCallbackBody {
  MessageSid?: string;
  /** e.g. 'queued', 'sent', 'delivered', 'read', 'undelivered', 'failed'. */
  MessageStatus?: string;
  /** Present only on undelivered/failed — e.g. 63024. */
  ErrorCode?: string;
}
```

- [ ] **Step 6: Write the failing webhook controller test**

Create `src/webhooks/webhooks.controller.spec.ts` (no existing file for
this controller — this is new coverage, not a modification):

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import * as Sentry from '@sentry/node';
import { WebhooksController } from './webhooks.controller';
import { WhatsAppInboundService } from '../rescue-request/whatsapp-inbound.service';
import { PaymentService } from '../payment/payment.service';
import { DispatchService } from '../rescue-request/dispatch.service';
import { TwilioService } from '../integrations/twilio/twilio.service';

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let twilioService: { verifyStatusCallbackSignature: jest.Mock };
  let dispatchService: { handleDeliveryStatusUpdate: jest.Mock };
  let sentryCapture: jest.SpyInstance;
  const originalApiBaseUrl = process.env.API_BASE_URL;

  beforeEach(async () => {
    process.env.API_BASE_URL = 'https://api.example.com';
    twilioService = {
      verifyStatusCallbackSignature: jest.fn().mockReturnValue(true),
    };
    dispatchService = {
      handleDeliveryStatusUpdate: jest.fn().mockResolvedValue(undefined),
    };
    sentryCapture = jest
      .spyOn(Sentry, 'captureMessage')
      .mockImplementation(() => '');

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        { provide: WhatsAppInboundService, useValue: {} },
        { provide: PaymentService, useValue: {} },
        { provide: DispatchService, useValue: dispatchService },
        { provide: TwilioService, useValue: twilioService },
      ],
    }).compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  afterEach(() => {
    sentryCapture.mockRestore();
    if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBaseUrl;
  });

  describe('handleTwilioStatusCallback', () => {
    const body = {
      MessageSid: 'SM123',
      MessageStatus: 'undelivered',
      ErrorCode: '63024',
    };

    it('verifies the signature against the exact registered callback URL, including /api/v1 and the offerId query param', async () => {
      // /api/v1 matters: main.ts calls app.setGlobalPrefix('api/v1'), so
      // this route is actually served under that prefix — a verification
      // URL missing it would never match what Twilio actually signed.
      await controller.handleTwilioStatusCallback('offer-1', body, 'sig123');

      expect(twilioService.verifyStatusCallbackSignature).toHaveBeenCalledWith(
        'sig123',
        'https://api.example.com/api/v1/webhooks/twilio-status?offerId=offer-1',
        body,
      );
    });

    it('forwards offerId/MessageSid/MessageStatus/parsed ErrorCode to DispatchService on a valid signature', async () => {
      await controller.handleTwilioStatusCallback('offer-1', body, 'sig123');

      expect(dispatchService.handleDeliveryStatusUpdate).toHaveBeenCalledWith(
        'offer-1',
        'SM123',
        'undelivered',
        63024,
      );
    });

    it('passes undefined for ErrorCode when the callback has none (e.g. a delivered status)', async () => {
      await controller.handleTwilioStatusCallback(
        'offer-1',
        { MessageSid: 'SM123', MessageStatus: 'delivered' },
        'sig123',
      );

      expect(dispatchService.handleDeliveryStatusUpdate).toHaveBeenCalledWith(
        'offer-1',
        'SM123',
        'delivered',
        undefined,
      );
    });

    it('passes undefined for ErrorCode when Twilio sends a non-numeric value, rather than NaN', async () => {
      // Twilio has never been observed sending a non-numeric ErrorCode,
      // but this field is attacker/proxy-reachable input before it hits
      // an `Int` column — Number('not-a-number') is NaN, and persisting
      // NaN to an Int column is a Prisma runtime error, not a validation
      // error caught earlier in the request.
      await controller.handleTwilioStatusCallback(
        'offer-1',
        { MessageSid: 'SM123', MessageStatus: 'failed', ErrorCode: 'not-a-number' },
        'sig123',
      );

      expect(dispatchService.handleDeliveryStatusUpdate).toHaveBeenCalledWith(
        'offer-1',
        'SM123',
        'failed',
        undefined,
      );
    });

    it('rejects and never calls DispatchService when the signature is invalid', async () => {
      twilioService.verifyStatusCallbackSignature.mockReturnValue(false);

      const result = await controller.handleTwilioStatusCallback(
        'offer-1',
        body,
        'bad-sig',
      );

      expect(dispatchService.handleDeliveryStatusUpdate).not.toHaveBeenCalled();
      expect(sentryCapture).toHaveBeenCalledWith(
        expect.stringContaining('Invalid Twilio status callback signature'),
        'error',
      );
      expect(result).toEqual({ status: 'error', message: 'Invalid signature' });
    });

    it('does not call DispatchService when offerId is missing, even with a valid signature', async () => {
      // Defensive: Twilio always sends back whatever query string it was
      // given, but nothing enforces that at compile time on our side —
      // this proves a malformed/missing offerId still no-ops cleanly
      // rather than calling DispatchService with 'undefined' as an id.
      await controller.handleTwilioStatusCallback(
        undefined as unknown as string,
        body,
        'sig123',
      );

      expect(dispatchService.handleDeliveryStatusUpdate).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

```bash
yarn test src/webhooks/webhooks.controller.spec.ts
```

Expected: FAIL — `handleTwilioStatusCallback` doesn't exist on
`WebhooksController` yet, and the controller doesn't take `DispatchService`/
`TwilioService` in its constructor yet.

- [ ] **Step 8: Implement the controller route**

Replace the full content of `src/webhooks/webhooks.controller.ts`:

```typescript
import {
  Body,
  Controller,
  Post,
  Header,
  Headers,
  HttpCode,
  Query,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import * as Sentry from '@sentry/node';
import { WhatsAppInboundService } from '../rescue-request/whatsapp-inbound.service';
import { PaymentService } from '../payment/payment.service';
import { DispatchService } from '../rescue-request/dispatch.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { TwilioStatusCallbackBody } from './dto/twilio-status-callback.dto';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly whatsAppInboundService: WhatsAppInboundService,
    private readonly paymentService: PaymentService,
    private readonly dispatchService: DispatchService,
    private readonly twilioService: TwilioService,
  ) {}

  // Twilio WhatsApp webhook
  @Post('twilio')
  @Header('Content-Type', 'text/xml')
  async handleTwilioWebhook(@Body() body: Record<string, any>) {
    console.log('🔔 Twilio webhook received');
    return this.whatsAppInboundService.handleIncomingWhatsAppMessage(body);
  }

  /**
   * Twilio delivery-status callback — registered only as the
   * `statusCallback` on dispatch-offer sends (see
   * DispatchService.sendDispatchOfferMessage), never a Twilio
   * Console-level default, so no other send type reaches this route.
   * Validated the same way the callback URL was built at send time: the
   * exact `${API_BASE_URL}/api/v1/webhooks/twilio-status?offerId=...`
   * string, not whatever host/protocol this request happened to arrive
   * with — keeps validation correct regardless of a reverse proxy's
   * headers. Note the `/api/v1` — main.ts calls
   * app.setGlobalPrefix('api/v1'), so this route (like every route in the
   * app) is actually served under that prefix; a URL missing it both
   * 404s and fails signature verification even for a genuine request.
   */
  @Post('twilio-status')
  @HttpCode(200)
  async handleTwilioStatusCallback(
    @Query('offerId') offerId: string,
    @Body() body: TwilioStatusCallbackBody,
    @Headers('x-twilio-signature') signature: string,
  ) {
    const url = `${process.env.API_BASE_URL}/api/v1/webhooks/twilio-status?offerId=${offerId}`;
    if (
      !this.twilioService.verifyStatusCallbackSignature(
        signature,
        url,
        body as Record<string, string>,
      )
    ) {
      console.error('❌ Invalid Twilio status callback signature');
      Sentry.captureMessage(
        'Invalid Twilio status callback signature received',
        'error',
      );
      return { status: 'error', message: 'Invalid signature' };
    }

    if (offerId && body.MessageSid && body.MessageStatus) {
      // Twilio's ErrorCode is a numeric string ("63024"), but it's still
      // attacker/proxy-reachable input before it hits an `Int` column —
      // Number('') is 0 and Number('abc') is NaN, neither a code Twilio
      // ever sends, so only a genuinely finite parse is forwarded.
      const parsedErrorCode = body.ErrorCode
        ? Number(body.ErrorCode)
        : undefined;
      await this.dispatchService.handleDeliveryStatusUpdate(
        offerId,
        body.MessageSid,
        body.MessageStatus,
        Number.isFinite(parsedErrorCode) ? parsedErrorCode : undefined,
      );
    }

    return { status: 'ok' };
  }

  // Paystack webhook
  @Post('paystack')
  @HttpCode(200)
  async handlePaystackWebhook(
    @Body() body: any,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-paystack-signature') signature: string,
  ) {
    console.log('🔔 Paystack webhook received');
    console.log('Body:', JSON.stringify(body, null, 2));
    console.log('Signature:', signature);

    // Verify against the exact request bytes Paystack signed — re-serializing
    // the parsed body (JSON.stringify(body)) does not reliably reproduce
    // Paystack's original payload, so that comparison fails signatures that
    // are actually valid.
    if (
      !req.rawBody ||
      !this.paymentService.verifyWebhookSignature(req.rawBody, signature)
    ) {
      console.error('❌ Invalid Paystack webhook signature');
      Sentry.captureMessage(
        'Invalid Paystack webhook signature received',
        'error',
      );
      return { status: 'error', message: 'Invalid signature' };
    }

    console.log('✅ Paystack webhook signature verified');
    console.log('Processing event:', body.event);

    return this.paymentService.handlePaystackWebhook(body);
  }
}
```

- [ ] **Step 9: Wire `TwilioModule` into `WebhooksModule`**

`DispatchService` is already exported from `RescueRequestModule`, which
`WebhooksModule` already imports — no change needed there. `TwilioService`
is not yet available to `WebhooksModule`, though. In
`src/webhooks/webhooks.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';
import { RescueRequestModule } from '../rescue-request/rescue-request.module';
import { PaymentModule } from '../payment/payment.module';
import { TwilioModule } from '../integrations/twilio/twilio.module';

@Module({
  imports: [RescueRequestModule, PaymentModule, TwilioModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
```

- [ ] **Step 10: Run the test to verify it passes**

```bash
yarn test src/webhooks/webhooks.controller.spec.ts
```

Expected: all PASS.

- [ ] **Step 11: Full-project typecheck, lint, and unit suite**

```bash
npx tsc --noEmit
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 527
yarn test --ci
```

Expected: all clean.

- [ ] **Step 12: Stage and present for commit approval**

```bash
git add src/rescue-request/dispatch.service.ts src/rescue-request/dispatch.service.spec.ts src/webhooks/webhooks.controller.ts src/webhooks/webhooks.controller.spec.ts src/webhooks/webhooks.module.ts src/webhooks/dto/twilio-status-callback.dto.ts
git diff --cached
```

Show the full staged diff and this proposed message, then **stop — do not
run `git commit` until the user explicitly approves this diff**:

```
Add POST /api/v1/webhooks/twilio-status: validated delivery-status callback for dispatch offers
```

---

### Task 5: Admin API — surface delivery status

**Files:**
- Modify: `src/rescue-request/dto/rescue-request-response.dto.ts`
- Modify: `src/rescue-request/rescue-request-admin.service.ts`
- Test: `src/rescue-request/rescue-request-admin.service.spec.ts`

**Interfaces:**
- Consumes: `DispatchOffer.deliveryStatus`/`deliveryErrorCode` (Task 1).
- Produces: `DispatchOfferAdminDto.deliveryStatus?: string`,
  `DispatchOfferAdminDto.deliveryErrorCode?: number` — Task 6 (lrr-web)
  consumes these exact field names from the `GET` response this DTO shapes.

- [ ] **Step 1: Write the failing test**

In `src/rescue-request/rescue-request-admin.service.spec.ts`, find the
`baseRaw.dispatchOffers` fixture and the test that asserts against it
(around lines 102–136):

```typescript
      dispatchOffers: [
        {
          operatorId: 'op-1',
          status: 'QUOTED',
          quotedPrice: 2500000,
          offeredAt: new Date('2026-08-10T00:00:00Z'),
          respondedAt: new Date('2026-08-10T00:05:00Z'),
          operator: { id: 'op-1', businessName: 'Swift Towing' },
        },
      ],
    };

    it('includes offers with computed motoristFacingTotal for ADMIN', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(baseRaw);
      platformConfigService.getConfig.mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 10,
      });

      const result = await detailService.detailForUser(
        { role: 'ADMIN', userId: 'admin-1' },
        'req-1',
      );

      expect(result.data.vehicleType).toBe('SEDAN');
      expect(result.data.destination).toBe('Mainland');
      expect(result.data.offers).toEqual([
        expect.objectContaining({
          operatorId: 'op-1',
          businessName: 'Swift Towing',
          quotedPrice: 2500000,
          motoristFacingTotal: 2750000,
        }),
      ]);
    });
```

Add `deliveryStatus`/`deliveryErrorCode` to the fixture, and a new,
separate test right after the existing one (don't fold the new assertion
into the existing test — it already has its own clear job of proving
`motoristFacingTotal`'s computation):

```typescript
      dispatchOffers: [
        {
          operatorId: 'op-1',
          status: 'QUOTED',
          quotedPrice: 2500000,
          offeredAt: new Date('2026-08-10T00:00:00Z'),
          respondedAt: new Date('2026-08-10T00:05:00Z'),
          deliveryStatus: null,
          deliveryErrorCode: null,
          operator: { id: 'op-1', businessName: 'Swift Towing' },
        },
      ],
    };

    it('includes offers with computed motoristFacingTotal for ADMIN', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(baseRaw);
      platformConfigService.getConfig.mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 10,
      });

      const result = await detailService.detailForUser(
        { role: 'ADMIN', userId: 'admin-1' },
        'req-1',
      );

      expect(result.data.vehicleType).toBe('SEDAN');
      expect(result.data.destination).toBe('Mainland');
      expect(result.data.offers).toEqual([
        expect.objectContaining({
          operatorId: 'op-1',
          businessName: 'Swift Towing',
          quotedPrice: 2500000,
          motoristFacingTotal: 2750000,
        }),
      ]);
    });

    it('includes deliveryStatus/deliveryErrorCode for ADMIN when a confirmed delivery failure is recorded', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue({
        ...baseRaw,
        dispatchOffers: [
          {
            ...baseRaw.dispatchOffers[0],
            status: 'TIMED_OUT',
            deliveryStatus: 'undelivered',
            deliveryErrorCode: 63024,
          },
        ],
      });
      platformConfigService.getConfig.mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 10,
      });

      const result = await detailService.detailForUser(
        { role: 'ADMIN', userId: 'admin-1' },
        'req-1',
      );

      expect(result.data.offers).toEqual([
        expect.objectContaining({
          deliveryStatus: 'undelivered',
          deliveryErrorCode: 63024,
        }),
      ]);
    });

    it('omits deliveryStatus/deliveryErrorCode when neither is recorded', async () => {
      prisma.rescueRequest.findUnique.mockResolvedValue(baseRaw);
      platformConfigService.getConfig.mockResolvedValue({
        serviceFeePercent: 10,
        depositPercent: 10,
      });

      const result = await detailService.detailForUser(
        { role: 'ADMIN', userId: 'admin-1' },
        'req-1',
      );

      expect(result.data.offers[0].deliveryStatus).toBeUndefined();
      expect(result.data.offers[0].deliveryErrorCode).toBeUndefined();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
yarn test src/rescue-request/rescue-request-admin.service.spec.ts -t "deliveryStatus\|deliveryErrorCode\|motoristFacingTotal"
```

Expected: the 2 new tests FAIL (`deliveryStatus`/`deliveryErrorCode` are
`undefined` where a value was expected). The existing
`motoristFacingTotal` test should still PASS unchanged.

- [ ] **Step 3: Implement**

In `src/rescue-request/dto/rescue-request-response.dto.ts`, find:

```typescript
export class DispatchOfferAdminDto {
  operatorId: string;
  businessName: string;
  status: DispatchOfferStatus;
  quotedPrice?: number;
  motoristFacingTotal?: number;
  offeredAt: Date;
  respondedAt?: Date;
}
```

Replace with:

```typescript
export class DispatchOfferAdminDto {
  operatorId: string;
  businessName: string;
  status: DispatchOfferStatus;
  quotedPrice?: number;
  motoristFacingTotal?: number;
  offeredAt: Date;
  respondedAt?: Date;
  /** Twilio's own status string (delivered/read/undelivered/failed/...),
   * verbatim — undefined until a status-callback has arrived for this offer. */
  deliveryStatus?: string;
  deliveryErrorCode?: number;
}
```

In `src/rescue-request/rescue-request-admin.service.ts`, find (around line
983–996):

```typescript
      const offers: DispatchOfferAdminDto[] = raw.dispatchOffers.map(
        (o: any) => ({
          operatorId: o.operatorId,
          businessName: o.operator.businessName,
          status: o.status,
          quotedPrice: o.quotedPrice ?? undefined,
          motoristFacingTotal: o.quotedPrice
            ? o.quotedPrice +
              Math.round((o.quotedPrice * config.serviceFeePercent) / 100)
            : undefined,
          offeredAt: o.offeredAt,
          respondedAt: o.respondedAt ?? undefined,
        }),
      );
```

Replace with:

```typescript
      const offers: DispatchOfferAdminDto[] = raw.dispatchOffers.map(
        (o: any) => ({
          operatorId: o.operatorId,
          businessName: o.operator.businessName,
          status: o.status,
          quotedPrice: o.quotedPrice ?? undefined,
          motoristFacingTotal: o.quotedPrice
            ? o.quotedPrice +
              Math.round((o.quotedPrice * config.serviceFeePercent) / 100)
            : undefined,
          offeredAt: o.offeredAt,
          respondedAt: o.respondedAt ?? undefined,
          deliveryStatus: o.deliveryStatus ?? undefined,
          deliveryErrorCode: o.deliveryErrorCode ?? undefined,
        }),
      );
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
yarn test src/rescue-request/rescue-request-admin.service.spec.ts
```

Expected: all PASS.

- [ ] **Step 5: Full verification suite**

```bash
npx tsc --noEmit
npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 527
yarn test --ci
```

Then the Docker-Postgres integration suite (per the `merge-to-staging`
skill — this plan's changes don't touch an integration-tested path
directly, but run it anyway since a schema migration is in this branch):

```bash
docker compose -f docker-compose.test.yml up -d
until docker compose -f docker-compose.test.yml ps postgres-test --format json | grep -q '"Health":"healthy"'; do sleep 2; done
DATABASE_URL=postgresql://lrr:lrr@localhost:5433/lrr_test yarn test:integration
docker compose -f docker-compose.test.yml down -v
```

Expected: everything green.

- [ ] **Step 6: Stage and present for commit approval**

```bash
git add src/rescue-request/dto/rescue-request-response.dto.ts src/rescue-request/rescue-request-admin.service.ts src/rescue-request/rescue-request-admin.service.spec.ts
git diff --cached
```

Show the full staged diff and this proposed message, then **stop — do not
run `git commit` until the user explicitly approves this diff**:

```
Surface delivery status/error code on the admin dispatch-offer API
```

---

### Task 6: Admin UI — show confirmed non-delivery (lrr-web)

**Files:**
- Modify: `app/types.ts`
- Modify: `app/components/tabs/RescueRequestsTabAdmin.tsx`

**Interfaces:**
- Consumes: `deliveryStatus?: string`/`deliveryErrorCode?: number` on the
  offer objects the admin detail endpoint returns (Task 5's
  `DispatchOfferAdminDto`, field names must match exactly).

This task is in the **lrr-web** repo — a separate worktree from Tasks 1–5.

- [ ] **Step 1: Add the fields to the frontend type**

In `app/types.ts`, find:

```typescript
export interface DispatchOfferAdmin {
  operatorId: string;
  businessName: string;
  status: string;
  quotedPrice?: number;
  motoristFacingTotal?: number;
  offeredAt: string;
  respondedAt?: string;
}
```

Replace with:

```typescript
export interface DispatchOfferAdmin {
  operatorId: string;
  businessName: string;
  status: string;
  quotedPrice?: number;
  motoristFacingTotal?: number;
  offeredAt: string;
  respondedAt?: string;
  /** Twilio's own status string, verbatim — undefined until a
   * status-callback has arrived for this offer. */
  deliveryStatus?: string;
  deliveryErrorCode?: number;
}
```

- [ ] **Step 2: Add the label**

This repo has no component-test coverage for `RescueRequestsTabAdmin.tsx`
today (confirmed: no matching `.spec.tsx`/`.test.tsx` file exists) — this
step is a direct change verified by running the dev server, matching the
project's existing test-coverage boundary for this file, not a gap
introduced by this task.

In `app/components/tabs/RescueRequestsTabAdmin.tsx`, find (around line
888–891):

```tsx
                          <p style={{ margin: "2px 0 0 0", fontSize: "0.72rem", fontWeight: 700, color: "#6c7890" }}>
                            {offer.status}
                          </p>
```

Replace with:

```tsx
                          <p style={{ margin: "2px 0 0 0", fontSize: "0.72rem", fontWeight: 700, color: "#6c7890" }}>
                            {offer.status}
                            {offer.status === "TIMED_OUT" &&
                              (offer.deliveryStatus === "undelivered" || offer.deliveryStatus === "failed") &&
                              " · Not delivered"}
                          </p>
```

- [ ] **Step 3: Typecheck and build**

```bash
npx tsc --noEmit
npx next build
```

Expected: both clean.

- [ ] **Step 4: Manually verify in the dev server**

Start the dev server (per the Maestro-setup memory's pattern: a seeded
local DB with a `DispatchOffer` row, or temporarily hand-edit a row's
`status`/`deliveryStatus` via a local psql session against the dev DB to
`TIMED_OUT`/`undelivered`) and open a request's detail modal in
`/requests`. Confirm:
- An offer with `status: TIMED_OUT, deliveryStatus: undelivered` (or
  `failed`) shows "TIMED_OUT · Not delivered".
- An offer with `status: TIMED_OUT, deliveryStatus: null` (the common case
  today, and every historical offer) shows plain "TIMED_OUT", unchanged.
- An offer with `status: QUOTED` or any other status is unaffected
  regardless of `deliveryStatus`.

- [ ] **Step 5: Stage and present for commit approval**

```bash
git add app/types.ts app/components/tabs/RescueRequestsTabAdmin.tsx
git diff --cached
```

Show the full staged diff and this proposed message, then **stop — do not
run `git commit` until the user explicitly approves this diff**:

```
Show confirmed Twilio delivery failures on TIMED_OUT dispatch offers
```
