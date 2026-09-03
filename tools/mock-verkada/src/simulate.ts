/**
 * Turns a route run into a timeline of taps, then into a timeline of HTTP
 * deliveries.
 *
 * THREE clocks, deliberately separate:
 *
 *  - the ROUTE clock (`simOffsetMs`, `occurredAtMs`) — when the tap happened at
 *    the door. Emitted as `data.created` in real, uncompressed seconds so the
 *    payload looks like an actual 45-minute route: taps at one stop land
 *    seconds apart, stops land minutes apart, and a cellular dropout is a real
 *    five-minute gap. This is what orders state (D-003). The route is anchored
 *    so that it *ends* at the moment the run starts, which keeps every
 *    `created` value in the past.
 *  - the DELIVERY clock (`deliverAtOffsetMs`) — when Command POSTs it to us,
 *    compressed by `--compress` so a 45-minute run plays out in seconds.
 *  - the SIGNATURE clock — real wall time at send, applied in transport.ts.
 *    Verkada's tolerance is 60 seconds, so this one must never be simulated.
 *
 * The gap between the route clock and the signature clock is the point: it is
 * exactly the cellular buffering the middleware has to tolerate.
 */

import {
  buildRawVerkadaEvent,
  msToEpochSeconds,
  type RawVerkadaEvent,
  type RawVerkadaUserInfo,
  type VerkadaDirection,
} from './payload.js';
import type { Rng } from './rng.js';
import type { MockDoor, MockStudent, RouteRun } from './route.js';

export type ExpectedOutcome = 'applied' | 'not_applied' | 'client_error';

export interface Tap {
  key: string;
  studentId: string;
  /** Null when the credential resolves to no user (rejected/unknown reads). */
  userInfo: RawVerkadaUserInfo | null;
  /** `input_value`. Format depends on the notification type — see payload.ts. */
  inputValue: string | null;
  /** The door the tap happened at. Carries device/door/ACU ids. */
  door: MockDoor;
  notificationType: string;
  kind: 'board' | 'exit';
  /** Route-clock ms from route start. */
  simOffsetMs: number;
  /** Extra route-clock ms of cellular buffering before Command emits it. */
  bufferMs: number;
  label: string;
  expected: ExpectedOutcome;
  expectedReason?: string;
}

export interface Delivery {
  seq: number;
  label: string;
  bodyText: string;
  /** Real ms after start at which to POST. */
  deliverAtOffsetMs: number;
  /** Route-clock epoch ms of the tap, for display and mutation. */
  occurredAtMs: number;
  /** Sign with this instead of the real secret (bad-signature scenario). */
  overrideSecret?: string;
  /** Sign with this timestamp instead of now (replay scenario). */
  overrideTimestampSeconds?: number;
  expected: ExpectedOutcome;
  expectedReason?: string;
}

export interface TimelineContext {
  route: RouteRun;
  rng: Rng;
  /** Real epoch ms at which the run starts. Paces deliveries. */
  startRealMs: number;
  /** Route-clock epoch ms of route start. Anchors `data.created`. */
  simEpochBaseMs: number;
  /** Route-clock ms per real ms. 60 = one simulated minute per real second. */
  compress: number;
  /** In/Out Door mode: populate `data.direction` (D-002). */
  directions: boolean;
  runTag: string;
}

const SECOND = 1000;
const MINUTE = 60_000;

/** Normal cellular delivery lag, in route-clock ms. */
function normalLatency(rng: Rng): number {
  return rng.int(400, 2500);
}

/** The PII-bearing half of `user_info`, exactly as Verkada sends it. */
export function userInfoFor(student: MockStudent): RawVerkadaUserInfo {
  return {
    user_id: student.verkadaUserId,
    name: student.person.name,
    email: student.person.email,
    first_name: student.person.firstName,
    last_name: student.person.lastName,
    phone: student.person.phone,
  };
}

/** The happy-path timeline: everyone boards at their stop, everyone exits at school. */
export function buildTaps(route: RouteRun, rng: Rng): Tap[] {
  const taps: Tap[] = [];

  for (const student of route.students) {
    const stop = route.stops[student.stopIndex];
    if (stop === undefined) continue;

    // Students queue at the door: a few seconds apart, order jittered.
    const boardOffset = stop.simOffsetMs + rng.int(0, 45 * SECOND);
    taps.push({
      key: `${student.studentId}:board`,
      studentId: student.studentId,
      userInfo: userInfoFor(student),
      inputValue: student.inputValue,
      door: route.bus,
      notificationType: 'door_keycard_entered_accepted',
      kind: 'board',
      simOffsetMs: boardOffset,
      bufferMs: normalLatency(rng),
      label: `board ${student.studentId} @ ${stop.stopId}`,
      expected: 'applied',
    });
  }

  for (const student of route.students) {
    const exitOffset = route.arrivalSimOffsetMs + rng.int(0, 4 * MINUTE);
    taps.push({
      key: `${student.studentId}:exit`,
      studentId: student.studentId,
      userInfo: userInfoFor(student),
      inputValue: student.inputValue,
      door: route.bus,
      notificationType: 'door_keycard_entered_accepted',
      kind: 'exit',
      simOffsetMs: exitOffset,
      bufferMs: normalLatency(rng),
      label: `exit ${student.studentId} @ school`,
      expected: 'applied',
    });
  }

  return taps.sort((a, b) => a.simOffsetMs - b.simOffsetMs);
}

/** Serialize taps into signed-ready HTTP deliveries, ordered by arrival time. */
export function buildDeliveries(taps: readonly Tap[], ctx: TimelineContext): Delivery[] {
  const deliveries = taps.map((tap, index): Delivery => {
    const occurredAtMs = ctx.simEpochBaseMs + tap.simOffsetMs;
    const emittedAtMs = occurredAtMs + tap.bufferMs;

    return {
      seq: index,
      label: tap.label,
      bodyText: JSON.stringify(buildEvent(tap, index, occurredAtMs, emittedAtMs, ctx)),
      deliverAtOffsetMs: (tap.simOffsetMs + tap.bufferMs) / ctx.compress,
      occurredAtMs,
      expected: tap.expected,
      ...(tap.expectedReason === undefined ? {} : { expectedReason: tap.expectedReason }),
    };
  });

  return sortDeliveries(deliveries);
}

/**
 * `data.direction` is populated only when the door is configured as an In/Out
 * Door (D-002). `--directions` simulates that configuration; without it the
 * field is null and the middleware has to derive direction from state.
 */
function directionFor(tap: Tap, ctx: TimelineContext): VerkadaDirection | null {
  if (!ctx.directions) return null;
  return tap.kind === 'board' ? 'Inbound' : 'Outbound';
}

export function buildEvent(
  tap: Tap,
  index: number,
  occurredAtMs: number,
  emittedAtMs: number,
  ctx: TimelineContext,
): RawVerkadaEvent {
  const suffix = String(index).padStart(4, '0');
  return buildRawVerkadaEvent({
    eventId: `evt_${ctx.runTag}_${suffix}`,
    webhookId: `wh_${ctx.runTag}_${suffix}`,
    orgId: ctx.route.orgId,
    deviceId: tap.door.deviceId,
    doorId: tap.door.doorId,
    doorName: tap.door.doorName,
    acuId: tap.door.acuId,
    acuName: tap.door.acuName,
    siteName: ctx.route.siteName,
    siteId: ctx.route.siteId,
    notificationType: tap.notificationType,
    inputValue: tap.inputValue,
    userInfo: tap.userInfo,
    direction: directionFor(tap, ctx),
    occurredAtMs,
    emittedAtMs,
  });
}

/** Arrival order. Ties keep their original sequence so runs stay reproducible. */
export function sortDeliveries(deliveries: readonly Delivery[]): Delivery[] {
  return [...deliveries].sort((a, b) => a.deliverAtOffsetMs - b.deliverAtOffsetMs || a.seq - b.seq);
}

/** Re-parse a delivery body to mutate it (duplicates, replays, corruption). */
export function readBody(delivery: Delivery): RawVerkadaEvent {
  return JSON.parse(delivery.bodyText) as RawVerkadaEvent;
}

export function withBody(delivery: Delivery, event: RawVerkadaEvent): Delivery {
  return { ...delivery, bodyText: JSON.stringify(event) };
}

/** Route-clock ms -> the integer epoch seconds Verkada puts in `created_at`. */
export function emitSeconds(routeClockMs: number): number {
  return msToEpochSeconds(routeClockMs);
}
