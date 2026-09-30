import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ...(process.env.DATABASE_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
});

pool.on('error', (error) => {
  console.error('[aether] Unexpected PostgreSQL connection error:', error.message);
});

export async function migrate() {
  const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const migrationNames = (await readdir(migrationsDir))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();

  for (const name of migrationNames) {
    const sql = await readFile(new URL(`./migrations/${name}`, import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    await inTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(731904251)');
      const { rows } = await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (rows[0]) {
        if (rows[0].checksum !== checksum) throw new Error(`Migration ${name} changed after it was applied.`);
        return;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
    });
  }
}

export async function inTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
