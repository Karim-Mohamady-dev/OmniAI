// @vitest-environment node
import { spawn } from 'child_process';
import cookieParser from 'cookie-parser';
import express from 'express';
import http from 'http';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const servers: http.Server[] = [];

async function startTestApp(routerMount: (app: express.Express) => void): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  routerMount(app);
  const srv = http.createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  servers.push(srv);
  const addr = srv.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void> | void
) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    vi.resetModules();
    await fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    vi.resetModules();
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve())))
  );
});

describe('Production Database & Crypto Enforcement', () => {
  it('1. Rejects missing DATABASE_URL in production and returns 503 on /api/health and /api/auth/register', async () => {
    await withEnv(
      {
        NODE_ENV: 'production',
        APP_URL: 'https://omniai.example.com',
        OMNIAI_MASTER_KEY: 'prod-enforcement-master-key-32bytes-minimum',
        DATABASE_URL: undefined,
        ALLOW_LOCAL_FILE_DB: undefined,
        OMNIAI_TEST_MEMORY_DB: undefined,
        OMNIAI_ISOLATED_TEST_HARNESS: undefined,
      },
      async () => {
        const dbMod = await import('../server/db/index.ts');
        const healthMod = await import('../server/health.ts');
        const authMod = await import('../server/routes/auth.ts');

        const initStatus = await dbMod.initializeActiveStore();
        expect(initStatus.ok).toBe(false);
        expect(initStatus.productionReady).toBe(false);
        expect(initStatus.backend).toBe('unavailable');

        const baseUrl = await startTestApp((app) => {
          app.get('/api/health', async (req, res) => {
            const snap = await healthMod.buildHealthSnapshot(req.requestId);
            res.status(snap.httpStatus).json(snap.body);
          });
          app.use('/api/auth', authMod.createAuthRouter());
        });

        const healthRes = await fetch(`${baseUrl}/api/health`);
        const healthJson = (await healthRes.json()) as {
          status: string;
          productionReady: boolean;
          database: { ok: boolean; backend: string; productionReady: boolean };
        };
        expect(healthRes.status).toBe(503);
        expect(healthJson.status).toBe('degraded');
        expect(healthJson.productionReady).toBe(false);
        expect(healthJson.database.backend).toBe('unavailable');
        expect(healthJson.database.productionReady).toBe(false);

        const regRes = await fetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: 'missingdb@example.com',
            password: 'StrongPassword#2026',
            displayName: 'User',
          }),
        });
        expect(regRes.status).toBe(503);
      }
    );
  });

  it('2. Rejects invalid or placeholder DATABASE_URL in production', async () => {
    await withEnv(
      {
        NODE_ENV: 'production',
        APP_URL: 'https://omniai.example.com',
        OMNIAI_MASTER_KEY: 'prod-enforcement-master-key-32bytes-minimum',
        DATABASE_URL: 'mysql://user:pass@localhost:3306/omniai',
        ALLOW_LOCAL_FILE_DB: undefined,
        OMNIAI_TEST_MEMORY_DB: undefined,
        OMNIAI_ISOLATED_TEST_HARNESS: undefined,
      },
      async () => {
        const { validateEnvironmentConfig } = await import('../server/config/envValidator.ts');
        const dbMod = await import('../server/db/index.ts');
        const healthMod = await import('../server/health.ts');

        const envReport = validateEnvironmentConfig();
        expect(envReport.valid).toBe(false);
        expect(envReport.errors.some((e) => e.includes('DATABASE_URL'))).toBe(true);

        const initStatus = await dbMod.initializeActiveStore();
        expect(initStatus.ok).toBe(false);
        expect(initStatus.backend).toBe('unavailable');

        const snap = await healthMod.buildHealthSnapshot();
        expect(snap.httpStatus).toBe(503);
        expect(snap.body.status).toBe('degraded');
      }
    );
  });

  it('3. Rejects unreachable PostgreSQL in production without silent memory/file fallback', async () => {
    await withEnv(
      {
        NODE_ENV: 'production',
        APP_URL: 'https://omniai.example.com',
        OMNIAI_MASTER_KEY: 'prod-enforcement-master-key-32bytes-minimum',
        DATABASE_URL: 'postgresql://app:secret@127.0.0.1:1/omniai_unreachable',
        ALLOW_LOCAL_FILE_DB: undefined,
        OMNIAI_TEST_MEMORY_DB: undefined,
        OMNIAI_ISOLATED_TEST_HARNESS: undefined,
      },
      async () => {
        const dbMod = await import('../server/db/index.ts');
        const healthMod = await import('../server/health.ts');

        const initStatus = await dbMod.initializeActiveStore();
        expect(initStatus.ok).toBe(false);
        expect(initStatus.productionReady).toBe(false);
        expect(initStatus.backend).toBe('unavailable');
        expect(initStatus.detail).toContain('Production database unavailable');

        const snap = await healthMod.buildHealthSnapshot();
        expect(snap.httpStatus).toBe(503);
        expect(snap.body.productionReady).toBe(false);
      }
    );
  });

  it('4. Reports productionReady: true on PostgresMultiUserStore only when migrations are up to date', async () => {
    const { PostgresMultiUserStore } = await import('../server/db/postgresStore.ts');
    const appliedMigrations: Array<{ version: string; name: string; checksum: string; applied_at: number }> = [];

    const poolStub = {
      async query<T = Record<string, unknown>>(text: string, params?: unknown[]) {
        const sql = text.trim();
        if (sql.startsWith('SELECT 1')) {
          return { rows: [{ ok: 1 }] as T[], rowCount: 1 };
        }
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
          return { rows: [] as T[], rowCount: 0 };
        }
        if (sql.includes('FROM schema_migrations')) {
          return { rows: appliedMigrations.map((m) => ({ ...m })) as T[], rowCount: appliedMigrations.length };
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
        return { rows: [] as T[], rowCount: 0 };
      },
      async connect() {
        return {
          query: poolStub.query,
          release() {},
        };
      },
    };

    const pgStore = new PostgresMultiUserStore(poolStub);
    const beforeMigrate = await pgStore.healthCheck();
    expect(beforeMigrate.ok).toBe(false);
    expect(beforeMigrate.productionReady).toBe(false);
    expect(beforeMigrate.migrations?.pending.length).toBeGreaterThan(0);

    await pgStore.initialize();
    const afterMigrate = await pgStore.healthCheck();
    expect(afterMigrate.ok).toBe(true);
    expect(afterMigrate.productionReady).toBe(true);
    expect(afterMigrate.backend).toBe('postgres');
    expect(afterMigrate.migrations?.pending).toEqual([]);
  });

  it('5. Rejects OMNIAI_TEST_MEMORY_DB=true in production outside an isolated test harness and fails fast on server startup', async () => {
    await withEnv(
      {
        NODE_ENV: 'production',
        APP_URL: 'https://omniai.example.com',
        OMNIAI_MASTER_KEY: 'prod-enforcement-master-key-32bytes-minimum',
        DATABASE_URL: undefined,
        OMNIAI_TEST_MEMORY_DB: 'true',
        OMNIAI_ISOLATED_TEST_HARNESS: undefined,
      },
      async () => {
        const { isIsolatedTestHarness, validateEnvironmentConfig } = await import(
          '../server/config/envValidator.ts'
        );
        const dbMod = await import('../server/db/index.ts');

        expect(isIsolatedTestHarness()).toBe(false);
        const envReport = validateEnvironmentConfig();
        expect(envReport.valid).toBe(false);
        expect(envReport.errors.some((e) => e.includes('OMNIAI_TEST_MEMORY_DB'))).toBe(true);

        const initStatus = await dbMod.initializeActiveStore();
        expect(initStatus.ok).toBe(false);
        expect(initStatus.backend).toBe('unavailable');
        expect(initStatus.productionReady).toBe(false);
      }
    );

    // Spawn the real server process with NODE_ENV=production + OMNIAI_TEST_MEMORY_DB=true -> must exit non-zero
    const exitResult = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ['server.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          OMNIAI_TEST_MEMORY_DB: 'true',
          OMNIAI_MASTER_KEY: 'prod-enforcement-master-key-32bytes-minimum',
          APP_URL: 'https://omniai.example.com',
          PORT: '0',
          DATABASE_URL: '',
          OMNIAI_ISOLATED_TEST_HARNESS: '',
          VITEST: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (d) => {
        stderr += d.toString('utf8');
      });
      child.once('exit', (code) => resolve({ code, stderr }));
    });
    expect(exitResult.code).toBe(1);
    expect(exitResult.stderr).toContain('fatal_startup_config_error');
  }, 15_000);

  it('6. Ensures HTTP query params and headers cannot enable test harness or bypass production health checks', async () => {
    await withEnv(
      {
        NODE_ENV: 'production',
        APP_URL: 'https://omniai.example.com',
        OMNIAI_MASTER_KEY: 'prod-enforcement-master-key-32bytes-minimum',
        DATABASE_URL: undefined,
        ALLOW_LOCAL_FILE_DB: 'true',
        OMNIAI_TEST_MEMORY_DB: undefined,
        OMNIAI_ISOLATED_TEST_HARNESS: undefined,
      },
      async () => {
        const dbMod = await import('../server/db/index.ts');
        const healthMod = await import('../server/health.ts');

        await dbMod.initializeActiveStore();
        const baseUrl = await startTestApp((app) => {
          app.get('/api/health', async (req, res) => {
            const snap = await healthMod.buildHealthSnapshot(req.requestId);
            res.status(snap.httpStatus).json(snap.body);
          });
        });

        const tamperedRes = await fetch(
          `${baseUrl}/api/health?testMemoryDb=true&isolatedTestHarness=true`,
          {
            headers: {
              'x-omniai-test-harness': 'true',
              'x-omniai-test-memory-db': 'true',
            },
          }
        );
        const body = (await tamperedRes.json()) as {
          status: string;
          productionReady: boolean;
          isolatedTestHarness: boolean;
          database: { backend: string; productionReady: boolean };
        };
        // Even with ALLOW_LOCAL_FILE_DB=true and forged headers/query, production /api/health never reports ok or productionReady
        expect(tamperedRes.status).toBe(503);
        expect(body.status).toBe('degraded');
        expect(body.productionReady).toBe(false);
        expect(body.isolatedTestHarness).toBe(false);
        expect(body.database.productionReady).toBe(false);
      }
    );
  });

  it('7. Allows non-production local storage in development while marking database.productionReady false', async () => {
    await withEnv(
      {
        NODE_ENV: 'development',
        DATABASE_URL: undefined,
        OMNIAI_TEST_MEMORY_DB: 'true',
        OMNIAI_ISOLATED_TEST_HARNESS: undefined,
      },
      async () => {
        const dbMod = await import('../server/db/index.ts');
        const healthMod = await import('../server/health.ts');

        const initStatus = await dbMod.initializeActiveStore();
        expect(initStatus.ok).toBe(true);
        expect(initStatus.productionReady).toBe(false);
        expect(initStatus.backend).toBe('memory');

        const snap = await healthMod.buildHealthSnapshot();
        expect(snap.httpStatus).toBe(200);
        expect(snap.body.status).toBe('ok');
        expect(snap.body.productionReady).toBe(false);
      }
    );
  });

  it('8. Supports explicit isolated localhost test harness mode without ever reporting productionReady', async () => {
    await withEnv(
      {
        NODE_ENV: 'production',
        APP_URL: 'http://127.0.0.1:3100',
        OMNIAI_MASTER_KEY: 'e2e-test-master-key-32bytes-minimum',
        OMNIAI_TEST_MEMORY_DB: 'true',
        OMNIAI_ISOLATED_TEST_HARNESS: 'true',
        VITEST: 'true',
        DATABASE_URL: undefined,
      },
      async () => {
        const dbMod = await import('../server/db/index.ts');
        const healthMod = await import('../server/health.ts');

        const initStatus = await dbMod.initializeActiveStore();
        expect(initStatus.ok).toBe(true);
        expect(initStatus.backend).toBe('memory');
        expect(initStatus.productionReady).toBe(false);

        const snap = await healthMod.buildHealthSnapshot();
        expect(snap.httpStatus).toBe(200);
        expect(snap.body.status).toBe('test-harness');
        expect(snap.body.isolatedTestHarness).toBe(true);
        expect(snap.body.productionReady).toBe(false);
      }
    );
  });

  it('9. Rejects encrypted credential storage in production when OMNIAI_MASTER_KEY is missing, weak, or reuses GEMINI_API_KEY', async () => {
    await withEnv(
      {
        NODE_ENV: 'production',
        OMNIAI_MASTER_KEY: 'AIzaSyFakeGeminiKeyValue123456',
        SESSION_SECRET: undefined,
        GEMINI_API_KEY: 'AIzaSyFakeGeminiKeyValue123456',
        OMNIAI_TEST_MEMORY_DB: 'true',
        OMNIAI_ISOLATED_TEST_HARNESS: 'true',
        VITEST: 'true',
      },
      async () => {
        const cryptoMod = await import('../server/crypto.ts');
        const vaultRouter = (await import('../server/routes/vault.ts')).default;

        expect(cryptoMod.getCryptoStatus().productionSafe).toBe(false);
        expect(() => cryptoMod.encryptString('sk-test-secret-key')).toThrow();

        const baseUrl = await startTestApp((app) => {
          app.use('/api/vault', vaultRouter);
        });

        const res = await fetch(`${baseUrl}/api/vault/keys`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: 'sk-live-secret-1234567890' }),
        });
        expect(res.status).toBe(503);
      }
    );
  });

  it('10. Resolves PostgreSQL SSL options accurately for DATABASE_SSL, PGSSLMODE, and connection URL sslmode', async () => {
    const { resolvePostgresSslOption } = await import('../server/db/postgresStore.ts');

    expect(resolvePostgresSslOption('postgresql://u:p@localhost:5432/db', {})).toBe(false);
    expect(resolvePostgresSslOption('postgresql://u:p@db.example.com:5432/db', { DATABASE_SSL: 'true' })).toEqual({
      rejectUnauthorized: false,
    });
    expect(resolvePostgresSslOption('postgresql://u:p@db.example.com:5432/db?sslmode=require', {})).toEqual({
      rejectUnauthorized: false,
    });
    expect(
      resolvePostgresSslOption('postgresql://u:p@db.example.com:5432/db?sslmode=verify-full', {})
    ).toEqual({ rejectUnauthorized: true });
    expect(
      resolvePostgresSslOption('postgresql://u:p@db.example.com:5432/db', {
        DATABASE_SSL: 'true',
        DATABASE_SSL_REJECT_UNAUTHORIZED: 'true',
      })
    ).toEqual({ rejectUnauthorized: true });
  });

  it('11. Refuses destructive test runners when TEST_DATABASE_URL or SMOKE_DATABASE_URL equals production DATABASE_URL', async () => {
    const tsxBin = path.resolve(
      process.cwd(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
    );
    const runScript = (script: string, extraEnv: Record<string, string | undefined>) =>
      new Promise<{ code: number | null; output: string }>((resolve) => {
        const child = spawn(tsxBin, [script], {
          cwd: process.cwd(),
          env: { ...process.env, ...extraEnv },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout?.on('data', (d) => (output += d.toString('utf8')));
        child.stderr?.on('data', (d) => (output += d.toString('utf8')));
        child.once('exit', (code) => resolve({ code, output }));
      });

    const sameUrl = 'postgresql://prod_user:prod_pass@db.example.com:5432/omniai_prod';
    const [relRes, smokeRes] = await Promise.all([
      runScript('scripts/testPostgresRelease.ts', {
        DATABASE_URL: sameUrl,
        TEST_DATABASE_URL: sameUrl,
      }),
      runScript('scripts/smokeTest.ts', {
        DATABASE_URL: sameUrl,
        SMOKE_DATABASE_URL: sameUrl,
        SMOKE_ALLOW_DATABASE_URL: 'true',
      }),
    ]);

    expect(relRes.code).toBe(2);
    expect(relRes.output).toContain('matches production DATABASE_URL');
    expect(smokeRes.code).toBe(2);
    expect(smokeRes.output).toContain('must be distinct from production DATABASE_URL');
  }, 15_000);
});

