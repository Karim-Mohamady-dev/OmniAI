import crypto from 'crypto';
import dotenv from 'dotenv';
import { isValidDatabaseUrl } from '../server/config/envValidator.ts';
import { getPostgresMigrationStatus, runPostgresMigrations } from '../server/db/migrate.ts';
import { createPostgresPool, PostgresMultiUserStore } from '../server/db/postgresStore.ts';
import { sanitizeSecretFromText } from '../server/vault/secretVault.ts';

dotenv.config();

interface StepResult {
  step: number;
  name: string;
  ok: boolean;
  detail: string;
}

async function main() {
  const testDbUrl = (process.env.TEST_DATABASE_URL || '').trim();
  const prodDbUrl = (process.env.DATABASE_URL || '').trim();

  console.log('\n=== OmniAI Studio Live PostgreSQL Release Verification (11-Step Gate) ===');

  if (testDbUrl && prodDbUrl && testDbUrl === prodDbUrl) {
    console.error('[BLOCKED] TEST_DATABASE_URL matches production DATABASE_URL. Destructive release verification refused.');
    process.exit(2);
  }

  const urlCheck = isValidDatabaseUrl(testDbUrl, 'TEST_DATABASE_URL');
  if (!urlCheck.valid) {
    console.error(
      `[BLOCKED] ${urlCheck.reason || 'TEST_DATABASE_URL is not configured.'} Export a disposable TEST_DATABASE_URL and run \`npm run test:postgres:release\`.`
    );
    process.exit(2);
  }

  const makePool = () =>
    createPostgresPool(testDbUrl, {
      max: 6,
      connectionTimeoutMillis: 10_000,
    });

  let pool = makePool();
  const prefix = `pgrel_${crypto.randomBytes(4).toString('hex')}`;
  const createdEmails: string[] = [];
  const results: StepResult[] = [];

  const record = (step: number, name: string, ok: boolean, detail: string) => {
    results.push({ step, name, ok, detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] Step ${String(step).padStart(2, '0')} | ${name.padEnd(32)} | ${detail}`);
  };

  try {
    const versionProbe = await pool.query<{ version: string }>('SELECT version() AS version');
    const serverVersion = (versionProbe.rows[0]?.version || 'unknown').split(',')[0];
    console.log(`Server       : ${serverVersion}`);

    // Verify concurrent connection pooling across multiple simultaneous checkouts
    const poolResults = await Promise.all(
      Array.from({ length: 5 }, (_v, idx) => pool.query<{ n: number }>('SELECT $1::int AS n', [idx + 1]))
    );
    const poolSum = poolResults.reduce((acc, r) => acc + Number(r.rows[0]?.n ?? 0), 0);
    if (poolSum !== 15) {
      throw new Error(`Unexpected concurrent connection pool query result sum=${poolSum}`);
    }

    // Step 1: Run migrations
    const mig1 = await runPostgresMigrations(pool);
    record(1, 'run_migrations', mig1.upToDate && mig1.applied.length >= 2, `applied=${mig1.applied.length}, poolQueries=5 OK`);

    // Step 2: Re-run migrations idempotently
    const mig2 = await runPostgresMigrations(pool);
    record(2, 'idempotent_migrations', mig2.upToDate && mig2.pending.length === 0, `pending=${mig2.pending.length}`);

    // Step 3: Migration status & DB health check
    const status = await getPostgresMigrationStatus(pool);
    const store = new PostgresMultiUserStore(pool);
    const health = await store.healthCheck();
    record(
      3,
      'db_status_and_health',
      status.upToDate && health.ok && health.productionReady && health.backend === 'postgres',
      `backend=${health.backend}, productionReady=${health.productionReady}, latency=${health.latencyMs}ms`
    );

    // Step 4: Register two distinct users
    const emailA = `${prefix}_alice@example.com`;
    const emailB = `${prefix}_bob@example.com`;
    createdEmails.push(emailA, emailB);
    const alice = await store.registerUser({ email: emailA, password: 'AlicePassword#2026', displayName: 'Alice' });
    const bob = await store.registerUser({ email: emailB, password: 'BobPassword#2026', displayName: 'Bob' });
    const authOk =
      (await store.authenticateUser(emailA, 'AlicePassword#2026'))?.id === alice.id &&
      (await store.authenticateUser(emailA, 'WrongPassword')) === null;
    record(4, 'register_two_users_and_auth', authOk && alice.id !== bob.id, `alice=${alice.id}, bob=${bob.id}`);

    // Step 5: Create & validate sessions
    const sesA = await store.createSession(alice.id);
    const validA = (await store.validateSession(sesA.sessionId, alice.id))?.id === alice.id;
    const crossInvalid = (await store.validateSession(sesA.sessionId, bob.id)) === null;
    record(5, 'create_and_validate_sessions', validA && crossInvalid, `sessionId=${sesA.sessionId.slice(0, 10)}...`);

    // Step 6: Revoke sessions and confirm rejection
    await store.revokeSession(sesA.sessionId);
    const afterRevoke = await store.validateSession(sesA.sessionId, alice.id);
    record(6, 'revoke_session_enforcement', afterRevoke === null, `validatedAfterRevoke=${String(afterRevoke)}`);

    // Step 7: Encrypted credentials & GitHub tokens isolated per user
    const credId = `${prefix}_openai_cred`;
    await store.setUserSecret(alice.id, credId, 'sk-pgrel-alice-secret-value-999', 'OpenAI');
    await store.setUserGitHubToken(alice.id, 'gho_pgrel_alice_token_xyz');
    const aliceSecret = await store.getUserSecret(alice.id, credId);
    const bobSecret = await store.getUserSecret(bob.id, credId);
    const aliceGh = await store.getUserGitHubToken(alice.id);
    const bobGh = await store.getUserGitHubToken(bob.id);
    record(
      7,
      'encrypted_credentials_isolation',
      aliceSecret === 'sk-pgrel-alice-secret-value-999' &&
        bobSecret === undefined &&
        aliceGh === 'gho_pgrel_alice_token_xyz' &&
        bobGh === null,
      'Alice decrypted cleanly; Bob received undefined/null'
    );

    // Step 8: Save & reload multi-user workspaces
    await store.saveUserWorkspace(alice.id, {
      models: [{ id: 'mdl-rel-1', displayName: 'Rel Model', providerName: 'OpenAI', modelId: 'gpt-4o', apiKey: 'sk-stripped', credentialRefId: credId, priority: 1, enabled: true }],
      folders: [{ id: 'fld-rel-1', name: 'Release', createdAt: Date.now() }],
      conversations: [{ id: 'conv-rel-1', folderId: 'fld-rel-1', title: 'Rel Chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() }],
      projects: [{ id: 'proj-rel-1', name: 'Rel App', framework: 'react-vite', files: [{ path: 'src/App.tsx', content: 'export default () => <h1>Rel</h1>;' }], createdAt: Date.now(), updatedAt: Date.now() }],
      snapshots: [{ id: 'snap-rel-1', projectId: 'proj-rel-1', label: 'v1', files: [], createdBy: 'user', createdAt: Date.now() }],
      usageRecords: [{ id: 'usg-rel-1', modelConfigId: 'mdl-rel-1', providerName: 'OpenAI', context: 'chat', totalTokens: 50, tokenSource: 'provider', costStatus: 'unavailable', timestamp: Date.now() }],
      settings: { theme: 'dark', language: 'en' },
    });
    const wsA = await store.getUserWorkspace(alice.id);
    const wsB = await store.getUserWorkspace(bob.id);
    record(
      8,
      'save_and_reload_workspaces',
      wsA.projects[0]?.id === 'proj-rel-1' && !JSON.stringify(wsA.models).includes('sk-stripped') && wsB.projects.length === 0,
      `aliceProjects=${wsA.projects.length}, bobProjects=${wsB.projects.length}`
    );

    // Step 9: Export backup and restore backup cleanly
    const bak = await store.saveUserBackup(alice.id, {
      schemaVersion: 3,
      checksum: 'fnv1a_release',
      payload: {
        schemaVersion: 3,
        models: wsA.models,
        folders: wsA.folders,
        conversations: wsA.conversations,
        projects: wsA.projects,
        snapshots: wsA.snapshots,
        usageRecords: wsA.usageRecords,
        settings: wsA.settings,
      },
    });
    const fetchedBak = await store.getUserBackupById(alice.id, bak.id);
    const bobBak = await store.getUserBackupById(bob.id, bak.id);
    await store.saveUserWorkspace(alice.id, { projects: [] });
    await store.saveUserWorkspace(alice.id, fetchedBak!.payload);
    const restoredA = await store.getUserWorkspace(alice.id);
    record(
      9,
      'backup_and_restore_cycle',
      bobBak === null && restoredA.projects[0]?.id === 'proj-rel-1',
      `backupId=${bak.id}, restoredProjects=${restoredA.projects.length}`
    );

    // Step 10: Transaction rollback verification
    let rolledBack = false;
    try {
      await store.saveUserWorkspace('usr_nonexistent_rollback', { projects: [] });
    } catch {
      rolledBack = true;
    }
    const afterFailedWrite = await store.getUserWorkspace(alice.id);
    record(
      10,
      'transaction_rollback_safety',
      rolledBack && afterFailedWrite.projects[0]?.id === 'proj-rel-1',
      'Failed write rejected cleanly without corrupting Alice data'
    );

    // Step 11: Simulate server restart (close pool cleanly, open fresh pool, verify persistent records)
    const sesRestart = await store.createSession(alice.id);
    await store.close();
    await pool.end().catch(() => {});

    pool = makePool();
    const restartedStore = new PostgresMultiUserStore(pool);
    const sesRestartValid = (await restartedStore.validateSession(sesRestart.sessionId, alice.id))?.id === alice.id;
    const secretAfterRestart = await restartedStore.getUserSecret(alice.id, credId);
    const wsAfterRestart = await restartedStore.getUserWorkspace(alice.id);
    record(
      11,
      'restart_persistence_verification',
      sesRestartValid &&
        secretAfterRestart === 'sk-pgrel-alice-secret-value-999' &&
        wsAfterRestart.projects[0]?.id === 'proj-rel-1',
      'Session, encrypted secret, and workspace survived fresh pool reconnect'
    );

    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
      console.error(`\n[FAIL] PostgreSQL 11-step release gate failed (${failures.length}/11 failed).`);
      process.exitCode = 1;
    } else {
      console.log('\n[PASS] PostgreSQL 11-step release gate PASSED (11/11).');
    }
  } catch (err) {
    console.error(
      `[BLOCKED] Live PostgreSQL release verification could not complete: ${sanitizeSecretFromText(
        err instanceof Error ? err.message : String(err),
        [testDbUrl]
      )}`
    );
    process.exitCode = 2;
  } finally {
    if (createdEmails.length > 0) {
      await pool.query('DELETE FROM users WHERE email = ANY($1::text[])', [createdEmails]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }
}

main();
