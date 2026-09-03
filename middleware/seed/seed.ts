/**
 * Synthetic roster seed.
 *
 * SYNTHETIC DATA ONLY — this is a hard rule in docs/CLAUDE.md. No real student
 * names, no real badge numbers, no real Verkada user ids, no real addresses.
 * Everything below is produced from fixed invented word lists and a seeded
 * PRNG, so:
 *
 *   * the same seed always produces byte-identical data (no run-to-run drift,
 *     which means tests can assert on specific ids)
 *   * nothing here can accidentally be a real credential or a real access user
 *
 * Identity follows D-007: students are enrolled as Verkada access users and the
 * roster resolves `user_info.user_id` -> student, point-in-time. Badge numbers
 * are written to `credentials` as provenance and are never a join key.
 *
 * The seed is destructive: it truncates the roster and operational tables and
 * rebuilds them. Run migrations first.
 *
 *   npm run migrate
 *   npm run seed
 *   SEED_SERVICE_DATE=2026-09-02 npm run seed
 *   SEED_ROSTER_OUT=./roster.json npm run seed    # roster file for mock-verkada
 */

import { writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import type { PoolClient } from 'pg';
import { closePool, requireDatabaseUrl, withTransaction } from '../db/pool.js';
import {
  BUSES,
  EDGE_CASES,
  ID_PREFIXES,
  RECYCLE_AT,
  REISSUE_AT,
  REPROVISION_AT,
  RNG_SEED,
  SCHOOL_YEAR,
  STOPS_PER_ROUTE,
  STUDENT_COUNT,
  TERM_START,
  assignedBusFor,
  buildIdentityFixtures,
  buildRosterExport,
  studentIdFor,
} from './fixtures.js';
import type { CredentialFixture, StudentLinkFixture, VerkadaUserFixture } from './fixtures.js';

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32). Small, fast, and — the point here — stable.
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick() called on an empty list');
  const value = items[Math.floor(rng() * items.length)];
  if (value === undefined) throw new Error('pick() produced no value');
  return value;
}

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`index ${index} out of range`);
  return value;
}

// ---------------------------------------------------------------------------
// Invented word lists. Not sourced from any roster, directory, or dataset.
// ---------------------------------------------------------------------------

const FIRST_NAMES = [
  'Aria', 'Bexley', 'Caspian', 'Delphine', 'Ellery', 'Fennick', 'Gwendra', 'Hollis',
  'Ilaria', 'Joric', 'Kestra', 'Linden', 'Marlowe', 'Norrin', 'Ottilie', 'Peregrin',
  'Quilla', 'Rowan', 'Solveig', 'Tamsin', 'Ursel', 'Verity', 'Wrenna', 'Xanther',
  'Yarrow', 'Zephyra', 'Alden', 'Briony', 'Corwin', 'Dagny',
] as const;

const LAST_NAMES = [
  'Ashvale', 'Brightwater', 'Coldmere', 'Dunhollow', 'Everly', 'Fallowick', 'Grimsby',
  'Harrowgate', 'Ingleford', 'Juniperry', 'Kestrelane', 'Larkmoor', 'Mossbrook',
  'Northvale', 'Oakenshaw', 'Pemberton', 'Quarrylea', 'Ravensworth', 'Stonewick',
  'Thornbury', 'Underhill', 'Vellacourt', 'Whitmarsh', 'Yarborough', 'Ziskind',
  'Applewhite', 'Barrowfield', 'Cindermere', 'Dovecote', 'Elmsworth',
] as const;

const STREET_WORDS = [
  'Aspen', 'Birch', 'Cedar', 'Dogwood', 'Elm', 'Fircone', 'Gable', 'Hawthorn',
  'Ironwood', 'Juniper', 'Kingfisher', 'Larch', 'Maple', 'Nutmeg', 'Orchard',
  'Poplar', 'Quince', 'Rosewood', 'Sycamore', 'Tamarack',
] as const;

const STREET_TYPES = ['Ave', 'St', 'Rd', 'Ln', 'Way', 'Ct'] as const;

const GRADES = ['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'] as const;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface StopRow {
  stopId: string;
  routeId: string;
  name: string;
  lat: number;
  lon: number;
  sequence: number;
  offsetMin: number;
}

interface StudentRow {
  studentId: string;
  firstName: string;
  lastName: string;
  grade: string;
}

interface AssignmentRow {
  studentId: string;
  busId: string;
  routeId: string;
  stopId: string;
}

interface RunRow {
  routeRunId: string;
  routeId: string;
  busId: string;
  serviceDate: string;
  session: 'am' | 'pm';
  startedAt: string;
}

interface SeedData {
  stops: readonly StopRow[];
  students: readonly StudentRow[];
  users: readonly VerkadaUserFixture[];
  links: readonly StudentLinkFixture[];
  credentials: readonly CredentialFixture[];
  assignments: readonly AssignmentRow[];
  runs: readonly RunRow[];
}

// ---------------------------------------------------------------------------
// Generation — pure, no I/O, fully determined by RNG_SEED and fixtures.ts
// ---------------------------------------------------------------------------

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function buildStops(rng: () => number): StopRow[] {
  const stops: StopRow[] = [];
  for (const bus of BUSES) {
    for (let i = 1; i <= STOPS_PER_ROUTE; i += 1) {
      stops.push({
        stopId: `${ID_PREFIXES.stop}${bus.stopPrefix}-${String(i).padStart(2, '0')}`,
        routeId: bus.routeId,
        name: `${pick(rng, STREET_WORDS)} ${pick(rng, STREET_TYPES)} & ${pick(rng, STREET_WORDS)} ${pick(rng, STREET_TYPES)}`,
        lat: round6(bus.originLat + i * 0.0061 + (rng() - 0.5) * 0.0008),
        lon: round6(bus.originLon + i * 0.0043 + (rng() - 0.5) * 0.0008),
        sequence: i,
        // Roughly three minutes between stops.
        offsetMin: (i - 1) * 3,
      });
    }
  }
  return stops;
}

function buildStudents(rng: () => number): StudentRow[] {
  const students: StudentRow[] = [];
  for (let i = 1; i <= STUDENT_COUNT; i += 1) {
    students.push({
      studentId: studentIdFor(i),
      firstName: pick(rng, FIRST_NAMES),
      lastName: pick(rng, LAST_NAMES),
      grade: pick(rng, GRADES),
    });
  }
  return students;
}

function buildAssignments(stops: readonly StopRow[]): AssignmentRow[] {
  const assignments: AssignmentRow[] = [];

  for (let i = 1; i <= STUDENT_COUNT; i += 1) {
    // `undefined` is the enrolled-but-unassigned edge case. Boards fine,
    // nothing to compare against.
    const bus = assignedBusFor(i);
    if (bus === undefined) continue;

    const routeStops = stops.filter((s) => s.routeId === bus.routeId);
    const stop = at(routeStops, (i - 1) % routeStops.length);

    assignments.push({
      studentId: studentIdFor(i),
      busId: bus.busId,
      routeId: bus.routeId,
      stopId: stop.stopId,
    });
  }

  return assignments;
}

function resolveServiceDate(): string {
  const raw = process.env.SEED_SERVICE_DATE;
  if (raw !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return new Date().toISOString().slice(0, 10);
}

function buildRuns(serviceDate: string): RunRow[] {
  return BUSES.map((bus) => ({
    routeRunId: `${bus.routeId}-${serviceDate}-am`,
    routeId: bus.routeId,
    busId: bus.busId,
    serviceDate,
    session: 'am' as const,
    // 07:15 US Central on the service date, expressed in UTC.
    startedAt: `${serviceDate}T12:15:00.000Z`,
  }));
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Every table the seed owns, in dependency order (children first). */
const SEEDED_TABLES = [
  'alerts',
  'boardings',
  'scan_enrichment',
  'scan_events',
  'route_runs',
  'student_assignments',
  'credentials',
  'student_verkada_links',
  'verkada_users',
  'route_stops',
  'stops',
  'routes',
  'readers',
  'students',
  'buses',
] as const;

async function assertMigrated(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ missing: string[] }>(
    `SELECT coalesce(array_agg(t.name ORDER BY t.name), ARRAY[]::text[]) AS missing
       FROM unnest($1::text[]) AS t(name)
      WHERE to_regclass('public.' || quote_ident(t.name)) IS NULL`,
    [[...SEEDED_TABLES]],
  );
  const missing = rows[0]?.missing ?? [];
  if (missing.length > 0) {
    throw new Error(
      `Missing table(s): ${missing.join(', ')}. Run "npm run migrate" before seeding.`,
    );
  }
}

async function writeSeed(client: PoolClient, data: SeedData): Promise<void> {
  await client.query(`TRUNCATE TABLE ${SEEDED_TABLES.join(', ')} RESTART IDENTITY CASCADE`);

  for (const bus of BUSES) {
    await client.query(
      'INSERT INTO buses (bus_id, label, capacity, active) VALUES ($1, $2, $3, true)',
      [bus.busId, bus.label, bus.capacity],
    );
  }

  // The reader map: (device_id, door_id) -> bus. One door-specific row per bus.
  for (const bus of BUSES) {
    await client.query(
      'INSERT INTO readers (device_id, door_id, bus_id, label, active) VALUES ($1, $2, $3, $4, true)',
      [bus.deviceId, bus.doorId, bus.busId, `${bus.label} front door`],
    );
  }

  for (const bus of BUSES) {
    await client.query(
      'INSERT INTO routes (route_id, name, bus_id, school_year, active) VALUES ($1, $2, $3, $4, true)',
      [bus.routeId, bus.routeName, bus.busId, SCHOOL_YEAR],
    );
  }

  for (const stop of data.stops) {
    await client.query('INSERT INTO stops (stop_id, name, lat, lon) VALUES ($1, $2, $3, $4)', [
      stop.stopId,
      stop.name,
      stop.lat,
      stop.lon,
    ]);
    await client.query(
      `INSERT INTO route_stops (route_id, stop_id, stop_sequence, scheduled_offset_min)
       VALUES ($1, $2, $3, $4)`,
      [stop.routeId, stop.stopId, stop.sequence, stop.offsetMin],
    );
  }

  for (const student of data.students) {
    await client.query(
      `INSERT INTO students (student_id, first_name, last_name, grade, active)
       VALUES ($1, $2, $3, $4, true)`,
      [student.studentId, student.firstName, student.lastName, student.grade],
    );
  }

  // Verkada access users. external_ref is the student id, which is a district
  // identifier — deliberately NOT a name or an email (D-012).
  for (const user of data.users) {
    await client.query(
      `INSERT INTO verkada_users
         (verkada_user_id, external_ref, active, provisioned_at, deprovisioned_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        user.verkadaUserId,
        studentIdFor(user.studentIndex),
        user.deprovisionedAt === null,
        user.provisionedAt,
        user.deprovisionedAt,
      ],
    );
  }

  // The identity join the webhook resolves against, point-in-time (D-003/D-007).
  for (const link of data.links) {
    await client.query(
      `INSERT INTO student_verkada_links
         (verkada_user_id, student_id, linked_at, unlinked_at, unlinked_reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [link.verkadaUserId, link.studentId, link.linkedAt, link.unlinkedAt, link.unlinkedReason],
    );
  }

  // Badge provenance only. Nothing joins to this table during ingest (D-007).
  for (const credential of data.credentials) {
    await client.query(
      `INSERT INTO credentials
         (verkada_user_id, facility_code, card_number, credential_type,
          issued_at, deactivated_at, deactivated_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        credential.verkadaUserId,
        credential.facilityCode,
        credential.cardNumber,
        credential.credentialType,
        credential.issuedAt,
        credential.deactivatedAt,
        credential.deactivatedReason,
      ],
    );
  }

  for (const assignment of data.assignments) {
    await client.query(
      `INSERT INTO student_assignments (student_id, bus_id, route_id, stop_id, effective_from)
       VALUES ($1, $2, $3, $4, $5)`,
      [assignment.studentId, assignment.busId, assignment.routeId, assignment.stopId, TERM_START],
    );
  }

  for (const run of data.runs) {
    await client.query(
      `INSERT INTO route_runs (route_run_id, route_id, bus_id, service_date, session, status, started_at)
       VALUES ($1, $2, $3, $4, $5, 'open', $6)`,
      [run.routeRunId, run.routeId, run.busId, run.serviceDate, run.session, run.startedAt],
    );
  }
}

/**
 * Write the roster file the mock generator consumes. Opt-in, because the seed's
 * job is the database; this is a convenience so the two stay in sync.
 */
async function maybeWriteRosterFile(): Promise<string | undefined> {
  const target = process.env.SEED_ROSTER_OUT;
  if (target === undefined || target === '') return undefined;
  const path = resolvePath(process.cwd(), target);
  await writeFile(path, `${JSON.stringify(buildRosterExport(), null, 2)}\n`, 'utf8');
  return path;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'yes') {
    throw new Error(
      'Refusing to seed with NODE_ENV=production. The seed truncates the roster. ' +
        'Set SEED_ALLOW_PRODUCTION=yes only if you are certain.',
    );
  }

  requireDatabaseUrl();

  const rng = makeRng(RNG_SEED);
  const stops = buildStops(rng);
  const students = buildStudents(rng);
  const { users, links, credentials } = buildIdentityFixtures();
  const assignments = buildAssignments(stops);
  const serviceDate = resolveServiceDate();
  const runs = buildRuns(serviceDate);

  await withTransaction(async (client) => {
    await assertMigrated(client);
    await writeSeed(client, { stops, students, users, links, credentials, assignments, runs });
  });

  const rosterPath = await maybeWriteRosterFile();

  console.log('[seed] synthetic data written');
  console.log(`[seed]   buses ${BUSES.length}  routes ${BUSES.length}  stops ${stops.length}`);
  console.log(`[seed]   students ${students.length}  verkada_users ${users.length}  links ${links.length}`);
  console.log(`[seed]   credentials ${credentials.length}  assignments ${assignments.length}`);
  console.log(`[seed]   route_runs ${runs.length} (service_date ${serviceDate}, session am, status open)`);
  console.log('[seed] identity model: verkada_user_id -> student, resolved as of occurred_at (D-007)');
  console.log('[seed] edge cases:');
  console.log(`[seed]   wrong bus       ${EDGE_CASES.wrongBusStudent} assigned ${EDGE_CASES.wrongBusAssignedBus}, expected to board ${EDGE_CASES.wrongBusActualBus}`);
  console.log(`[seed]   reissued badge  ${EDGE_CASES.reissuedCredentialStudent} (old badge deactivated ${REISSUE_AT}; identity unchanged)`);
  console.log(`[seed]   recycled badge  ${EDGE_CASES.recycledCardFrom} -> ${EDGE_CASES.recycledCardTo} at ${RECYCLE_AT} (identity unchanged)`);
  console.log(`[seed]   reprovisioned   ${EDGE_CASES.reprovisionedStudent} (new verkada user at ${REPROVISION_AT}; earlier taps must still resolve)`);
  console.log(`[seed]   no assignment   ${EDGE_CASES.unassignedStudent}`);
  console.log(`[seed]   unknown user    ${EDGE_CASES.unknownVerkadaUserId} (deliberately absent)`);
  if (rosterPath !== undefined) {
    console.log(`[seed] roster file for mock-verkada: ${rosterPath}`);
  } else {
    console.log('[seed] set SEED_ROSTER_OUT=<path> to also write the mock-verkada roster file');
  }
}

main()
  .then(() => closePool())
  .catch(async (err: unknown) => {
    console.error('[seed] failed:', err instanceof Error ? err.message : err);
    await closePool().catch(() => undefined);
    process.exitCode = 1;
  });
