/**
 * Shared Postgres connection pool.
 *
 * Everything that talks to the database imports `pool` from here — one pool per
 * process. DATABASE_URL comes from the environment; in development it is loaded
 * from `middleware/.env`, which is gitignored (see docs/CLAUDE.md hard rules:
 * never commit a database URL). `middleware/.env.example` documents the shape.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import type { PoolClient } from 'pg';

const { Pool } = pg;
export type { PoolClient, QueryResult, QueryResultRow } from 'pg';

const thisDir = dirname(fileURLToPath(import.meta.url));

// Load `middleware/.env` regardless of cwd. dotenv never overwrites variables
// already present in the environment, so real deployment env vars win.
loadEnv({ path: resolve(thisDir, '..', '.env') });

/** The connection string, or undefined if it has not been configured. */
export const databaseUrl: string | undefined = process.env.DATABASE_URL;

/**
 * Throw a useful error instead of a confusing pg connection failure. Call this
 * at the top of anything that must have a database (migrate, seed, server boot).
 */
export function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Copy middleware/.env.example to middleware/.env and fill it in.',
    );
  }
  return databaseUrl;
}

function poolSize(): number {
  const raw = process.env.PGPOOL_MAX;
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

/**
 * Managed Postgres usually requires TLS but presents a certificate the default
 * Node trust store rejects. PGSSL=require opts in without a custom CA bundle.
 */
function sslOption(): { ssl: { rejectUnauthorized: boolean } } | Record<string, never> {
  return process.env.PGSSL === 'require' ? { ssl: { rejectUnauthorized: false } } : {};
}

export const pool = new Pool({
  ...(databaseUrl === undefined ? {} : { connectionString: databaseUrl }),
  max: poolSize(),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ...sslOption(),
});

// A pool-level error (server restart, idle connection killed) is not fatal —
// pg discards the client and reconnects on the next checkout. Without a
// listener, Node treats it as an unhandled 'error' event and exits.
pool.on('error', (err: Error) => {
  console.error('[db] idle client error:', err.message);
});

/**
 * Run `fn` inside a transaction, committing on success and rolling back on
 * throw. The client is always released.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the original error is the useful one.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Close the pool. Call on graceful shutdown and at the end of scripts. */
export async function closePool(): Promise<void> {
  await pool.end();
}
