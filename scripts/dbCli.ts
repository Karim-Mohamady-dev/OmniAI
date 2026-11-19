import dotenv from 'dotenv';
import { isValidDatabaseUrl } from '../server/config/envValidator.ts';
import { getPostgresMigrationStatus, runPostgresMigrations } from '../server/db/migrate.ts';
import { createPostgresPool, PostgresMultiUserStore } from '../server/db/postgresStore.ts';
import { sanitizeSecretFromText } from '../server/vault/secretVault.ts';

dotenv.config();

type Subcommand = 'init' | 'migrate' | 'status' | 'health';

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args.find((a) => !a.startsWith('--')) || 'health').toLowerCase() as Subcommand;
  const useTestDb = args.includes('--test');

  if (!['init', 'migrate', 'status', 'health'].includes(cmd)) {
    console.error('Usage: tsx scripts/dbCli.ts <init|migrate|status|health> [--test]');
    process.exit(2);
  }

  const varName = useTestDb ? 'TEST_DATABASE_URL' : process.env.DATABASE_URL?.trim() ? 'DATABASE_URL' : 'TEST_DATABASE_URL';
  const dbUrl = useTestDb
    ? (process.env.TEST_DATABASE_URL || '').trim()
    : (process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || '').trim();
  const check = isValidDatabaseUrl(dbUrl, varName);

  console.log(`\n=== OmniAI PostgreSQL CLI (${cmd}${useTestDb ? ' --test' : ''}) ===`);
  if (!check.valid) {
    console.error(`[BLOCKED] ${check.reason || `Live PostgreSQL ${varName} is not configured.`}`);
    console.error(`Set ${varName}="postgresql://<user>:<password>@<host>:5432/<db>" and retry.`);
    process.exit(2);
  }

  const pool = createPostgresPool(dbUrl, {
    max: 5,
    connectionTimeoutMillis: 10_000,
  });

  try {
    const versionRes = await pool.query<{ version: string }>('SELECT version() AS version');
    const serverVersion = versionRes.rows[0]?.version || 'unknown';

    if (cmd === 'init') {
      const status = await getPostgresMigrationStatus(pool);
      console.log(`[OK] PostgreSQL connection verified (${serverVersion.split(',')[0]}).`);
      console.log(`Target Var        : ${varName}`);
      console.log(`Applied migrations: ${status.applied.length}`);
      console.log(`Pending migrations: ${status.pending.length}`);
      if (!status.upToDate) {
        console.log(`Run \`npm run db:migrate${useTestDb ? ' -- --test' : ''}\` to apply pending SQL migrations.`);
      }
      return;
    }

    if (cmd === 'migrate') {
      const report = await runPostgresMigrations(pool);
      console.log(`[OK] Migrations applied on ${varName}. Total applied=${report.applied.length}, pending=${report.pending.length}`);
      for (const m of report.applied) {
        console.log(`  - ${m.version} | ${m.name} | sha256=${m.checksum.slice(0, 12)}...`);
      }
      return;
    }

    if (cmd === 'status') {
      const report = await getPostgresMigrationStatus(pool);
      console.log(`Target Var : ${varName}`);
      console.log(`Server     : ${serverVersion.split(',')[0]}`);
      console.log(`Up to date : ${report.upToDate}`);
      console.log(`Applied    : ${report.applied.map((m) => m.name).join(', ') || 'none'}`);
      console.log(`Pending    : ${report.pending.join(', ') || 'none'}`);
      if (!report.upToDate) process.exitCode = 1;
      return;
    }

    if (cmd === 'health') {
      const store = new PostgresMultiUserStore(pool);
      const health = await store.healthCheck();
      console.log(JSON.stringify({ targetVar: varName, serverVersion: serverVersion.split(',')[0], ...health }, null, 2));
      if (!health.ok) process.exitCode = 1;
    }
  } catch (err) {
    const safeMsg = sanitizeSecretFromText(err instanceof Error ? err.message : String(err), [dbUrl]);
    console.error(`[FAIL] PostgreSQL ${cmd} failed: ${safeMsg}`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
