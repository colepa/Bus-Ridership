/**
 * Webhook signature verification — Verkada's scheme, not Stripe's (D-011).
 *
 * ============================================================================
 * REAL SCHEME — https://apidocs.verkada.com/reference/securing-webhooks
 * (retrieved 2026-09-02)
 * ----------------------------------------------------------------------------
 *   Header:  Verkada-Signature: <timestamp>|<signature>
 *   Signed:  HMAC-SHA256(secret, rawBody + "|" + timestamp)   <- BODY FIRST
 *   Digest:  lowercase hex
 *
 * The ordering is the trap. This looks like Stripe's `t=...,v1=...` scheme but
 * the signed material is reversed: Verkada's own Python sample is
 *
 *     to_hash = b'|'.join((request.get_data() or b'', timestamp.encode()))
 *
 * i.e. body, pipe, timestamp. Signing `timestamp|body` produces a digest that
 * is wrong in a way no test of ours would catch unless it pins the order — see
 * `verifySignature.test.ts`.
 *
 * The timestamp is inside the signed material, so an attacker cannot replay a
 * captured body under a fresh timestamp. Verkada's sample rejects when
 * `time.time() - int(timestamp) > 60`; that 60s default is configurable here.
 *
 * Status mapping, from Verkada's docs (see `signatureFailureStatus`):
 *   400  signature header missing or malformed
 *   403  signature expired or invalid
 * The previous implementation returned 401 for all of these. It was wrong.
 * ============================================================================
 *
 * Two different notions of "stale" exist in this system; do not conflate them:
 *
 *  - TRANSPORT stale (this file): the signature timestamp is outside the
 *    tolerance window. That is a replay attempt or a badly skewed clock -> 403.
 *    It is stamped when Command POSTs, so it is unaffected by cellular
 *    buffering on the bus.
 *  - BUSINESS stale (boarding module): `ScanEvent.occurredAt` is old because
 *    the gateway buffered it. Per D-003 that is expected and must be tolerated;
 *    it comes back as `RejectionReason.stale_event` and returns 200 (D-004).
 *
 * The signing secret is read from the environment and is never logged, never
 * echoed in an error, and never defaulted to a usable-looking value.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Header Verkada sends the signature in. Verkada writes it `Verkada-Signature`;
 * this is the lowercase form because Node lowercases incoming header names.
 */
export const SIGNATURE_HEADER = 'verkada-signature';

/** Env var holding the shared signing secret. Lives in a gitignored .env. */
export const SIGNING_SECRET_ENV = 'VERKADA_WEBHOOK_SECRET';

/** Verkada's own sample uses 60 seconds. Configurable, but do not raise it idly. */
export const DEFAULT_TOLERANCE_SECONDS = 60;

export type SignatureFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'timestamp_out_of_tolerance'
  | 'invalid_signature';

export type SignatureResult =
  | { ok: true; timestampSeconds: number }
  | { ok: false; failure: SignatureFailure };

export interface VerifyOptions {
  /** The EXACT bytes received. Re-serializing parsed JSON will not verify. */
  rawBody: Buffer;
  /** Raw value of the signature header, if any. */
  headerValue: string | undefined;
  secret: string;
  /** Injected for deterministic tests. */
  now?: Date;
  /** How far in the PAST a signature may be. Default 60s, per Verkada. */
  toleranceSeconds?: number;
  /**
   * How far in the FUTURE a signature may be. Verkada's sample does not bound
   * this at all; we do, because a far-future timestamp is either a broken clock
   * or someone pre-computing signatures. Defaults to `toleranceSeconds`.
   */
  futureToleranceSeconds?: number;
}

/**
 * HTTP status for a signature failure, per Verkada's docs: 400 for a header we
 * cannot even read, 403 for one we can read and do not trust.
 */
export function signatureFailureStatus(failure: SignatureFailure): 400 | 403 {
  return failure === 'missing_header' || failure === 'malformed_header' ? 400 : 403;
}

/**
 * Read the signing secret from the environment.
 *
 * Throws when absent or blank. There is deliberately no fallback: a default
 * secret is an unsigned webhook wearing a costume.
 */
export function loadSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env[SIGNING_SECRET_ENV];
  if (secret === undefined || secret.trim() === '') {
    throw new Error(
      `${SIGNING_SECRET_ENV} is not set. Add it to middleware/.env (gitignored); ` +
        'the webhook refuses to start without it.',
    );
  }
  return secret;
}

interface ParsedHeader {
  /** The timestamp token EXACTLY as received — it is signed material. */
  timestampToken: string;
  timestampSeconds: number;
  signatureHex: string;
}

/**
 * Parse `<timestamp>|<signature>`.
 *
 * Exactly two pipe-separated tokens. The timestamp token is kept verbatim as
 * well as parsed: the HMAC covers the string Verkada sent, so re-rendering
 * `1692131003` from a Number (or normalising a hypothetical leading zero) would
 * break verification.
 */
function parseSignatureHeader(headerValue: string): ParsedHeader | undefined {
  const parts = headerValue.trim().split('|');
  if (parts.length !== 2) return undefined;

  const timestampToken = (parts[0] ?? '').trim();
  const signatureHex = (parts[1] ?? '').trim();

  if (!/^\d+$/.test(timestampToken)) return undefined;
  const timestampSeconds = Number(timestampToken);
  if (!Number.isFinite(timestampSeconds)) return undefined;

  // A SHA-256 hex digest: 64 lowercase-or-uppercase hex chars.
  if (!/^[0-9a-f]{64}$/i.test(signatureHex)) return undefined;

  return { timestampToken, timestampSeconds, signatureHex };
}

/**
 * The exact bytes covered by the HMAC: `rawBody + "|" + timestamp`.
 *
 * Built as a Buffer, not a template string, because the body is arbitrary bytes
 * and must not be forced through a UTF-8 round trip.
 */
function signedPayload(rawBody: Buffer, timestampToken: string): Buffer {
  return Buffer.concat([rawBody, Buffer.from(`|${timestampToken}`, 'utf8')]);
}

function hmacHex(secret: string, payload: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Compute a `Verkada-Signature` header value for a body. Used by tests and, in
 * mirrored form, by tools/mock-verkada. Never call this on the receive path.
 */
export function signWebhookBody(
  rawBody: Buffer | string,
  secret: string,
  timestampSeconds: number,
): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const token = String(Math.trunc(timestampSeconds));
  return `${token}|${hmacHex(secret, signedPayload(body, token))}`;
}

/** Constant-time hex compare. Guards the length mismatch that makes timingSafeEqual throw. */
function hexEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  // timingSafeEqual throws on length mismatch; a length difference is already
  // public information (the digest length is fixed by the algorithm).
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify an incoming webhook.
 *
 * Order matters: shape, then freshness, then the HMAC itself. The failure
 * reason drives the status code (400 vs 403) and the log line; the response
 * body must not tell a caller which of the two 403 checks it failed.
 */
export function verifyWebhookSignature(options: VerifyOptions): SignatureResult {
  const { rawBody, headerValue, secret } = options;
  if (headerValue === undefined || headerValue.trim() === '') {
    return { ok: false, failure: 'missing_header' };
  }

  const parsed = parseSignatureHeader(headerValue);
  if (parsed === undefined) return { ok: false, failure: 'malformed_header' };

  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const futureToleranceSeconds = options.futureToleranceSeconds ?? toleranceSeconds;
  const nowSeconds = (options.now ?? new Date()).getTime() / 1000;
  const ageSeconds = nowSeconds - parsed.timestampSeconds;

  if (ageSeconds > toleranceSeconds || -ageSeconds > futureToleranceSeconds) {
    return { ok: false, failure: 'timestamp_out_of_tolerance' };
  }

  const expected = hmacHex(secret, signedPayload(rawBody, parsed.timestampToken));
  if (!hexEquals(expected, parsed.signatureHex)) {
    return { ok: false, failure: 'invalid_signature' };
  }

  return { ok: true, timestampSeconds: parsed.timestampSeconds };
}
