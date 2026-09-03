/**
 * Middleware entrypoint — the composition root.
 *
 * This is the only file that knows about all three layers at once. Everything
 * below it stays injectable and testable: the webhook router takes an
 * `applyScan` function, the boarding logic takes a `RosterLookup`, and neither
 * imports the other.
 *
 * Run it:
 *   cp .env.example .env      # then set VERKADA_WEBHOOK_SECRET
 *   npm run dev -w @bus-ridership/middleware
 *
 * Then drive it with the mock generator:
 *   npm start -w @bus-ridership/mock-verkada -- --scenario all --assert
 */

import { readFileSync } from 'node:fs';
import express from 'express';

import { reconcileRouteRun } from './boarding/index.js';
import {
  MemoryRouteRunStore,
  rosterFromEntries,
  type RosterFileEntry,
} from './runtime/memoryStore.js';
import type { BusId } from './types/events.js';
import { createWebhookRouter } from './webhook/router.js';
import { loadSigningSecret } from './webhook/verifySignature.js';

const PORT = Number(process.env['PORT'] ?? 3000);

/**
 * device_id → bus. In production this comes from the `readers` table
 * (`resolve_bus_for_reader`); for the pilot it is config, so the service can run
 * with no database. Convention matches the seed and the mock generator.
 */
function loadDeviceMap(): Map<string, BusId> {
  const raw = process.env['DEVICE_BUS_MAP'];
  if (raw) {
    return new Map(Object.entries(JSON.parse(raw) as Record<string, string>) as [string, BusId][]);
  }
  return new Map<string, BusId>([
    ['RDR-101-DOOR', 'BUS-101' as BusId],
    ['RDR-102-DOOR', 'BUS-102' as BusId],
    ['RDR-103-DOOR', 'BUS-103' as BusId],
  ]);
}

function loadRoster(): readonly RosterFileEntry[] {
  const path = process.env['ROSTER_FILE'];
  if (!path) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as RosterFileEntry[];
}

export function createApp(): express.Express {
  const roster = loadRoster();
  const { lookup, size } = rosterFromEntries(roster);
  if (size === 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'roster is empty — every tap will return unknown_user',
        hint: 'SEED_ROSTER_OUT=./roster.json npm run seed, then ROSTER_FILE=./roster.json',
      }),
    );
  }

  const deviceMap = loadDeviceMap();
  const store = new MemoryRouteRunStore({ lookupUser: lookup });
  const app = express();

  // NOTE: no express.json() here, and there must never be one mounted ahead of
  // the webhook router — it captures raw bytes itself, and a JSON round-trip
  // before signature verification breaks the HMAC (D-011).
  app.use(
    '/webhooks',
    createWebhookRouter({
      secret: loadSigningSecret(),
      resolveBusId: (deviceId) => deviceMap.get(deviceId),
      applyScan: (scan) => store.apply(scan),
    }),
  );

  // Read-only views. The portal (issue #3) will replace these, but they make the
  // pipeline observable today.
  app.get('/api/buses/:busId/manifest', (req, res) => {
    const run = store.currentRunFor(req.params.busId as BusId);
    if (!run) {
      res.status(404).json({ error: 'no active route run for this bus' });
      return;
    }
    res.json({
      busId: run.busId,
      routeRunId: run.routeRunId,
      updatedAt: run.updatedAt,
      aboard: run.aboard,
      reconciliationStale: run.reconciliationStale,
    });
  });

  app.post('/api/route-runs/:routeRunId/reconcile', (req, res) => {
    const run = store.get(req.params.routeRunId);
    if (!run) {
      res.status(404).json({ error: 'unknown route run' });
      return;
    }
    const result = reconcileRouteRun(run);
    res.json(result);
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, buses: store.all().length }));

  return app;
}

// Only listen when run directly, so tests can import createApp() freely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  createApp().listen(PORT, () => {
    console.log(JSON.stringify({ level: 'info', message: 'middleware listening', port: PORT }));
  });
}
