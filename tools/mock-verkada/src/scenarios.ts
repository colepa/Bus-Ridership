/**
 * Scenarios — the failure modes the system exists to catch, plus the transport
 * failures the webhook has to survive.
 *
 * Two hooks, applied in order:
 *   mutateTaps        — change what happened on the bus (before serialization)
 *   mutateDeliveries  — change how it reached us (after serialization)
 */

import { NOTIFICATION_TYPES, bitStringValue } from './payload.js';
import {
  emitSeconds,
  readBody,
  sortDeliveries,
  userInfoFor,
  withBody,
  type Delivery,
  type Tap,
  type TimelineContext,
} from './simulate.js';
import type { MockDoor } from './route.js';

/**
 * Scenarios shape the timeline only. The signing secret is deliberately not
 * part of this context: the one scenario that needs a wrong key carries its own
 * obviously-fake string, so the real secret never travels through here.
 */
export type ScenarioContext = TimelineContext;

export interface Scenario {
  name: string;
  description: string;
  mutateTaps?: (taps: Tap[], ctx: ScenarioContext) => Tap[];
  mutateDeliveries?: (deliveries: Delivery[], ctx: ScenarioContext) => Delivery[];
}

const SECOND = 1000;
const MINUTE = 60_000;

function nextSeq(deliveries: readonly Delivery[]): number {
  return deliveries.reduce((max, d) => Math.max(max, d.seq), 0) + 1;
}

/** Route-clock ms at which a delivery is POSTed. The inverse of `--compress`. */
function simDeliverMs(delivery: Delivery, ctx: ScenarioContext): number {
  return delivery.deliverAtOffsetMs * ctx.compress;
}

const happy: Scenario = {
  name: 'happy',
  description: 'Clean route run: every student boards at their stop and exits at school.',
};

const wrongBus: Scenario = {
  name: 'wrong-bus',
  description:
    'One student boards a bus that is not theirs. Must still appear on that bus manifest, with a wrong_bus alert (D-005).',
  mutateTaps: (taps, ctx) => {
    const boardings = taps.filter((t) => t.kind === 'board');
    const victim = boardings.length > 0 ? ctx.rng.pick(boardings) : undefined;
    if (victim === undefined) return taps;

    return taps.map((tap) =>
      tap.studentId === victim.studentId
        ? {
            ...tap,
            door: ctx.route.otherBus,
            label: `${tap.label} [WRONG BUS -> ${ctx.route.otherBus.busId}]`,
            expected: 'applied' as const,
            expectedReason: 'wrong_bus alert expected',
          }
        : tap,
    );
  },
};

const neverScansOff: Scenario = {
  name: 'never-scans-off',
  description:
    'One student boards and never taps off. End-of-route reconciliation must raise never_scanned_off.',
  mutateTaps: (taps, ctx) => {
    const boardings = taps.filter((t) => t.kind === 'board');
    const victim = boardings.length > 0 ? ctx.rng.pick(boardings) : undefined;
    if (victim === undefined) return taps;

    return taps
      .filter((tap) => !(tap.studentId === victim.studentId && tap.kind === 'exit'))
      .map((tap) =>
        tap.studentId === victim.studentId
          ? { ...tap, label: `${tap.label} [NEVER SCANS OFF]` }
          : tap,
      );
  },
};

/**
 * Named `unknown-card` for continuity, but identity now keys off
 * `user_info.user_id` (D-007), so what makes this unknown is the user, not the
 * credential.
 */
const unknownCard: Scenario = {
  name: 'unknown-card',
  description:
    'A Verkada user who is on no roster taps at the door. Recorded, not applied, 200 (D-004).',
  mutateTaps: (taps, ctx) => {
    const stop = ctx.route.stops[0];
    return [
      ...taps,
      {
        key: 'unknown-user:board',
        studentId: 'stu_unknown',
        userInfo: {
          user_id: '00000000-0000-4000-8000-999999999999',
          name: 'Syn Unenrolled',
          email: 'unenrolled@example.invalid',
          first_name: 'Syn',
          last_name: 'Unenrolled',
          phone: '+15550009999',
        },
        inputValue: '109|99999',
        door: ctx.route.bus,
        notificationType: NOTIFICATION_TYPES.keycardAccepted,
        kind: 'board',
        simOffsetMs: (stop?.simOffsetMs ?? 0) + 20 * SECOND,
        bufferMs: 900,
        label: 'tap by an unenrolled Verkada user [UNKNOWN USER]',
        expected: 'not_applied',
        expectedReason: 'unknown_user',
      },
    ];
  },
};

const unknownReader: Scenario = {
  name: 'unknown-reader',
  description: 'A tap from a door with no bus mapping (spare unit, mis-provisioned).',
  mutateTaps: (taps, ctx) => {
    const stop = ctx.route.stops[0];
    const student = ctx.route.students[0];
    const spare: MockDoor = {
      busId: 'unmapped',
      deviceId: 'RDR-SPARE-UNIT',
      doorId: 'RDR-SPARE-UNIT',
      doorName: 'spare unit door',
      acuId: 'ACU-SPARE',
      acuName: 'spare door controller',
    };

    return [
      ...taps,
      {
        key: 'unknown-reader:board',
        studentId: student?.studentId ?? 'stu_0001',
        userInfo: student === undefined ? null : userInfoFor(student),
        inputValue: student?.inputValue ?? '109|35001',
        door: spare,
        notificationType: NOTIFICATION_TYPES.keycardAccepted,
        kind: 'board',
        simOffsetMs: (stop?.simOffsetMs ?? 0) + 35 * SECOND,
        bufferMs: 900,
        label: 'tap from an unmapped door [UNKNOWN READER]',
        expected: 'not_applied',
        expectedReason: 'unknown_reader',
      },
    ];
  },
};

/**
 * A credential the door itself refused. Verkada still sends it, and it is real
 * signal — someone tried to get on — but it must never board anyone (D-009).
 * Note the payload differences from an accepted read: `input_value` is a 40-bit
 * binary string and `user_info` is null.
 */
const rejectedCredential: Scenario = {
  name: 'rejected-credential',
  description:
    'A deactivated/unknown card is REJECTED at the door. Recorded as signal, never boards (D-009). 200.',
  mutateTaps: (taps, ctx) => {
    const stop = ctx.route.stops[0];
    return [
      ...taps,
      {
        key: 'rejected-credential:board',
        studentId: 'stu_rejected',
        userInfo: null,
        inputValue: bitStringValue(0x8d_a0_02_f4_05),
        door: ctx.route.bus,
        notificationType: NOTIFICATION_TYPES.keycardRejected,
        kind: 'board',
        simOffsetMs: (stop?.simOffsetMs ?? 0) + 50 * SECOND,
        bufferMs: 900,
        label: 'card refused at the door [REJECTED CREDENTIAL]',
        expected: 'not_applied',
        expectedReason: 'credential_rejected',
      },
      {
        key: 'rejected-credential:nfc',
        studentId: 'stu_rejected',
        userInfo: null,
        inputValue: bitStringValue(0x12_34_56_78_9a),
        door: ctx.route.bus,
        notificationType: NOTIFICATION_TYPES.nfcRejected,
        kind: 'board',
        simOffsetMs: (stop?.simOffsetMs ?? 0) + 55 * SECOND,
        bufferMs: 900,
        label: 'phone NFC refused at the door [REJECTED CREDENTIAL]',
        expected: 'not_applied',
        expectedReason: 'credential_rejected',
      },
    ];
  },
};

/**
 * Door noise. A real bus door emits far more of this than it does taps, and
 * every bit of it must come back 200 without touching the manifest (D-009).
 */
const ignoredType: Scenario = {
  name: 'ignored-type',
  description:
    'Non-credential door events (door_opened, door_held_open). Must return 200 and change nothing (D-009).',
  mutateTaps: (taps, ctx) => {
    const stop = ctx.route.stops[0];
    const base = stop?.simOffsetMs ?? 0;
    const noise = [NOTIFICATION_TYPES.opened, NOTIFICATION_TYPES.heldOpen];

    return [
      ...taps,
      ...noise.map((notificationType, i): Tap => ({
        key: `ignored-type:${notificationType}`,
        studentId: 'n/a',
        userInfo: null,
        inputValue: null,
        door: ctx.route.bus,
        notificationType,
        kind: 'board',
        simOffsetMs: base + (65 + i * 5) * SECOND,
        bufferMs: 900,
        label: `${notificationType} [IGNORED TYPE]`,
        expected: 'not_applied',
        expectedReason: 'unsupported_notification_type',
      })),
    ];
  },
};

const duplicate: Scenario = {
  name: 'duplicate',
  description:
    'Command re-delivers an event it already sent (same event_id, new webhook_id). Must be idempotent: 200, not applied.',
  mutateDeliveries: (deliveries, ctx) => {
    const original = deliveries.find((d) => d.expected === 'applied');
    if (original === undefined) return deliveries;

    const event = readBody(original);
    event.webhook_id = `${event.webhook_id}_redelivery`;
    // created_at moves; event_id and data.created do not — that is the point.
    const simDeliver = simDeliverMs(original, ctx) + 90 * SECOND;
    event.created_at = emitSeconds(ctx.simEpochBaseMs + simDeliver);

    const copy: Delivery = {
      ...withBody(original, event),
      seq: nextSeq(deliveries),
      deliverAtOffsetMs: simDeliver / ctx.compress,
      label: `${original.label} [DUPLICATE re-delivery]`,
      expected: 'not_applied',
      expectedReason: 'duplicate_event',
    };

    return sortDeliveries([...deliveries, copy]);
  },
};

const lateBurst: Scenario = {
  name: 'late-burst',
  description:
    'Cellular dropout: taps keep happening, nothing is delivered, then everything arrives at once and out of order (D-003).',
  mutateDeliveries: (deliveries, ctx) => {
    const dropoutStartSim = ctx.route.stops[Math.floor(ctx.route.stops.length / 2)]?.simOffsetMs;
    if (dropoutStartSim === undefined) return deliveries;

    const dropoutEndSim = dropoutStartSim + 5 * MINUTE;

    const inWindow = deliveries.filter((d) => {
      const at = simDeliverMs(d, ctx);
      return at >= dropoutStartSim && at < dropoutEndSim;
    });
    if (inWindow.length === 0) return deliveries;

    // Buffered events flush in whatever order the gateway feels like.
    const flushOrder = ctx.rng.shuffle(inWindow.map((d) => d.seq));

    const rewritten = deliveries.map((delivery) => {
      const position = flushOrder.indexOf(delivery.seq);
      if (position === -1) return delivery;

      const flushSim = dropoutEndSim + position * 250;
      const event = readBody(delivery);
      // data.created (the tap) stays put; only the emit time moves.
      event.created_at = emitSeconds(ctx.simEpochBaseMs + flushSim);

      return {
        ...withBody(delivery, event),
        deliverAtOffsetMs: flushSim / ctx.compress,
        label: `${delivery.label} [LATE BURST]`,
      };
    });

    return sortDeliveries(rewritten);
  },
};

const badSignature: Scenario = {
  name: 'bad-signature',
  description: 'An event signed with the wrong secret. Must be rejected 403 and never applied.',
  mutateDeliveries: (deliveries, ctx) => {
    const original = deliveries.find((d) => d.expected === 'applied');
    if (original === undefined) return deliveries;

    const forged: Delivery = {
      ...original,
      seq: nextSeq(deliveries),
      deliverAtOffsetMs: original.deliverAtOffsetMs + (5 * SECOND) / ctx.compress,
      overrideSecret: 'not-the-real-signing-secret',
      label: `${original.label} [BAD SIGNATURE]`,
      expected: 'client_error',
      expectedReason: 'signature verification failure (403)',
    };

    return sortDeliveries([...deliveries, forged]);
  },
};

const replay: Scenario = {
  name: 'replay',
  description:
    'A correctly signed event captured earlier and re-sent with its original, now-stale signature timestamp. Verkada tolerates 60 seconds.',
  mutateDeliveries: (deliveries, ctx) => {
    const original = deliveries.find((d) => d.expected === 'applied');
    if (original === undefined) return deliveries;

    // The signature clock is REAL time, so the stale timestamp is real too.
    const staleSeconds = Math.floor((ctx.startRealMs - 45 * MINUTE) / 1000);
    const replayed: Delivery = {
      ...original,
      seq: nextSeq(deliveries),
      deliverAtOffsetMs: original.deliverAtOffsetMs + (10 * SECOND) / ctx.compress,
      overrideTimestampSeconds: staleSeconds,
      label: `${original.label} [REPLAY, stale signature]`,
      expected: 'client_error',
      expectedReason: 'timestamp outside the 60s tolerance (403)',
    };

    return sortDeliveries([...deliveries, replayed]);
  },
};

const malformed: Scenario = {
  name: 'malformed',
  description:
    'A correctly signed body that does not match the payload shape, and one that is not JSON at all. Both 400.',
  mutateDeliveries: (deliveries, ctx) => {
    const base = deliveries[0];
    const offset = (base?.deliverAtOffsetMs ?? 0) + (2 * SECOND) / ctx.compress;
    const seq = nextSeq(deliveries);

    const shapeless: Delivery = {
      seq,
      label: 'signed body missing required fields [MALFORMED]',
      bodyText: JSON.stringify({
        org_id: 'org_broken',
        webhook_type: 'notification',
        webhook_id: 'wh_broken',
        // no created_at, and data has no event_id/device_id/created
        data: { notification_type: 'door_keycard_entered_accepted' },
      }),
      deliverAtOffsetMs: offset,
      occurredAtMs: ctx.simEpochBaseMs + offset * ctx.compress,
      expected: 'client_error',
      expectedReason: 'payload shape (400)',
    };

    const notJson: Delivery = {
      seq: seq + 1,
      label: 'signed body that is not JSON [MALFORMED]',
      bodyText: '{"webhook_id": "wh_truncated", "data": {',
      deliverAtOffsetMs: offset + (1 * SECOND) / ctx.compress,
      occurredAtMs: ctx.simEpochBaseMs + offset * ctx.compress,
      expected: 'client_error',
      expectedReason: 'not JSON (400)',
    };

    return sortDeliveries([...deliveries, shapeless, notJson]);
  },
};

const registry: Scenario[] = [
  happy,
  wrongBus,
  neverScansOff,
  unknownCard,
  unknownReader,
  rejectedCredential,
  ignoredType,
  duplicate,
  lateBurst,
  badSignature,
  replay,
  malformed,
];

export const SCENARIOS: ReadonlyMap<string, Scenario> = new Map(registry.map((s) => [s.name, s]));

/** Every failure mode at once. Useful as a smoke test of the whole pipeline. */
export const ALL_SCENARIO = 'all';

export function listScenarios(): Scenario[] {
  return [...registry];
}

/** Resolve a comma-separated --scenario value into an ordered scenario list. */
export function resolveScenarios(value: string): Scenario[] {
  const names = value
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');

  if (names.length === 0) return [happy];
  if (names.includes(ALL_SCENARIO)) return registry.filter((s) => s.name !== happy.name);

  return names.map((name) => {
    const scenario = SCENARIOS.get(name);
    if (scenario === undefined) {
      throw new Error(
        `unknown scenario "${name}". Known: ${[ALL_SCENARIO, ...registry.map((s) => s.name)].join(', ')}`,
      );
    }
    return scenario;
  });
}
