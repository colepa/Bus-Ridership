/**
 * Command-line surface for the mock Verkada generator.
 */

import { parseArgs } from 'node:util';

import { ALL_SCENARIO, listScenarios } from './scenarios.js';

export const SECRET_ENV = 'VERKADA_WEBHOOK_SECRET';

/** Simulated-time compression used by --instant: a 45 minute run in ~270ms. */
export const INSTANT_COMPRESS = 10_000;

export interface CliOptions {
  scenario: string;
  seed: string;
  url: string;
  students: number;
  stops: number;
  busId: string;
  otherBusId: string;
  orgId: string;
  /** Facility code used in `input_value` (`facility|card`) on accepted reads. */
  facilityCode: number;
  rosterPath?: string;
  compress: number;
  /** In/Out Door mode: populate `data.direction` (D-002). */
  directions: boolean;
  dryRun: boolean;
  assert: boolean;
  timeoutMs: number;
  list: boolean;
  help: boolean;
}

const DEFAULTS = {
  scenario: 'happy',
  seed: 'bus-pilot',
  url: 'http://localhost:3000/webhooks/verkada',
  students: '12',
  stops: '4',
  bus: 'BUS-101',
  otherBus: 'BUS-102',
  org: 'org_demo_district',
  facilityCode: '109',
  compress: '60',
  timeout: '5000',
} as const;

export function usage(): string {
  const scenarioLines = [
    `  ${ALL_SCENARIO.padEnd(16)} every failure scenario below, in one run`,
    ...listScenarios().map((s) => `  ${s.name.padEnd(16)} ${s.description}`),
  ].join('\n');

  return `mock-verkada — fake Verkada access events for the bus ridership middleware

Usage: npm start -- [options]

Options:
  --scenario <list>   comma-separated scenarios (default: ${DEFAULTS.scenario})
  --seed <string>     PRNG seed; same seed = same run (default: ${DEFAULTS.seed})
  --url <url>         webhook endpoint (default: ${DEFAULTS.url})
  --students <n>      riders on the run (default: ${DEFAULTS.students})
  --stops <n>         stops on the route (default: ${DEFAULTS.stops})
  --bus <id>          bus under test (default: ${DEFAULTS.bus})
  --other-bus <id>    the bus a wrong-bus boarding happens on (default: ${DEFAULTS.otherBus})
  --org <id>          Verkada org id in the payload (default: ${DEFAULTS.org})
  --facility-code <n> facility code in input_value, "<facility>|<card>"
                      (default: ${DEFAULTS.facilityCode})
  --roster <path>     JSON array of { verkadaUserId, cardId?, studentId?,
                      assignedBusId? } from middleware/seed, so user ids match
                      the database (identity keys off user_id, D-007)
  --compress <n>      simulated minutes per real second (default: ${DEFAULTS.compress})
  --instant           run the whole timeline immediately (compress=${INSTANT_COMPRESS})
  --directions        In/Out Door mode: populate data.direction on every tap
                      (Inbound on board, Outbound on exit) so the reported-
                      direction path is exercised instead of derivation (D-002)
  --dry-run           build and print the timeline, send nothing
  --assert            exit non-zero if any response did not match expectations
  --timeout <ms>      per-request timeout (default: ${DEFAULTS.timeout})
  --list              list scenarios and exit
  --help              this text

Environment:
  ${SECRET_ENV}   HMAC signing secret, shared with the middleware. Required
                              unless --dry-run. Never printed.

Scenarios:
${scenarioLines}
`;
}

function toNumber(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got "${value}"`);
  return parsed;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      scenario: { type: 'string', default: DEFAULTS.scenario },
      seed: { type: 'string', default: DEFAULTS.seed },
      url: { type: 'string', default: DEFAULTS.url },
      students: { type: 'string', default: DEFAULTS.students },
      stops: { type: 'string', default: DEFAULTS.stops },
      bus: { type: 'string', default: DEFAULTS.bus },
      'other-bus': { type: 'string', default: DEFAULTS.otherBus },
      org: { type: 'string', default: DEFAULTS.org },
      'facility-code': { type: 'string', default: DEFAULTS.facilityCode },
      roster: { type: 'string' },
      compress: { type: 'string', default: DEFAULTS.compress },
      instant: { type: 'boolean', default: false },
      directions: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      assert: { type: 'boolean', default: false },
      timeout: { type: 'string', default: DEFAULTS.timeout },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  const compress = values.instant
    ? INSTANT_COMPRESS
    : toNumber('compress', values.compress ?? DEFAULTS.compress);
  if (compress <= 0) throw new Error('--compress must be greater than zero');

  const students = Math.trunc(toNumber('students', values.students ?? DEFAULTS.students));
  const stops = Math.trunc(toNumber('stops', values.stops ?? DEFAULTS.stops));

  return {
    scenario: values.scenario ?? DEFAULTS.scenario,
    seed: values.seed ?? DEFAULTS.seed,
    url: values.url ?? DEFAULTS.url,
    students,
    stops,
    busId: values.bus ?? DEFAULTS.bus,
    otherBusId: values['other-bus'] ?? DEFAULTS.otherBus,
    orgId: values.org ?? DEFAULTS.org,
    facilityCode: Math.trunc(
      toNumber('facility-code', values['facility-code'] ?? DEFAULTS.facilityCode),
    ),
    ...(values.roster === undefined ? {} : { rosterPath: values.roster }),
    compress,
    directions: values.directions ?? false,
    dryRun: values['dry-run'] ?? false,
    assert: values.assert ?? false,
    timeoutMs: Math.trunc(toNumber('timeout', values.timeout ?? DEFAULTS.timeout)),
    list: values.list ?? false,
    help: values.help ?? false,
  };
}
