import { PrismaService } from '../../src/prisma/prisma.service';
import { WhatsAppCustomerFlowService } from '../../src/rescue-request/whatsapp-customer-flow.service';
import { WhatsAppInboundService } from '../../src/rescue-request/whatsapp-inbound.service';
import { RescueRequestSharedService } from '../../src/rescue-request/rescue-request-shared.service';
import { WhatsAppSessionStore } from '../../src/rescue-request/state/whatsapp-session.store';
import { TwilioMediaDownloadError } from '../../src/integrations/twilio/twilio.service';
import { truncateAll, createCustomer, createOperator } from './factories';

/**
 * End to end against a real database: a BSUID-only (masked) customer who
 * reaches the end of media capture with no phone number on file is gated
 * into WAITING_FOR_CONTACT_INFO, and every real shape their reply
 * can take — a valid vCard, an off-script message, a vCard with no TEL
 * line, a transient Twilio media 404, an unnormalized bare number, a
 * number that belongs to a registered operator, a number that belongs to a
 * different existing customer, two concurrent deliveries of the same
 * webhook, and a CANCEL that ignores all of it — is driven through the
 * real handler via the same public entry point every real inbound
 * WhatsApp webhook uses, WhatsAppInboundService.handleIncomingWhatsAppMessage.
 *
 * DispatchService is a plain jest-mock here, not the real class: whether
 * dispatch itself finds a candidate operator is entirely out of scope for
 * this plan (it's dispatch.service's own integration coverage) — what this
 * suite proves is that the contact-info gate correctly hands off to it
 * (`startDispatch` called, RescueRequest.status flipped to DISPATCHING)
 * once, and only once, a real phone number is on file.
 */
describe('WhatsApp BSUID contact-info gate (integration)', () => {
  let prisma: PrismaService;
  let inboundService: WhatsAppInboundService;
  let sessionStore: WhatsAppSessionStore;
  let twilio: {
    sendWhatsAppMessage: jest.Mock;
    sendWhatsAppTemplateMessage: jest.Mock;
    downloadMedia: jest.Mock;
  };
  let dispatchService: { startDispatch: jest.Mock };

  const originalContactInfoTemplateSid =
    process.env.TWILIO_CONTACT_INFO_REQUEST_TEMPLATE_SID;
  const originalStaffAlertTemplateSid =
    process.env.TWILIO_NEW_REQUEST_ALERT_TEMPLATE_SID;
  const STAFF_ALERT_NUMBER = '+2348000000001';

  beforeAll(() => {
    prisma = new PrismaService();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(() => {
    if (originalStaffAlertTemplateSid === undefined) {
      delete process.env.TWILIO_NEW_REQUEST_ALERT_TEMPLATE_SID;
    } else {
      process.env.TWILIO_NEW_REQUEST_ALERT_TEMPLATE_SID =
        originalStaffAlertTemplateSid;
    }
    if (originalContactInfoTemplateSid === undefined) {
      delete process.env.TWILIO_CONTACT_INFO_REQUEST_TEMPLATE_SID;
    } else {
      process.env.TWILIO_CONTACT_INFO_REQUEST_TEMPLATE_SID =
        originalContactInfoTemplateSid;
    }
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    // sendContactInfoRequest warns and silently no-ops without this — every
    // scenario below needs the real Content-Template branch reachable.
    process.env.TWILIO_CONTACT_INFO_REQUEST_TEMPLATE_SID = 'HXcontactinfo';
    // Forces the freeform staff-alert fallback so its text is assertable.
    delete process.env.TWILIO_NEW_REQUEST_ALERT_TEMPLATE_SID;

    twilio = {
      sendWhatsAppMessage: jest.fn().mockResolvedValue({ sid: 'SM1' }),
      sendWhatsAppTemplateMessage: jest.fn().mockResolvedValue({ sid: 'SM2' }),
      downloadMedia: jest.fn().mockResolvedValue(Buffer.from('fake-photo')),
    };
    const s3 = { uploadMedia: jest.fn().mockResolvedValue(undefined) };
    const geocoding = { reverseGeocode: jest.fn().mockResolvedValue(null) };
    const platformConfig = {
      getConfig: jest.fn().mockResolvedValue({
        newRequestAlertPhoneNumbers: [STAFF_ALERT_NUMBER],
      }),
    };
    // Out of scope for this plan — see the describe-block comment above.
    dispatchService = { startDispatch: jest.fn().mockResolvedValue(undefined) };

    sessionStore = new WhatsAppSessionStore(prisma);
    const sharedService = new RescueRequestSharedService(
      prisma,
      geocoding as never,
      twilio as never,
      sessionStore,
    );

    const customerFlowService = new WhatsAppCustomerFlowService(
      prisma,
      twilio as never,
      s3 as never,
      geocoding as never,
      {} as never, // RatingService — no rating flow on this path
      {} as never, // PaystackService — no deposit flow on this path
      platformConfig as never,
      {} as never, // OperatorService — unused by WhatsAppCustomerFlowService
      dispatchService as never,
      {} as never, // DisputeService — no dispute flow on this path
      {} as never, // PaymentEventsService — no completion/dispute flow here
      sessionStore,
      sharedService,
      {} as never, // PaymentLedgerService — no payment flow on this path
      {} as never, // PaystackCustomerService — no payment flow on this path
    );

    inboundService = new WhatsAppInboundService(
      prisma,
      sessionStore,
      {} as never, // WhatsAppOperatorFlowService — no sender here ever matches a registered operator's own phone
      customerFlowService,
      sharedService,
    );
  });

  // ── Fixture helpers ───────────────────────────────────────────────────────

  function vCardWithPhone(phoneNumber: string): Buffer {
    return Buffer.from(
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Jane Doe',
        `TEL;TYPE=CELL:${phoneNumber}`,
        'END:VCARD',
      ].join('\n'),
    );
  }

  function vCardWithoutTel(): Buffer {
    return Buffer.from(
      ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Jane Doe', 'END:VCARD'].join('\n'),
    );
  }

  function contactShareWebhook(from: string) {
    return {
      From: from,
      MessageType: 'contacts',
      MediaUrl0: 'https://api.twilio.com/media/contact-card',
      MediaContentType0: 'text/vcard',
      ChannelMetadata: JSON.stringify({
        data: { context: { Origin: 'contact_request' } },
      }),
    };
  }

  /** Seeds a masked customer already parked at the real gate — media
   * capture complete, session in WAITING_FOR_CONTACT_INFO — the exact spot
   * the media step leaves one in, without re-driving the whole SOS flow
   * for every scenario that's really only about the gate's own handler. */
  async function seedMaskedCustomerAtGate(externalUserId: string) {
    const maskedUser = await prisma.user.create({
      data: {
        phoneNumber: null,
        whatsappExternalUserId: externalUserId,
        role: 'CUSTOMER',
      },
    });
    const request = await prisma.rescueRequest.create({
      data: {
        customerId: maskedUser.id,
        status: 'WAITING_FOR_MEDIA',
        latitude: 6.5,
        longitude: 3.4,
        vehicleType: 'SEDAN',
        destination: 'Ikeja, Lagos',
        issueType: 'BREAKDOWN',
      },
    });
    await prisma.requestMedia.create({
      data: {
        rescueRequestId: request.id,
        mediaType: 'IMAGE',
        s3Key: `seed/${request.id}.jpg`,
        contentType: 'image/jpeg',
        context: 'INITIAL',
        uploadedByRole: 'CUSTOMER',
      },
    });
    await sessionStore.getOrCreate(maskedUser.id);
    await sessionStore.update(maskedUser.id, {
      state: 'WAITING_FOR_CONTACT_INFO' as never,
      rescueRequestId: request.id,
    });
    return { maskedUser, request };
  }

  it('masked happy path: SOS through photos triggers the ask, Share Contact unblocks dispatch', async () => {
    const from = 'whatsapp:CA.happy1';

    // 1. SOS creates the masked (BSUID-only) User.
    await inboundService.handleIncomingWhatsAppMessage({
      From: from,
      Body: 'SOS',
    });
    const maskedUser = await prisma.user.findUniqueOrThrow({
      where: { whatsappExternalUserId: 'CA.happy1' },
    });
    expect(maskedUser.phoneNumber).toBeNull();

    // 2. Location pin.
    await inboundService.handleIncomingWhatsAppMessage({
      From: from,
      Latitude: '6.5',
      Longitude: '3.4',
    });

    // 3. Vehicle type.
    await inboundService.handleIncomingWhatsAppMessage({
      From: from,
      Body: '1',
    });

    // 4. Destination (typed, no pin — avoids the geocoding branch).
    await inboundService.handleIncomingWhatsAppMessage({
      From: from,
      Body: 'Ikeja, Lagos',
    });

    // 5. Issue type — this is what actually creates the RescueRequest.
    await inboundService.handleIncomingWhatsAppMessage({
      From: from,
      Body: '1',
    });
    const request = await prisma.rescueRequest.findFirstOrThrow({
      where: { customerId: maskedUser.id },
    });
    expect(request.status).toBe('WAITING_FOR_MEDIA');

    // 6. A photo.
    await inboundService.handleIncomingWhatsAppMessage({
      From: from,
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/photo1',
      MediaContentType0: 'image/jpeg',
    });
    expect(
      await prisma.requestMedia.count({
        where: { rescueRequestId: request.id },
      }),
    ).toBe(1);

    // 7. "2" to continue — this masked customer has no phone number on
    // file, so the gate fires instead of going straight to dispatch.
    const askReply = await inboundService.handleIncomingWhatsAppMessage({
      From: from,
      Body: '2',
    });
    expect(askReply).toContain('Share contact');

    const sessionAfterAsk = await prisma.whatsAppSession.findUniqueOrThrow({
      where: { userId: maskedUser.id },
    });
    expect(sessionAfterAsk.state).toBe('WAITING_FOR_CONTACT_INFO');
    expect(twilio.sendWhatsAppTemplateMessage).toHaveBeenCalledTimes(1);
    expect(twilio.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
      'CA.happy1',
      'HXcontactinfo',
      {},
    );

    // 8. The customer shares their real contact card — a fresh, unclaimed
    // number.
    twilio.downloadMedia.mockResolvedValueOnce(
      vCardWithPhone('+2348099990001'),
    );
    await inboundService.handleIncomingWhatsAppMessage(
      contactShareWebhook(from),
    );

    const backfilled = await prisma.user.findUniqueOrThrow({
      where: { id: maskedUser.id },
    });
    expect(backfilled.phoneNumber).toBe('+2348099990001');

    const finalRequest = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(finalRequest.status).toBe('DISPATCHING');

    const finalSession = await prisma.whatsAppSession.findUniqueOrThrow({
      where: { userId: maskedUser.id },
    });
    expect(finalSession.state).toBe('REQUEST_CONFIRMED');

    expect(dispatchService.startDispatch).toHaveBeenCalledTimes(1);
    expect(dispatchService.startDispatch).toHaveBeenCalledWith(
      request.id,
      maskedUser.id,
    );
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
      'CA.happy1',
      expect.stringContaining('Searching for nearby tow operators'),
    );
    // Staff see the real number the gate collected, never the BSUID.
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
      `whatsapp:${STAFF_ALERT_NUMBER}`,
      expect.stringContaining('Customer: +2348099990001'),
    );
    expect(twilio.sendWhatsAppMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('CA.happy1'),
    );
  });

  it('a customer who already has a phone number never sees the new state', async () => {
    const customer = await createCustomer(prisma);
    const request = await prisma.rescueRequest.create({
      data: {
        customerId: customer.id,
        status: 'WAITING_FOR_MEDIA',
        latitude: 6.5,
        longitude: 3.4,
        vehicleType: 'SEDAN',
        destination: 'Ikeja, Lagos',
        issueType: 'BREAKDOWN',
      },
    });
    await prisma.requestMedia.create({
      data: {
        rescueRequestId: request.id,
        mediaType: 'IMAGE',
        s3Key: `seed/${request.id}.jpg`,
        contentType: 'image/jpeg',
        context: 'INITIAL',
        uploadedByRole: 'CUSTOMER',
      },
    });
    await sessionStore.getOrCreate(customer.id);
    await sessionStore.update(customer.id, {
      state: 'WAITING_FOR_MEDIA' as never,
      rescueRequestId: request.id,
    });

    await inboundService.handleIncomingWhatsAppMessage({
      From: `whatsapp:${customer.phoneNumber}`,
      Body: '2',
    });

    expect(twilio.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();

    const finalSession = await prisma.whatsAppSession.findUniqueOrThrow({
      where: { userId: customer.id },
    });
    expect(finalSession.state).toBe('REQUEST_CONFIRMED');

    const finalRequest = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(finalRequest.status).toBe('DISPATCHING');
    expect(dispatchService.startDispatch).toHaveBeenCalledWith(
      request.id,
      customer.id,
    );
  });

  it('off-script reply at the contact-info step re-prompts and stays in state', async () => {
    const { maskedUser } = await seedMaskedCustomerAtGate('CA.offscript');

    const reply = await inboundService.handleIncomingWhatsAppMessage({
      From: 'whatsapp:CA.offscript',
      Body: 'what do you mean?',
    });
    expect(reply).toContain('Share contact');

    expect(twilio.sendWhatsAppTemplateMessage).toHaveBeenCalledWith(
      'CA.offscript',
      'HXcontactinfo',
      {},
    );

    const session = await prisma.whatsAppSession.findUniqueOrThrow({
      where: { userId: maskedUser.id },
    });
    expect(session.state).toBe('WAITING_FOR_CONTACT_INFO');

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: maskedUser.id },
    });
    expect(user.phoneNumber).toBeNull();
  });

  it('a vCard with no TEL line re-prompts and stays in state', async () => {
    const { maskedUser } = await seedMaskedCustomerAtGate('CA.notel');
    twilio.downloadMedia.mockResolvedValueOnce(vCardWithoutTel());

    const reply = await inboundService.handleIncomingWhatsAppMessage(
      contactShareWebhook('whatsapp:CA.notel'),
    );
    expect(reply).toContain('Share contact');

    const session = await prisma.whatsAppSession.findUniqueOrThrow({
      where: { userId: maskedUser.id },
    });
    expect(session.state).toBe('WAITING_FOR_CONTACT_INFO');

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: maskedUser.id },
    });
    expect(user.phoneNumber).toBeNull();
  });

  it('a transient vCard 404 re-prompts rather than crashing', async () => {
    const { maskedUser } = await seedMaskedCustomerAtGate('CA.transient404');
    twilio.downloadMedia.mockRejectedValueOnce(
      new TwilioMediaDownloadError(
        'https://api.twilio.com/media/contact-card',
        404,
        'Not Found',
      ),
    );

    const reply = await inboundService.handleIncomingWhatsAppMessage(
      contactShareWebhook('whatsapp:CA.transient404'),
    );
    expect(reply).toContain('Share contact');

    const session = await prisma.whatsAppSession.findUniqueOrThrow({
      where: { userId: maskedUser.id },
    });
    expect(session.state).toBe('WAITING_FOR_CONTACT_INFO');

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: maskedUser.id },
    });
    expect(user.phoneNumber).toBeNull();
  });

  it('a bare national-format phone number is rejected rather than stored unnormalized', async () => {
    const { maskedUser } = await seedMaskedCustomerAtGate('CA.barenumber');
    twilio.downloadMedia.mockResolvedValueOnce(vCardWithPhone('08012345678'));

    await inboundService.handleIncomingWhatsAppMessage(
      contactShareWebhook('whatsapp:CA.barenumber'),
    );

    const session = await prisma.whatsAppSession.findUniqueOrThrow({
      where: { userId: maskedUser.id },
    });
    expect(session.state).toBe('WAITING_FOR_CONTACT_INFO');

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: maskedUser.id },
    });
    expect(user.phoneNumber).toBeNull();
    // Never written anywhere, in any form.
    expect(
      await prisma.user.findUnique({ where: { phoneNumber: '08012345678' } }),
    ).toBeNull();
  });

  it('a number colliding with a registered operator is rejected, never written', async () => {
    const operatorPhone = '+2349011112222';
    await createOperator(prisma, operatorPhone);
    const { maskedUser } = await seedMaskedCustomerAtGate('CA.opcollision');
    twilio.downloadMedia.mockResolvedValueOnce(vCardWithPhone(operatorPhone));

    const reply = await inboundService.handleIncomingWhatsAppMessage(
      contactShareWebhook('whatsapp:CA.opcollision'),
    );
    expect(reply).toContain('Share contact');

    const session = await prisma.whatsAppSession.findUniqueOrThrow({
      where: { userId: maskedUser.id },
    });
    expect(session.state).toBe('WAITING_FOR_CONTACT_INFO');

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: maskedUser.id },
    });
    expect(user.phoneNumber).toBeNull();
    // The operator's dispatch line must never become anyone's User.phoneNumber.
    expect(
      await prisma.user.findUnique({ where: { phoneNumber: operatorPhone } }),
    ).toBeNull();
  });

  it('a number colliding with a different existing customer triggers the full merge, replying on the original conversation address throughout', async () => {
    const existingPhone = '+2348077778888';
    const existingUser = await createCustomer(prisma, existingPhone);
    // A stale session of their own, to prove it gets discarded rather than
    // colliding with the masked session being re-pointed onto this row.
    await sessionStore.getOrCreate(existingUser.id);

    const { maskedUser, request } =
      await seedMaskedCustomerAtGate('CA.mergecust');
    twilio.downloadMedia.mockResolvedValueOnce(vCardWithPhone(existingPhone));

    await inboundService.handleIncomingWhatsAppMessage(
      contactShareWebhook('whatsapp:CA.mergecust'),
    );

    // The masked row survives as an identity-less, soft-deleted orphan.
    const maskedAfter = await prisma.user.findUniqueOrThrow({
      where: { id: maskedUser.id },
    });
    expect(maskedAfter.deletedAt).not.toBeNull();
    expect(maskedAfter.whatsappExternalUserId).toBeNull();
    // Its own session row was moved, not duplicated.
    expect(
      await prisma.whatsAppSession.findUnique({
        where: { userId: maskedUser.id },
      }),
    ).toBeNull();

    // existingUser absorbed the BSUID and now owns the request + live session.
    const existingAfter = await prisma.user.findUniqueOrThrow({
      where: { id: existingUser.id },
    });
    expect(existingAfter.whatsappExternalUserId).toBe('CA.mergecust');
    expect(existingAfter.phoneNumber).toBe(existingPhone);

    const requestAfter = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(requestAfter.customerId).toBe(existingUser.id);
    expect(requestAfter.status).toBe('DISPATCHING');

    const sessionAfter = await prisma.whatsAppSession.findUniqueOrThrow({
      where: { userId: existingUser.id },
    });
    expect(sessionAfter.state).toBe('REQUEST_CONFIRMED');
    expect(sessionAfter.rescueRequestId).toBe(request.id);

    expect(dispatchService.startDispatch).toHaveBeenCalledWith(
      request.id,
      existingUser.id,
    );

    // The confirmation goes out on the masked BSUID address throughout —
    // never switched to existingUser's own real phone number.
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
      'CA.mergecust',
      expect.stringContaining('Searching for nearby tow operators'),
    );
    expect(twilio.sendWhatsAppMessage).toHaveBeenCalledWith(
      `whatsapp:${STAFF_ALERT_NUMBER}`,
      expect.stringContaining(`Customer: ${existingPhone}`),
    );

    // A further message from the same masked sender now routes to the
    // survivor: no new User is minted for that BSUID.
    const usersBefore = await prisma.user.count();
    const followUp = await inboundService.handleIncomingWhatsAppMessage({
      From: 'whatsapp:CA.mergecust',
      Body: 'hello?',
    });
    expect(followUp).toContain("We've received your request");
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(
      await prisma.user.findMany({
        where: { whatsappExternalUserId: 'CA.mergecust' },
        select: { id: true },
      }),
    ).toEqual([{ id: existingUser.id }]);
    expect(
      await prisma.whatsAppSession.findUnique({
        where: { userId: existingUser.id },
      }),
    ).not.toBeNull();
  });

  it('a fresh SOS while waiting for contact info auto-cancels the old request and restarts the flow', async () => {
    const { maskedUser, request } =
      await seedMaskedCustomerAtGate('CA.sosagain');

    await inboundService.handleIncomingWhatsAppMessage({
      From: 'whatsapp:CA.sosagain',
      Body: 'SOS',
    });

    const requestAfter = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(requestAfter.status).toBe('CANCELLED');
    const session = await prisma.whatsAppSession.findUniqueOrThrow({
      where: { userId: maskedUser.id },
    });
    expect(session.state).toBe('WAITING_FOR_LOCATION');
  });

  it('a concurrent duplicate of the contacts webhook does not double-claim, double-backfill, or double-call handleMediaFinished', async () => {
    const { maskedUser, request } = await seedMaskedCustomerAtGate('CA.race1');
    const freshPhone = '+2348099990099';
    // Not "Once" — both racing deliveries each independently download and
    // parse the same attachment before either one reaches the atomic claim.
    twilio.downloadMedia.mockResolvedValue(vCardWithPhone(freshPhone));

    const body = contactShareWebhook('whatsapp:CA.race1');
    await Promise.all([
      inboundService.handleIncomingWhatsAppMessage(body),
      inboundService.handleIncomingWhatsAppMessage(body),
    ]);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: maskedUser.id },
    });
    expect(user.phoneNumber).toBe(freshPhone);
    expect(
      await prisma.user.count({ where: { phoneNumber: freshPhone } }),
    ).toBe(1);

    const session = await prisma.whatsAppSession.findUniqueOrThrow({
      where: { userId: maskedUser.id },
    });
    expect(session.state).toBe('REQUEST_CONFIRMED');

    const requestAfter = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(requestAfter.status).toBe('DISPATCHING');

    // The single-flight claim means handleMediaFinished's own side effects
    // — dispatch handoff and the customer confirmation — each fire exactly
    // once, never twice.
    expect(dispatchService.startDispatch).toHaveBeenCalledTimes(1);
    expect(twilio.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
    const confirmationCalls = twilio.sendWhatsAppMessage.mock.calls.filter(
      ([, message]: [string, string]) =>
        typeof message === 'string' &&
        message.includes('Searching for nearby tow operators'),
    );
    expect(confirmationCalls).toHaveLength(1);
  });

  it('a customer who never responds can still reply CANCEL', async () => {
    const { maskedUser, request } =
      await seedMaskedCustomerAtGate('CA.nevercancel');

    const reply = await inboundService.handleIncomingWhatsAppMessage({
      From: 'whatsapp:CA.nevercancel',
      Body: 'CANCEL',
    });
    expect(reply).toContain('cancelled');

    const requestAfter = await prisma.rescueRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(requestAfter.status).toBe('CANCELLED');

    expect(
      await prisma.whatsAppSession.findUnique({
        where: { userId: maskedUser.id },
      }),
    ).toBeNull();
    expect(twilio.sendWhatsAppTemplateMessage).not.toHaveBeenCalled();
  });
});
