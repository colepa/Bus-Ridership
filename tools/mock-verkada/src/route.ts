/**
 * Synthetic fleet, doors and roster for a simulated route run.
 *
 * SYNTHETIC DATA ONLY (CLAUDE.md hard rule). Every id, coordinate, name, email
 * and phone number here is invented; the contact details use the reserved
 * `.invalid` domain and the 555 phone range so they cannot resolve to anyone.
 * They exist for one reason: real Verkada events carry a person's name, email
 * and phone in `user_info`, and the middleware has to drop them at the adapter
 * boundary (D-012). A generator that omitted them would leave that untested.
 *
 * If you need the ids to line up with the middleware's seeded roster, pass
 * --roster with a JSON file exported from middleware/seed rather than editing
 * this file.
 */

import { facilityCardValue } from './payload.js';
import type { Rng } from './rng.js';

/**
 * A Verkada access door on a bus.
 *
 * Real Verkada device and door ids are UUIDs; these are readable so they can be
 * pasted into the middleware's device -> bus map. The id format is opaque to
 * both sides, so nothing depends on it. The shape follows the seed's convention
 * (`BUS-101` -> `RDR-101-DOOR`) so a default run matches a default seed.
 */
export interface MockDoor {
  busId: string;
  /** `data.device_id` — the access control object that produces the event. */
  deviceId: string;
  /** `data.door_id`. Equal to deviceId in Verkada's own examples. */
  doorId: string;
  doorName: string;
  acuId: string;
  acuName: string;
}

export interface MockStop {
  stopId: string;
  /** Milliseconds into the route run at which the bus reaches this stop. */
  simOffsetMs: number;
  lat: number;
  lon: number;
}

/**
 * The PII half of `user_info`. Invented. Never logged by this tool, and the
 * middleware must discard it on arrival.
 */
export interface MockPerson {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface MockStudent {
  studentId: string;
  /** `user_info.user_id` — the identity key the roster matches on (D-007). */
  verkadaUserId: string;
  /** `input_value` for an accepted keycard: `facility|card`. Audit only. */
  inputValue: string;
  person: MockPerson;
  assignedBusId: string;
  stopIndex: number;
}

export interface RouteRun {
  routeId: string;
  orgId: string;
  siteName: string;
  siteId: string;
  /** The bus under test. */
  bus: MockDoor;
  /** A second bus, so wrong-bus boardings have somewhere to happen. */
  otherBus: MockDoor;
  stops: MockStop[];
  students: MockStudent[];
  /** Sim offset at which the bus reaches school and doors open for exits. */
  arrivalSimOffsetMs: number;
  /** Sim offset by which everything is over. Anchors the payload clock. */
  endSimOffsetMs: number;
}

export interface RosterEntry {
  /** Primary key (D-007). */
  verkadaUserId: string;
  /** Optional: what the reader reports for this credential. Audit only. */
  cardId?: string;
  studentId?: string;
  assignedBusId?: string;
}

export interface BuildRouteOptions {
  rng: Rng;
  studentCount: number;
  stopCount: number;
  busId: string;
  otherBusId: string;
  orgId: string;
  facilityCode: number;
  /** Optional real seeded roster, so user ids match the middleware database. */
  roster?: RosterEntry[];
}

const MINUTE = 60_000;

/** Synthetic base coordinates. Not a real district. */
const BASE_LAT = 37.42;
const BASE_LON = -122.09;

/**
 * Deterministic, obviously-synthetic Verkada user id for rider N.
 *
 * UUID-shaped because that is what Verkada emits, but all-zero prefixed so it
 * can never be mistaken for a real Command user. The seed can adopt the same
 * formula (rider N <-> student N) to make a default run resolve end to end.
 */
export function syntheticVerkadaUserId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function doorFor(busId: string): MockDoor {
  const number = busId.replace(/^bus[-_ ]?/i, '').toUpperCase();
  const deviceId = `RDR-${number}-DOOR`;
  return {
    busId,
    deviceId,
    doorId: deviceId,
    doorName: `${busId} front door`,
    acuId: `ACU-${number}`,
    acuName: `${busId} door controller`,
  };
}

function personFor(index: number): MockPerson {
  const padded = String(index).padStart(4, '0');
  return {
    name: `Syn Rider${padded}`,
    firstName: 'Syn',
    lastName: `Rider${padded}`,
    email: `rider${padded}@example.invalid`,
    phone: `+1555${padded.padStart(7, '0')}`,
  };
}

export function buildRoute(options: BuildRouteOptions): RouteRun {
  const { rng, studentCount, stopCount, busId, otherBusId, orgId, facilityCode, roster } = options;

  if (stopCount < 1) throw new Error('--stops must be at least 1');
  if (studentCount < 1) throw new Error('--students must be at least 1');

  const stops: MockStop[] = Array.from({ length: stopCount }, (_, i) => ({
    stopId: `stop_${String(i + 1).padStart(2, '0')}`,
    // First stop 3 minutes in, then one every 4 minutes.
    simOffsetMs: (3 + i * 4) * MINUTE,
    lat: BASE_LAT + i * 0.004 + rng.next() * 0.0005,
    lon: BASE_LON + i * 0.006 + rng.next() * 0.0005,
  }));

  const students: MockStudent[] = Array.from({ length: studentCount }, (_, i) => {
    const index = i + 1;
    const entry =
      roster === undefined || roster.length === 0 ? undefined : roster[i % roster.length];
    return {
      studentId: entry?.studentId ?? `stu_${String(index).padStart(4, '0')}`,
      verkadaUserId: entry?.verkadaUserId ?? syntheticVerkadaUserId(index),
      inputValue: entry?.cardId ?? facilityCardValue(facilityCode, 35_000 + index),
      person: personFor(index),
      assignedBusId: entry?.assignedBusId ?? busId,
      stopIndex: i % stopCount,
    };
  });

  const lastStop = stops[stops.length - 1];
  const arrivalSimOffsetMs = (lastStop?.simOffsetMs ?? 0) + 12 * MINUTE;

  return {
    routeId: 'route_pilot_am',
    orgId,
    siteName: 'Transportation',
    siteId: 'site_transportation',
    bus: doorFor(busId),
    otherBus: doorFor(otherBusId),
    stops,
    students,
    arrivalSimOffsetMs,
    // Exits finish within four minutes of arrival; one more for late scenarios.
    endSimOffsetMs: arrivalSimOffsetMs + 5 * MINUTE,
  };
}

/**
 * Load a roster JSON file:
 *   [{ "verkadaUserId": "...", "cardId": "...", "studentId": "...",
 *      "assignedBusId": "..." }, ...]
 *
 * `verkadaUserId` is required — it is the identity key the middleware matches
 * on (D-007). `cardId` is optional and only becomes `input_value`, which the
 * middleware keeps for audit and never looks up.
 */
export function parseRosterFile(text: string): RosterEntry[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('roster file must contain a JSON array of { verkadaUserId, ... } objects');
  }
  return parsed.map((row, index) => {
    if (typeof row !== 'object' || row === null) {
      throw new Error(`roster entry ${index} is not an object`);
    }
    const record = row as Record<string, unknown>;
    const verkadaUserId = record['verkadaUserId'] ?? record['verkada_user_id'];
    if (typeof verkadaUserId !== 'string' || verkadaUserId === '') {
      throw new Error(
        `roster entry ${index} has no verkadaUserId (identity keys off user_id, D-007)`,
      );
    }
    const cardId = record['cardId'] ?? record['card_id'];
    const studentId = record['studentId'] ?? record['student_id'];
    const assignedBusId = record['assignedBusId'] ?? record['assigned_bus_id'];
    return {
      verkadaUserId,
      ...(typeof cardId === 'string' ? { cardId } : {}),
      ...(typeof studentId === 'string' ? { studentId } : {}),
      ...(typeof assignedBusId === 'string' ? { assignedBusId } : {}),
    };
  });
}
