import express, { type Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApplyResult, BusId, ScanEvent, StudentId } from '../types/events.js';
import { deviceLookupFromMap } from './normalize.js';
import { createWebhookRouter, type ApplyScan, type WebhookLogger } from './router.js';
import { SIGNATURE_HEADER, signWebhookBody } from './verifySignature.js';

const SECRET = 'test-signing-secret-not-a-real-one';
const DEVICE = '14828dd8-4988-46aa-93fb-d176dfbaefc4';
const BUS = 'BUS-101' as BusId;
const USER_ID = '53a68297-9fa8-4848-8cb3-9815d4a511dc';
const EVENT_ID = '0a626165-d71c-4d2d-bc0b-8cfafc1edacc';
const NOW = new Date('2026-09-02T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const MOUNT = '/webhooks/verkada';

/** Invented PII, `.invalid` domain — present so the tests can prove it dies here. */
const PII = {
  name: 'Syn Testrider',
  email: 'syn.testrider@example.invalid',
  first_name: 'Syn',
  last_name: 'Testrider',
  phone: '+15550000007',
} as const;
const PII_VALUES = Object.values(PII);

const silentLogger: WebhookLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

type Json = Record<string, unknown>;

/** The real Verkada envelope (access-events-webhooks docs, retrieved 2026-09-02). */
function rawEvent(dataOverrides: Json = {}, envelopeOverrides: Json = {}): Json {
  return {
    org_id: 'a74fc6a6-4fc5-4e5c-88e5-57301683327a',
    webhook_type: 'notification',
    created_at: NOW_SECONDS,
    webhook_id: '457eb610-03b4-4fa0-a8c7-c06f3142df50',
    data: {
      event_id: EVENT_ID,
      device_id: DEVICE,
      created: NOW_SECONDS - 30,
      notification_type: 'door_keycard_entered_accepted',
      device_type: 'access_control',
      door_id: DEVICE,
      direction: null,
      input_value: '109|35302',
      aux_info: null,
      user_info: { user_id: USER_ID, ...PII },
      lockdown_info: null,
      door_info: {
        acu_name: 'Lobby Door Controller',
        acu_id: '8adf16e0-a52a-45d1-8b68-efc5d6fb64ba',
        name: 'Front Door',
        door_id: DEVICE,
        site: { name: 'HQ', site_id: '42338454-dc42-4d25-80ce-35e42c2d0578' },
        api_control_enabled: false,
        camera_info: null,
      },
      ...dataOverrides,
    },
    ...envelopeOverrides,
  };
}

const applied = (scan: ScanEvent): ApplyResult => ({
  applied: true,
  scan: {
    ...scan,
    studentId: 'STU-0007' as StudentId,
    direction: 'on',
    directionSource: scan.deviceDirection === undefined ? 'derived' : 'device',
  },
  alerts: [],
});

/**
 * A stand-in for middleware/src/boarding that follows D-009: a rejected
 * credential is reported back, never boarded.
 */
const boardingStub: ApplyScan = (scan) =>
  scan.accepted ? applied(scan) : { applied: false, reason: 'credential_rejected', alerts: [] };

function buildApp(
  overrides: {
    applyScan?: ApplyScan;
    deviceMap?: Record<string, string>;
    logger?: WebhookLogger;
    applyTimeoutMs?: number;
  } = {},
) {
  const applyScan = vi.fn(overrides.applyScan ?? boardingStub);
  const recordUnroutable = vi.fn();
  const archiveRawEvent = vi.fn();
  const logger = overrides.logger ?? silentLogger;

  const app = express();
  app.use(
    '/webhooks',
    createWebhookRouter({
      secret: SECRET,
      resolveBusId: deviceLookupFromMap(overrides.deviceMap ?? { [DEVICE]: BUS }),
      applyScan,
      recordUnroutable,
      archiveRawEvent,
      logger,
      now: () => NOW,
      ...(overrides.applyTimeoutMs === undefined
        ? {}
        : { applyTimeoutMs: overrides.applyTimeoutMs }),
    }),
  );

  return { app, applyScan, recordUnroutable, archiveRawEvent, logger };
}

function post(app: Express, body: string, header: string | undefined) {
  const req = request(app).post(MOUNT).set('Content-Type', 'application/json');
  if (header !== undefined) req.set(SIGNATURE_HEADER, header);
  return req.send(body);
}

function signedPost(app: Express, body: unknown, timestampSeconds = NOW_SECONDS) {
  const serialized = JSON.stringify(body);
  return post(app, serialized, signWebhookBody(serialized, SECRET, timestampSeconds));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /webhooks/verkada', () => {
  it('accepts a validly signed event and applies it', async () => {
    const { app, applyScan } = buildApp();

    const res = await signedPost(app, rawEvent());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: true, eventId: EVENT_ID });
    expect(applyScan).toHaveBeenCalledTimes(1);

    const scan = applyScan.mock.calls[0]?.[0] as ScanEvent;
    expect(scan).toMatchObject({
      eventId: EVENT_ID,
      verkadaUserId: USER_ID,
      cardId: '109|35302',
      deviceId: DEVICE,
      doorId: DEVICE,
      busId: BUS,
      notificationType: 'door_keycard_entered_accepted',
      accepted: true,
      receivedAt: NOW.toISOString(),
    });
  });

  it('passes a reported direction through for In/Out Doors (D-002)', async () => {
    const { app, applyScan } = buildApp();

    await signedPost(app, rawEvent({ direction: 'Inbound' }));

    const scan = applyScan.mock.calls[0]?.[0] as ScanEvent;
    expect(scan.deviceDirection).toBe('Inbound');
  });

  it('surfaces alert kinds without leaking student ids (D-005 wrong bus)', async () => {
    const { app } = buildApp({
      applyScan: (scan) => ({
        applied: true,
        scan: {
          ...scan,
          studentId: 'STU-0007' as StudentId,
          direction: 'on',
          directionSource: 'derived',
        },
        alerts: [
          {
            kind: 'wrong_bus',
            studentId: 'STU-0007' as StudentId,
            busId: scan.busId,
            routeRunId: 'run_1',
            raisedAt: scan.occurredAt,
            triggeringEventId: scan.eventId,
            detail: 'assigned BUS-102',
          },
        ],
      }),
    });

    const res = await signedPost(app, rawEvent());

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.alerts).toEqual(['wrong_bus']);
    expect(JSON.stringify(res.body)).not.toContain('STU-0007');
  });

  describe('signature failures (Verkada status codes, D-011)', () => {
    it('returns 400 for a missing signature header', async () => {
      const { app, applyScan } = buildApp();
      const res = await post(app, JSON.stringify(rawEvent()), undefined);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_signature_header' });
      expect(applyScan).not.toHaveBeenCalled();
    });

    it('returns 400 for a malformed signature header', async () => {
      const { app, applyScan } = buildApp();
      const res = await post(app, JSON.stringify(rawEvent()), 't=123,v1=deadbeef');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_signature_header' });
      expect(applyScan).not.toHaveBeenCalled();
    });

    it('returns 403 for a signature made with the wrong secret', async () => {
      const { app, applyScan } = buildApp();
      const serialized = JSON.stringify(rawEvent());

      const res = await post(app, serialized, signWebhookBody(serialized, 'wrong', NOW_SECONDS));

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'invalid_signature' });
      expect(applyScan).not.toHaveBeenCalled();
    });

    it('returns 403 for a replayed request outside the 60s window', async () => {
      const { app, applyScan } = buildApp();
      const res = await signedPost(app, rawEvent(), NOW_SECONDS - 600);

      expect(res.status).toBe(403);
      expect(applyScan).not.toHaveBeenCalled();
    });

    it('does not reveal which of the two 403 checks failed', async () => {
      const { app } = buildApp();
      const serialized = JSON.stringify(rawEvent());

      const forged = await post(app, serialized, signWebhookBody(serialized, 'wrong', NOW_SECONDS));
      const stale = await signedPost(app, rawEvent(), NOW_SECONDS - 600);

      expect(forged.status).toBe(stale.status);
      expect(forged.body).toEqual(stale.body);
    });
  });

  describe('400: body problems', () => {
    it('rejects a body that is not JSON', async () => {
      const { app, applyScan } = buildApp();
      const body = 'this is not json {';
      const res = await post(app, body, signWebhookBody(body, SECRET, NOW_SECONDS));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'malformed_body' });
      expect(applyScan).not.toHaveBeenCalled();
    });

    it('rejects JSON that does not match the payload shape', async () => {
      const { app, applyScan } = buildApp();
      const res = await signedPost(app, { hello: 'world' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'malformed_body' });
      expect(applyScan).not.toHaveBeenCalled();
    });

    it('rejects a signed but structurally broken event', async () => {
      const { app } = buildApp();
      const body = rawEvent();
      delete (body['data'] as Json)['event_id'];

      const res = await signedPost(app, body);
      expect(res.status).toBe(400);
    });
  });

  describe('200: accepted but not applied (D-004, D-009)', () => {
    it('does not board a rejected credential', async () => {
      const { app, applyScan } = buildApp();

      const res = await signedPost(
        app,
        rawEvent({
          notification_type: 'door_keycard_entered_rejected',
          input_value: '1000110110100000000000010111100100000101',
          user_info: null,
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ applied: false, reason: 'credential_rejected' });

      // The event still reaches boarding — a rejected tap is signal worth
      // recording (D-009) — but it arrives flagged as not accepted.
      const scan = applyScan.mock.calls[0]?.[0] as ScanEvent;
      expect(scan.accepted).toBe(false);
      expect(scan.notificationType).toBe('door_keycard_entered_rejected');
    });

    it.each([
      'door_opened',
      'door_held_open',
      'door_tamper',
      'door_apb_double_entry',
      'lockdown_activated',
    ])('returns 200 and ignores %s without calling boarding', async (notificationType) => {
      const { app, applyScan } = buildApp();

      const res = await signedPost(app, rawEvent({ notification_type: notificationType }));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        applied: false,
        reason: 'unsupported_notification_type',
        eventId: EVENT_ID,
      });
      expect(applyScan).not.toHaveBeenCalled();
    });

    it('returns 200 for an unknown user', async () => {
      const { app } = buildApp({
        applyScan: () => ({ applied: false, reason: 'unknown_user', alerts: [] }),
      });

      const res = await signedPost(app, rawEvent());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ applied: false, reason: 'unknown_user' });
    });

    it('returns 200 for a duplicate event', async () => {
      const seen = new Set<string>();
      const { app, applyScan } = buildApp({
        applyScan: (scan) => {
          if (seen.has(scan.eventId)) {
            return { applied: false, reason: 'duplicate_event', alerts: [] };
          }
          seen.add(scan.eventId);
          return applied(scan);
        },
      });

      const first = await signedPost(app, rawEvent());
      const second = await signedPost(app, rawEvent());

      expect(first.status).toBe(200);
      expect(first.body.applied).toBe(true);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ applied: false, reason: 'duplicate_event' });
      expect(applyScan).toHaveBeenCalledTimes(2);
    });

    it('returns 200 for a business-stale event (late cellular delivery)', async () => {
      const { app } = buildApp({
        applyScan: () => ({ applied: false, reason: 'stale_event', alerts: [] }),
      });

      // Signature is fresh; the on-bus timestamp is an hour old (D-003).
      const res = await signedPost(app, rawEvent({ created: NOW_SECONDS - 3600 }));

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ applied: false, reason: 'stale_event' });
    });

    it('returns 200 for an unknown device, records it redacted, and skips boarding', async () => {
      const { app, applyScan, recordUnroutable } = buildApp({ deviceMap: {} });

      const res = await signedPost(app, rawEvent());

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        applied: false,
        reason: 'unknown_reader',
        eventId: EVENT_ID,
      });
      expect(applyScan).not.toHaveBeenCalled();
      expect(recordUnroutable).toHaveBeenCalledTimes(1);

      const record = recordUnroutable.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(record).toMatchObject({
        eventId: EVENT_ID,
        deviceId: DEVICE,
        receivedAt: NOW.toISOString(),
        reason: 'unknown_reader',
      });
      const stored = JSON.stringify(record.redactedRaw);
      for (const value of PII_VALUES) expect(stored).not.toContain(value);
      expect(stored).toContain(USER_ID);
    });
  });

  it('returns 500 when the boarding module throws, so Verkada retries', async () => {
    const { app } = buildApp({
      applyScan: () => {
        throw new Error('database is on fire');
      },
    });

    const res = await signedPost(app, rawEvent());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'apply_failed' });
  });

  describe('response deadline (D-010)', () => {
    it('answers with 500 rather than hanging when boarding stalls', async () => {
      const { app } = buildApp({
        applyTimeoutMs: 50,
        applyScan: () => new Promise<ApplyResult>(() => {}),
      });

      const startedAt = Date.now();
      const res = await signedPost(app, rawEvent());

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'apply_timeout' });
      expect(Date.now() - startedAt).toBeLessThan(2000);
    });

    it('sends exactly one response even if boarding finishes after the deadline', async () => {
      const { app } = buildApp({
        applyTimeoutMs: 20,
        applyScan: (scan) =>
          new Promise<ApplyResult>((resolve) => {
            setTimeout(() => resolve(applied(scan)), 60);
          }),
      });

      const res = await signedPost(app, rawEvent());
      expect(res.status).toBe(500);

      // Let the late apply settle; the router must not try to respond twice.
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    it('refuses a deadline that cannot meet Verkada’s 2000 ms contract', () => {
      expect(() =>
        createWebhookRouter({
          secret: SECRET,
          resolveBusId: deviceLookupFromMap({}),
          applyScan: boardingStub,
          applyTimeoutMs: 2500,
        }),
      ).toThrow(/2000/);
    });
  });

  describe('raw body capture (D-011)', () => {
    it('verifies the exact bytes received, not a re-serialization', async () => {
      const { app } = buildApp();
      // Signed with whitespace; a JSON round-trip would produce different bytes
      // and break the HMAC if the router verified after parsing.
      const spaced = JSON.stringify(rawEvent(), null, 2);

      const res = await post(app, spaced, signWebhookBody(spaced, SECRET, NOW_SECONDS));

      expect(res.status).toBe(200);
      expect(res.body.applied).toBe(true);
    });

    it('is byte-exact: reordered but equivalent JSON fails the signature', async () => {
      const { app } = buildApp();
      const original = JSON.stringify(rawEvent());
      const header = signWebhookBody(original, SECRET, NOW_SECONDS);
      const reordered = JSON.stringify(JSON.parse(original), Object.keys(rawEvent()).reverse());

      const res = await post(app, reordered, header);
      expect(res.status).toBe(403);
    });

    it('verifies even when Content-Type is not application/json', async () => {
      const { app } = buildApp();
      const serialized = JSON.stringify(rawEvent());

      const res = await request(app)
        .post(MOUNT)
        .set('Content-Type', 'text/plain')
        .set(SIGNATURE_HEADER, signWebhookBody(serialized, SECRET, NOW_SECONDS))
        .send(serialized);

      expect(res.status).toBe(200);
    });

    it('fails closed with 400 if a JSON parser consumed the body first', async () => {
      // Regression guard: mounting express.json() ahead of the webhook replaces
      // the Buffer with a plain object and silently defeats verification.
      const badApp = express();
      badApp.use(express.json());
      badApp.use(
        '/webhooks',
        createWebhookRouter({
          secret: SECRET,
          resolveBusId: deviceLookupFromMap({ [DEVICE]: BUS }),
          applyScan: boardingStub,
          logger: silentLogger,
          now: () => NOW,
        }),
      );

      const serialized = JSON.stringify(rawEvent());
      const res = await request(badApp)
        .post(MOUNT)
        .set('Content-Type', 'application/json')
        .set(SIGNATURE_HEADER, signWebhookBody(serialized, SECRET, NOW_SECONDS))
        .send(serialized);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'raw_body_required' });
    });
  });

  describe('PII and logging hygiene (D-012, CLAUDE.md)', () => {
    function loggedText(logger: WebhookLogger): string {
      return JSON.stringify([
        (logger.info as ReturnType<typeof vi.fn>).mock.calls,
        (logger.warn as ReturnType<typeof vi.fn>).mock.calls,
        (logger.error as ReturnType<typeof vi.fn>).mock.calls,
      ]);
    }

    it('never logs a name, email, phone, credential, user id or the secret', async () => {
      const logger: WebhookLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const { app } = buildApp({ logger });

      await signedPost(app, rawEvent());
      await signedPost(app, rawEvent({ notification_type: 'door_opened' }));
      await signedPost(
        app,
        rawEvent({ notification_type: 'door_keycard_entered_rejected', user_info: null }),
      );

      const logged = loggedText(logger);

      expect(logged).toContain(EVENT_ID);
      expect(logged).toContain('door_keycard_entered_accepted');
      for (const value of PII_VALUES) expect(logged).not.toContain(value);
      expect(logged).not.toContain('109|35302');
      expect(logged).not.toContain(USER_ID);
      expect(logged).not.toContain(SECRET);
    });

    it('never puts PII in the response body', async () => {
      const { app } = buildApp();
      const res = await signedPost(app, rawEvent());

      const serialized = JSON.stringify(res.body);
      for (const value of PII_VALUES) expect(serialized).not.toContain(value);
      expect(serialized).not.toContain(USER_ID);
    });

    it('hands persistence a payload with PII already stripped', async () => {
      const { app, archiveRawEvent } = buildApp();
      await signedPost(app, rawEvent());

      expect(archiveRawEvent).toHaveBeenCalledTimes(1);
      const stored = JSON.stringify(archiveRawEvent.mock.calls[0]?.[0]);
      for (const value of PII_VALUES) expect(stored).not.toContain(value);
      expect(stored).toContain(USER_ID);
      // The rest of the wire payload survives for forensics.
      expect(stored).toContain('door_keycard_entered_accepted');
    });

    it('keeps PII out of the normalized event handed to boarding', async () => {
      const { app, applyScan } = buildApp();
      await signedPost(app, rawEvent());

      const scan = JSON.stringify(applyScan.mock.calls[0]?.[0]);
      for (const value of PII_VALUES) expect(scan).not.toContain(value);
    });
  });
});
