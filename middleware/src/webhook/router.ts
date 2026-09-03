/**
 * Verkada webhook endpoint.
 *
 * Contract with the rest of the system:
 *  - This module knows HTTP, signatures, and nothing about boarding rules.
 *    Every decision about state is delegated to the injected `applyScan`
 *    handler (implemented by middleware/src/boarding), which returns an
 *    `ApplyResult`.
 *  - This module knows no Verkada field names. `normalize.ts` owns those.
 *
 * Status codes follow Verkada's endpoint contract and docs/decisions.md
 * (D-004, D-010, D-011):
 *  - 400  signature header missing or malformed; body is not JSON or does not
 *         match the payload shape
 *  - 403  signature expired or invalid  (NOT 401 — Verkada documents 403)
 *  - 500  our fault: boarding/persistence failed or timed out. Verkada's docs
 *         read 500 as "try this request later", which is exactly what we want.
 *  - 200  everything else, including unknown user, ignored notification types,
 *         duplicates, and stale/out-of-order events. Those are recorded and not
 *         applied; a 4xx would make Verkada retry them forever.
 *
 * TIMING (D-010). Verkada requires a response in under 2000 ms. Two rules keep
 * that true:
 *  1. A hard deadline timer (`applyTimeoutMs`, default 1500 ms) answers the
 *     request even if something downstream hangs. It never leaves the socket
 *     open waiting on a database.
 *  2. Anything that is not needed to decide the response — raw-payload
 *     archival, enrichment (GPS/clip lookups against Command, D-008), alert
 *     fan-out — MUST be asynchronous and MUST NOT be awaited here. The injected
 *     `applyScan` is awaited, so its implementation is expected to do the
 *     minimum synchronous state transition and queue the rest.
 *
 * CONCURRENCY. The router holds no per-request state outside the handler
 * closure, so concurrent deliveries are independent. Ordering is re-established
 * downstream from `occurredAt` (D-003), never from arrival order.
 *
 * LOGGING (CLAUDE.md hard rules + D-012): event ids, device/door ids, bus ids,
 * notification types and outcomes only. Never a credential (`input_value`),
 * never a name/email/phone, never a student or Verkada user id, never the
 * signing secret.
 */

import express, { type Request, type Response, type Router } from 'express';

import type { ApplyResult, ScanEvent } from '../types/events.js';
import {
  normalizeIncoming,
  redactRawEvent,
  type DeviceBusLookup,
  type IgnoredEvent,
  type NormalizeOutcome,
} from './normalize.js';
import {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  signatureFailureStatus,
  verifyWebhookSignature,
} from './verifySignature.js';

/** Boarding-module seam. Injected so the webhook can be built and tested alone. */
export type ApplyScan = (scan: ScanEvent) => ApplyResult | Promise<ApplyResult>;

/** An event we accepted but could not even turn into a ScanEvent. */
export interface UnroutableEvent {
  eventId: string;
  deviceId: string;
  doorId?: string;
  notificationType: string;
  receivedAt: string;
  reason: 'unknown_reader';
  /** Wire payload with `user_info` reduced to `user_id` (D-012). Safe to store. */
  redactedRaw: unknown;
}

/** Optional sink for unroutable events so they are still auditable. */
export type RecordUnroutable = (event: UnroutableEvent) => void | Promise<void>;

/**
 * Optional forensic archive of every verified delivery. Receives the payload
 * with PII already stripped (D-012). Called fire-and-forget: it is persistence,
 * so it must not sit on the response path (D-010).
 */
export type ArchiveRawEvent = (redactedRaw: unknown) => void | Promise<void>;

export interface WebhookLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface WebhookRouterDeps {
  /** HMAC signing secret. Load with `loadSigningSecret()`; never hardcode. */
  secret: string;
  /** device/door -> bus mapping, from configuration. */
  resolveBusId: DeviceBusLookup;
  /** Boarding logic. The only place state changes. */
  applyScan: ApplyScan;
  recordUnroutable?: RecordUnroutable;
  archiveRawEvent?: ArchiveRawEvent;
  logger?: WebhookLogger;
  /** Injected clock for deterministic tests. */
  now?: () => Date;
  /** Signature replay window, seconds. Default 60 (Verkada's own sample). */
  toleranceSeconds?: number;
  /**
   * Hard response deadline in ms. Must stay comfortably under Verkada's 2000 ms
   * requirement (D-010); the margin covers TLS and network time we do not see.
   */
  applyTimeoutMs?: number;
  /**
   * What to answer when the deadline fires. 500 (default) asks Verkada to retry,
   * which is right because we do not know whether the scan was applied — and
   * boarding is idempotent on `event_id`, so a retry is safe. Set to 200 for a
   * deployment that would rather drop an event than receive a redelivery.
   */
  applyTimeoutStatus?: 200 | 500;
  /** Route path within the router. Mount the router wherever you like. */
  path?: string;
  /** Max accepted body size. Verkada events are small; this is a DoS guard. */
  bodyLimit?: string;
  /** Override the credential notification-type allow-list (see normalize.ts). */
  credentialNotificationTypes?: ReadonlySet<string>;
}

const defaultLogger: WebhookLogger = {
  info: (message, fields) => console.log(JSON.stringify({ level: 'info', message, ...fields })),
  warn: (message, fields) => console.warn(JSON.stringify({ level: 'warn', message, ...fields })),
  error: (message, fields) => console.error(JSON.stringify({ level: 'error', message, ...fields })),
};

export const DEFAULT_WEBHOOK_PATH = '/verkada';

/** Comfortably inside Verkada's 2000 ms ceiling (D-010). */
export const DEFAULT_APPLY_TIMEOUT_MS = 1500;

function signatureHeaderValue(req: Request): string | undefined {
  return req.header(SIGNATURE_HEADER) ?? undefined;
}

/** Parse the raw bytes. Kept separate so a JSON error is unambiguously a 400. */
function parseJsonBody(rawBody: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(rawBody.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

/**
 * Build the webhook router.
 *
 * Mount example (done by the app entrypoint, not here):
 *   app.use('/webhooks', createWebhookRouter({ ... }));  // POST /webhooks/verkada
 */
export function createWebhookRouter(deps: WebhookRouterDeps): Router {
  const {
    secret,
    resolveBusId,
    applyScan,
    recordUnroutable,
    archiveRawEvent,
    logger = defaultLogger,
    now = () => new Date(),
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
    applyTimeoutMs = DEFAULT_APPLY_TIMEOUT_MS,
    applyTimeoutStatus = 500,
    path = DEFAULT_WEBHOOK_PATH,
    bodyLimit = '256kb',
    credentialNotificationTypes,
  } = deps;

  if (secret.trim() === '') {
    throw new Error('createWebhookRouter: signing secret is empty');
  }
  if (applyTimeoutMs <= 0 || applyTimeoutMs >= 2000) {
    throw new Error('createWebhookRouter: applyTimeoutMs must be >0 and <2000 (D-010)');
  }

  const router = express.Router();

  // RAW BODY CAPTURE. This must run instead of (never after) a JSON body
  // parser: the HMAC covers the exact bytes Verkada sent, and
  // JSON.stringify(JSON.parse(body)) is not those bytes. `type: '*/*'` means a
  // wrong or missing Content-Type still yields a Buffer we can verify, rather
  // than an empty body that mysteriously fails the signature check.
  const captureRawBody = express.raw({ type: '*/*', limit: bodyLimit });

  router.post(path, captureRawBody, (req: Request, res: Response): void => {
    void handleWebhook(req, res);
  });

  /** Fire-and-forget: persistence must never sit on the response path (D-010). */
  function detach(work: unknown, event: string, fields: Record<string, unknown>): void {
    if (work instanceof Promise) {
      work.catch((err: unknown) => {
        logger.error(event, { ...fields, error: errorMessage(err) });
      });
    }
  }

  async function handleWebhook(req: Request, res: Response): Promise<void> {
    const receivedAt = now();

    let responded = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    /** Single exit point. Idempotent, so a late `applyScan` cannot double-send. */
    const respond = (status: number, body: Record<string, unknown>): void => {
      if (responded) return;
      responded = true;
      if (deadline !== undefined) clearTimeout(deadline);
      res.status(status).json(body);
    };

    // D-010: answer no matter what. If boarding, the database or anything else
    // hangs, the socket is still closed inside the window with a status Verkada
    // understands.
    deadline = setTimeout(() => {
      logger.error('webhook.deadline_exceeded', {
        timeoutMs: applyTimeoutMs,
        status: applyTimeoutStatus,
      });
      respond(
        applyTimeoutStatus,
        applyTimeoutStatus === 200
          ? { applied: false, reason: 'timeout' }
          : { error: 'apply_timeout' },
      );
    }, applyTimeoutMs);

    try {
      const rawBody: unknown = req.body;
      if (!Buffer.isBuffer(rawBody)) {
        // Something upstream already consumed/parsed the body. Verifying now is
        // impossible, so fail closed and make the misconfiguration loud.
        logger.error('webhook.raw_body_missing', {
          detail: 'body was not captured as a Buffer; check middleware ordering',
        });
        respond(400, { error: 'raw_body_required' });
        return;
      }

      const signature = verifyWebhookSignature({
        rawBody,
        headerValue: signatureHeaderValue(req),
        secret,
        now: receivedAt,
        toleranceSeconds,
      });

      if (!signature.ok) {
        const status = signatureFailureStatus(signature.failure);
        // Log the specific failure; return only the class of failure. A caller
        // learns "your header is unreadable" (400) or "I do not trust it" (403),
        // never which of expiry/HMAC tripped.
        logger.warn('webhook.signature_rejected', {
          failure: signature.failure,
          status,
          bytes: rawBody.length,
        });
        respond(status, {
          error: status === 400 ? 'invalid_signature_header' : 'invalid_signature',
        });
        return;
      }

      const parsed = parseJsonBody(rawBody);
      if (!parsed.ok) {
        logger.warn('webhook.malformed_body', { detail: 'body is not valid JSON' });
        respond(400, { error: 'malformed_body' });
        return;
      }

      // Forensic copy, PII already removed (D-012). Never awaited.
      if (archiveRawEvent !== undefined) {
        try {
          detach(archiveRawEvent(redactRawEvent(parsed.value)), 'webhook.archive_failed', {});
        } catch (err) {
          logger.error('webhook.archive_failed', { error: errorMessage(err) });
        }
      }

      const outcome: NormalizeOutcome = normalizeIncoming(parsed.value, {
        resolveBusId,
        receivedAt,
        ...(credentialNotificationTypes === undefined ? {} : { credentialNotificationTypes }),
      });

      if (!outcome.ok) {
        if (outcome.kind === 'malformed') {
          logger.warn('webhook.malformed_body', { issues: outcome.issues });
          respond(400, { error: 'malformed_body' });
          return;
        }
        handleIgnored(outcome.event, parsed.value, respond);
        return;
      }

      const event = outcome.event;

      let result: ApplyResult;
      try {
        result = await applyScan(event);
      } catch (err) {
        // A boarding/DB failure is ours, not the caller's: 500 so Verkada retries.
        logger.error('webhook.apply_failed', {
          eventId: event.eventId,
          busId: event.busId,
          error: errorMessage(err),
        });
        respond(500, { error: 'apply_failed' });
        return;
      }

      if (responded) {
        // The deadline already answered. Boarding still ran; say so, because a
        // Verkada retry will now hit the duplicate path rather than re-apply.
        logger.warn('webhook.applied_after_deadline', {
          eventId: event.eventId,
          busId: event.busId,
          applied: result.applied,
        });
        return;
      }

      // Alert payloads carry student ids; count them, do not echo or log them.
      const alertKinds = result.alerts.map((a) => a.kind);
      const fields = {
        eventId: event.eventId,
        busId: event.busId,
        deviceId: event.deviceId,
        notificationType: event.notificationType,
        accepted: event.accepted,
        alerts: alertKinds,
      };

      if (result.applied) {
        logger.info('webhook.applied', {
          ...fields,
          direction: result.scan?.direction,
          directionSource: result.scan?.directionSource,
        });
      } else {
        logger.info('webhook.not_applied', { ...fields, reason: result.reason });
      }

      respond(200, {
        applied: result.applied,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        eventId: event.eventId,
        alerts: alertKinds,
      });
    } catch (err) {
      // Nothing should reach here; if it does, Verkada should retry.
      logger.error('webhook.unhandled_error', { error: errorMessage(err) });
      respond(500, { error: 'internal_error' });
    }
  }

  /**
   * A verified, well-formed delivery that produced no scan. Always 200 — an
   * ignored notification type is not an error (D-009), and an unmapped reader
   * is recorded rather than retried forever (D-004).
   */
  function handleIgnored(
    ignored: IgnoredEvent,
    rawValue: unknown,
    respond: (status: number, body: Record<string, unknown>) => void,
  ): void {
    if (ignored.reason === 'unknown_reader') {
      if (recordUnroutable !== undefined) {
        const record: UnroutableEvent = {
          eventId: ignored.eventId,
          deviceId: ignored.deviceId,
          ...(ignored.doorId === undefined ? {} : { doorId: ignored.doorId }),
          notificationType: ignored.notificationType,
          receivedAt: ignored.receivedAt,
          reason: 'unknown_reader',
          redactedRaw: redactRawEvent(rawValue),
        };
        try {
          detach(recordUnroutable(record), 'webhook.record_unroutable_failed', {
            eventId: ignored.eventId,
          });
        } catch (err) {
          logger.error('webhook.record_unroutable_failed', {
            eventId: ignored.eventId,
            error: errorMessage(err),
          });
        }
      }

      logger.warn('webhook.not_applied', {
        eventId: ignored.eventId,
        deviceId: ignored.deviceId,
        notificationType: ignored.notificationType,
        reason: 'unknown_reader',
      });
    } else {
      // Correctly signed, well-formed, just not an event we act on (D-009).
      logger.info('webhook.ignored', {
        eventId: ignored.eventId,
        deviceId: ignored.deviceId,
        notificationType: ignored.notificationType,
        reason: ignored.reason,
      });
    }

    respond(200, {
      applied: false,
      reason: ignored.reason,
      eventId: ignored.eventId,
    });
  }

  return router;
}
