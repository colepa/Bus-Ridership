/**
 * Synthetic builders for the boarding tests. Test-only, but a plain module so
 * both test files share one set of fixtures.
 *
 * Synthetic data only — these names, user ids and card values are invented
 * (hard rule).
 */

import type {
  BusId,
  CardId,
  DeviceDirection,
  RouteId,
  ScanEvent,
  StopId,
  StudentAssignment,
  StudentId,
  VerkadaUserId,
} from '../types/events.js';
import type { RosterLookup } from './stateMachine.js';

export const busId = (value: string): BusId => value as BusId;
export const userId = (value: string): VerkadaUserId => value as VerkadaUserId;
export const cardId = (value: string): CardId => value as CardId;
export const studentId = (value: string): StudentId => value as StudentId;
export const routeId = (value: string): RouteId => value as RouteId;
export const stopId = (value: string): StopId => value as StopId;

export const BUS_12 = busId('BUS-12');
export const BUS_ROGUE = busId('BUS-77');
export const ROUTE_RUN = 'run-2026-09-02-am';

/** The `notification_type` a normal accepted keycard tap carries (D-009). */
export const ACCEPTED_TYPE = 'door_keycard_entered_accepted';
/** Its rejected counterpart — recorded, never boards (D-009). */
export const REJECTED_TYPE = 'door_keycard_entered_rejected';

export function student(
  id: string,
  verkadaUser: string,
  assignedBus: BusId = BUS_12,
): StudentAssignment {
  return {
    studentId: studentId(id),
    verkadaUserId: userId(verkadaUser),
    // Deliberately unlike any id or bus id, so "no names in alerts" assertions
    // cannot pass by accident.
    firstName: 'Quilla',
    lastName: 'Featherstonehaugh',
    grade: '5',
    assignedBusId: assignedBus,
    assignedRouteId: routeId('ROUTE-A'),
    assignedStopId: stopId('STOP-1'),
  };
}

/**
 * Roster lookup over a fixed set of students, keyed on Verkada user id (D-007).
 * Total and non-throwing.
 */
export function rosterOf(...students: StudentAssignment[]): RosterLookup {
  const byUser = new Map<string, StudentAssignment>(students.map((s) => [s.verkadaUserId, s]));
  return (user: VerkadaUserId) => byUser.get(user);
}

export interface ScanOverrides {
  readonly eventId?: string;
  readonly busId?: BusId;
  /** Defaults to `occurredAt` (delivered instantly). */
  readonly receivedAt?: string;
  /**
   * What the door reported. Present only for an In/Out Door; leave it off to
   * exercise the derived path (revised D-002).
   */
  readonly direction?: DeviceDirection;
  /** Raw `input_value`. Audit only — nothing keys off it. */
  readonly cardId?: CardId;
  readonly notificationType?: string;
  /** Defaults to true. False models a `*_rejected` notification type (D-009). */
  readonly accepted?: boolean;
}

/**
 * Build a ScanEvent for a known Verkada user. `occurredAt` is the on-bus time
 * (ordering truth); `receivedAt` defaults to it, so tests opt in to delivery
 * lag explicitly.
 */
export function scan(
  user: VerkadaUserId,
  occurredAt: string,
  overrides: ScanOverrides = {},
): ScanEvent {
  const accepted = overrides.accepted ?? true;
  return {
    eventId: overrides.eventId ?? `evt-${user}-${occurredAt}`,
    verkadaUserId: user,
    deviceId: 'acu-door-1',
    doorId: 'door-1',
    busId: overrides.busId ?? BUS_12,
    notificationType:
      overrides.notificationType ?? (accepted ? ACCEPTED_TYPE : REJECTED_TYPE),
    accepted,
    occurredAt,
    receivedAt: overrides.receivedAt ?? occurredAt,
    ...(overrides.direction !== undefined ? { deviceDirection: overrides.direction } : {}),
    ...(overrides.cardId !== undefined ? { cardId: overrides.cardId } : {}),
  };
}

/**
 * A tap that matched no Verkada access user — `verkadaUserId` is absent, which
 * is what a rejected or unenrolled credential looks like after normalization.
 */
export function unmatchedScan(occurredAt: string, overrides: ScanOverrides = {}): ScanEvent {
  const base = scan(userId('user-unmatched'), occurredAt, {
    eventId: `evt-unmatched-${occurredAt}`,
    ...overrides,
  });
  const event: ScanEvent = { ...base };
  delete event.verkadaUserId;
  return event;
}

/** ISO helper: `t('08:00:00')` -> a fixed pilot morning in UTC. */
export function t(clock: string): string {
  return `2026-09-02T${clock}.000Z`;
}
