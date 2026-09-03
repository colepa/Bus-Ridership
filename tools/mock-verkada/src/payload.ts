/**
 * MIRROR of the REAL Verkada access-event wire format.
 *
 * Sources (retrieved 2026-09-02):
 *   https://apidocs.verkada.com/reference/access-events-webhooks
 *   https://apidocs.verkada.com/reference/securing-webhooks
 *
 * The middleware's copy of this knowledge lives in
 * `middleware/src/webhook/normalize.ts` (payload) and
 * `middleware/src/webhook/verifySignature.ts` (signature transport). This file
 * is the generator's single source of truth for both: nothing else in
 * tools/mock-verkada may mention a Verkada field name.
 *
 * Envelope:
 *   { org_id, webhook_type: "notification", created_at, webhook_id, data }
 *
 * Signature:
 *   Verkada-Signature: <timestamp>|<hex hmac-sha256>
 *   signed material:   rawBody + "|" + timestamp        <- BODY FIRST
 *
 * Faithfulness matters here in one specific, uncomfortable way: real events
 * carry the person's name, email and phone in `user_info`, and the middleware
 * is required to drop them at the adapter boundary (D-012). A generator that
 * omitted them would make that code path untestable end to end, so this one
 * emits them — invented, from the reserved `.invalid` domain, and never printed
 * to the console.
 */

import { createHmac } from 'node:crypto';

/** `webhook_type` is this literal for every access event. */
export const VERKADA_WEBHOOK_TYPE = 'notification';

/** Verkada's canonical header casing. HTTP header names are case-insensitive. */
export const SIGNATURE_HEADER = 'Verkada-Signature';

/** `device_type` for an access control event. */
export const DEVICE_TYPE = 'access_control';

/**
 * The notification types this generator emits.
 *
 * The first four are the credential events the middleware acts on; the rest are
 * ordinary door noise that must be ignored with a 200 (D-009).
 */
export const NOTIFICATION_TYPES = {
  keycardAccepted: 'door_keycard_entered_accepted',
  keycardRejected: 'door_keycard_entered_rejected',
  nfcAccepted: 'door_mobile_nfc_scan_accepted',
  nfcRejected: 'door_mobile_nfc_scan_rejected',
  opened: 'door_opened',
  heldOpen: 'door_held_open',
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

/** Populated only when the door is configured as an In/Out Door (D-002). */
export type VerkadaDirection = 'Inbound' | 'Outbound';

/** PII, exactly as Verkada sends it. Synthetic here; dropped by the receiver. */
export interface RawVerkadaUserInfo {
  user_id: string;
  name: string;
  email: string;
  first_name: string;
  last_name: string;
  phone: string;
}

export interface RawVerkadaSite {
  name: string;
  site_id: string;
}

export interface RawVerkadaDoorInfo {
  acu_name: string;
  acu_id: string;
  name: string;
  door_id: string;
  site: RawVerkadaSite;
  api_control_enabled: boolean;
  /** Null in every documented example (D-008). */
  camera_info: null;
}

export interface RawAccessEventData {
  event_id: string;
  device_id: string;
  /** Epoch SECONDS. When the tap happened at the door. */
  created: number;
  notification_type: string;
  device_type: string;
  door_id: string | null;
  direction: VerkadaDirection | null;
  /**
   * The credential. Format varies by event type: "109|35302" (facility|card) on
   * an accepted keycard, a 40-bit binary string on rejected/NFC, "1234" for an
   * entry code, a UUID for face. This is why identity keys off user_id (D-007).
   */
  input_value: string | null;
  aux_info: null;
  user_info: RawVerkadaUserInfo | null;
  lockdown_info: null;
  door_info: RawVerkadaDoorInfo | null;
}

export interface RawVerkadaEvent {
  org_id: string;
  webhook_type: string;
  /** Epoch seconds. When Command emitted the delivery — NOT the tap time. */
  created_at: number;
  webhook_id: string;
  data: RawAccessEventData;
}

export interface BuildEventInput {
  eventId: string;
  webhookId: string;
  orgId: string;
  /** The access control object that produced the event. */
  deviceId: string;
  /** Null on ACU-level events. Equal to deviceId in Verkada's own examples. */
  doorId: string | null;
  doorName: string;
  acuId: string;
  acuName: string;
  siteName: string;
  siteId: string;
  notificationType: string;
  inputValue: string | null;
  /** Null when the credential resolved to no user (rejected/unknown). */
  userInfo: RawVerkadaUserInfo | null;
  direction: VerkadaDirection | null;
  /** Tap time, epoch ms on the simulated route clock. */
  occurredAtMs: number;
  /** Command emit time, epoch ms. Later than occurredAt for buffered taps. */
  emittedAtMs: number;
}

/** Build one webhook body in the real Verkada shape. */
export function buildRawVerkadaEvent(input: BuildEventInput): RawVerkadaEvent {
  const data: RawAccessEventData = {
    event_id: input.eventId,
    device_id: input.deviceId,
    created: msToEpochSeconds(input.occurredAtMs),
    notification_type: input.notificationType,
    device_type: DEVICE_TYPE,
    door_id: input.doorId,
    direction: input.direction,
    input_value: input.inputValue,
    aux_info: null,
    user_info: input.userInfo,
    lockdown_info: null,
    door_info: {
      acu_name: input.acuName,
      acu_id: input.acuId,
      name: input.doorName,
      door_id: input.doorId ?? input.deviceId,
      site: { name: input.siteName, site_id: input.siteId },
      api_control_enabled: false,
      camera_info: null,
    },
  };

  return {
    org_id: input.orgId,
    webhook_type: VERKADA_WEBHOOK_TYPE,
    created_at: msToEpochSeconds(input.emittedAtMs),
    webhook_id: input.webhookId,
    data,
  };
}

/**
 * `Verkada-Signature: <epoch seconds>|<hex hmac-sha256>` over
 * `rawBody + "|" + timestamp`.
 *
 * Body first, then the pipe, then the timestamp — the reverse of the Stripe
 * convention this resembles. Verkada's Python sample:
 *
 *     to_hash = b'|'.join((request.get_data() or b'', timestamp.encode()))
 */
export function signWebhookBody(
  bodyText: string,
  secret: string,
  timestampSeconds: number,
): string {
  const token = String(Math.trunc(timestampSeconds));
  const digest = createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(bodyText, 'utf8'), Buffer.from(`|${token}`, 'utf8')]))
    .digest('hex');
  return `${token}|${digest}`;
}

/** Verkada timestamps are integer epoch seconds, both in the envelope and in `data`. */
export function msToEpochSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** An accepted keycard reports `facility|card`. */
export function facilityCardValue(facilityCode: number, cardNumber: number): string {
  return `${facilityCode}|${cardNumber}`;
}

/**
 * A rejected read (and mobile NFC) reports the raw 40 bits off the wire, as a
 * string of ones and zeroes. Deterministic in the value so runs stay reproducible.
 */
export function bitStringValue(seedValue: number): string {
  let bits = '';
  let value = Math.abs(Math.trunc(seedValue));
  for (let i = 0; i < 40; i += 1) {
    // `%` rather than `&`: 40 bits does not fit in JavaScript's 32-bit bitwise ops.
    bits = String(value % 2) + bits;
    value = Math.floor(value / 2);
  }
  return bits;
}
