/**
 * Stable identifiers for the synthetic seed world.
 *
 * SYNTHETIC DATA ONLY (docs/CLAUDE.md hard rules). Nothing in this file or in
 * seed.ts is derived from a real roster: names are drawn from fixed invented
 * word lists, every Verkada user id is a structurally obvious fake, credential
 * numbers all sit behind a reserved facility code, and every id is prefixed so
 * it cannot be mistaken for a district identifier.
 *
 * The mock event generator and tests should import these constants rather than
 * hard-coding ids, so renumbering the seed does not silently break them.
 *
 * IDENTITY MODEL (D-007): the roster is keyed on a Verkada access user id
 * (`user_info.user_id`), not on a card number. `data.input_value` is not stable
 * across event types, so it is audit data only. Everything the pipeline
 * resolves — student, assignment, manifest — hangs off `verkadaUserId`.
 */

import type { BusId, RouteId, StudentId, VerkadaUserId } from '../src/types/events.js';

/** Everything the seed writes uses these prefixes. Grep-ably fake. */
export const ID_PREFIXES = {
  student: 'STU-',
  bus: 'BUS-',
  route: 'RT-',
  stop: 'STOP-',
  device: 'ACU-SYN-',
  door: 'DOOR-SYN-',
} as const;

export const SCHOOL_YEAR = '2026-2027';

/** Fixed PRNG seed. The same seed always produces byte-identical seed data. */
export const RNG_SEED = 0x62_75_73_00; // "bus\0"

export const STUDENT_COUNT = 60;
export const STOPS_PER_ROUTE = 8;

/** Fixed, always-in-the-past instants so the seed does not drift with the clock. */
export const TERM_START = '2026-08-17T12:00:00.000Z';
/** A student loses a badge and is issued a new number — identity is unchanged. */
export const REISSUE_AT = '2026-08-24T15:30:00.000Z';
/** A retired badge number is handed to a different access user. */
export const RECYCLE_AT = '2026-08-27T15:30:00.000Z';
/** A student is re-provisioned under a brand new Verkada access user. */
export const REPROVISION_AT = '2026-08-31T15:30:00.000Z';

/**
 * Reserved facility code for every synthetic credential. Real Wiegand facility
 * codes in the district's stock are two- and three-digit values well below
 * this; 999 exists so a grep for `999|` finds every fake badge at once.
 */
export const SYNTHETIC_FACILITY_CODE = 999;

export interface SeedBus {
  busId: BusId;
  label: string;
  capacity: number;
  /** Verkada `data.device_id` — the access control object on the vehicle. */
  deviceId: string;
  /** Verkada `data.door_id` — the front door managed by that ACU. */
  doorId: string;
  routeId: RouteId;
  routeName: string;
  /** Stop id suffix letter, e.g. 'A' -> STOP-A-01. */
  stopPrefix: string;
  /** Anchor coordinate; stops fan out from here deterministically. */
  originLat: number;
  originLon: number;
}

export const BUSES: readonly SeedBus[] = [
  {
    busId: 'BUS-101' as BusId,
    label: 'Bus 101',
    capacity: 72,
    deviceId: 'ACU-SYN-101',
    doorId: 'DOOR-SYN-101-FRONT',
    routeId: 'RT-A' as RouteId,
    routeName: 'Route A — Northgate',
    stopPrefix: 'A',
    originLat: 44.9412,
    originLon: -93.2032,
  },
  {
    busId: 'BUS-102' as BusId,
    label: 'Bus 102',
    capacity: 72,
    deviceId: 'ACU-SYN-102',
    doorId: 'DOOR-SYN-102-FRONT',
    routeId: 'RT-B' as RouteId,
    routeName: 'Route B — Ridgeline',
    stopPrefix: 'B',
    originLat: 44.9765,
    originLon: -93.2611,
  },
  {
    busId: 'BUS-103' as BusId,
    label: 'Bus 103',
    capacity: 48,
    deviceId: 'ACU-SYN-103',
    doorId: 'DOOR-SYN-103-FRONT',
    routeId: 'RT-C' as RouteId,
    routeName: 'Route C — Fairhaven',
    stopPrefix: 'C',
    originLat: 44.9053,
    originLon: -93.1712,
  },
];

/** Zero-padded student id for index 1..STUDENT_COUNT. */
export function studentIdFor(index: number): StudentId {
  return `${ID_PREFIXES.student}${String(index).padStart(4, '0')}` as StudentId;
}

/**
 * Deterministic synthetic Verkada access user id.
 *
 * UUID-shaped because that is what `user_info.user_id` is, but the first group
 * is the literal `5eed` ("seed") and the variant/version nibbles are fixed, so
 * a real Verkada UUID can never collide with one of these and a human reading a
 * log can tell instantly that it is fabricated.
 *
 * `generation` distinguishes successive access users for the SAME student —
 * the re-provisioning case that makes point-in-time link resolution necessary
 * (D-003 late arrivals must resolve against the link in force at occurredAt).
 */
export function verkadaUserIdFor(studentIndex: number, generation = 1): VerkadaUserId {
  const gen = generation.toString(16).padStart(2, '0');
  const idx = studentIndex.toString(16).padStart(10, '0');
  return `5eed0000-0000-4000-8000-${gen}${idx}` as VerkadaUserId;
}

/** Synthetic badge number for a student index. Audit data only (D-007). */
export function cardNumberFor(studentIndex: number, generation = 1): string {
  return String(100_000 + generation * 10_000 + studentIndex);
}

/**
 * The `data.input_value` an accepted keycard tap carries for this badge:
 * `facility|card`, e.g. `999|110007`. Rejected and NFC events report a 40-bit
 * binary string instead and face events report a UUID — which is exactly why
 * nothing joins on this value (D-007).
 */
export function acceptedInputValueFor(studentIndex: number, generation = 1): string {
  return `${SYNTHETIC_FACILITY_CODE}|${cardNumberFor(studentIndex, generation)}`;
}

/**
 * Edge cases the boarding logic has to survive. Each one exists in the seeded
 * database; the comment says what it is there to exercise.
 */
export const EDGE_CASES = {
  /**
   * Assigned to BUS-101 / RT-A but expected to tap on BUS-102 in the mock feed.
   * Must still appear on the BUS-102 manifest, with a wrong_bus alert (D-005).
   */
  wrongBusStudent: studentIdFor(7),
  wrongBusAssignedBus: 'BUS-101' as BusId,
  wrongBusActualBus: 'BUS-102' as BusId,

  /**
   * Lost their badge on REISSUE_AT and holds a new number now. Under D-007 this
   * is a NON-event for resolution: identity is the Verkada user, which did not
   * change, so both the old and the new badge resolve to the same student. The
   * reissue is visible only in `credentials`, as provenance. Seeded precisely so
   * a regression that re-keys the roster on the card number fails loudly here.
   */
  reissuedCredentialStudent: studentIdFor(22),

  /**
   * A badge number that changed hands: deactivated for `recycledCardFrom` on
   * RECYCLE_AT and issued to `recycledCardTo` the same instant. Also a
   * non-event for resolution under D-007, and the sharpest illustration of why:
   * "latest holder of this number wins" would silently attribute the donor's
   * pre-RECYCLE_AT taps to the wrong child.
   */
  recycledCardFrom: studentIdFor(43),
  recycledCardTo: studentIdFor(44),

  /**
   * Re-provisioned as a NEW Verkada access user on REPROVISION_AT (account
   * deleted and recreated). This is the case that actually needs point-in-time
   * identity resolution: a late-arriving event (D-003) stamped before
   * REPROVISION_AT carries the generation-1 user id and must still resolve to
   * this student, while events after it carry generation 2.
   */
  reprovisionedStudent: studentIdFor(31),

  /**
   * Enrolled, has a Verkada user, but no row in student_assignments. Boards
   * fine and appears on the manifest; there is simply no assigned bus to
   * compare against, so no wrong-bus determination is possible.
   */
  unassignedStudent: studentIdFor(60),

  /**
   * Deliberately absent from `verkada_users` and `student_verkada_links`. An
   * accepted tap carrying this user id must produce the `unknown_user`
   * rejection and still return 2xx (D-004).
   */
  unknownVerkadaUserId: '5eed0000-0000-4000-8000-ffffffffffff' as VerkadaUserId,

  /**
   * Never issued to anyone. Useful as the `input_value` on a
   * `door_keycard_entered_rejected` payload: recorded, never boards (D-009).
   */
  unknownInputValue: `${SYNTHETIC_FACILITY_CODE}|000000`,
} as const;

/**
 * Which bus a student index is assigned to. `undefined` for the deliberately
 * unassigned student. Lives here rather than in seed.ts so the roster export
 * and the database seed cannot disagree about it.
 */
export function assignedBusFor(studentIndex: number): SeedBus | undefined {
  if (studentIdFor(studentIndex) === EDGE_CASES.unassignedStudent) return undefined;
  const bus = studentIndex <= 20 ? BUSES[0] : studentIndex <= 40 ? BUSES[1] : BUSES[2];
  if (bus === undefined) throw new Error('BUSES must contain at least three entries');
  return bus;
}

// ---------------------------------------------------------------------------
// Identity and credential history
// ---------------------------------------------------------------------------
//
// Built here, not in seed.ts, and derived from nothing but the constants above.
// The database seed, the roster export the mock generator consumes, and any
// test that wants to assert on a specific tap therefore all read the same
// history and cannot drift apart.

/** A row of `verkada_users`. No name/email/phone field exists, by design (D-012). */
export interface VerkadaUserFixture {
  verkadaUserId: string;
  /** Which student this access user was created for. Not a database column. */
  studentIndex: number;
  generation: number;
  provisionedAt: string;
  deprovisionedAt: string | null;
}

/** A row of `student_verkada_links` — the point-in-time identity join (D-007). */
export interface StudentLinkFixture {
  verkadaUserId: string;
  studentId: string;
  linkedAt: string;
  unlinkedAt: string | null;
  unlinkedReason: string | null;
}

/** A row of `credentials` — badge provenance, never a join key (D-007). */
export interface CredentialFixture {
  verkadaUserId: string;
  facilityCode: number;
  cardNumber: string;
  credentialType: 'keycard';
  issuedAt: string;
  deactivatedAt: string | null;
  deactivatedReason: string | null;
}

export interface IdentityFixtures {
  users: VerkadaUserFixture[];
  links: StudentLinkFixture[];
  credentials: CredentialFixture[];
}

function isEdge(studentIndex: number, edge: string): boolean {
  return (studentIdFor(studentIndex) as string) === edge;
}

/**
 * The full identity + credential history for the synthetic world.
 *
 * Read this as a timeline:
 *
 *   TERM_START      every student gets one access user and one badge.
 *   REISSUE_AT      student 22 loses their badge. NEW BADGE, SAME ACCESS USER —
 *                   under D-007 nothing about resolution changes, which is the
 *                   entire point. A regression that re-keys on the card number
 *                   starts failing this student's late-arriving events.
 *   RECYCLE_AT      student 43's badge number is retired and reissued to
 *                   student 44. Two holders, disjoint periods, one number.
 *                   Resolution is unaffected; a "latest holder wins" lookup
 *                   would misattribute every pre-RECYCLE_AT tap.
 *   REPROVISION_AT  student 31's access user is deleted and recreated. THIS is
 *                   the change that moves identity, and the only one that
 *                   requires resolving as of occurred_at rather than now.
 */
export function buildIdentityFixtures(): IdentityFixtures {
  const users: VerkadaUserFixture[] = [];
  const links: StudentLinkFixture[] = [];
  const credentials: CredentialFixture[] = [];

  for (let i = 1; i <= STUDENT_COUNT; i += 1) {
    const studentId = studentIdFor(i);
    const reprovisioned = isEdge(i, EDGE_CASES.reprovisionedStudent);
    const gen1 = verkadaUserIdFor(i, 1);

    users.push({
      verkadaUserId: gen1,
      studentIndex: i,
      generation: 1,
      provisionedAt: TERM_START,
      deprovisionedAt: reprovisioned ? REPROVISION_AT : null,
    });
    links.push({
      verkadaUserId: gen1,
      studentId,
      linkedAt: TERM_START,
      unlinkedAt: reprovisioned ? REPROVISION_AT : null,
      unlinkedReason: reprovisioned ? 'reprovisioned' : null,
    });
    credentials.push({
      verkadaUserId: gen1,
      facilityCode: SYNTHETIC_FACILITY_CODE,
      cardNumber: cardNumberFor(i, 1),
      credentialType: 'keycard',
      issuedAt: TERM_START,
      deactivatedAt: null,
      deactivatedReason: null,
    });

    if (reprovisioned) {
      const gen2 = verkadaUserIdFor(i, 2);
      users.push({
        verkadaUserId: gen2,
        studentIndex: i,
        generation: 2,
        provisionedAt: REPROVISION_AT,
        deprovisionedAt: null,
      });
      links.push({
        verkadaUserId: gen2,
        studentId,
        linkedAt: REPROVISION_AT,
        unlinkedAt: null,
        unlinkedReason: null,
      });
    }
  }

  const activeCredentialOf = (verkadaUserId: string): CredentialFixture => {
    const row = credentials.find(
      (c) => c.verkadaUserId === verkadaUserId && c.deactivatedAt === null,
    );
    if (!row) throw new Error(`no active credential for ${verkadaUserId}`);
    return row;
  };

  // --- REISSUE_AT: lost badge, new number, unchanged identity ---------------
  const reissueIndex = studentIndexOf(EDGE_CASES.reissuedCredentialStudent);
  const reissueUser = verkadaUserIdFor(reissueIndex, 1);
  const lost = activeCredentialOf(reissueUser);
  lost.deactivatedAt = REISSUE_AT;
  lost.deactivatedReason = 'lost';
  credentials.push({
    verkadaUserId: reissueUser,
    facilityCode: SYNTHETIC_FACILITY_CODE,
    cardNumber: cardNumberFor(reissueIndex, 2),
    credentialType: 'keycard',
    issuedAt: REISSUE_AT,
    deactivatedAt: null,
    deactivatedReason: null,
  });

  // --- RECYCLE_AT: one badge number, two holders, disjoint periods ----------
  const donorIndex = studentIndexOf(EDGE_CASES.recycledCardFrom);
  const recipientIndex = studentIndexOf(EDGE_CASES.recycledCardTo);
  const donorUser = verkadaUserIdFor(donorIndex, 1);
  const recipientUser = verkadaUserIdFor(recipientIndex, 1);

  const donorCard = activeCredentialOf(donorUser);
  const recycledNumber = donorCard.cardNumber;
  donorCard.deactivatedAt = RECYCLE_AT;
  donorCard.deactivatedReason = 'transferred';
  credentials.push({
    verkadaUserId: donorUser,
    facilityCode: SYNTHETIC_FACILITY_CODE,
    cardNumber: cardNumberFor(donorIndex, 2),
    credentialType: 'keycard',
    issuedAt: RECYCLE_AT,
    deactivatedAt: null,
    deactivatedReason: null,
  });

  const recipientOld = activeCredentialOf(recipientUser);
  recipientOld.deactivatedAt = RECYCLE_AT;
  recipientOld.deactivatedReason = 'damaged';
  credentials.push({
    verkadaUserId: recipientUser,
    facilityCode: SYNTHETIC_FACILITY_CODE,
    cardNumber: recycledNumber,
    credentialType: 'keycard',
    issuedAt: RECYCLE_AT,
    deactivatedAt: null,
    deactivatedReason: null,
  });

  // --- REPROVISION_AT: the badge follows the new access user ----------------
  const reprovIndex = studentIndexOf(EDGE_CASES.reprovisionedStudent);
  const oldUserCard = activeCredentialOf(verkadaUserIdFor(reprovIndex, 1));
  oldUserCard.deactivatedAt = REPROVISION_AT;
  oldUserCard.deactivatedReason = 'reprovisioned';
  credentials.push({
    verkadaUserId: verkadaUserIdFor(reprovIndex, 2),
    facilityCode: SYNTHETIC_FACILITY_CODE,
    cardNumber: cardNumberFor(reprovIndex, 2),
    credentialType: 'keycard',
    issuedAt: REPROVISION_AT,
    deactivatedAt: null,
    deactivatedReason: null,
  });

  return { users, links, credentials };
}

/** Inverse of `studentIdFor`. Throws rather than returning a wrong index. */
export function studentIndexOf(studentId: string): number {
  const raw = studentId.startsWith(ID_PREFIXES.student)
    ? studentId.slice(ID_PREFIXES.student.length)
    : '';
  const index = Number.parseInt(raw, 10);
  if (!Number.isInteger(index) || index < 1 || index > STUDENT_COUNT) {
    throw new Error(`not a seeded student id: ${studentId}`);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Roster export for the mock event generator
// ---------------------------------------------------------------------------

/**
 * One entry of the roster file the mock event generator consumes
 * (`mock-verkada --roster <path>`).
 *
 * `verkadaUserId` is the join key the middleware actually uses (D-007) and is
 * what a generated payload must put in `user_info.user_id`.
 * `acceptedInputValue` is the credential value a
 * `door_keycard_entered_accepted` payload should carry so the audit trail lines
 * up with `credentials` — it is NOT how anything resolves.
 */
export interface RosterExportEntry {
  studentId: string;
  verkadaUserId: string;
  acceptedInputValue: string;
  assignedBusId?: string;
  assignedRouteId?: string;
  /** Set on entries seeded to exercise a specific edge case. */
  note?: string;
}

/**
 * The roster as the mock generator wants it. Pure and dependency-free, so the
 * generator (or a test) can import it without a database.
 *
 * Identity and credential are the ones in force *now*, derived from
 * `buildIdentityFixtures()` rather than restated, so the export can never
 * describe a world the seed did not write.
 */
export function buildRosterExport(): RosterExportEntry[] {
  const { links, credentials } = buildIdentityFixtures();
  const entries: RosterExportEntry[] = [];

  for (let i = 1; i <= STUDENT_COUNT; i += 1) {
    const studentId = studentIdFor(i);

    const link = links.find((l) => l.studentId === studentId && l.unlinkedAt === null);
    if (link === undefined) throw new Error(`no active identity link for ${studentId}`);

    const credential = credentials.find(
      (c) => c.verkadaUserId === link.verkadaUserId && c.deactivatedAt === null,
    );
    if (credential === undefined) {
      throw new Error(`no active credential for ${studentId}`);
    }

    const entry: RosterExportEntry = {
      studentId,
      verkadaUserId: link.verkadaUserId,
      acceptedInputValue: `${credential.facilityCode}|${credential.cardNumber}`,
    };

    const bus = assignedBusFor(i);
    if (bus !== undefined) {
      entry.assignedBusId = bus.busId;
      entry.assignedRouteId = bus.routeId;
    } else {
      entry.note = 'no assignment — boards, but no wrong-bus comparison is possible';
    }
    if (studentId === EDGE_CASES.wrongBusStudent) {
      entry.note = `expected to board ${EDGE_CASES.wrongBusActualBus} (wrong bus, D-005)`;
    }
    if (studentId === EDGE_CASES.reprovisionedStudent) {
      entry.note =
        `re-provisioned at ${REPROVISION_AT}; taps before that instant carry ` +
        `${verkadaUserIdFor(i, 1)} and must still resolve to this student`;
    }
    if (studentId === EDGE_CASES.reissuedCredentialStudent) {
      entry.note = `badge reissued at ${REISSUE_AT}; same verkadaUserId throughout`;
    }
    if (studentId === EDGE_CASES.recycledCardTo) {
      entry.note = `holds a badge number previously issued to ${EDGE_CASES.recycledCardFrom}`;
    }

    entries.push(entry);
  }

  // Not a student: the unknown-user path. Present in the file so the generator
  // can emit an accepted tap that the middleware must reject with
  // `unknown_user` and still answer 2xx (D-004).
  entries.push({
    studentId: '(none)',
    verkadaUserId: EDGE_CASES.unknownVerkadaUserId,
    acceptedInputValue: EDGE_CASES.unknownInputValue,
    note: 'deliberately not enrolled — expect rejection_reason unknown_user',
  });

  return entries;
}
