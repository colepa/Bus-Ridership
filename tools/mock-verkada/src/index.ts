/**
 * Entry point: build a route run, apply the requested scenarios, deliver it.
 *
 * Logging rule (CLAUDE.md): opaque ids and outcomes only. No credentials, no
 * student records, never the signing secret. The generated payloads contain
 * synthetic `user_info` PII (see route.ts) so the middleware's D-012 redaction
 * is exercised end to end — none of it is ever printed here.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { SECRET_ENV, parseCliArgs, usage, type CliOptions } from './cli.js';
import { createRng } from './rng.js';
import { buildRoute, parseRosterFile, type RosterEntry, type RouteRun } from './route.js';
import { ALL_SCENARIO, listScenarios, resolveScenarios, type ScenarioContext } from './scenarios.js';
import { buildDeliveries, buildTaps, type Delivery } from './simulate.js';
import { runDeliveries, type DeliveryResult } from './transport.js';

async function loadRoster(path: string | undefined): Promise<RosterEntry[] | undefined> {
  if (path === undefined) return undefined;
  return parseRosterFile(await readFile(path, 'utf8'));
}

function readSecret(options: CliOptions): string {
  const secret = process.env[SECRET_ENV];
  if (secret !== undefined && secret.trim() !== '') return secret;
  if (options.dryRun) return 'dry-run-placeholder-never-sent';
  throw new Error(
    `${SECRET_ENV} is not set. Export the same secret the middleware uses ` +
      '(from its gitignored .env), or pass --dry-run to build the timeline without sending.',
  );
}

export interface PlannedRun {
  route: RouteRun;
  deliveries: Delivery[];
}

/** Build the full delivery timeline for a set of scenarios. */
export async function planRun(options: CliOptions, startRealMs: number): Promise<PlannedRun> {
  const scenarios = resolveScenarios(options.scenario);
  const rng = createRng(`${options.seed}:${options.scenario}`);
  const roster = await loadRoster(options.rosterPath);

  const route = buildRoute({
    rng,
    studentCount: options.students,
    stopCount: options.stops,
    busId: options.busId,
    otherBusId: options.otherBusId,
    orgId: options.orgId,
    facilityCode: options.facilityCode,
    ...(roster === undefined ? {} : { roster }),
  });

  const ctx: ScenarioContext = {
    route,
    rng,
    startRealMs,
    // Anchor the route clock so the run *ends* about now: every `data.created`
    // is then a plausible, in-the-past tap time, while deliveries are still
    // paced by --compress. See the three-clock note in simulate.ts.
    simEpochBaseMs: startRealMs - route.endSimOffsetMs,
    compress: options.compress,
    directions: options.directions,
    runTag: `${options.seed}_${options.scenario.replace(/[^a-z0-9]+/gi, '')}`,
  };

  let taps = buildTaps(route, rng);
  for (const scenario of scenarios) {
    if (scenario.mutateTaps) taps = scenario.mutateTaps(taps, ctx);
  }
  taps = [...taps].sort((a, b) => a.simOffsetMs - b.simOffsetMs);

  let deliveries = buildDeliveries(taps, ctx);
  for (const scenario of scenarios) {
    if (scenario.mutateDeliveries) deliveries = scenario.mutateDeliveries(deliveries, ctx);
  }

  return { route, deliveries };
}

function formatResult(result: DeliveryResult, dryRun: boolean): string {
  const at = `${(result.delivery.deliverAtOffsetMs / 1000).toFixed(1)}s`;
  const status = dryRun ? 'plan' : String(result.status);
  const mark = dryRun ? ' ' : result.matchedExpectation ? '+' : '!';
  const reason = result.reason === undefined ? '' : ` (${result.reason})`;
  return `${mark} ${at.padStart(8)}  ${status.padEnd(5)} ${result.observed.padEnd(14)} ${result.delivery.label}${reason}`;
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('\n' + usage());
    return 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  if (options.list) {
    console.log(`${ALL_SCENARIO}\n  every failure scenario below, in one run\n`);
    for (const scenario of listScenarios()) {
      console.log(`${scenario.name}\n  ${scenario.description}\n`);
    }
    return 0;
  }

  let secret: string;
  let planned: PlannedRun;
  const startRealMs = Date.now();

  try {
    secret = readSecret(options);
    planned = await planRun(options, startRealMs);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const { route, deliveries } = planned;

  console.log(
    [
      `scenario   ${options.scenario}`,
      `seed       ${options.seed}`,
      `route      ${options.students} students · ${options.stops} stops · bus ${options.busId}`,
      // Device ids are configuration, not secrets: print them so they can be
      // pasted straight into the middleware's device -> bus map.
      `doors      ${route.bus.deviceId} -> ${route.bus.busId}` +
        ` · ${route.otherBus.deviceId} -> ${route.otherBus.busId}`,
      `direction  ${options.directions ? 'reported by the door (In/Out Door mode)' : 'null — middleware must derive it (D-002)'}`,
      `timeline   ${deliveries.length} deliveries · compress ${options.compress}x` +
        ` · ~${(Math.max(...deliveries.map((d) => d.deliverAtOffsetMs)) / 1000).toFixed(1)}s wall clock`,
      `target     ${options.dryRun ? '(dry run, nothing sent)' : options.url}`,
      '',
    ].join('\n'),
  );

  const results = await runDeliveries(deliveries, {
    url: options.url,
    secret,
    dryRun: options.dryRun,
    timeoutMs: options.timeoutMs,
    startRealMs,
    onResult: (result) => {
      console.log(formatResult(result, options.dryRun));
    },
  });

  if (options.dryRun) {
    console.log(`\nplanned ${results.length} deliveries; nothing was sent.`);
    return 0;
  }

  const mismatches = results.filter((r) => !r.matchedExpectation);
  const applied = results.filter((r) => r.observed === 'applied').length;
  const notApplied = results.filter((r) => r.observed === 'not_applied').length;
  const rejected = results.filter((r) => r.observed === 'client_error').length;

  console.log(
    `\napplied ${applied} · accepted-not-applied ${notApplied} · rejected 4xx ${rejected} · unexpected ${mismatches.length}`,
  );

  if (mismatches.length > 0) {
    console.log('\nunexpected outcomes:');
    for (const mismatch of mismatches) {
      console.log(
        `  ${mismatch.delivery.label}: expected ${mismatch.delivery.expected}, got ${mismatch.observed}` +
          (mismatch.reason === undefined ? '' : ` (${mismatch.reason})`),
      );
    }
  }

  return options.assert && mismatches.length > 0 ? 1 : 0;
}

const entryPath = process.argv[1];
const invokedDirectly = entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
