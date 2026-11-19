import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { isValidDatabaseUrl } from '../server/config/envValidator.ts';
import { createPostgresPool } from '../server/db/postgresStore.ts';
import { buildProjectZipArchive } from '../src/project-engine/zipExporter.ts';
import type { Project } from '../src/types/index.ts';

interface SmokeCheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
  });
}

function extractCookies(res: Response): string {
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie') as string]
        : [];
  return setCookies
    .map((c) => c.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

async function waitForServerReady(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // retry until timeout
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Production server did not become ready at ${baseUrl}/api/health within ${timeoutMs}ms.`);
}

async function main() {
  const distIndex = path.resolve(process.cwd(), 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    console.error('[FAIL] dist/index.html is missing. Run `npm run build` before `npm run test:smoke`.');
    process.exit(1);
  }

  const smokeDbVar = process.env.SMOKE_DATABASE_URL?.trim() ? 'SMOKE_DATABASE_URL' : 'TEST_DATABASE_URL';
  const smokeDbUrl = (process.env.SMOKE_DATABASE_URL || process.env.TEST_DATABASE_URL || '').trim();
  const prodDbUrl = (process.env.DATABASE_URL || '').trim();

  console.log('\n=== OmniAI Studio Production Release Smoke Test ===');

  if (smokeDbUrl && prodDbUrl && smokeDbUrl === prodDbUrl) {
    console.error(
      `[BLOCKED] ${smokeDbVar} must be distinct from production DATABASE_URL.`
    );
    process.exit(2);
  }

  const smokeUrlCheck = isValidDatabaseUrl(smokeDbUrl, smokeDbVar);
  if (!smokeUrlCheck.valid) {
    console.error(
      `[BLOCKED] ${smokeUrlCheck.reason || 'Production smoke test requires a real PostgreSQL test database (set SMOKE_DATABASE_URL or TEST_DATABASE_URL).'} In-memory fallback is disabled for release smoke verification.`
    );
    process.exit(2);
  }

  let smokeEmailCreated: string | null = null;

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const smokeMasterKey = `smoke_master_${crypto.randomBytes(16).toString('hex')}`;

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    APP_URL: baseUrl,
    DATABASE_URL: smokeDbUrl,
    OMNIAI_MASTER_KEY: smokeMasterKey,
    SESSION_SECRET: smokeMasterKey,
    OMNIAI_TEST_MEMORY_DB: undefined,
    OMNIAI_ISOLATED_TEST_HARNESS: undefined,
    ALLOW_LOCAL_FILE_DB: undefined,
  };

  console.log(`Target Build : dist/index.html (production SPA + Node server)`);
  console.log(`Server URL   : ${baseUrl}`);
  console.log(`DB Mode      : Real PostgreSQL test database`);

  const serverLogs: string[] = [];
  const child = spawn(process.execPath, ['server.ts'], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => serverLogs.push(d.toString('utf8')));
  child.stderr?.on('data', (d) => serverLogs.push(d.toString('utf8')));

  const results: SmokeCheckResult[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name.padEnd(28)} | ${detail}`);
  };

  try {
    await waitForServerReady(baseUrl);
    record('production_startup', true, 'Production server booted cleanly from dist/ against PostgreSQL');

    // 1. Health & Database Health
    const healthRes = await fetch(`${baseUrl}/api/health`);
    const healthJson = (await healthRes.json()) as {
      status?: string;
      mode?: string;
      productionReady?: boolean;
      database?: {
        ok?: boolean;
        productionReady?: boolean;
        backend?: string;
        migrations?: { upToDate?: boolean };
      };
      crypto?: { productionSafe?: boolean; source?: string };
      config?: { valid?: boolean };
    };
    record(
      'health_endpoint',
      healthRes.status === 200 && healthJson.status === 'ok' && healthJson.mode === 'production',
      `status=${healthJson.status}, mode=${healthJson.mode}`
    );
    record(
      'database_health',
      Boolean(
        healthJson.database?.ok &&
          healthJson.database?.backend === 'postgres' &&
          healthJson.database?.productionReady &&
          healthJson.database?.migrations?.upToDate &&
          healthJson.productionReady
      ),
      `backend=${healthJson.database?.backend}, productionReady=${healthJson.database?.productionReady}, migrationsUpToDate=${healthJson.database?.migrations?.upToDate}`
    );
    record(
      'crypto_and_config',
      Boolean(healthJson.crypto?.productionSafe && healthJson.config?.valid),
      `cryptoSource=${healthJson.crypto?.source}, configValid=${healthJson.config?.valid}`
    );

    // 2. Production built HTML serving
    const rootRes = await fetch(`${baseUrl}/`);
    const rootHtml = await rootRes.text();
    record(
      'spa_dist_serving',
      rootRes.status === 200 && rootHtml.includes('<div id="root">'),
      `HTTP ${rootRes.status}, bytes=${rootHtml.length}`
    );

    // 3. Protected workspace rejects anonymous requests
    const unauthWsRes = await fetch(`${baseUrl}/api/workspace/state`);
    record(
      'protected_workspace_authz',
      unauthWsRes.status === 401,
      `Unauthenticated GET /api/workspace/state -> HTTP ${unauthWsRes.status}`
    );

    // 4. Authentication lifecycle + Workspace persistence + Logout revocation
    const email = `smoke_${crypto.randomBytes(4).toString('hex')}@example.com`;
    smokeEmailCreated = email;
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password: 'SmokeTestPassword#2026',
        displayName: 'Smoke User',
      }),
    });
    const cookieHeader = extractCookies(regRes);
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookieHeader },
    });
    const meJson = (await meRes.json()) as { authenticated?: boolean; user?: { email?: string } };

    const saveWsRes = await fetch(`${baseUrl}/api/workspace/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({
        projects: [
          {
            id: 'smoke-proj-1',
            name: 'Smoke Project',
            framework: 'react-vite',
            files: [{ path: 'src/App.tsx', content: 'export default () => <div>Smoke</div>;', updatedAt: Date.now() }],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      }),
    });
    const loadWsRes = await fetch(`${baseUrl}/api/workspace/state`, {
      headers: { Cookie: cookieHeader },
    });
    const loadWsJson = (await loadWsRes.json()) as { projects?: Array<{ id: string }> };

    await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookieHeader },
    });
    const afterLogoutRes = await fetch(`${baseUrl}/api/workspace/state`, {
      headers: { Cookie: cookieHeader },
    });

    record(
      'auth_and_workspace_cycle',
      regRes.status === 201 &&
        Boolean(meJson.authenticated) &&
        saveWsRes.ok &&
        loadWsJson.projects?.[0]?.id === 'smoke-proj-1' &&
        afterLogoutRes.status === 401,
      `register=${regRes.status}, wsLoaded=${loadWsJson.projects?.length ?? 0}, postLogout=${afterLogoutRes.status}`
    );

    // 5. Model capabilities endpoint
    const capsRes = await fetch(`${baseUrl}/api/ai/capabilities`);
    const capsJson = (await capsRes.json()) as { supportedProtocols?: string[]; routingModes?: string[] };
    record(
      'ai_capabilities_endpoint',
      capsRes.status === 200 && Array.isArray(capsJson.supportedProtocols) && capsJson.supportedProtocols.length >= 4,
      `protocols=${(capsJson.supportedProtocols || []).join(',')}`
    );

    // 6. Diagnostics endpoint & secret sanitization check
    const secretSentinel = 'sk-smoke-sentinel-secret-987654321';
    const diagRes = await fetch(`${baseUrl}/api/diagnostics/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        models: [
          {
            id: 'smoke-mdl',
            displayName: 'Smoke Model',
            providerName: 'OpenAI',
            protocol: 'openai-compatible',
            modelId: 'gpt-4o-mini',
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: secretSentinel,
            priority: 1,
            enabled: true,
          },
        ],
        tests: ['text'],
      }),
    });
    const diagRaw = await diagRes.text();
    const diagJson = JSON.parse(diagRaw) as { results?: Array<{ status: string; detail: string }> };
    const noSecretLeak = !diagRaw.includes(secretSentinel) && !diagRaw.includes(smokeMasterKey);
    record(
      'diagnostics_and_redaction',
      diagRes.status === 200 && Array.isArray(diagJson.results) && noSecretLeak,
      `HTTP ${diagRes.status}, status=${diagJson.results?.[0]?.status}, secretRedacted=${noSecretLeak}`
    );

    // 7. Preview bundling (esbuild + Tailwind v4)
    const previewRes = await fetch(`${baseUrl}/api/preview/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        framework: 'react-vite',
        files: [
          { path: 'index.html', content: '<!doctype html><html><body><div id="root"></div></body></html>' },
          {
            path: 'src/App.tsx',
            content: 'export default function App() { return <main className="p-4">Smoke Preview Ready</main>; }',
          },
        ],
      }),
    });
    const previewJson = (await previewRes.json()) as { ok?: boolean; html?: string; buildTimeMs?: number };
    record(
      'preview_bundling',
      previewRes.status === 200 && Boolean(previewJson.ok) && Boolean(previewJson.html?.includes('Smoke Preview Ready')),
      `ok=${previewJson.ok}, htmlBytes=${previewJson.html?.length ?? 0}, buildTimeMs=${previewJson.buildTimeMs}`
    );

    // 8. ZIP export integrity check (must exclude .env while packaging project files)
    const sampleProject: Project = {
      id: 'smoke-zip',
      name: 'Smoke Export App',
      description: 'Smoke test project',
      framework: 'react-vite',
      files: [
        { path: 'package.json', content: '{"name":"smoke-app"}', updatedAt: Date.now() },
        { path: 'src/App.tsx', content: 'export default () => <h1>ZIP OK</h1>;', updatedAt: Date.now() },
        { path: '.env', content: 'SECRET_SHOULD_NOT_EXPORT=123', updatedAt: Date.now() },
      ],
      activities: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const zipResult = await buildProjectZipArchive(sampleProject);
    const zipBytes = zipResult.blob.size;
    record(
      'zip_export',
      zipBytes > 250 && zipResult.excludedCount === 1,
      `filename=${zipResult.filename}, size=${zipBytes} bytes, excludedEnv=${zipResult.excludedCount}`
    );

    // 9. Graceful SIGTERM shutdown
    const exitCode = await new Promise<number | null>((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 5000);
      child.once('exit', (code) => {
        clearTimeout(killTimer);
        resolve(code);
      });
      child.kill('SIGTERM');
    });
    record('graceful_shutdown', exitCode === 0, `SIGTERM exitCode=${exitCode}`);

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.error(`\nSmoke test FAILED (${failed.length}/${results.length} failed).`);
      process.exitCode = 1;
    } else {
      console.log(`\nSmoke test PASSED (${results.length}/${results.length} checks passed).`);
    }
  } finally {
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGKILL');
    }
    if (smokeEmailCreated) {
      const cleanupPool = createPostgresPool(smokeDbUrl, { max: 2, connectionTimeoutMillis: 5_000 });
      await cleanupPool
        .query('DELETE FROM users WHERE email = $1', [smokeEmailCreated])
        .catch(() => {})
        .finally(() => cleanupPool.end().catch(() => {}));
    }
    const combinedLogs = serverLogs.join('');
    if (combinedLogs.includes(smokeMasterKey)) {
      console.error('[CRITICAL] Master encryption key appeared in server logs!');
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error('Smoke test crashed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
