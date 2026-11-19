// @vitest-environment node
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool, PostgresMultiUserStore } from '../server/db/postgresStore.ts';

const RAW_TEST_DB_URL = (process.env.TEST_DATABASE_URL || '').trim();
const PROD_DB_URL = (process.env.DATABASE_URL || '').trim();
const SAME_AS_PROD = Boolean(RAW_TEST_DB_URL && PROD_DB_URL && RAW_TEST_DB_URL === PROD_DB_URL);
const LIVE_PG_URL = SAME_AS_PROD ? '' : RAW_TEST_DB_URL;
const HAS_LIVE_POSTGRES = Boolean(
  LIVE_PG_URL && LIVE_PG_URL !== 'postgresql://user:password@localhost:5432/omniai'
);

if (SAME_AS_PROD) {
  console.error(
    '[POSTGRES LIVE VERIFICATION] REFUSED: TEST_DATABASE_URL must be distinct from production DATABASE_URL.'
  );
} else if (!HAS_LIVE_POSTGRES) {
  console.warn(
    '[POSTGRES LIVE VERIFICATION] BLOCKED — NOT VERIFIED: Set TEST_DATABASE_URL to a disposable live PostgreSQL instance (never DATABASE_URL) and run `npm run test:postgres`.'
  );
}

describe('PostgreSQL Live Database Verification Suite', () => {
  let pool: Pool | null = null;
  let store: PostgresMultiUserStore | null = null;
  const testPrefix = `pgtest_${crypto.randomBytes(4).toString('hex')}`;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    if (!HAS_LIVE_POSTGRES) return;
    pool = createPostgresPool(LIVE_PG_URL, {
      max: 5,
      connectionTimeoutMillis: 10_000,
    });
    store = new PostgresMultiUserStore(pool);
  });

  afterAll(async () => {
    if (pool && createdEmails.length > 0) {
      await pool
        .query('DELETE FROM users WHERE email = ANY($1::text[])', [createdEmails])
        .catch(() => {});
    }
    if (pool) {
      await pool.end().catch(() => {});
    }
  });

  it.skipIf(!HAS_LIVE_POSTGRES)(
    'executes migrations idempotently, persists multi-user workspaces, isolates credentials, revokes sessions, and restores backups against live PostgreSQL',
    async () => {
      expect(store).not.toBeNull();
      const pg = store!;

      // 1. Migrations & health check
      const migFirst = await pg.initialize();
      expect(migFirst.upToDate).toBe(true);
      expect(migFirst.applied.length).toBeGreaterThanOrEqual(2);

      const migSecond = await pg.initialize();
      expect(migSecond.pending).toEqual([]);

      const health = await pg.healthCheck();
      expect(health.ok).toBe(true);
      expect(health.backend).toBe('postgres');
      expect(health.migrations?.upToDate).toBe(true);

      // 2. Register two isolated users & verify password auth
      const emailA = `${testPrefix}_alice@example.com`;
      const emailB = `${testPrefix}_bob@example.com`;
      createdEmails.push(emailA, emailB);

      const alice = await pg.registerUser({
        email: emailA,
        password: 'StrongPassword#2026',
        displayName: 'Live Alice',
      });
      const bob = await pg.registerUser({
        email: emailB,
        password: 'AnotherPassword#2026',
        displayName: 'Live Bob',
      });

      expect((await pg.authenticateUser(emailA, 'StrongPassword#2026'))?.id).toBe(alice.id);
      expect(await pg.authenticateUser(emailA, 'WrongPassword!')).toBeNull();

      // 3. Session creation, validation, and revocation
      const sessionA = await pg.createSession(alice.id);
      expect((await pg.validateSession(sessionA.sessionId, alice.id))?.id).toBe(alice.id);
      expect(await pg.validateSession(sessionA.sessionId, bob.id)).toBeNull();

      await pg.revokeSession(sessionA.sessionId);
      expect(await pg.validateSession(sessionA.sessionId, alice.id)).toBeNull();

      // 4. Encrypted credential persistence & cross-user isolation
      await pg.setUserSecret(alice.id, `${testPrefix}_cred_1`, 'sk-live-pg-alice-secret-999', 'OpenAI');
      expect(await pg.getUserSecret(alice.id, `${testPrefix}_cred_1`)).toBe(
        'sk-live-pg-alice-secret-999'
      );
      expect(await pg.getUserSecret(bob.id, `${testPrefix}_cred_1`)).toBeUndefined();

      // 5. GitHub encrypted token & workspace persistence (models, folders, conversations, projects, snapshots, usage, settings)
      await pg.setUserGitHubToken(alice.id, 'gho_live_pg_token_abc');
      expect(await pg.getUserGitHubToken(alice.id)).toBe('gho_live_pg_token_abc');
      expect(await pg.getUserGitHubToken(bob.id)).toBeNull();

      await pg.saveUserWorkspace(alice.id, {
        models: [
          {
            id: 'mdl-pg-1',
            displayName: 'Live Model',
            providerName: 'OpenAI',
            modelId: 'gpt-4o-mini',
            apiKey: 'sk-should-be-stripped-before-db',
            credentialRefId: `${testPrefix}_cred_1`,
            priority: 1,
            enabled: true,
          },
        ],
        folders: [{ id: 'fld-pg-1', name: 'Production', createdAt: Date.now() }],
        conversations: [
          {
            id: 'conv-pg-1',
            folderId: 'fld-pg-1',
            title: 'PG Conversation',
            messages: [{ id: 'm1', role: 'user', content: 'Hello PG', timestamp: Date.now() }],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        projects: [
          {
            id: 'proj-pg-1',
            name: 'PG App',
            framework: 'react-vite',
            files: [{ path: 'src/App.tsx', content: 'export default () => <h1>PG</h1>;', updatedAt: Date.now() }],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        snapshots: [
          {
            id: 'snap-pg-1',
            projectId: 'proj-pg-1',
            label: 'Initial',
            files: [{ path: 'src/App.tsx', content: 'export default () => <h1>PG</h1>;' }],
            createdBy: 'user',
            createdAt: Date.now(),
          },
        ],
        usageRecords: [
          {
            id: 'usg-pg-1',
            modelConfigId: 'mdl-pg-1',
            providerName: 'OpenAI',
            context: 'chat',
            totalTokens: 42,
            tokenSource: 'provider',
            costStatus: 'unavailable',
            timestamp: Date.now(),
          },
        ],
        settings: { theme: 'dark', language: 'en' },
      });

      const wsAlice = await pg.getUserWorkspace(alice.id);
      const wsBob = await pg.getUserWorkspace(bob.id);
      expect(wsAlice.models).toHaveLength(1);
      expect(JSON.stringify(wsAlice.models)).not.toContain('sk-should-be-stripped-before-db');
      expect(wsAlice.folders[0]?.name).toBe('Production');
      expect(wsAlice.projects[0]?.id).toBe('proj-pg-1');
      expect(wsAlice.snapshots).toHaveLength(1);
      expect(wsAlice.usageRecords).toHaveLength(1);
      expect((wsAlice.settings as { theme?: string } | null)?.theme).toBe('dark');
      expect(wsBob.projects).toHaveLength(0);

      // 6. Backup & restore verification
      const bak = await pg.saveUserBackup(alice.id, {
        schemaVersion: 3,
        checksum: 'fnv1a_test',
        payload: {
          schemaVersion: 3,
          models: wsAlice.models,
          folders: wsAlice.folders,
          conversations: wsAlice.conversations,
          projects: wsAlice.projects,
          snapshots: wsAlice.snapshots,
          usageRecords: wsAlice.usageRecords,
          settings: wsAlice.settings,
        },
      });
      const fetchedBak = await pg.getUserBackupById(alice.id, bak.id);
      expect(fetchedBak).not.toBeNull();
      expect(await pg.getUserBackupById(bob.id, bak.id)).toBeNull();

      await pg.saveUserWorkspace(alice.id, { projects: [], conversations: [] });
      expect((await pg.getUserWorkspace(alice.id)).projects).toHaveLength(0);

      await pg.saveUserWorkspace(alice.id, fetchedBak!.payload);
      expect((await pg.getUserWorkspace(alice.id)).projects.map((p) => p.id)).toEqual(['proj-pg-1']);

      // 7. Transaction rollback verification (failed workspace write must not corrupt prior data)
      await expect(
        pg.saveUserWorkspace('usr_nonexistent_rollback_check', { projects: [] })
      ).rejects.toThrow();
      expect((await pg.getUserWorkspace(alice.id)).projects.map((p) => p.id)).toEqual(['proj-pg-1']);

      // 8. Simulated restart persistence: close original pool/store and open a fresh connection pool
      await pg.close();
      const restartPool = createPostgresPool(LIVE_PG_URL, {
        max: 3,
        connectionTimeoutMillis: 10_000,
      });
      pool = restartPool;
      const restartedPg = new PostgresMultiUserStore(restartPool);

      const activeSession = await restartedPg.createSession(alice.id);
      expect((await restartedPg.validateSession(activeSession.sessionId, alice.id))?.id).toBe(alice.id);
      expect(await restartedPg.getUserSecret(alice.id, `${testPrefix}_cred_1`)).toBe(
        'sk-live-pg-alice-secret-999'
      );
      expect((await restartedPg.getUserWorkspace(alice.id)).projects.map((p) => p.id)).toEqual(['proj-pg-1']);
    }
  );
});
