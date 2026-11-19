import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface SqlQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount?: number | null;
}

export interface SqlClientLike {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlQueryResult<T>>;
  release(): void;
}

export interface SqlPoolLike {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<SqlQueryResult<T>>;
  connect(): Promise<SqlClientLike>;
}

export interface AppliedMigrationRecord {
  version: string;
  name: string;
  checksum: string;
  appliedAt: number;
}

export interface MigrationStatusReport {
  applied: AppliedMigrationRecord[];
  pending: string[];
  upToDate: boolean;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

export function loadMigrationFiles(migrationsDir: string = DEFAULT_MIGRATIONS_DIR): Array<{
  version: string;
  name: string;
  sql: string;
  checksum: string;
}> {
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.map((fileName) => {
    const fullPath = path.join(migrationsDir, fileName);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const version = fileName.split('_')[0] || fileName;
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    return {
      version,
      name: fileName,
      sql,
      checksum,
    };
  });
}

async function ensureMigrationsTable(pool: SqlPoolLike): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at BIGINT NOT NULL
    );
  `);
}

export async function runPostgresMigrations(
  pool: SqlPoolLike,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR
): Promise<MigrationStatusReport> {
  await ensureMigrationsTable(pool);
  const files = loadMigrationFiles(migrationsDir);
  const existing = await pool.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: string | number;
  }>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC');

  const appliedMap = new Map(existing.rows.map((r) => [r.version, r]));

  for (const mig of files) {
    const prior = appliedMap.get(mig.version);
    if (prior) {
      if (prior.checksum !== mig.checksum) {
        throw new Error(
          `Migration checksum mismatch for ${mig.name}: database has ${prior.checksum}, file has ${mig.checksum}.`
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(mig.sql);
      const now = Date.now();
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES ($1, $2, $3, $4)',
        [mig.version, mig.name, mig.checksum, now]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return getPostgresMigrationStatus(pool, migrationsDir);
}

export async function getPostgresMigrationStatus(
  pool: SqlPoolLike,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR
): Promise<MigrationStatusReport> {
  await ensureMigrationsTable(pool);
  const files = loadMigrationFiles(migrationsDir);
  const existing = await pool.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: string | number;
  }>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC');

  const appliedVersions = new Set(existing.rows.map((r) => r.version));
  const pending = files.filter((f) => !appliedVersions.has(f.version)).map((f) => f.name);

  return {
    applied: existing.rows.map((r) => ({
      version: r.version,
      name: r.name,
      checksum: r.checksum,
      appliedAt: Number(r.applied_at),
    })),
    pending,
    upToDate: pending.length === 0,
  };
}
