/**
 * Forward-only migration runner.
 *
 * Applies every `NNN_name.sql` in `db/migrations/` that has not been applied
 * yet, in filename order, each in its own transaction. Applied versions are
 * recorded in `schema_migrations` with a checksum, so:
 *
 *   * running it twice is a no-op (idempotent)
 *   * editing an already-applied migration is an error, not a silent drift —
 *     fix forward with a new numbered file
 *
 * There is no `down`. Rollback is a new migration.
 *
 *   npm run migrate            apply pending migrations
 *   npm run migrate -- --status  show applied/pending without changing anything
 *   npm run migrate -- --dry-run list what would run
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
// `.js` extension: this package is ESM ("type": "module"), so the compiled
// output must carry a real specifier. TypeScript maps it back to pool.ts.
import { closePool, pool, requireDatabaseUrl } from './pool.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Arbitrary constant so two concurrent deploys cannot migrate at once. */
const ADVISORY_LOCK_KEY = 8_421_337;

const FILENAME_PATTERN = /^(\d{3,})_([A-Za-z0-9_.-]+)\.sql$/;

interface Migration {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

// A type alias, not an interface: pg's `query<R extends QueryResultRow>` needs
// an implicit index signature, which interfaces do not get.
type AppliedRow = {
  version: string;
  filename: string;
  checksum: string;
  applied_at: Date;
};

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function loadMigrations(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const files = entries.filter((name) => FILENAME_PATTERN.test(name)).sort();

  const migrations: Migration[] = [];
  const seen = new Map<string, string>();

  for (const filename of files) {
    const match = FILENAME_PATTERN.exec(filename);
    if (!match) continue;
    const version = match[1];
    if (version === undefined) continue;

    const duplicate = seen.get(version);
    if (duplicate !== undefined) {
      throw new Error(
        `Duplicate migration version ${version}: "${duplicate}" and "${filename}". ` +
          'Migration numbers must be unique.',
      );
    }
    seen.set(version, filename);

    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    migrations.push({ version, filename, sql, checksum: sha256(sql) });
  }

  return migrations;
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version      text        PRIMARY KEY,
      filename     text        NOT NULL,
      checksum     text        NOT NULL,
      applied_at   timestamptz NOT NULL DEFAULT now(),
      duration_ms  integer     NOT NULL DEFAULT 0
    )
  `);
}

async function readApplied(client: PoolClient): Promise<Map<string, AppliedRow>> {
  const { rows } = await client.query<AppliedRow>(
    'SELECT version, filename, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.map((row) => [row.version, row]));
}

/**
 * An already-applied migration whose file has changed means the database and
 * the repo disagree about what the schema is. Refuse rather than guess.
 */
function assertNoDrift(migrations: Migration[], applied: Map<string, AppliedRow>): void {
  const drifted: string[] = [];
  for (const migration of migrations) {
    const record = applied.get(migration.version);
    if (record && record.checksum !== migration.checksum) {
      drifted.push(`${migration.filename} (applied ${record.applied_at.toISOString()})`);
    }
  }
  if (drifted.length > 0) {
    throw new Error(
      'Applied migrations have been modified on disk:\n  ' +
        drifted.join('\n  ') +
        '\nMigrations are forward-only. Revert the edit and add a new numbered migration instead.',
    );
  }

  // A migration numbered below an already-applied one would run out of order.
  const highestApplied = [...applied.keys()].sort().at(-1);
  if (highestApplied !== undefined) {
    const outOfOrder = migrations
      .filter((m) => !applied.has(m.version) && m.version < highestApplied)
      .map((m) => m.filename);
    if (outOfOrder.length > 0) {
      throw new Error(
        `Unapplied migration(s) numbered below the latest applied version (${highestApplied}): ` +
          `${outOfOrder.join(', ')}. Renumber them above ${highestApplied}.`,
      );
    }
  }
}

async function applyMigration(client: PoolClient, migration: Migration): Promise<number> {
  const startedAt = Date.now();
  await client.query('BEGIN');
  try {
    // The whole file runs as one simple query, so `$$`-quoted function bodies
    // and multi-statement files work without any client-side SQL splitting.
    await client.query(migration.sql);
    const durationMs = Date.now() - startedAt;
    await client.query(
      `INSERT INTO schema_migrations (version, filename, checksum, duration_ms)
       VALUES ($1, $2, $3, $4)`,
      [migration.version, migration.filename, migration.checksum, durationMs],
    );
    await client.query('COMMIT');
    return durationMs;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const statusOnly = args.has('--status');
  const dryRun = args.has('--dry-run');

  requireDatabaseUrl();

  const migrations = await loadMigrations();
  if (migrations.length === 0) {
    console.log(`[migrate] no migrations found in ${MIGRATIONS_DIR}`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await ensureMigrationsTable(client);
      const applied = await readApplied(client);
      assertNoDrift(migrations, applied);

      const pending = migrations.filter((m) => !applied.has(m.version));

      if (statusOnly) {
        for (const migration of migrations) {
          const record = applied.get(migration.version);
          const state = record ? `applied ${record.applied_at.toISOString()}` : 'PENDING';
          console.log(`[migrate] ${migration.filename.padEnd(32)} ${state}`);
        }
        return;
      }

      if (pending.length === 0) {
        console.log(`[migrate] up to date (${applied.size} applied)`);
        return;
      }

      if (dryRun) {
        console.log(`[migrate] would apply ${pending.length} migration(s):`);
        for (const migration of pending) console.log(`[migrate]   ${migration.filename}`);
        return;
      }

      for (const migration of pending) {
        process.stdout.write(`[migrate] applying ${migration.filename} ... `);
        const durationMs = await applyMigration(client, migration);
        console.log(`ok (${durationMs}ms)`);
      }
      console.log(`[migrate] applied ${pending.length} migration(s)`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

main()
  .then(() => closePool())
  .catch(async (err: unknown) => {
    console.error('[migrate] failed:', err instanceof Error ? err.message : err);
    await closePool().catch(() => undefined);
    process.exitCode = 1;
  });
