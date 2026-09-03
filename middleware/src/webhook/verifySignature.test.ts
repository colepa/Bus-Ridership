import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNING_SECRET_ENV,
  loadSigningSecret,
  signWebhookBody,
  signatureFailureStatus,
  verifyWebhookSignature,
} from './verifySignature.js';

const SECRET = 'test-signing-secret-not-a-real-one';
const NOW = new Date('2026-09-02T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const BODY = Buffer.from(
  JSON.stringify({ webhook_id: 'wh_1', data: { event_id: 'evt_1' } }),
  'utf8',
);

function verify(headerValue: string | undefined, body: Buffer = BODY, now: Date = NOW) {
  return verifyWebhookSignature({ rawBody: body, headerValue, secret: SECRET, now });
}

/** Verkada's scheme, spelled out independently of the implementation. */
function referenceDigest(body: Buffer, timestamp: number | string, secret = SECRET): string {
  return createHmac('sha256', secret)
    .update(Buffer.concat([body, Buffer.from(`|${timestamp}`, 'utf8')]))
    .digest('hex');
}

describe('signWebhookBody', () => {
  it('emits <timestamp>|<hex sha256>', () => {
    const header = signWebhookBody(BODY, SECRET, NOW_SECONDS);
    const [timestamp, signature] = header.split('|');

    expect(timestamp).toBe(String(NOW_SECONDS));
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs rawBody + "|" + timestamp — body FIRST (D-011)', () => {
    // The whole point of this test: Verkada's order is the reverse of Stripe's.
    // If someone "fixes" the implementation to `timestamp|body`, this fails.
    const header = signWebhookBody(BODY, SECRET, NOW_SECONDS);
    expect(header).toBe(`${NOW_SECONDS}|${referenceDigest(BODY, NOW_SECONDS)}`);
  });

  it('does not accidentally match the reversed (Stripe-style) ordering', () => {
    const stripeOrder = createHmac('sha256', SECRET)
      .update(Buffer.concat([Buffer.from(`${NOW_SECONDS}|`, 'utf8'), BODY]))
      .digest('hex');

    expect(verify(`${NOW_SECONDS}|${stripeOrder}`)).toEqual({
      ok: false,
      failure: 'invalid_signature',
    });
  });
});

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed body', () => {
    const header = signWebhookBody(BODY, SECRET, NOW_SECONDS);
    expect(verify(header)).toEqual({ ok: true, timestampSeconds: NOW_SECONDS });
  });

  it('accepts an uppercase hex digest', () => {
    const header = `${NOW_SECONDS}|${referenceDigest(BODY, NOW_SECONDS).toUpperCase()}`;
    expect(verify(header).ok).toBe(true);
  });

  it('tolerates surrounding whitespace in the header', () => {
    expect(verify(`  ${signWebhookBody(BODY, SECRET, NOW_SECONDS)}  `).ok).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(verify(undefined)).toEqual({ ok: false, failure: 'missing_header' });
    expect(verify('   ')).toEqual({ ok: false, failure: 'missing_header' });
  });

  it.each([
    ['no separator', `${NOW_SECONDS}${referenceDigest(BODY, NOW_SECONDS)}`],
    ['timestamp only', `${NOW_SECONDS}|`],
    ['signature only', `|${referenceDigest(BODY, NOW_SECONDS)}`],
    ['three tokens', `${NOW_SECONDS}|${referenceDigest(BODY, NOW_SECONDS)}|extra`],
    ['non-numeric timestamp', `yesterday|${referenceDigest(BODY, NOW_SECONDS)}`],
    ['negative timestamp', `-5|${referenceDigest(BODY, NOW_SECONDS)}`],
    ['non-hex signature', `${NOW_SECONDS}|${'z'.repeat(64)}`],
    ['truncated signature', `${NOW_SECONDS}|abcd`],
    ['stripe-style header', `t=${NOW_SECONDS},v1=${referenceDigest(BODY, NOW_SECONDS)}`],
  ])('rejects a malformed header (%s)', (_name, header) => {
    expect(verify(header)).toEqual({ ok: false, failure: 'malformed_header' });
  });

  it('rejects a body that was tampered with after signing', () => {
    const header = signWebhookBody(BODY, SECRET, NOW_SECONDS);
    const tampered = Buffer.from(BODY.toString('utf8').replace('evt_1', 'evt_2'), 'utf8');
    expect(verify(header, tampered)).toEqual({ ok: false, failure: 'invalid_signature' });
  });

  it('rejects a signature made with a different secret', () => {
    const header = signWebhookBody(BODY, 'some-other-secret', NOW_SECONDS);
    expect(verify(header)).toEqual({ ok: false, failure: 'invalid_signature' });
  });

  it('covers the timestamp, so replaying a body under a fresh one fails', () => {
    const captured = referenceDigest(BODY, NOW_SECONDS - 1000);
    // Attacker rewrites the timestamp to something inside the window and keeps
    // the digest. The digest no longer matches the material.
    expect(verify(`${NOW_SECONDS}|${captured}`)).toEqual({
      ok: false,
      failure: 'invalid_signature',
    });
  });

  it('verifies exact bytes: re-serialized JSON does not match', () => {
    const header = signWebhookBody(BODY, SECRET, NOW_SECONDS);
    const reserialized = Buffer.from(
      JSON.stringify(JSON.parse(BODY.toString('utf8')), null, 2),
      'utf8',
    );
    expect(verify(header, reserialized)).toEqual({ ok: false, failure: 'invalid_signature' });
  });

  describe('freshness', () => {
    it('defaults to Verkada’s 60 second window', () => {
      expect(DEFAULT_TOLERANCE_SECONDS).toBe(60);
    });

    it('rejects a replay outside the tolerance window', () => {
      const stale = NOW_SECONDS - DEFAULT_TOLERANCE_SECONDS - 1;
      expect(verify(signWebhookBody(BODY, SECRET, stale))).toEqual({
        ok: false,
        failure: 'timestamp_out_of_tolerance',
      });
    });

    it('accepts a signature right at the edge of the window', () => {
      const edge = NOW_SECONDS - DEFAULT_TOLERANCE_SECONDS;
      expect(verify(signWebhookBody(BODY, SECRET, edge)).ok).toBe(true);
    });

    it('rejects a timestamp implausibly far in the future', () => {
      const future = NOW_SECONDS + DEFAULT_TOLERANCE_SECONDS + 1;
      expect(verify(signWebhookBody(BODY, SECRET, future))).toEqual({
        ok: false,
        failure: 'timestamp_out_of_tolerance',
      });
    });

    it('honours a custom tolerance', () => {
      const header = signWebhookBody(BODY, SECRET, NOW_SECONDS - 30);
      expect(
        verifyWebhookSignature({
          rawBody: BODY,
          headerValue: header,
          secret: SECRET,
          now: NOW,
          toleranceSeconds: 10,
        }),
      ).toEqual({ ok: false, failure: 'timestamp_out_of_tolerance' });
    });

    it('allows the future window to be widened independently for clock skew', () => {
      const header = signWebhookBody(BODY, SECRET, NOW_SECONDS + 120);
      expect(
        verifyWebhookSignature({
          rawBody: BODY,
          headerValue: header,
          secret: SECRET,
          now: NOW,
          toleranceSeconds: 60,
          futureToleranceSeconds: 300,
        }).ok,
      ).toBe(true);
    });

    it('checks freshness before the HMAC, so a stale forgery reports as stale', () => {
      const stale = NOW_SECONDS - 3600;
      expect(verify(`${stale}|${'a'.repeat(64)}`)).toEqual({
        ok: false,
        failure: 'timestamp_out_of_tolerance',
      });
    });
  });
});

describe('signatureFailureStatus', () => {
  it('maps unreadable headers to 400 and untrusted ones to 403 (Verkada docs)', () => {
    expect(signatureFailureStatus('missing_header')).toBe(400);
    expect(signatureFailureStatus('malformed_header')).toBe(400);
    expect(signatureFailureStatus('timestamp_out_of_tolerance')).toBe(403);
    expect(signatureFailureStatus('invalid_signature')).toBe(403);
  });
});

describe('loadSigningSecret', () => {
  it('reads the secret from the environment', () => {
    expect(loadSigningSecret({ [SIGNING_SECRET_ENV]: 'abc' })).toBe('abc');
  });

  it('throws rather than defaulting when unset or blank', () => {
    expect(() => loadSigningSecret({})).toThrow(SIGNING_SECRET_ENV);
    expect(() => loadSigningSecret({ [SIGNING_SECRET_ENV]: '  ' })).toThrow(SIGNING_SECRET_ENV);
  });

  it('never puts the secret in the error message', () => {
    try {
      loadSigningSecret({ [SIGNING_SECRET_ENV]: '' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('VERKADA_WEBHOOK_SECRET=');
    }
  });
});
