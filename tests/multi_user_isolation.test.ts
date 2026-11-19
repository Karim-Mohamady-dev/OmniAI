// @vitest-environment node
import http from 'http';
import cookieParser from 'cookie-parser';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultiUserStore } from '../server/db/multiUserStore.ts';
import { attachAuthUserMiddleware, createAuthRouter } from '../server/routes/auth.ts';
import { createWorkspaceRouter } from '../server/routes/workspace.ts';
import { computeSimpleChecksum, validateBackupPayload } from '../src/storage/backupValidator.ts';

function extractCookiePair(setCookieHeader: string | null): string {
  if (!setCookieHeader) return '';
  return setCookieHeader.split(';')[0] || '';
}

describe('Multi-User Isolation & Backup Integrity Validation', () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (srv) =>
          new Promise<void>((resolve) => {
            srv.close(() => resolve());
          })
      )
    );
    servers.length = 0;
  });

  async function startIsolatedServer() {
    const store = new MultiUserStore(null);
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(attachAuthUserMiddleware(store));
    app.use('/api/auth', createAuthRouter(store));
    app.use('/api/workspace', createWorkspaceRouter(store));

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address() as { port: number };
    return { baseUrl: `http://127.0.0.1:${address.port}`, store };
  }

  it('enforces unauthenticated 401 and prevents cross-user workspace read or overwrite (403)', async () => {
    const { baseUrl } = await startIsolatedServer();

    // Unauthenticated workspace access -> 401
    const unauthRes = await fetch(`${baseUrl}/api/workspace/state`);
    expect(unauthRes.status).toBe(401);

    // Register User A
    const regA = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@example.com',
        password: 'password1234',
        displayName: 'Alice',
      }),
    });
    expect(regA.status).toBe(201);
    const aliceJson = (await regA.json()) as { user: { id: string } };
    const aliceCookie = extractCookiePair(regA.headers.get('set-cookie'));
    expect(aliceCookie).toContain('omniai_auth_session=');

    // Save private project in User A workspace
    const putA = await fetch(`${baseUrl}/api/workspace/state`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: aliceCookie,
      },
      body: JSON.stringify({
        ownerUserId: aliceJson.user.id,
        projects: [{ id: 'proj-alice-secret', name: 'Alice Secret App', files: [] }],
      }),
    });
    expect(putA.status).toBe(200);

    // Register User B
    const regB = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'bob@example.com',
        password: 'password1234',
        displayName: 'Bob',
      }),
    });
    expect(regB.status).toBe(201);
    const bobCookie = extractCookiePair(regB.headers.get('set-cookie'));

    // User B reads own workspace -> must NOT see Alice's project
    const getB = await fetch(`${baseUrl}/api/workspace/state`, {
      headers: { Cookie: bobCookie },
    });
    expect(getB.status).toBe(200);
    const bobWs = (await getB.json()) as { projects: Array<{ id: string }> };
    expect(bobWs.projects).toHaveLength(0);

    // User B tries to overwrite User A workspace via ownerUserId spoofing -> 403
    const spoofPut = await fetch(`${baseUrl}/api/workspace/state`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: bobCookie,
      },
      body: JSON.stringify({
        ownerUserId: aliceJson.user.id,
        projects: [{ id: 'pwned', name: 'Pwned', files: [] }],
      }),
    });
    expect(spoofPut.status).toBe(403);

    // User A still has untouched workspace
    const getA = await fetch(`${baseUrl}/api/workspace/state`, {
      headers: { Cookie: aliceCookie },
    });
    const aliceWs = (await getA.json()) as { projects: Array<{ id: string }> };
    expect(aliceWs.projects.map((p) => p.id)).toEqual(['proj-alice-secret']);
  });

  it('rejects tampered backup checksums and path traversal entries on import', () => {
    const basePayload = {
      schemaVersion: 3,
      exportedAt: 1700000000000,
      models: [],
      conversations: [],
      folders: [],
      projects: [
        {
          id: 'p1',
          name: 'Safe App',
          files: [{ path: 'src/App.tsx', content: 'export default () => null;', updatedAt: 1 }],
        },
      ],
      snapshots: [],
      usageRecords: [],
      settings: null,
    };
    const checksum = computeSimpleChecksum(basePayload);
    expect(validateBackupPayload({ ...basePayload, checksum }).valid).toBe(true);

    // Tampered content fails checksum check
    const tampered = {
      ...basePayload,
      projects: [
        {
          id: 'p1',
          name: 'Tampered App',
          files: [{ path: 'src/App.tsx', content: 'tampered', updatedAt: 1 }],
        },
      ],
      checksum,
    };
    const tamperedRes = validateBackupPayload(tampered);
    expect(tamperedRes.valid).toBe(false);
    expect(tamperedRes.errors.join(' ')).toMatch(/checksum mismatch/i);

    // Path traversal fails validation
    const traversal = {
      ...basePayload,
      projects: [
        {
          id: 'p1',
          name: 'Evil',
          files: [{ path: '../../etc/passwd', content: 'bad', updatedAt: 1 }],
        },
      ],
    };
    const traversalRes = validateBackupPayload(traversal);
    expect(traversalRes.valid).toBe(false);
    expect(traversalRes.errors.join(' ')).toMatch(/unsafe file path/i);
  });

  it('revokes session token server-side on logout and rejects reused session cookie', async () => {
    const { baseUrl } = await startIsolatedServer();

    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'sessiontest@example.com',
        password: 'password1234',
        displayName: 'Session User',
      }),
    });
    expect(reg.status).toBe(201);
    const cookie = extractCookiePair(reg.headers.get('set-cookie'));

    const meBefore = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(((await meBefore.json()) as { authenticated: boolean }).authenticated).toBe(true);

    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(logoutRes.status).toBe(200);

    // Reusing the captured cookie must now be rejected
    const meAfter = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(((await meAfter.json()) as { authenticated: boolean }).authenticated).toBe(false);

    const wsAfter = await fetch(`${baseUrl}/api/workspace/state`, { headers: { Cookie: cookie } });
    expect(wsAfter.status).toBe(401);
  });

  it('isolates per-user encrypted vault credentials and workspace backups/restores', async () => {
    const { default: vaultRouter } = await import('../server/routes/vault.ts');
    const store = new MultiUserStore(null);
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(attachAuthUserMiddleware(store));
    app.use('/api/auth', createAuthRouter(store));
    app.use('/api/workspace', createWorkspaceRouter(store));
    app.use('/api/vault', vaultRouter);

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    // Register Alice & Bob
    const regA = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'va@example.com', password: 'password1234', displayName: 'VA' }),
    });
    const aliceCookie = extractCookiePair(regA.headers.get('set-cookie'));

    const regB = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'vb@example.com', password: 'password1234', displayName: 'VB' }),
    });
    const bobCookie = extractCookiePair(regB.headers.get('set-cookie'));

    // Alice stores a private API key in the backend user-scoped vault (note: using global active store? wait: vault calls resolveSecretForModel/storeSecretInVault using getActiveStore(), so let's also verify store.setUserSecret & store.getUserSecret directly)
    const aliceMe = (await (await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: aliceCookie } })).json()) as {
      user: { id: string };
    };
    const bobMe = (await (await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: bobCookie } })).json()) as {
      user: { id: string };
    };

    store.setUserSecret(aliceMe.user.id, 'cred_alice_1', 'sk-alice-top-secret-key', 'OpenAI');
    expect(store.getUserSecret(aliceMe.user.id, 'cred_alice_1')).toBe('sk-alice-top-secret-key');
    expect(store.getUserSecret(bobMe.user.id, 'cred_alice_1')).toBeUndefined();

    // Alice saves workspace, creates backup, exports checksummed backup, modifies state, restores backup
    await fetch(`${baseUrl}/api/workspace/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({
        models: [{ id: 'm1', displayName: 'Alice Model', apiKey: 'sk-should-be-stripped' }],
        projects: [{ id: 'p-orig', name: 'Original Project', files: [{ path: 'index.html', content: '<h1>V1</h1>' }] }],
      }),
    });

    const createBak = await fetch(`${baseUrl}/api/workspace/backups`, {
      method: 'POST',
      headers: { Cookie: aliceCookie },
    });
    expect(createBak.status).toBe(201);
    const bakJson = (await createBak.json()) as { backup: { id: string } };

    const listBakB = await fetch(`${baseUrl}/api/workspace/backups`, { headers: { Cookie: bobCookie } });
    expect(((await listBakB.json()) as { backups: unknown[] }).backups).toHaveLength(0);

    // Bob cannot restore Alice's backupId
    const bobRestoreAlice = await fetch(`${baseUrl}/api/workspace/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: bobCookie },
      body: JSON.stringify({ backupId: bakJson.backup.id }),
    });
    expect(bobRestoreAlice.status).toBe(404);

    // Export strips plaintext apiKey and includes valid checksum
    const exportRes = await fetch(`${baseUrl}/api/workspace/export`, { headers: { Cookie: aliceCookie } });
    const exportJson = (await exportRes.json()) as Record<string, unknown>;
    expect(String(exportJson.checksum)).toMatch(/^fnv1a_/);
    expect(JSON.stringify(exportJson)).not.toContain('sk-should-be-stripped');

    // Overwrite Alice workspace then restore from backupId
    await fetch(`${baseUrl}/api/workspace/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ projects: [] }),
    });

    const restoreRes = await fetch(`${baseUrl}/api/workspace/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
      body: JSON.stringify({ backupId: bakJson.backup.id }),
    });
    expect(restoreRes.status).toBe(200);

    const restoredWs = (await (
      await fetch(`${baseUrl}/api/workspace/state`, { headers: { Cookie: aliceCookie } })
    ).json()) as { projects: Array<{ id: string }> };
    expect(restoredWs.projects.map((p) => p.id)).toEqual(['p-orig']);
  });

  it('returns HTTP 503 cleanly when production database is unavailable and refuses silent fallback', async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origDbUrl = process.env.DATABASE_URL;
    const origAllowLocal = process.env.ALLOW_LOCAL_FILE_DB;
    const origTestMem = process.env.OMNIAI_TEST_MEMORY_DB;

    try {
      vi.resetModules();
      process.env.NODE_ENV = 'production';
      delete process.env.DATABASE_URL;
      delete process.env.ALLOW_LOCAL_FILE_DB;
      delete process.env.OMNIAI_TEST_MEMORY_DB;

      const dbMod = await import('../server/db/index.ts');
      const authMod = await import('../server/routes/auth.ts');

      const health = await dbMod.initializeActiveStore();
      expect(health.ok).toBe(false);
      expect(health.backend).toBe('unavailable');
      expect(dbMod.getDatabaseUnavailableReason()).toContain('DATABASE_URL is required in production');

      const app = express();
      app.use(express.json());
      app.use(cookieParser());
      app.use('/api/auth', authMod.createAuthRouter());
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'prod@example.com', password: 'password1234', displayName: 'Prod' }),
      });
      expect(res.status).toBe(503);
    } finally {
      if (origNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = origNodeEnv;
      if (origDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = origDbUrl;
      if (origAllowLocal === undefined) delete process.env.ALLOW_LOCAL_FILE_DB;
      else process.env.ALLOW_LOCAL_FILE_DB = origAllowLocal;
      if (origTestMem === undefined) delete process.env.OMNIAI_TEST_MEMORY_DB;
      else process.env.OMNIAI_TEST_MEMORY_DB = origTestMem;
      vi.resetModules();
    }
  });

  it('verifies PostgresMultiUserStore transactional migrations, session revocation & user isolation SQL', async () => {
    const { runPostgresMigrations } = await import('../server/db/migrate.ts');
    const { PostgresMultiUserStore } = await import('../server/db/postgresStore.ts');

    const executedQueries: Array<{ sql: string; params?: unknown[] }> = [];
    const appliedMigrations: Array<{ version: string; name: string; checksum: string; applied_at: number }> = [];
    const userRows = new Map<string, { id: string; email: string; display_name: string; password_hash: string; role: 'user' | 'admin'; created_at: number }>();
    const sessionRows = new Map<string, { id: string; user_id: string; token_hash: string; expires_at: number; revoked_at: number | null }>();
    const secretRows = new Map<string, { id: string; user_id: string; encrypted_payload: string; masked_key: string }>();

    const makeQueryable = () => ({
      async query<T = Record<string, unknown>>(text: string, params?: unknown[]) {
        executedQueries.push({ sql: text.trim(), params });
        const sql = text.trim();

        if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK') || sql.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
          return { rows: [] as T[], rowCount: 0 };
        }
        if (sql === 'SELECT 1 AS ok') {
          return { rows: [{ ok: 1 }] as T[], rowCount: 1 };
        }
        if (sql.includes('FROM schema_migrations')) {
          return { rows: [...appliedMigrations] as T[], rowCount: appliedMigrations.length };
        }
        if (sql.startsWith('INSERT INTO schema_migrations')) {
          appliedMigrations.push({
            version: String(params?.[0]),
            name: String(params?.[1]),
            checksum: String(params?.[2]),
            applied_at: Number(params?.[3]),
          });
          return { rows: [] as T[], rowCount: 1 };
        }
        if (sql.includes('CREATE TABLE IF NOT EXISTS users')) {
          return { rows: [] as T[], rowCount: 0 };
        }
        if (sql.startsWith('SELECT id FROM users WHERE email = $1')) {
          const email = String(params?.[0]);
          const match = Array.from(userRows.values()).find((u) => u.email === email);
          return { rows: (match ? [{ id: match.id }] : []) as T[], rowCount: match ? 1 : 0 };
        }
        if (sql.startsWith('INSERT INTO users')) {
          userRows.set(String(params?.[0]), {
            id: String(params?.[0]),
            email: String(params?.[1]),
            display_name: String(params?.[2]),
            password_hash: String(params?.[3]),
            role: 'user',
            created_at: Number(params?.[4]),
          });
          return { rows: [] as T[], rowCount: 1 };
        }
        if (sql.startsWith('SELECT id, email, display_name, password_hash, role, created_at FROM users WHERE email = $1')) {
          const match = Array.from(userRows.values()).find((u) => u.email === String(params?.[0]));
          return { rows: (match ? [match] : []) as T[], rowCount: match ? 1 : 0 };
        }
        if (sql.startsWith('INSERT INTO user_sessions')) {
          sessionRows.set(String(params?.[0]), {
            id: String(params?.[0]),
            user_id: String(params?.[1]),
            token_hash: String(params?.[2]),
            expires_at: Number(params?.[3]),
            revoked_at: null,
          });
          return { rows: [] as T[], rowCount: 1 };
        }
        if (sql.includes('FROM user_sessions s') && sql.includes('JOIN users u')) {
          const sid = String(params?.[0]);
          const uid = String(params?.[1]);
          const hash = String(params?.[2]);
          const now = Number(params?.[3]);
          const s = sessionRows.get(sid);
          const u = s ? userRows.get(s.user_id) : undefined;
          const valid = s && u && s.user_id === uid && s.token_hash === hash && s.revoked_at === null && s.expires_at > now;
          return { rows: (valid ? [u] : []) as T[], rowCount: valid ? 1 : 0 };
        }
        if (sql.startsWith('UPDATE user_sessions SET revoked_at')) {
          const s = sessionRows.get(String(params?.[1]));
          if (s) s.revoked_at = Number(params?.[0]);
          return { rows: [] as T[], rowCount: s ? 1 : 0 };
        }
        if (sql.startsWith('INSERT INTO encrypted_credentials')) {
          secretRows.set(String(params?.[0]), {
            id: String(params?.[0]),
            user_id: String(params?.[1]),
            encrypted_payload: String(params?.[3]),
            masked_key: String(params?.[4]),
          });
          return { rows: [] as T[], rowCount: 1 };
        }
        if (sql.startsWith('SELECT encrypted_payload FROM encrypted_credentials')) {
          const rec = secretRows.get(String(params?.[0]));
          const match = rec && rec.user_id === String(params?.[1]) ? [{ encrypted_payload: rec.encrypted_payload }] : [];
          return { rows: match as T[], rowCount: match.length };
        }
        return { rows: [] as T[], rowCount: 0 };
      },
    });

    const q = makeQueryable();
    const mockPool = {
      query: q.query,
      async connect() {
        return { query: q.query, release() {} };
      },
    };

    const pgStore = new PostgresMultiUserStore(mockPool);
    const migReport = await pgStore.initialize();
    expect(migReport.upToDate).toBe(true);
    expect(migReport.applied.length).toBeGreaterThanOrEqual(2);
    expect(executedQueries.some((e) => e.sql === 'BEGIN')).toBe(true);
    expect(executedQueries.some((e) => e.sql === 'COMMIT')).toBe(true);

    // Re-running migrations is idempotent
    const secondRun = await runPostgresMigrations(mockPool);
    expect(secondRun.pending).toEqual([]);

    // User registration, scrypt auth, session create/validate/revoke, encrypted secret scoping
    const alice = await pgStore.registerUser({ email: 'pg@example.com', password: 'strongpassword', displayName: 'PG User' });
    expect((await pgStore.authenticateUser('pg@example.com', 'strongpassword'))?.id).toBe(alice.id);
    expect(await pgStore.authenticateUser('pg@example.com', 'wrongpass')).toBeNull();

    const sess = await pgStore.createSession(alice.id);
    expect((await pgStore.validateSession(sess.sessionId, alice.id))?.id).toBe(alice.id);
    await pgStore.revokeSession(sess.sessionId);
    expect(await pgStore.validateSession(sess.sessionId, alice.id)).toBeNull();

    await pgStore.setUserSecret(alice.id, 'pg_cred_1', 'sk-pg-secret-999', 'OpenAI');
    expect(await pgStore.getUserSecret(alice.id, 'pg_cred_1')).toBe('sk-pg-secret-999');
    expect(await pgStore.getUserSecret('other-user', 'pg_cred_1')).toBeUndefined();

    const health = await pgStore.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.backend).toBe('postgres');
    expect(health.migrations?.upToDate).toBe(true);
  });
});

