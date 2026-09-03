/**
 * Delivery: paces the timeline against the real clock and POSTs each body,
 * signed at send time exactly the way Command would.
 *
 * The signing secret is read from the environment and only ever used as an
 * HMAC key. It is never printed, not even in --dry-run output.
 */

import { SIGNATURE_HEADER, signWebhookBody } from './payload.js';
import type { Delivery, ExpectedOutcome } from './simulate.js';

export interface DeliveryResult {
  delivery: Delivery;
  status: number | 'error';
  observed: ExpectedOutcome | 'server_error' | 'transport_error';
  reason?: string;
  matchedExpectation: boolean;
}

export interface SendOptions {
  url: string;
  secret: string;
  dryRun: boolean;
  timeoutMs: number;
  onResult: (result: DeliveryResult) => void;
  /** Real epoch ms the run started; used to pace deliveries. */
  startRealMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function classify(status: number, body: unknown): { observed: DeliveryResult['observed']; reason?: string } {
  if (status >= 500) return { observed: 'server_error' };
  if (status >= 400) return { observed: 'client_error' };

  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const applied = record['applied'] === true;
  const reason = typeof record['reason'] === 'string' ? record['reason'] : undefined;

  return {
    observed: applied ? 'applied' : 'not_applied',
    ...(reason === undefined ? {} : { reason }),
  };
}

/** POST one delivery. Signs at send time unless the scenario overrides it. */
export async function sendDelivery(
  delivery: Delivery,
  options: Pick<SendOptions, 'url' | 'secret' | 'timeoutMs'>,
): Promise<{ status: number | 'error'; body: unknown; error?: string }> {
  const secret = delivery.overrideSecret ?? options.secret;
  const timestampSeconds =
    delivery.overrideTimestampSeconds ?? Math.floor(Date.now() / 1000);
  const signature = signWebhookBody(delivery.bodyText, secret, timestampSeconds);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signature,
      },
      body: delivery.bodyText,
      signal: controller.signal,
    });

    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // Non-JSON error page; keep the raw text.
    }
    return { status: response.status, body };
  } catch (err) {
    return {
      status: 'error',
      body: undefined,
      error: err instanceof Error ? err.message : 'unknown transport error',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Run the whole timeline in arrival order, pacing against the wall clock. */
export async function runDeliveries(
  deliveries: readonly Delivery[],
  options: SendOptions,
): Promise<DeliveryResult[]> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const results: DeliveryResult[] = [];

  for (const delivery of deliveries) {
    const dueAt = options.startRealMs + delivery.deliverAtOffsetMs;
    const wait = dueAt - now();
    if (wait > 1) await sleep(wait);

    if (options.dryRun) {
      const result: DeliveryResult = {
        delivery,
        status: 0,
        observed: delivery.expected,
        matchedExpectation: true,
        ...(delivery.expectedReason === undefined ? {} : { reason: delivery.expectedReason }),
      };
      results.push(result);
      options.onResult(result);
      continue;
    }

    const response = await sendDelivery(delivery, options);

    if (response.status === 'error') {
      const result: DeliveryResult = {
        delivery,
        status: 'error',
        observed: 'transport_error',
        matchedExpectation: false,
        ...(response.error === undefined ? {} : { reason: response.error }),
      };
      results.push(result);
      options.onResult(result);
      continue;
    }

    const { observed, reason } = classify(response.status, response.body);
    const result: DeliveryResult = {
      delivery,
      status: response.status,
      observed,
      matchedExpectation: observed === delivery.expected,
      ...(reason === undefined ? {} : { reason }),
    };
    results.push(result);
    options.onResult(result);
  }

  return results;
}
