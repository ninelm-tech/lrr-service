# Media Capture & Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let motorists send photos/video/audio during the WhatsApp SOS flow; store it in S3 and forward short redirect links to it inside the WhatsApp dispatch offer sent to matched operators.

**Architecture:** `RescueRequest` is created as soon as destination is captured, with a new `WAITING_FOR_MEDIA` status — earlier than the current flow creates it. Each photo/video/audio attachment becomes a `RequestMedia` row immediately (no intermediate session JSON, no bulk insert). A numbered reply (`1. Add more` / `2. Continue`) — consistent with this flow's existing numbered-option convention — replaces a typed `DONE` keyword. On "Continue," the subscriber-check/deposit logic that currently runs at request-creation time instead runs as an `update()` on the already-existing row, transitioning it to `DISPATCHING` and kicking off dispatch. A new `GET /media/:mediaId` endpoint issues a fresh signed S3 URL redirect on each hit, so the WhatsApp message only ever contains short, stable-looking links.

**Tech Stack:** NestJS + Prisma (Postgres) backend (`lrr-service`), AWS S3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), native `fetch` for downloading Twilio media, Jest for tests.

## Global Constraints

- `lrr-web` is untouched — this spec is WhatsApp-only, no portal changes.
- Dispatch reliability outranks the media nice-to-have: any failure to construct/attach media links must never block the dispatch offer message itself.
- Continuing past media capture requires at least one `IMAGE` or `VIDEO` `RequestMedia` row for the request — `AUDIO` alone never satisfies it.
- Cap of 5 `RequestMedia` rows per request.
- A `RequestMedia` row is only created after BOTH the Twilio download and the S3 upload succeed for that attachment — never a half-captured entry, and a failure on one attachment must not block others in the same inbound message.
- Media is delivered as `{API_BASE_URL}/api/v1/media/{mediaId}` redirect links inside the existing text offer message — no separate native WhatsApp media-attachment messages.
- The `/media/:mediaId` endpoint has no auth gate (operator opens it straight from WhatsApp with no session) — this is an accepted MVP trade-off, not an oversight.
- No changes to pricing, matching, or truck-class logic.
- `MediaType` enum values are `IMAGE`/`VIDEO`/`AUDIO` (not `PHOTO`) — classifies by `image/*` MIME type, also covering scans/screenshots.

---

## Task 1: Prisma schema — `MediaType`, `RequestMedia`, `RescueRequestStatus.WAITING_FOR_MEDIA`

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: Prisma enum `MediaType` (`IMAGE`, `VIDEO`, `AUDIO`); model `RequestMedia` (`id`, `rescueRequestId`, `mediaType`, `s3Key`, `contentType`, `createdAt`); `RescueRequest.media: RequestMedia[]` relation; `RescueRequestStatus.WAITING_FOR_MEDIA`. All later tasks depend on these Prisma Client types.

- [ ] **Step 1: Add the `MediaType` enum**

Add directly below the existing `VehicleType` enum (after `HEAVY_TRAILER }`, before `// ============== MODELS ==============`):

```prisma
enum MediaType {
  IMAGE
  VIDEO
  AUDIO
}
```

- [ ] **Step 2: Add `WAITING_FOR_MEDIA` to `RescueRequestStatus`**

Find the `RescueRequestStatus` enum and add `WAITING_FOR_MEDIA` after the existing "collecting request details" values, before `DISPATCHING`:

```prisma
enum RescueRequestStatus {
  WAITING_FOR_LOCATION
  WAITING_FOR_ISSUE_TYPE
  WAITING_FOR_MEDIA
  WAITING_FOR_DEPOSIT
  DISPATCHING
  OPERATOR_ASSIGNED
  IN_PROGRESS
  ARRIVED
  COMPLETED
  CANCELLED
  STALLED
}
```

(only the `WAITING_FOR_MEDIA` line is new — match against the real current enum contents in the file, which may have the same members in the same order; insert `WAITING_FOR_MEDIA` right before `DISPATCHING`.)

- [ ] **Step 3: Add the `RequestMedia` model and `RescueRequest.media` relation**

Add the `media` relation to `RescueRequest`, directly after the existing `dispatchOffers` line:

```prisma
model RescueRequest {
  ...
  dispatchOffers     DispatchOffer[]
  media              RequestMedia[]

  @@index([customerId])
  ...
}
```

Add the new model directly after `RescueRequest` (before the `DispatchOffer` model):

```prisma
// Photos/video/audio submitted by the motorist for a request, forwarded
// to operators as signed redirect links in the dispatch offer.
model RequestMedia {
  id               String        @id @default(cuid())

  rescueRequestId  String
  rescueRequest    RescueRequest @relation(fields: [rescueRequestId], references: [id])

  mediaType        MediaType
  s3Key            String
  contentType      String

  createdAt        DateTime      @default(now())

  @@index([rescueRequestId])
}
```

- [ ] **Step 4: Generate Prisma client and create the migration**

```bash
cd lrr-service
npx prisma generate
npx prisma migrate dev --name add_request_media_and_waiting_for_media_status
```

Expected: migration runs cleanly; `npx prisma generate` reports `MediaType`/`RequestMedia`/the new status value available on `PrismaClient`.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(schema): add RequestMedia model and RescueRequestStatus.WAITING_FOR_MEDIA"
```

---

## Task 2: Media classification domain module

**Files:**
- Create: `src/rescue-request/domain/media-classification.ts`
- Test: `src/rescue-request/domain/media-classification.spec.ts`

**Interfaces:**
- Consumes: `MediaType` from `@prisma/client` (Task 1).
- Produces: `classifyMediaType(contentType: string): MediaType | undefined`, `getExtensionFromContentType(contentType: string): string`. Task 6 (WhatsApp flow) imports both.

- [ ] **Step 1: Write the failing test**

```typescript
// src/rescue-request/domain/media-classification.spec.ts
import { MediaType } from '@prisma/client';
import { classifyMediaType, getExtensionFromContentType } from './media-classification';

describe('classifyMediaType', () => {
  it('classifies image/* as IMAGE', () => {
    expect(classifyMediaType('image/jpeg')).toBe(MediaType.IMAGE);
    expect(classifyMediaType('image/png')).toBe(MediaType.IMAGE);
  });

  it('classifies video/* as VIDEO', () => {
    expect(classifyMediaType('video/mp4')).toBe(MediaType.VIDEO);
    expect(classifyMediaType('video/3gpp')).toBe(MediaType.VIDEO);
  });

  it('classifies audio/* as AUDIO', () => {
    expect(classifyMediaType('audio/ogg')).toBe(MediaType.AUDIO);
    expect(classifyMediaType('audio/mpeg')).toBe(MediaType.AUDIO);
  });

  it('returns undefined for unrecognised content types', () => {
    expect(classifyMediaType('application/pdf')).toBeUndefined();
    expect(classifyMediaType('')).toBeUndefined();
  });
});

describe('getExtensionFromContentType', () => {
  it('maps common content types to file extensions', () => {
    expect(getExtensionFromContentType('image/jpeg')).toBe('jpg');
    expect(getExtensionFromContentType('image/png')).toBe('png');
    expect(getExtensionFromContentType('video/mp4')).toBe('mp4');
    expect(getExtensionFromContentType('audio/ogg')).toBe('ogg');
    expect(getExtensionFromContentType('audio/mpeg')).toBe('mp3');
  });

  it('falls back to a generic extension for unrecognised content types', () => {
    expect(getExtensionFromContentType('application/octet-stream')).toBe('bin');
    expect(getExtensionFromContentType('')).toBe('bin');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/rescue-request/domain/media-classification.spec.ts
```

Expected: FAIL — `Cannot find module './media-classification'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/rescue-request/domain/media-classification.ts
import { MediaType } from '@prisma/client';

export function classifyMediaType(contentType: string): MediaType | undefined {
  if (contentType.startsWith('image/')) return MediaType.IMAGE;
  if (contentType.startsWith('video/')) return MediaType.VIDEO;
  if (contentType.startsWith('audio/')) return MediaType.AUDIO;
  return undefined;
}

const CONTENT_TYPE_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
};

export function getExtensionFromContentType(contentType: string): string {
  return CONTENT_TYPE_TO_EXTENSION[contentType] ?? 'bin';
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/rescue-request/domain/media-classification.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rescue-request/domain/media-classification.ts src/rescue-request/domain/media-classification.spec.ts
git commit -m "feat(rescue-request): add media content-type classification helpers"
```

---

## Task 3: S3 integration module

**Files:**
- Create: `src/integrations/s3/s3.service.ts`
- Create: `src/integrations/s3/s3.module.ts`
- Test: `src/integrations/s3/s3.service.spec.ts`
- Modify: `src/integrations/integrations.module.ts`
- Modify: `package.json`
- Modify: `.env.example`

**Interfaces:**
- Produces: `S3Service.uploadMedia(buffer: Buffer, contentType: string, key: string): Promise<void>`, `S3Service.getSignedUrl(key: string, expirySeconds: number): Promise<string>`. Task 6 (flow) uses `uploadMedia`; Task 7 (redirect endpoint) uses `getSignedUrl`.

- [ ] **Step 1: Add AWS SDK dependencies**

In `package.json`, add to `"dependencies"` (alongside the existing `"@sentry/node"`/`"@sentry/profiling-node"` lines, alphabetically):

```json
    "@aws-sdk/client-s3": "^3.700.0",
    "@aws-sdk/s3-request-presigner": "^3.700.0",
```

```bash
npm install
```

Expected: `package-lock.json` updates, both packages installed under `node_modules/@aws-sdk/`.

- [ ] **Step 2: Write the failing test**

```typescript
// src/integrations/s3/s3.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { S3Service } from './s3.service';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed-url.example.com/object'),
}));

describe('S3Service', () => {
  let service: S3Service;

  beforeEach(async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        S3Service,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              const values: Record<string, string> = {
                AWS_REGION: 'eu-west-1',
                S3_BUCKET_NAME: 'lrr-media-test',
              };
              return values[key];
            },
          },
        },
      ],
    }).compile();

    service = module.get<S3Service>(S3Service);
  });

  it('uploads media with the correct bucket, key, body, and content type', async () => {
    const buffer = Buffer.from('fake-image-bytes');
    await service.uploadMedia(buffer, 'image/jpeg', 'rescue-requests/req-1/abc.jpg');

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'lrr-media-test',
          Key: 'rescue-requests/req-1/abc.jpg',
          Body: buffer,
          ContentType: 'image/jpeg',
        }),
      }),
    );
  });

  it('returns a signed URL for a given key', async () => {
    const url = await service.getSignedUrl('rescue-requests/req-1/abc.jpg', 3600);
    expect(url).toBe('https://signed-url.example.com/object');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx jest src/integrations/s3/s3.service.spec.ts
```

Expected: FAIL — `Cannot find module './s3.service'`.

- [ ] **Step 4: Write `s3.service.ts`**

```typescript
// src/integrations/s3/s3.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class S3Service {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.get<string>('AWS_REGION') || 'eu-west-1';
    this.bucket = this.configService.get<string>('S3_BUCKET_NAME') || '';

    this.client = new S3Client({ region });
  }

  async uploadMedia(buffer: Buffer, contentType: string, key: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
  }

  async getSignedUrl(key: string, expirySeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expirySeconds },
    );
  }
}
```

- [ ] **Step 5: Write `s3.module.ts`**

```typescript
// src/integrations/s3/s3.module.ts
import { Module } from '@nestjs/common';
import { S3Service } from './s3.service';

@Module({
  providers: [S3Service],
  exports: [S3Service],
})
export class S3Module {}
```

- [ ] **Step 6: Wire `S3Module` into `IntegrationsModule`**

```typescript
// src/integrations/integrations.module.ts
import { Module } from '@nestjs/common';
import { TwilioModule } from './twilio/twilio.module';
import { PaystackModule } from './paystack/paystack.module';
import { S3Module } from './s3/s3.module';

@Module({
  imports: [TwilioModule, PaystackModule, S3Module]
})
export class IntegrationsModule {}
```

- [ ] **Step 7: Add S3 env vars to `.env.example`**

Add a new section, following the existing Twilio/Paystack documentation style (append near the end, before or after the Paystack block):

```bash
# ── AWS S3 (motorist media storage) ─────────────────────────
# Staging/prod: IAM role credentials (ECS task role / EC2 instance profile) —
# no explicit access keys needed in this file for deployed environments.
# Local dev: relies on your local AWS CLI credentials (~/.aws/credentials)
# or explicit AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env vars.
AWS_REGION=eu-west-1
S3_BUCKET_NAME=lrr-media

# ── API base URL (used to build the /media/:mediaId redirect links sent
# to operators — must be reachable from the public internet) ───────────
# Local:   http://localhost:3000
# Staging: https://api-staging.lrr.ninelm.com
# Prod:    https://api.lrr.ninelm.com
API_BASE_URL=http://localhost:3000
```

- [ ] **Step 8: Run test to verify it passes**

```bash
npx jest src/integrations/s3/s3.service.spec.ts
```

Expected: PASS.

- [ ] **Step 9: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json src/integrations/s3 src/integrations/integrations.module.ts .env.example
git commit -m "feat(integrations): add S3 module for media upload and signed URLs"
```

---

## Task 4: Twilio media download

**Files:**
- Modify: `src/integrations/twilio/twilio.service.ts`
- Test: `src/integrations/twilio/twilio.service.spec.ts`

**Interfaces:**
- Produces: `TwilioService.downloadMedia(url: string): Promise<Buffer>`. Task 6 (flow) uses this to fetch each `MediaUrl{i}` before uploading to S3.

- [ ] **Step 1: Write the failing test**

Add to the existing `twilio.service.spec.ts` (which already has a `ConfigService` mock from an earlier DI fix — extend it, don't replace it):

```typescript
// src/integrations/twilio/twilio.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TwilioService } from './twilio.service';

describe('TwilioService', () => {
  let service: TwilioService;

  beforeEach(async () => {
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

  describe('downloadMedia', () => {
    it('fetches the URL with Basic Auth using the Twilio credentials and returns a Buffer', async () => {
      const fakeBytes = new Uint8Array([1, 2, 3]);
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => fakeBytes.buffer,
      });
      global.fetch = fetchMock as any;

      const result = await service.downloadMedia('https://api.twilio.com/media/ME123');

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
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as any;

      await expect(service.downloadMedia('https://api.twilio.com/media/missing')).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/integrations/twilio/twilio.service.spec.ts
```

Expected: the two new `downloadMedia` tests FAIL (`service.downloadMedia is not a function`); the pre-existing `should be defined` test passes.

- [ ] **Step 3: Add `downloadMedia` to `TwilioService`**

The constructor already reads `accountSid`/`authToken` into local `const`s but doesn't keep them on the instance. Change both to store on `this` (needed by the new method), and add the method:

```typescript
// src/integrations/twilio/twilio.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';

@Injectable()
export class TwilioService {
  private readonly client: Twilio;
  private readonly whatsappFrom: string;
  private readonly accountSid: string;
  private readonly authToken: string;

  constructor(private readonly configService: ConfigService) {
    this.accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID') || '';
    this.authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN') || '';
    this.whatsappFrom = this.configService.get<string>('TWILIO_WHATSAPP_FROM') || '';

    this.client = new Twilio(this.accountSid, this.authToken);
  }

  /**
   * Send a WhatsApp message to a user
   */
  async sendWhatsAppMessage(to: string, message: string): Promise<void> {
    try {
      // Accept either "+234..." or "whatsapp:+234..." — normalise here
      const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
      const result = await this.client.messages.create({
        from: `whatsapp:${this.whatsappFrom}`,
        to:   formattedTo,
        body: message,
      });
      console.log('WhatsApp message sent:', result.sid);
    } catch (error) {
      console.error('Failed to send WhatsApp message:', error);
      throw error;
    }
  }

  /**
   * Download media (photo/video/audio) from a Twilio-hosted MediaUrl.
   * Twilio media URLs require HTTP Basic Auth with the account SID/auth token.
   */
  async downloadMedia(url: string): Promise<Buffer> {
    const credentials = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${credentials}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to download Twilio media: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/integrations/twilio/twilio.service.spec.ts
```

Expected: PASS, all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/integrations/twilio/twilio.service.ts src/integrations/twilio/twilio.service.spec.ts
git commit -m "feat(twilio): add downloadMedia for fetching inbound WhatsApp attachments"
```

---

## Task 5: `WAITING_FOR_MEDIA` WhatsApp flow state

**Files:**
- Modify: `src/rescue-request/state/whatsapp-session.types.ts`

**Interfaces:**
- Produces: `WhatsAppFlowState.WAITING_FOR_MEDIA` (session-layer flow state — distinct from the Task 1 `RescueRequestStatus.WAITING_FOR_MEDIA`, same name, different enum, different purpose). Task 6 consumes this.

No session data field is needed for media (unlike the truck-class-matching plan's vehicle-type/destination additions) — the existing `rescueRequestId` session field, populated earlier by Task 6, is sufficient to look up `RequestMedia` rows directly from the database at any point.

- [ ] **Step 1: Add the new state**

In `whatsapp-session.types.ts`, add directly after `WAITING_FOR_DESTINATION`:

```typescript
export enum WhatsAppFlowState {
  IDLE = 'IDLE',
  WAITING_FOR_LOCATION = 'WAITING_FOR_LOCATION',
  WAITING_FOR_VEHICLE_TYPE = 'WAITING_FOR_VEHICLE_TYPE',
  WAITING_FOR_DESTINATION = 'WAITING_FOR_DESTINATION',
  WAITING_FOR_MEDIA = 'WAITING_FOR_MEDIA',
  WAITING_FOR_ISSUE_TYPE = 'WAITING_FOR_ISSUE_TYPE',
  WAITING_FOR_DEPOSIT = 'WAITING_FOR_DEPOSIT',
  REQUEST_CONFIRMED = 'REQUEST_CONFIRMED',
  ...
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors (nothing references the new state yet — that's Task 6).

- [ ] **Step 3: Commit**

```bash
git add src/rescue-request/state/whatsapp-session.types.ts
git commit -m "feat(rescue-request): add WAITING_FOR_MEDIA WhatsApp flow state"
```

---

## Task 6: WhatsApp flow — media capture step

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts`
- Modify: `src/rescue-request/rescue-request.module.ts`

**Interfaces:**
- Consumes: `S3Service.uploadMedia` (Task 3), `TwilioService.downloadMedia` (Task 4), `classifyMediaType`/`getExtensionFromContentType` (Task 2), `WhatsAppFlowState.WAITING_FOR_MEDIA` (Task 5), `MediaType`/`RequestMedia`/`RescueRequestStatus.WAITING_FOR_MEDIA` (Task 1).
- Produces: `RescueRequest` rows are now created at destination-capture time (status `WAITING_FOR_MEDIA`) instead of at the end of the flow, with `RequestMedia` rows created immediately per attachment. Task 8 (dispatch forwarding) reads `RequestMedia` for a given `rescueRequestId`.

- [ ] **Step 1: Update imports and constructor**

Add to the existing `@prisma/client` import:

```typescript
import { RescueRequestStatus, UserRole, VehicleType, MediaType } from '@prisma/client';
```

Add new imports directly after the `vehicle-truck-mapping` import:

```typescript
import {
  classifyMediaType,
  getExtensionFromContentType,
} from './domain/media-classification';
import { S3Service } from '../integrations/s3/s3.service';
```

Add the Node `crypto` import at the top of the file, alongside the other imports:

```typescript
import * as crypto from 'crypto';
```

Add `S3Service` to the constructor:

```typescript
  constructor(
    private readonly sessionStore: WhatsAppSessionStore,
    private readonly prisma: PrismaService,
    private readonly paystackService: PaystackService,
    private readonly twilioService: TwilioService,
    private readonly operatorService: OperatorService,
    private readonly s3Service: S3Service,
  ) {}
```

Add a cap constant near the existing dispatch config constants:

```typescript
const MAX_MEDIA_ITEMS = 5;
```

- [ ] **Step 2: Replace the destination step — create the `RescueRequest` early**

Replace the `WAITING_FOR_DESTINATION` block:

```typescript
    // ── Step 3: Waiting for destination ────────────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_DESTINATION) {
      const destination = rawMessage;
      if (!destination) {
        return this.reply(`Please type where you'd like the car towed to.`);
      }
      return this.handleDestinationProvided(
        phoneNumber, userId, session, session.vehicleType as VehicleType, destination,
      );
    }
```

with:

```typescript
    // ── Step 3: Waiting for destination ────────────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_DESTINATION) {
      const destination = rawMessage;
      if (!destination) {
        return this.reply(`Please type where you'd like the car towed to.`);
      }

      const customer = await this.findOrCreateCustomer(phoneNumber);
      const rescueRequest = await this.prisma.rescueRequest.create({
        data: {
          customerId:  customer.id,
          status:      RescueRequestStatus.WAITING_FOR_MEDIA,
          latitude:    session.latitude,
          longitude:   session.longitude,
          vehicleType: session.vehicleType as VehicleType,
          destination,
        },
      });

      await this.sessionStore.update(userId, {
        destination,
        rescueRequestId: rescueRequest.id,
        state: WhatsAppFlowState.WAITING_FOR_MEDIA,
      });
      return this.reply(
        `📍 Got it!\n\nPlease send at least one *photo or video* of the vehicle/breakdown (voice notes welcome too, but a photo or video is required).`,
      );
    }

    // ── Step 3b: Waiting for media ─────────────────────────────────────────
    if (session.state === WhatsAppFlowState.WAITING_FOR_MEDIA) {
      const rescueRequestId = session.rescueRequestId as string;

      if (message === '2') {
        const visualCount = await this.prisma.requestMedia.count({
          where: { rescueRequestId, mediaType: { in: [MediaType.IMAGE, MediaType.VIDEO] } },
        });
        if (visualCount === 0) {
          return this.reply(
            `Please send at least one photo or video before continuing — a voice note alone isn't enough for the operator to assess the vehicle.`,
          );
        }
        return this.handleMediaFinished(phoneNumber, userId, session, rescueRequestId);
      }

      if (message === '1') {
        return this.reply(`Go ahead — send your photo(s), video(s), or voice note(s).`);
      }

      const numMedia = Number(body.NumMedia ?? 0);
      if (numMedia === 0) {
        return this.reply(
          `Please send at least one photo or video (voice notes welcome too).\n\n1️⃣ Add more\n2️⃣ Continue to dispatch`,
        );
      }

      const existingCount = await this.prisma.requestMedia.count({ where: { rescueRequestId } });
      let savedCount = existingCount;
      let failedCount = 0;
      let capReached = false;

      for (let i = 0; i < numMedia; i++) {
        if (savedCount >= MAX_MEDIA_ITEMS) {
          capReached = true;
          break;
        }

        const mediaUrl: string | undefined = body[`MediaUrl${i}`];
        const contentType: string | undefined = body[`MediaContentType${i}`];
        if (!mediaUrl || !contentType) continue;

        const saved = await this.captureMediaAttachment(rescueRequestId, mediaUrl, contentType);
        if (saved) {
          savedCount++;
        } else {
          failedCount++;
        }
      }

      const capNote = capReached
        ? `\n\n⚠️ You've reached the ${MAX_MEDIA_ITEMS}-item limit — further attachments won't be saved.`
        : '';
      const failNote = failedCount > 0
        ? `\n\n⚠️ ${failedCount} item(s) failed to upload — please resend if important.`
        : '';

      return this.reply(
        `📸 Received (${savedCount}/${MAX_MEDIA_ITEMS} items saved).${capNote}${failNote}\n\n1️⃣ Add more\n2️⃣ Continue to dispatch`,
      );
    }
```

- [ ] **Step 3: Add `captureMediaAttachment` helper**

Add this private method directly after `handleIncomingWhatsAppMessage` (before `handleOperatorMessage`):

```typescript
  /**
   * Downloads one Twilio media attachment, uploads it to S3, and creates the
   * RequestMedia row. Returns false (rather than throwing) on any failure —
   * a single bad attachment must not break the rest of the batch or the flow.
   */
  private async captureMediaAttachment(
    rescueRequestId: string,
    mediaUrl: string,
    contentType: string,
  ): Promise<boolean> {
    const mediaType = classifyMediaType(contentType);
    if (!mediaType) return false;

    try {
      const buffer = await this.twilioService.downloadMedia(mediaUrl);
      const extension = getExtensionFromContentType(contentType);
      const s3Key = `rescue-requests/${rescueRequestId}/${crypto.randomUUID()}.${extension}`;

      await this.s3Service.uploadMedia(buffer, contentType, s3Key);

      await this.prisma.requestMedia.create({
        data: { rescueRequestId, mediaType, s3Key, contentType },
      });

      return true;
    } catch (error) {
      console.error('Failed to capture media attachment:', error);
      Sentry.captureException(error);
      return false;
    }
  }
```

- [ ] **Step 4: Replace `handleDestinationProvided` with `handleMediaFinished`**

Delete the entire existing `handleDestinationProvided` private method and replace it with:

```typescript
  // ──────────────────────────────────────────────────────────────────────────
  //  Media capture finished → subscriber check → deposit or direct dispatch
  // ──────────────────────────────────────────────────────────────────────────
  private async handleMediaFinished(
    phoneNumber: string,
    userId: string,
    session: Awaited<ReturnType<WhatsAppSessionStore['getOrCreate']>>,
    rescueRequestId: string,
  ) {
    const customer = await this.findOrCreateCustomer(phoneNumber);
    const subscription = await this.getActiveSubscription(customer.id);
    const vehicleType = session.vehicleType as VehicleType;
    const destination = session.destination as string;

    if (subscription) {
      const towsLeft = subscription.towsIncludedPerMonth - subscription.towsUsedThisMonth;

      if (towsLeft > 0) {
        // Subscriber with remaining allowance — skip deposit
        await this.prisma.rescueRequest.update({
          where: { id: rescueRequestId },
          data: { status: RescueRequestStatus.DISPATCHING, depositPaid: true },
        });

        await this.prisma.subscription.update({
          where: { id: subscription.id },
          data: { towsUsedThisMonth: { increment: 1 } },
        });

        await this.sessionStore.update(userId, {
          state:              WhatsAppFlowState.REQUEST_CONFIRMED,
          dispatchRound:      0,
          offeredOperatorIds: [],
        });

        const greet = customer.name ? `Hi ${customer.name}! ` : '';
        await this.twilioService.sendWhatsAppMessage(
          phoneNumber,
          `${greet}✅ Subscriber recognised!\n\nVehicle: ${formatVehicleType(vehicleType)}\nDestination: ${destination}\nTows remaining this month: ${towsLeft - 1}\n\nFinding nearest operator...`,
        );

        void this.startDispatch(rescueRequestId, customer.id);
        return this.xmlOk();
      }

      // Subscriber tows exhausted — fall through to dispatch-first flow with full amount
    }

    // ── Dispatch-first: find an operator BEFORE charging the customer ─────────
    const isExhaustedSubscriber = !!subscription;
    const depositAmount = isExhaustedSubscriber ? FULL_AMOUNT_KOBO : DEPOSIT_AMOUNT_KOBO;

    await this.prisma.rescueRequest.update({
      where: { id: rescueRequestId },
      data: { status: RescueRequestStatus.DISPATCHING, depositAmount },
    });

    await this.sessionStore.update(userId, {
      state:              WhatsAppFlowState.REQUEST_CONFIRMED,
      dispatchRound:      0,
      offeredOperatorIds: [],
    });

    const greet     = customer.name ? `Hi ${customer.name.split(' ')[0]}! ` : '';
    const costNote  = isExhaustedSubscriber
      ? `ℹ️ Monthly tow allowance used up. A one-time fee of ₦50,000 will apply.\n`
      : ``;
    const costBreak = depositAmount === FULL_AMOUNT_KOBO
      ? `💰 Fee if assigned: *₦50,000* (paid in full at confirmation)`
      : `💰 Total if assigned: *₦50,000* (₦5,000 now · ₦45,000 on completion)`;

    await this.twilioService.sendWhatsAppMessage(
      phoneNumber,
      `${greet}🔍 ${costNote}Searching for the nearest tow operator...\n\nVehicle: ${formatVehicleType(vehicleType)}\nDestination: ${destination}\n${costBreak}\n\n⏳ You will *only be charged once an operator is confirmed*. Reply CANCEL at any time.`,
    );

    void this.startDispatch(rescueRequestId, customer.id);
    return this.xmlOk();
  }
```

(this is nearly identical to the deleted `handleDestinationProvided`, with the two key differences: `rescueRequest.update({ where: { id: rescueRequestId }, ... })` instead of `rescueRequest.create(...)`, since the row already exists; and `sessionStore.update` no longer needs to set `rescueRequestId`/`vehicleType`/`destination` — those were already set earlier, in Step 2's destination-handling block.)

- [ ] **Step 5: Wire `S3Module` into `RescueRequestModule`**

```typescript
// src/rescue-request/rescue-request.module.ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RescueRequestService } from './rescue-request.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { PrismaModule } from '../prisma/prisma.module';
import { RescueRequestController } from './rescue-request.controller';
import { PaystackModule } from '../integrations/paystack/paystack.module';
import { TwilioModule } from '../integrations/twilio/twilio.module';
import { S3Module } from '../integrations/s3/s3.module';
import { OperatorModule } from '../operator/operator.module';
import { AuthGuard } from '../auth/auth.guard';

@Module({
  imports: [
    PrismaModule,
    PaystackModule,
    TwilioModule,
    S3Module,
    OperatorModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'your-secret-key',
      signOptions: { expiresIn: '24h' },
    }),
  ],
  controllers: [RescueRequestController],
  providers: [RescueRequestService, WhatsAppSessionStore, AuthGuard],
  exports: [RescueRequestService],
})
export class RescueRequestModule {}
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. Double check `handleDestinationProvided` has no remaining references anywhere in the file (`grep -n "handleDestinationProvided" src/rescue-request/rescue-request.service.ts` should return nothing) and that `handleMediaFinished` is only called from the new `message === '2'` branch added in Step 2.

- [ ] **Step 7: Run the full rescue-request test suite**

```bash
npx jest src/rescue-request
```

Expected: PASS — the existing suites (domain mapping, session store) are unaffected by this task; no dedicated new test file for this task itself, matching the precedent set by the truck-class-matching plan (state-machine correctness here is covered by manual verification, per that plan's approach to `rescue-request.service.ts`).

- [ ] **Step 8: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts src/rescue-request/rescue-request.module.ts
git commit -m "feat(rescue-request): create RescueRequest at destination capture and store media immediately"
```

---

## Task 7: Media redirect endpoint

**Files:**
- Create: `src/media/media.controller.ts`
- Create: `src/media/media.module.ts`
- Test: `src/media/media.controller.spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `S3Service.getSignedUrl` (Task 3), `PrismaService` (existing), `RequestMedia` (Task 1).
- Produces: `GET /api/v1/media/:mediaId` → 302 redirect to a signed S3 URL. Task 8 (dispatch forwarding) constructs links pointing at this route.

- [ ] **Step 1: Write the failing test**

```typescript
// src/media/media.controller.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { MediaController } from './media.controller';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';

describe('MediaController', () => {
  let controller: MediaController;
  let prisma: { requestMedia: { findUnique: jest.Mock } };
  let s3: { getSignedUrl: jest.Mock };

  beforeEach(async () => {
    prisma = { requestMedia: { findUnique: jest.fn() } };
    s3 = { getSignedUrl: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MediaController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: S3Service, useValue: s3 },
      ],
    }).compile();

    controller = module.get<MediaController>(MediaController);
  });

  it('redirects to a freshly generated signed URL for an existing media item', async () => {
    prisma.requestMedia.findUnique.mockResolvedValue({
      id: 'media-1',
      s3Key: 'rescue-requests/req-1/abc.jpg',
    });
    s3.getSignedUrl.mockResolvedValue('https://signed.example.com/abc.jpg');

    const result = await controller.redirectToMedia('media-1');

    expect(prisma.requestMedia.findUnique).toHaveBeenCalledWith({ where: { id: 'media-1' } });
    expect(s3.getSignedUrl).toHaveBeenCalledWith('rescue-requests/req-1/abc.jpg', expect.any(Number));
    expect(result).toEqual({ url: 'https://signed.example.com/abc.jpg', statusCode: 302 });
  });

  it('throws NotFoundException for a nonexistent media ID', async () => {
    prisma.requestMedia.findUnique.mockResolvedValue(null);

    await expect(controller.redirectToMedia('missing-id')).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/media/media.controller.spec.ts
```

Expected: FAIL — `Cannot find module './media.controller'`.

- [ ] **Step 3: Write `media.controller.ts`**

```typescript
// src/media/media.controller.ts
import { Controller, Get, NotFoundException, Param, Redirect } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../integrations/s3/s3.service';

const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1 hour

@Controller('media')
export class MediaController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
  ) {}

  @Get(':mediaId')
  @Redirect()
  async redirectToMedia(@Param('mediaId') mediaId: string) {
    const media = await this.prisma.requestMedia.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundException('Media not found');

    const url = await this.s3Service.getSignedUrl(media.s3Key, SIGNED_URL_EXPIRY_SECONDS);
    return { url, statusCode: 302 };
  }
}
```

- [ ] **Step 4: Write `media.module.ts`**

```typescript
// src/media/media.module.ts
import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { S3Module } from '../integrations/s3/s3.module';

@Module({
  imports: [PrismaModule, S3Module],
  controllers: [MediaController],
})
export class MediaModule {}
```

- [ ] **Step 5: Wire `MediaModule` into `AppModule`**

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { IntegrationsModule } from './integrations/integrations.module';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { RescueRequestModule } from './rescue-request/rescue-request.module';
import { PaymentModule } from './payment/payment.module';
import { OperatorModule } from './operator/operator.module';
import { AuthModule } from './auth/auth.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { MediaModule } from './media/media.module';
import { SentryInterceptor } from './common/sentry.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    IntegrationsModule,
    PrismaModule,
    AuthModule,
    RescueRequestModule,
    PaymentModule,
    OperatorModule,
    WebhooksModule,
    SubscriptionModule,
    MediaModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_INTERCEPTOR, useClass: SentryInterceptor },
  ],
})
export class AppModule {}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npx jest src/media/media.controller.spec.ts
```

Expected: PASS, both tests green.

- [ ] **Step 7: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/media src/app.module.ts
git commit -m "feat(media): add GET /media/:mediaId signed-URL redirect endpoint"
```

---

## Task 8: Dispatch forwarding — media links in the operator offer message

**Files:**
- Modify: `src/rescue-request/rescue-request.service.ts`

**Interfaces:**
- Consumes: `RequestMedia` rows (Task 1, created by Task 6), `/media/:mediaId` route (Task 7).
- Produces: operator dispatch offer message now includes a media-links section when the request has stored media.

- [ ] **Step 1: Write the failing test**

Create `src/rescue-request/rescue-request.service.spec.ts` (does not exist yet) with a focused test on `buildMediaLinksSection` — a pure-enough method to test in isolation without standing up the full service's DI graph:

```typescript
// src/rescue-request/rescue-request.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { RescueRequestService } from './rescue-request.service';
import { WhatsAppSessionStore } from './state/whatsapp-session.store';
import { PrismaService } from '../prisma/prisma.service';
import { PaystackService } from '../integrations/paystack/paystack.service';
import { TwilioService } from '../integrations/twilio/twilio.service';
import { OperatorService } from '../operator/operator.service';
import { S3Service } from '../integrations/s3/s3.service';

describe('RescueRequestService', () => {
  let service: RescueRequestService;
  const originalApiBaseUrl = process.env.API_BASE_URL;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RescueRequestService,
        { provide: WhatsAppSessionStore, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: PaystackService, useValue: {} },
        { provide: TwilioService, useValue: {} },
        { provide: OperatorService, useValue: {} },
        { provide: S3Service, useValue: {} },
      ],
    }).compile();

    service = module.get<RescueRequestService>(RescueRequestService);
  });

  afterEach(() => {
    process.env.API_BASE_URL = originalApiBaseUrl;
  });

  describe('buildMediaLinksSection', () => {
    it('returns an empty string when there are no media items', () => {
      process.env.API_BASE_URL = 'https://api.lrr.ninelm.com';
      const result = (service as any).buildMediaLinksSection([]);
      expect(result).toBe('');
    });

    it('returns an empty string when API_BASE_URL is not configured', () => {
      delete process.env.API_BASE_URL;
      const result = (service as any).buildMediaLinksSection([{ id: 'media-1' }]);
      expect(result).toBe('');
    });

    it('builds one /media/:id link per item under API_BASE_URL/api/v1', () => {
      process.env.API_BASE_URL = 'https://api.lrr.ninelm.com';
      const result = (service as any).buildMediaLinksSection([
        { id: 'media-1' },
        { id: 'media-2' },
      ]);
      expect(result).toBe(
        '\n\n📎 Photos/Video/Audio:\nhttps://api.lrr.ninelm.com/api/v1/media/media-1\nhttps://api.lrr.ninelm.com/api/v1/media/media-2',
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest src/rescue-request/rescue-request.service.spec.ts
```

Expected: FAIL — `(service as any).buildMediaLinksSection is not a function`.

- [ ] **Step 3: Add the `buildMediaLinksSection` helper**

Add this private method near the other small formatting helpers already on this service (e.g. next to `formatStatus`) — this codebase has no separate `formatters/` module convention, so this stays a private method here like its neighbors, not a new file:

```typescript
  /**
   * Builds the "Photos/Video/Audio" section appended to the operator offer
   * message. Best-effort: if API_BASE_URL isn't configured, the section is
   * simply omitted — this must never block the dispatch offer itself.
   */
  private buildMediaLinksSection(mediaItems: Array<{ id: string }>): string {
    if (mediaItems.length === 0) return '';

    const apiBaseUrl = process.env.API_BASE_URL;
    if (!apiBaseUrl) return '';

    const links = mediaItems
      .map((item) => `${apiBaseUrl}/api/v1/media/${item.id}`)
      .join('\n');

    return `\n\n📎 Photos/Video/Audio:\n${links}`;
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx jest src/rescue-request/rescue-request.service.spec.ts
```

Expected: PASS, all 3 tests green.

- [ ] **Step 5: Wire the helper into `startDispatch`**

Directly after the existing `vehicleLabel`/`destinationLabel` construction and before the `Promise.all(batch.map(...))` notify block, add:

```typescript
    const vehicleLabel = rescueRequest.vehicleType
      ? formatVehicleType(rescueRequest.vehicleType as VehicleType)
      : 'Unknown';
    const destinationLabel = rescueRequest.destination ?? 'Not specified';

    const mediaItems = await this.prisma.requestMedia.findMany({
      where: { rescueRequestId },
    });
    const mediaSection = this.buildMediaLinksSection(mediaItems);

    // Notify all batch operators simultaneously
    await Promise.all(
      batch.map((op) =>
        this.twilioService.sendWhatsAppMessage(
          toWhatsAppAddress(op.phoneNumber),
          `🚨 *NEW RESCUE JOB*\n\nVehicle: ${vehicleLabel}\nDestination: ${destinationLabel}\nDistance: ${op.distance.toFixed(1)} km\nLocation: https://maps.google.com/?q=${lat},${lon}${mediaSection}\n\nReply *YES* to accept or *NO* to decline.\nYou have ${windowSeconds} seconds.`,
        ),
      ),
    );
```

(only the `mediaItems`/`mediaSection` lines are new, plus appending `${mediaSection}` into the existing template literal right after the `Location:` line — everything else in this block is unchanged from the current code.)

- [ ] **Step 6: Verify TypeScript compiles and the full test suite passes**

```bash
npx tsc --noEmit
npx jest
```

Expected: no errors; every suite passes.

- [ ] **Step 7: Commit**

```bash
git add src/rescue-request/rescue-request.service.ts src/rescue-request/rescue-request.service.spec.ts
git commit -m "feat(rescue-request): forward media redirect links in the dispatch offer"
```

---

## Task 9: Rollout verification

**Files:** none (verification-only task)

- [ ] **Step 1: Run the full backend test suite**

```bash
cd lrr-service
npx jest
```

Expected: all suites pass, including every suite added/modified in Tasks 1-8.

- [ ] **Step 2: Run the full TypeScript build**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Confirm the migration is additive and rollout-safe**

```bash
cat prisma/migrations/*add_request_media_and_waiting_for_media_status*/migration.sql
```

Expected: only `CREATE TYPE`/`CREATE TABLE`/`ALTER TABLE ... ADD COLUMN`/enum-value-add statements, no drops.

- [ ] **Step 4: Confirm required infrastructure is documented**

```bash
grep -A5 "AWS S3" .env.example
grep "API base URL" .env.example
```

Expected: both the S3 bucket/region vars and `API_BASE_URL` are documented — this is a reminder that the actual S3 bucket must be provisioned and these env vars set in staging/prod before this feature works end-to-end; the application code cannot self-provision the bucket.

## Manual Verification (after all tasks)

- [ ] Send a WhatsApp "HELP" message from a test number, complete location/vehicle-type/destination, and confirm the flow now asks for photo/video/audio.
- [ ] Check the database — confirm a `RescueRequest` row with status `WAITING_FOR_MEDIA` exists immediately after destination, before any media is sent.
- [ ] Send a voice note only, then reply `2` — confirm it's rejected with a message asking for a photo/video.
- [ ] Send a photo, then reply `2` — confirm the flow advances to dispatch and the request's status moves to `DISPATCHING`.
- [ ] Send 6 photos in one message before continuing — confirm only 5 are accepted and a limit-reached note appears, and confirm 5 `RequestMedia` rows exist (not 6).
- [ ] Start a request, send one photo, then send `CANCEL` before replying `2` — confirm the request is found and cancelled (not silently orphaned).
- [ ] Confirm the matched operator's WhatsApp offer message includes `{API_BASE_URL}/api/v1/media/{id}` links.
- [ ] Open one of those links in a browser — confirm it redirects to a working, viewable S3 object (not an XML error page).
- [ ] Wait past the signed URL's 1-hour expiry (or manually test with a short expiry), click the same `/media/:id` link again — confirm it still works (fresh signed URL generated per click).
