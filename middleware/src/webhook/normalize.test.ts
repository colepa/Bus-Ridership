import { describe, expect, it } from 'vitest';

import type { BusId } from '../types/events.js';
import {
  CREDENTIAL_NOTIFICATION_TYPES,
  acceptedFromNotificationType,
  deviceLookupFromMap,
  epochSecondsToIso,
  isIgnored,
  normalizeIncoming,
  normalizeVerkadaEvent,
  parseRawVerkadaEvent,
  redactRawEvent,
  type RawVerkadaWebhook,
} from './normalize.js';

/**
 * Fixtures mirror the real payload from
 * https://apidocs.verkada.com/reference/access-events-webhooks — same field
 * names, same shapes, same UUID formats.
 *
 * SYNTHETIC DATA ONLY (CLAUDE.md): the `user_info` PII below is invented and
 * uses the reserved `.invalid` domain. It exists precisely so the tests can
 * prove it never survives normalization (D-012).
 */
const DEVICE = '14828dd8-4988-46aa-93fb-d176dfbaefc4';
const BUS = 'BUS-101' as BusId;
const USER_ID = '53a68297-9fa8-4848-8cb3-9815d4a511dc';
const EVENT_ID = '0a626165-d71c-4d2d-bc0b-8cfafc1edacc';
const CREATED = 1_744_674_135; // epoch SECONDS — the tap time
const EMITTED = 1_744_674_140; // envelope created_at — Command emit time
const RECEIVED_AT = new Date('2026-09-02T12:00:00.000Z');

/** Invented PII. Every one of these strings must be absent from any output. */
const PII = {
  name: 'Syn Testrider',
  email: 'syn.testrider@example.invalid',
  first_name: 'Syn',
  last_name: 'Testrider',
  phone: '+15550000007',
} as const;
const PII_VALUES = Object.values(PII);

const lookup = deviceLookupFromMap({ [DEVICE]: BUS });

type Json = Record<string, unknown>;

function rawEvent(dataOverrides: Json = {}, envelopeOverrides: Json = {}): Json {
  return {
    org_id: 'a74fc6a6-4fc5-4e5c-88e5-57301683327a',
    webhook_type: 'notification',
    created_at: EMITTED,
    webhook_id: '457eb610-03b4-4fa0-a8c7-c06f3142df50',
    data: {
      event_id: EVENT_ID,
      device_id: DEVICE,
      created: CREATED,
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

function parseOrThrow(body: unknown): RawVerkadaWebhook {
  const parsed = parseRawVerkadaEvent(body);
  if (!parsed.ok) throw new Error(`fixture failed validation: ${parsed.issues.join(', ')}`);
  return parsed.raw;
}

function normalize(body: Json = rawEvent()) {
  return normalizeVerkadaEvent(parseOrThrow(body), {
    resolveBusId: lookup,
    receivedAt: RECEIVED_AT,
  });
}

describe('normalizeVerkadaEvent', () => {
  it('maps the real accepted-keycard payload onto ScanEvent', () => {
    const event = normalize();

    expect(event).toEqual({
      eventId: EVENT_ID,
      verkadaUserId: USER_ID,
      cardId: '109|35302',
      deviceId: DEVICE,
      doorId: DEVICE,
      busId: BUS,
      notificationType: 'door_keycard_entered_accepted',
      accepted: true,
      occurredAt: epochSecondsToIso(CREATED),
      receivedAt: RECEIVED_AT.toISOString(),
    });
  });

  it('orders on data.created, not the envelope created_at (D-003)', () => {
    // A buffered tap: it happened an hour before Command emitted it.
    const event = normalize(
      rawEvent({ created: CREATED - 3600 }, { created_at: EMITTED }),
    );
    if (isIgnored(event)) throw new Error('expected a scan');

    expect(event.occurredAt).toBe(epochSecondsToIso(CREATED - 3600));
    expect(new Date(event.receivedAt).getTime()).toBeGreaterThan(
      new Date(event.occurredAt).getTime(),
    );
  });

  it('sets accepted from the notification_type suffix (D-009)', () => {
    for (const type of CREDENTIAL_NOTIFICATION_TYPES) {
      const event = normalize(rawEvent({ notification_type: type }));
      if (isIgnored(event)) throw new Error(`expected a scan for ${type}`);
      expect(event.accepted).toBe(type.endsWith('_accepted'));
      expect(event.notificationType).toBe(type);
    }
  });

  it('normalizes a rejected credential so it can be recorded, with accepted=false', () => {
    // Rejected events report the credential as a 40-bit binary string and may
    // resolve no user at all.
    const event = normalize(
      rawEvent({
        notification_type: 'door_keycard_entered_rejected',
        input_value: '1000110110100000000000010111100100000101',
        user_info: null,
      }),
    );
    if (isIgnored(event)) throw new Error('expected a scan');

    expect(event.accepted).toBe(false);
    expect(event.cardId).toBe('1000110110100000000000010111100100000101');
    expect(event.verkadaUserId).toBeUndefined();
  });

  it('keys identity off user_info.user_id, whatever input_value looks like (D-007)', () => {
    const formats = [
      '109|35302', // accepted keycard: facility|card
      '1000110110100000000000010111100100000101', // rejected / NFC: 40-bit binary
      '1234', // entry code
      '53a68297-9fa8-4848-8cb3-9815d4a511dc', // face
    ];

    for (const input of formats) {
      const event = normalize(rawEvent({ input_value: input }));
      if (isIgnored(event)) throw new Error('expected a scan');
      expect(event.verkadaUserId).toBe(USER_ID);
      expect(event.cardId).toBe(input);
    }
  });

  it('tolerates a null input_value', () => {
    const event = normalize(rawEvent({ input_value: null }));
    if (isIgnored(event)) throw new Error('expected a scan');
    expect(event.cardId).toBeUndefined();
  });

  describe('direction (D-002)', () => {
    it('carries a reported direction through for In/Out Doors', () => {
      for (const direction of ['Inbound', 'Outbound'] as const) {
        const event = normalize(rawEvent({ direction }));
        if (isIgnored(event)) throw new Error('expected a scan');
        expect(event.deviceDirection).toBe(direction);
      }
    });

    it('leaves deviceDirection unset when the door is not an In/Out Door', () => {
      const event = normalize(rawEvent({ direction: null }));
      if (isIgnored(event)) throw new Error('expected a scan');
      expect(event.deviceDirection).toBeUndefined();
    });

    it('ignores an unrecognised direction value rather than rejecting the event', () => {
      const event = normalize(rawEvent({ direction: 'Sideways' }));
      if (isIgnored(event)) throw new Error('expected a scan');
      expect(event.deviceDirection).toBeUndefined();
    });
  });

  describe('ignored deliveries (D-009)', () => {
    it.each([
      'door_opened',
      'door_held_open',
      'door_tamper',
      'door_acu_online',
      'door_aux_input_triggered',
      'door_apb_double_entry',
      'door_apb_double_exit',
      'lockdown_activated',
    ])('ignores %s', (notificationType) => {
      const event = normalize(rawEvent({ notification_type: notificationType }));
      expect(isIgnored(event)).toBe(true);
      expect(event).toMatchObject({
        ignored: true,
        reason: 'unsupported_notification_type',
        notificationType,
        eventId: EVENT_ID,
      });
    });

    it('ignores a webhook_type that is not "notification"', () => {
      const event = normalize(rawEvent({}, { webhook_type: 'test' }));
      expect(event).toMatchObject({ ignored: true, reason: 'unsupported_webhook_type' });
    });

    it('ignores a device with no bus mapping', () => {
      const event = normalize(
        rawEvent({ device_id: 'ffffffff-0000-0000-0000-000000000000', door_id: null }),
      );
      expect(event).toMatchObject({ ignored: true, reason: 'unknown_reader' });
    });

    it('never puts a credential or a user id on an ignored event', () => {
      const event = normalize(rawEvent({ notification_type: 'door_opened' }));
      expect(JSON.stringify(event)).not.toContain('109|35302');
      expect(JSON.stringify(event)).not.toContain(USER_ID);
    });
  });

  describe('bus resolution', () => {
    it('falls back to door_id when device_id is not mapped', () => {
      const event = normalizeVerkadaEvent(
        parseOrThrow(rawEvent({ device_id: 'unmapped-acu', door_id: DEVICE })),
        { resolveBusId: lookup, receivedAt: RECEIVED_AT },
      );
      if (isIgnored(event)) throw new Error('expected a scan');
      expect(event.busId).toBe(BUS);
      expect(event.deviceId).toBe('unmapped-acu');
    });

    it('resolves through the injected lookup, not a hardcoded table', () => {
      const event = normalizeVerkadaEvent(parseOrThrow(rawEvent()), {
        resolveBusId: () => 'BUS-999' as BusId,
      });
      if (isIgnored(event)) throw new Error('expected a scan');
      expect(event.busId).toBe('BUS-999');
    });
  });

  it('honours a caller-supplied credential allow-list', () => {
    const event = normalizeVerkadaEvent(
      parseOrThrow(rawEvent({ notification_type: 'door_entry_code_entered_accepted' })),
      {
        resolveBusId: lookup,
        credentialNotificationTypes: new Set(['door_entry_code_entered_accepted']),
      },
    );
    if (isIgnored(event)) throw new Error('expected a scan');
    expect(event.accepted).toBe(true);
  });
});

describe('acceptedFromNotificationType', () => {
  it('reads the suffix and refuses to guess', () => {
    expect(acceptedFromNotificationType('door_keycard_entered_accepted')).toBe(true);
    expect(acceptedFromNotificationType('door_mobile_nfc_scan_rejected')).toBe(false);
    expect(acceptedFromNotificationType('door_opened')).toBeUndefined();
  });
});

describe('parseRawVerkadaEvent', () => {
  it('accepts the real payload', () => {
    expect(parseRawVerkadaEvent(rawEvent()).ok).toBe(true);
  });

  it('tolerates unknown fields so additive Verkada changes do not 4xx', () => {
    const body = rawEvent({
      scenario_info: { scenario: 'something_new', nested: { deeper: true } },
      door_info: {
        name: 'Front Door',
        timezone: 'America/Chicago',
        site: { name: 'HQ', site_id: 'x', region: 'us-west' },
        camera_info: null,
      },
    });
    body['future_envelope_field'] = 42;

    expect(parseRawVerkadaEvent(body).ok).toBe(true);
  });

  it('accepts the documented nulls', () => {
    const body = rawEvent({
      door_id: null,
      direction: null,
      input_value: null,
      aux_info: null,
      lockdown_info: null,
      user_info: null,
      door_info: null,
    });
    expect(parseRawVerkadaEvent(body).ok).toBe(true);
  });

  const drop = (key: string) => (b: Json) => {
    delete (b['data'] as Json)[key];
  };
  const setData = (key: string, value: unknown) => (b: Json) => {
    (b['data'] as Json)[key] = value;
  };

  it.each<[string, (b: Json) => void]>([
    [
      'missing data',
      (b) => {
        delete b['data'];
      },
    ],
    ['missing event_id', drop('event_id')],
    ['missing device_id', drop('device_id')],
    ['missing notification_type', drop('notification_type')],
    ['missing created', drop('created')],
    ['created as a string', setData('created', '1744674135')],
    ['created as zero', setData('created', 0)],
    [
      'missing webhook_id',
      (b) => {
        delete b['webhook_id'];
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const body = rawEvent();
    mutate(body);
    expect(parseRawVerkadaEvent(body).ok).toBe(false);
  });

  it('reports issue paths without echoing credentials or PII', () => {
    const body = rawEvent({ created: 'not-a-number' });

    const parsed = parseRawVerkadaEvent(body);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;

    const issues = parsed.issues.join(' ');
    expect(issues).toContain('data.created');
    expect(issues).not.toContain('109|35302');
    for (const value of PII_VALUES) expect(issues).not.toContain(value);
  });
});

describe('PII never survives the adapter (D-012)', () => {
  it('strips name, email and phone during parsing', () => {
    const parsed = JSON.stringify(parseOrThrow(rawEvent()));
    for (const value of PII_VALUES) expect(parsed).not.toContain(value);
    expect(parsed).toContain(USER_ID);
  });

  it('produces a ScanEvent with no trace of the person beyond user_id', () => {
    const serialized = JSON.stringify(normalize());
    for (const value of PII_VALUES) expect(serialized).not.toContain(value);
    expect(serialized).toContain(USER_ID);
  });

  it('strips PII even when Verkada adds new fields to user_info', () => {
    const body = rawEvent({
      user_info: { user_id: USER_ID, ...PII, badge_photo_url: 'https://example.invalid/p.jpg' },
    });
    const serialized = JSON.stringify(normalize(body));
    expect(serialized).not.toContain('badge_photo_url');
    for (const value of PII_VALUES) expect(serialized).not.toContain(value);
  });
});

describe('redactRawEvent', () => {
  it('reduces user_info to user_id and keeps everything else', () => {
    const redacted = redactRawEvent(rawEvent()) as Json;
    const data = redacted['data'] as Json;

    expect(data['user_info']).toEqual({ user_id: USER_ID });
    expect(data['input_value']).toBe('109|35302');
    expect(data['event_id']).toBe(EVENT_ID);
    // Door metadata is not PII and must survive for forensics.
    expect((data['door_info'] as Json)['name']).toBe('Front Door');
    expect(((data['door_info'] as Json)['site'] as Json)['name']).toBe('HQ');
  });

  it('lets no PII survive, anywhere, at any depth', () => {
    const body = rawEvent({
      // Deliberately hostile: PII smuggled into unmodelled corners.
      aux_info: { note: 'x', contact: { email: PII.email, phone: PII.phone } },
      scenario_info: { actors: [{ user_info: { user_id: 'u2', ...PII } }] },
    });

    const serialized = JSON.stringify(redactRawEvent(body));
    for (const value of PII_VALUES) expect(serialized).not.toContain(value);
    expect(serialized).toContain(USER_ID);
    expect(serialized).toContain('u2');
  });

  it('drops a user_info that carries no user_id rather than keeping the rest', () => {
    const redacted = redactRawEvent(rawEvent({ user_info: { ...PII } })) as Json;
    expect((redacted['data'] as Json)['user_info']).toBeNull();
  });

  it('preserves unknown/future fields, which is the point of keeping the raw body', () => {
    const redacted = redactRawEvent(rawEvent({ scenario_info: { scenario: 'new' } })) as Json;
    expect((redacted['data'] as Json)['scenario_info']).toEqual({ scenario: 'new' });
  });

  it('does not mutate its input', () => {
    const body = rawEvent();
    redactRawEvent(body);
    expect(((body['data'] as Json)['user_info'] as Json)['email']).toBe(PII.email);
  });

  it('survives non-object input', () => {
    expect(redactRawEvent(null)).toBeNull();
    expect(redactRawEvent('nope')).toBe('nope');
    expect(redactRawEvent([1, 2])).toEqual([1, 2]);
  });
});

describe('normalizeIncoming', () => {
  it('returns the normalized event for a good body', () => {
    const outcome = normalizeIncoming(rawEvent(), { resolveBusId: lookup });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.event.eventId).toBe(EVENT_ID);
  });

  it('flags a malformed body', () => {
    const outcome = normalizeIncoming({ nope: true }, { resolveBusId: lookup });
    expect(outcome).toMatchObject({ ok: false, kind: 'malformed' });
  });

  it('flags an unmapped device as ignored, not malformed', () => {
    const outcome = normalizeIncoming(rawEvent({ device_id: 'spare-unit', door_id: null }), {
      resolveBusId: lookup,
      receivedAt: RECEIVED_AT,
    });
    expect(outcome).toMatchObject({
      ok: false,
      kind: 'ignored',
      event: { reason: 'unknown_reader', eventId: EVENT_ID, deviceId: 'spare-unit' },
    });
  });

  it('flags a notification type we do not act on', () => {
    const outcome = normalizeIncoming(rawEvent({ notification_type: 'door_opened' }), {
      resolveBusId: lookup,
    });
    expect(outcome).toMatchObject({
      ok: false,
      kind: 'ignored',
      event: { reason: 'unsupported_notification_type' },
    });
  });
});
