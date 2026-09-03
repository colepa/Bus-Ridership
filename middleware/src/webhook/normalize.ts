/**
 * VERKADA WIRE-FORMAT ADAPTER — the only module that knows what Verkada sends.
 *
 * Per docs/decisions.md (D-001), the rest of the system speaks `ScanEvent`
 * (middleware/src/types/events.ts) and nothing else. Every Verkada-specific
 * field name in the JSON body lives in this file.
 *
 * ============================================================================
 * REAL SCHEMA — https://apidocs.verkada.com/reference/access-events-webhooks
 * (retrieved 2026-09-02; supersedes the provisional shape, see D-006)
 * ----------------------------------------------------------------------------
 *   {
 *     "org_id":       "a74fc6a6-...",
 *     "webhook_type": "notification",        // literal, for EVERY access event
 *     "created_at":   1692131003,            // epoch seconds, Command emit time
 *     "webhook_id":   "457eb610-...",
 *     "data": {
 *       "event_id":          "0a626165-...",             // idempotency key
 *       "device_id":         "14828dd8-...",             // access control object
 *       "created":           1744674135,                 // epoch SECONDS, tap time
 *       "notification_type": "door_keycard_entered_accepted",  // the discriminator
 *       "device_type":       "access_control",
 *       "door_id":           "14828dd8-..." | null,
 *       "direction":         "Inbound" | "Outbound" | null,    // In/Out Doors only
 *       "input_value":       "109|35302" | null,               // format VARIES
 *       "aux_info":          null,
 *       "user_info":         { user_id, name, email, first_name, last_name, phone },
 *       "lockdown_info":     null,
 *       "door_info":         { acu_name, acu_id, name, door_id, site, ... }
 *     }
 *   }
 *
 * Three things about this payload drive the code below:
 *
 *  1. `data.notification_type` is the discriminator, not `webhook_type` (D-006).
 *  2. `data.input_value` is NOT a stable identity. An accepted keycard reports
 *     `"109|35302"` (facility|card); the same physical card rejected reports a
 *     40-bit binary string; entry codes report `"1234"`; face reports a UUID.
 *     Identity therefore keys off `user_info.user_id` (D-007) and `input_value`
 *     is carried for audit only.
 *  3. `user_info` carries the student's NAME, EMAIL and PHONE on every event.
 *     Per D-012 it is reduced to `user_id` here and nowhere later. The zod
 *     schema below models only `user_id`, so zod's default "strip unknown keys"
 *     behaviour deletes the PII during parsing — before any other module, log
 *     line or database row can see it. Do not switch these objects to
 *     `.passthrough()`.
 *
 * Unknown fields are tolerated everywhere (newer examples add `scenario_info`
 * and `door_info.timezone`): an additive Verkada change must never start 4xx-ing
 * production traffic.
 *
 * Signature transport is the other half of the seam and lives in
 * `verifySignature.ts`.
 * ============================================================================
 */

import { z } from 'zod';

import type {
  BusId,
  CardId,
  DeviceDirection,
  ScanEvent,
  VerkadaUserId,
} from '../types/events.js';

/** `webhook_type` is this literal string for every access event (D-006). */
export const VERKADA_WEBHOOK_TYPE = 'notification';

/**
 * The `notification_type` values that represent a credential presented at the
 * door. Everything else Verkada emits — door_opened, door_held_open,
 * door_tamper, door_acu_*, door_aux*, door_apb_*, lockdown_* — is ignored with
 * a 200 (D-009).
 *
 * Accepted types board a student; rejected types are still normalized so the
 * boarding module can record "someone tried" (D-009), but never change state.
 *
 * Extendable per-deployment through `NormalizeContext.credentialNotificationTypes`
 * (e.g. to switch on entry codes or face) without editing the adapter.
 */
export const CREDENTIAL_NOTIFICATION_TYPES = [
  'door_keycard_entered_accepted',
  'door_mobile_nfc_scan_accepted',
  'door_keycard_entered_rejected',
  'door_mobile_nfc_scan_rejected',
] as const;

export type CredentialNotificationType = (typeof CREDENTIAL_NOTIFICATION_TYPES)[number];

const DEFAULT_CREDENTIAL_TYPES: ReadonlySet<string> = new Set(CREDENTIAL_NOTIFICATION_TYPES);

/**
 * Anti-passback events (`door_apb_double_entry` / `door_apb_double_exit`) are
 * deliberately NOT in the set above. They are interesting — see the note in
 * docs/decisions.md — but they describe a door policy violation, not a tap, and
 * acting on them today would double-count boardings.
 */

const epochSeconds = z
  .number()
  .finite()
  .refine((n) => n > 0, { message: 'must be a positive epoch-seconds value' });

/**
 * PII BOUNDARY (D-012). Only `user_id` is modelled; `name`, `email`,
 * `first_name`, `last_name` and `phone` arrive on the wire and are stripped by
 * zod right here. `nullish()` on `user_id` because a rejected credential can
 * carry a `user_info` object with no resolved user, and that must not 400.
 */
const rawUserInfoSchema = z.object({
  user_id: z.string().min(1).nullish(),
});

const rawSiteSchema = z.object({
  name: z.string().nullish(),
  site_id: z.string().nullish(),
});

/**
 * Door metadata. Everything optional: `camera_info` is null in every documented
 * example (D-008), and newer payloads add `timezone`, which strip discards.
 */
const rawDoorInfoSchema = z.object({
  acu_name: z.string().nullish(),
  acu_id: z.string().nullish(),
  name: z.string().nullish(),
  door_id: z.string().nullish(),
  site: rawSiteSchema.nullish(),
  api_control_enabled: z.boolean().nullish(),
  camera_info: z.unknown(),
});

/**
 * The access control event itself.
 *
 * `aux_info` and `lockdown_info` exist on the wire and are deliberately NOT
 * modelled: nothing downstream reads them, and leaving them out means zod
 * strips them rather than carrying an arbitrary blob of unvetted data into
 * memory. `redactRawEvent()` preserves them for forensics.
 */
export const rawAccessEventSchema = z.object({
  // Required. Without these we cannot identify, order or route the event, so a
  // payload missing them is genuinely malformed and gets a 400.
  event_id: z.string().min(1),
  device_id: z.string().min(1),
  /** Epoch SECONDS. The tap time — this is what orders state (D-003). */
  created: epochSeconds,
  notification_type: z.string().min(1),

  // Everything below degrades to null rather than rejecting the delivery. A
  // Verkada-side type change in a field we merely carry must not turn a
  // boarding into a 400 that Verkada then retries forever (D-004).
  device_type: z.string().nullish().catch(null),
  door_id: z.string().nullish().catch(null),
  /**
   * Free-form string, not an enum: populated only for In/Out Doors, and a value
   * we do not recognise must be ignored rather than rejected (D-002).
   */
  direction: z.string().nullish().catch(null),
  /** The credential. Format varies by event type — audit only, never a key (D-007). */
  input_value: z.string().nullish().catch(null),
  user_info: rawUserInfoSchema.nullish().catch(null),
  door_info: rawDoorInfoSchema.nullish().catch(null),
});

/** The full webhook body: envelope + access event. */
export const rawVerkadaWebhookSchema = z.object({
  org_id: z.string().min(1),
  webhook_type: z.string().min(1),
  /** Epoch seconds, when Command emitted the delivery. NOT the tap time. */
  created_at: epochSeconds,
  webhook_id: z.string().min(1),
  data: rawAccessEventSchema,
});

export type RawVerkadaWebhook = z.infer<typeof rawVerkadaWebhookSchema>;
export type RawAccessEvent = z.infer<typeof rawAccessEventSchema>;

/**
 * device/door -> bus resolution. Injected, never hardcoded: the mapping is
 * district configuration (and eventually a DB table), not knowledge of the wire
 * format. In the documented payloads `device_id` and `door_id` are the same
 * UUID, but they are separate fields and ACU-level events carry a null door, so
 * `device_id` is tried first and `door_id` second.
 */
export type DeviceBusLookup = (deviceId: string) => BusId | undefined;

export interface NormalizeContext {
  resolveBusId: DeviceBusLookup;
  /** Wall clock at receipt. Defaults to now. Injected so tests are deterministic. */
  receivedAt?: Date;
  /** Override the credential allow-list. Defaults to CREDENTIAL_NOTIFICATION_TYPES. */
  credentialNotificationTypes?: ReadonlySet<string>;
}

/** Why a well-formed, correctly signed delivery produced no ScanEvent. */
export type IgnoreReason =
  | 'unsupported_webhook_type'
  | 'unsupported_notification_type'
  | 'unknown_reader';

/**
 * A delivery we accepted and did not turn into a scan. Always answered with a
 * 200 (D-004/D-009) — never an error, or Verkada retries it forever.
 *
 * Carries no credential and no user id: an ignored event is logged, and logs
 * get ids of things (doors, events), not people.
 */
export interface IgnoredEvent {
  ignored: true;
  reason: IgnoreReason;
  eventId: string;
  notificationType: string;
  deviceId: string;
  doorId?: string;
  receivedAt: string;
}

export type NormalizedEvent = ScanEvent | IgnoredEvent;

export function isIgnored(result: NormalizedEvent): result is IgnoredEvent {
  return 'ignored' in result && result.ignored;
}

/** Outcome of running an untrusted body through parse + normalize. */
export type NormalizeOutcome =
  | { ok: true; event: ScanEvent }
  | { ok: false; kind: 'malformed'; issues: string[] }
  | { ok: false; kind: 'ignored'; event: IgnoredEvent };

/** epoch seconds -> ISO 8601 UTC. */
export function epochSecondsToIso(seconds: number): string {
  return new Date(Math.round(seconds * 1000)).toISOString();
}

/** ISO 8601 UTC -> epoch seconds. Exported for the adapter's own tests/tools. */
export function isoToEpochSeconds(iso: string): number {
  return new Date(iso).getTime() / 1000;
}

/**
 * `*_accepted` -> true, `*_rejected` -> false, anything else -> undefined
 * (which the caller treats as "not a credential event").
 *
 * Suffix-based on purpose: Verkada keeps adding credential kinds, and every one
 * of them so far ends in one of these two suffixes.
 */
export function acceptedFromNotificationType(notificationType: string): boolean | undefined {
  if (notificationType.endsWith('_accepted')) return true;
  if (notificationType.endsWith('_rejected')) return false;
  return undefined;
}

/** Verkada reports direction only for In/Out Doors; anything else is "unknown". */
function directionFrom(value: string | null | undefined): DeviceDirection | undefined {
  if (value === 'Inbound' || value === 'Outbound') return value;
  return undefined;
}

/** Validate an untrusted body against the real schema. */
export function parseRawVerkadaEvent(
  body: unknown,
): { ok: true; raw: RawVerkadaWebhook } | { ok: false; issues: string[] } {
  const result = rawVerkadaWebhookSchema.safeParse(body);
  if (result.success) return { ok: true, raw: result.data };
  // Issue paths and codes only — never echo the offending values, which can be
  // credentials or PII (CLAUDE.md hard rules, D-012).
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.code}`),
  };
}

/**
 * The adapter proper: Verkada's shape -> the internal contract.
 *
 * Never throws for business reasons. A delivery we cannot turn into a scan
 * comes back as an `IgnoredEvent`, because every one of those cases still has
 * to answer 200 (D-004).
 */
export function normalizeVerkadaEvent(
  raw: RawVerkadaWebhook,
  ctx: NormalizeContext,
): NormalizedEvent {
  const { data } = raw;
  const receivedAt = (ctx.receivedAt ?? new Date()).toISOString();
  const doorId = data.door_id ?? undefined;

  const ignore = (reason: IgnoreReason): IgnoredEvent => ({
    ignored: true,
    reason,
    eventId: data.event_id,
    notificationType: data.notification_type,
    deviceId: data.device_id,
    ...(doorId === undefined ? {} : { doorId }),
    receivedAt,
  });

  if (raw.webhook_type !== VERKADA_WEBHOOK_TYPE) {
    return ignore('unsupported_webhook_type');
  }

  const credentialTypes = ctx.credentialNotificationTypes ?? DEFAULT_CREDENTIAL_TYPES;
  if (!credentialTypes.has(data.notification_type)) {
    return ignore('unsupported_notification_type');
  }

  const accepted = acceptedFromNotificationType(data.notification_type);
  if (accepted === undefined) {
    // Configured as a credential type but with no accept/reject suffix: we
    // cannot tell whether it boards anyone, so we do not guess.
    return ignore('unsupported_notification_type');
  }

  const busId = ctx.resolveBusId(data.device_id) ?? (doorId ? ctx.resolveBusId(doorId) : undefined);
  if (busId === undefined) return ignore('unknown_reader');

  // D-012: user_id survives, everything else about the person is already gone —
  // the zod schema never modelled it.
  const verkadaUserId = data.user_info?.user_id ?? undefined;
  const cardId = data.input_value ?? undefined;
  const deviceDirection = directionFrom(data.direction);

  return {
    eventId: data.event_id,
    ...(verkadaUserId === undefined ? {} : { verkadaUserId: verkadaUserId as VerkadaUserId }),
    ...(cardId === undefined ? {} : { cardId: cardId as CardId }),
    deviceId: data.device_id,
    ...(doorId === undefined ? {} : { doorId }),
    busId,
    notificationType: data.notification_type,
    accepted,
    ...(deviceDirection === undefined ? {} : { deviceDirection }),
    occurredAt: epochSecondsToIso(data.created),
    receivedAt,
  };
}

/**
 * Parse + normalize in one call. This is what the router uses, so the router
 * never touches a Verkada field name.
 */
export function normalizeIncoming(body: unknown, ctx: NormalizeContext): NormalizeOutcome {
  const parsed = parseRawVerkadaEvent(body);
  if (!parsed.ok) return { ok: false, kind: 'malformed', issues: parsed.issues };

  const result = normalizeVerkadaEvent(parsed.raw, ctx);
  if (isIgnored(result)) return { ok: false, kind: 'ignored', event: result };
  return { ok: true, event: result };
}

/**
 * Build a device lookup from a plain map. Convenience for wiring/tests only —
 * the production map comes from configuration, not from this module.
 */
export function deviceLookupFromMap(map: Readonly<Record<string, string>>): DeviceBusLookup {
  return (deviceId) => {
    const busId = map[deviceId];
    return busId === undefined ? undefined : (busId as BusId);
  };
}

/* ========================================================================== *
 * Forensic redaction (D-012)
 * ========================================================================== */

/**
 * Keys that are PII wherever they appear. `name` is NOT in this list on
 * purpose: `door_info.name` is "Front Door" and `door_info.site.name` is "HQ",
 * both of which we want to keep. The person's name lives at
 * `user_info.name`, which the `user_info` reduction below removes wholesale.
 */
const PII_KEYS: ReadonlySet<string> = new Set([
  'email',
  'first_name',
  'last_name',
  'phone',
  'phone_number',
]);

/** Depth guard. Real payloads nest three levels; anything deeper is not ours. */
const MAX_REDACT_DEPTH = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reduce a `user_info` object to `{ user_id }`, dropping name/email/phone and
 * anything else Verkada may add to it later. Default-deny: only `user_id` is
 * copied out.
 */
function redactUserInfo(value: unknown): unknown {
  if (!isRecord(value)) return null;
  const userId = value['user_id'];
  return typeof userId === 'string' ? { user_id: userId } : null;
}

/**
 * Strip a raw webhook body down to something safe to persist for forensics
 * (D-012): the wire payload verbatim, minus every trace of the person.
 *
 * Operates on the ORIGINAL parsed-JSON body rather than the zod output so that
 * unknown/future fields survive for debugging — which is the whole point of
 * keeping the raw payload — while PII does not.
 *
 * Pure: the input is never mutated.
 */
export function redactRawEvent(raw: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return null;

  if (Array.isArray(raw)) return raw.map((item) => redactRawEvent(item, depth + 1));
  if (!isRecord(raw)) return raw;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (PII_KEYS.has(key)) continue;
    if (key === 'user_info') {
      out[key] = redactUserInfo(value);
      continue;
    }
    out[key] = redactRawEvent(value, depth + 1);
  }
  return out;
}
