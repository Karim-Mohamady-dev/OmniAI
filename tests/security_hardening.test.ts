// @vitest-environment node
import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { encryptString } from '../server/crypto.ts';
import { MultiUserStore } from '../server/db/multiUserStore.ts';
import {
  corsMiddleware,
  structuredRequestLogger,
  validateExternalModelUrl,
} from '../server/middleware/security.ts';
import { attachAuthUserMiddleware, createAuthRouter } from '../server/routes/auth.ts';
import { createGitHubRouter } from '../server/routes/github.ts';
import vaultRouter from '../server/routes/vault.ts';
import { createWorkspaceRouter } from '../server/routes/workspace.ts';
import { sanitizeSecretFromText } from '../server/vault/secretVault.ts';
import { buildProjectZipArchive } from '../src/project-engine/zipExporter.ts';
import { computeSimpleChecksum, validateBackupPayload } from '../src/storage/backupValidator.ts';
import type { Project } from '../src/types/index.ts';

function extractCookie(setCookie: string | null, name: string): string {
  if (!setCookie) return '';
  const parts = setCookie.split(/,(?=\s*[a-zA-Z0-9_-]+=)/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.split(';')[0] || '';
    }
  }
  return '';
}

describe('Phase 5 Security Hardening, Data Integrity & Observability', () => {
  const servers: http.Server[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map((srv) => new Promise<void>((resolve) => srv.close(() => resolve())))
    );
    servers.length = 0;
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function startApp(store: MultiUserStore) {
    const app = express();
    app.use(corsMiddleware);
    app.use(structuredRequestLogger);
    app.use(express.json({ limit: '5mb' }));
    app.use(cookieParser());
    app.use(attachAuthUserMiddleware(store));
    app.use('/api/auth', createAuthRouter(store));
    app.use('/api/workspace', createWorkspaceRouter(store));
    app.use('/api/vault', vaultRouter);
    app.use(createGitHubRouter(store));

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const addr = server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  it('blocks IPv4-mapped IPv6 SSRF bypasses and enforces production localhost default', () => {
    const origEnv = process.env.NODE_ENV;
    const origAllowLocal = process.env.ALLOW_LOCAL_MODEL_URLS;

    try {
      // IPv4-mapped IPv6 metadata and private networks must always be blocked
      expect(validateExternalModelUrl('http://[::ffff:169.254.169.254]/latest/meta-data', { allowLocalhost: true }).valid).toBe(false);
      expect(validateExternalModelUrl('http://[::ffff:10.0.0.1]/v1', { allowLocalhost: true }).valid).toBe(false);
      expect(validateExternalModelUrl('http://[::ffff:192.168.1.50]/v1', { allowLocalhost: true }).valid).toBe(false);
      expect(validateExternalModelUrl('http://0.0.0.1/v1', { allowLocalhost: true }).valid).toBe(false);

      // In production, localhost & ::ffff:127.0.0.1 must be blocked by default unless ALLOW_LOCAL_MODEL_URLS='true'
      process.env.NODE_ENV = 'production';
      delete process.env.ALLOW_LOCAL_MODEL_URLS;
      expect(validateExternalModelUrl('http://localhost:11434/v1').valid).toBe(false);
      expect(validateExternalModelUrl('http://[::ffff:127.0.0.1]:11434/v1').valid).toBe(false);

      process.env.ALLOW_LOCAL_MODEL_URLS = 'true';
      expect(validateExternalModelUrl('http://localhost:11434/v1').valid).toBe(true);
      expect(validateExternalModelUrl('http://[::ffff:127.0.0.1]:11434/v1').valid).toBe(true);
    } finally {
      if (origEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = origEnv;
      if (origAllowLocal === undefined) delete process.env.ALLOW_LOCAL_MODEL_URLS;
      else process.env.ALLOW_LOCAL_MODEL_URLS = origAllowLocal;
    }
  });

  it('rejects untrusted cross-origin credentialed CORS requests and emits X-Request-Id', async () => {
    const store = new MultiUserStore(null);
    const baseUrl = await startApp(store);

    const evilRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Origin: 'https://evil-attacker.example' },
    });
    expect(evilRes.headers.get('access-control-allow-origin')).toBeNull();
    expect(evilRes.headers.get('access-control-allow-credentials')).toBeNull();
    expect(evilRes.headers.get('x-request-id')).toMatch(/^req_[a-f0-9]+$/);

    const trustedRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: {
        Origin: 'http://127.0.0.1:3000',
        'X-Request-Id': 'trace-verify-001',
      },
    });
    expect(trustedRes.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3000');
    expect(trustedRes.headers.get('access-control-allow-credentials')).toBe('true');
    expect(trustedRes.headers.get('x-request-id')).toBe('trace-verify-001');
  });

  it('redacts Anthropic keys, Bearer tokens, and PostgreSQL connection string passwords', () => {
    const raw =
      'connect failed postgresql://omniai_user:SuperSecretDbPass!@db.internal:5432/prod with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig and sk-ant-api03-abcdef1234567890';
    const clean = sanitizeSecretFromText(raw);
    expect(clean).not.toContain('SuperSecretDbPass!');
    expect(clean).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(clean).not.toContain('sk-ant-api03-abcdef1234567890');
    expect(clean).toContain('postgresql://omniai_user:[REDACTED]@db.internal:5432/prod');
    expect(clean).toContain('[REDACTED_KEY]');
  });

  it('isolates anonymous vault credentials across browsers and clears cookies on auth switch', async () => {
    const store = new MultiUserStore(null);
    const baseUrl = await startApp(store);

    const storeResA = await fetch(`${baseUrl}/api/vault/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-browser-a-secret-99999' }),
    });
    expect(storeResA.status).toBe(200);
    const vaultSetCookie = storeResA.headers.get('set-cookie');
    const cookieA = [
      extractCookie(vaultSetCookie, 'omniai_anon_vault'),
      extractCookie(vaultSetCookie, 'omniai_key_vault'),
    ]
      .filter(Boolean)
      .join('; ');

    // Browser A sees its ref, Browser B (no cookie) sees 0 credentials
    const statusA = (await (
      await fetch(`${baseUrl}/api/vault/status`, { headers: { Cookie: cookieA } })
    ).json()) as { storedCredentialCount: number };
    const statusB = (await (
      await fetch(`${baseUrl}/api/vault/status`)
    ).json()) as { storedCredentialCount: number };
    expect(statusA.storedCredentialCount).toBe(1);
    expect(statusB.storedCredentialCount).toBe(0);

    // Register with prior anonymous vault cookies clears those anonymous cookies cleanly
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `${cookieA}; omniai_gh_session=stale_gh` },
      body: JSON.stringify({
        email: 'cleancookie@example.com',
        password: 'password1234',
        displayName: 'CleanCookie',
      }),
    });
    expect(reg.status).toBe(201);
    const setCookiesOnReg = reg.headers.get('set-cookie') || '';
    expect(setCookiesOnReg).toContain('omniai_auth_session=');
    expect(setCookiesOnReg).toContain('omniai_gh_session=;');
    expect(setCookiesOnReg).toContain('omniai_anon_vault=;');
  });

  it('rejects GitHub OAuth callback if user session switched and escapes HTML error payloads', async () => {
    const origId = process.env.GITHUB_CLIENT_ID;
    const origSecret = process.env.GITHUB_CLIENT_SECRET;
    try {
      process.env.GITHUB_CLIENT_ID = 'gh-test-id';
      process.env.GITHUB_CLIENT_SECRET = 'gh-test-secret';

      const store = new MultiUserStore(null);
      const baseUrl = await startApp(store);

      // Register User A & start GitHub OAuth URL
      const regA = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'gh-a@example.com', password: 'password1234', displayName: 'GHA' }),
      });
      const cookieA = extractCookie(regA.headers.get('set-cookie'), 'omniai_auth_session');

      const authUrlRes = await fetch(`${baseUrl}/api/github/auth/url`, {
        headers: { Cookie: cookieA },
      });
      const authUrlJson = (await authUrlRes.json()) as { url: string };
      const state = new URL(authUrlJson.url).searchParams.get('state')!;
      const ghStateCookie = extractCookie(authUrlRes.headers.get('set-cookie'), 'omniai_gh_state');

      // Register User B and attempt callback replay with User A's state cookie -> 403
      const regB = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'gh-b@example.com', password: 'password1234', displayName: 'GHB' }),
      });
      const cookieB = extractCookie(regB.headers.get('set-cookie'), 'omniai_auth_session');

      const replayRes = await fetch(`${baseUrl}/auth/callback?code=fake&state=${state}`, {
        headers: { Cookie: `${cookieB}; ${ghStateCookie}` },
      });
      expect(replayRes.status).toBe(403);

      // XSS payload in error_description must be HTML-escaped
      const errRes = await fetch(
        `${baseUrl}/auth/callback?error=access_denied&error_description=${encodeURIComponent('<img src=x onerror=alert(1)>')}`
      );
      expect(errRes.status).toBe(400);
      const html = await errRes.text();
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;img src=x');
    } finally {
      if (origId === undefined) delete process.env.GITHUB_CLIENT_ID;
      else process.env.GITHUB_CLIENT_ID = origId;
      if (origSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
      else process.env.GITHUB_CLIENT_SECRET = origSecret;
    }
  });

  it('persists workspace backup across disk reload, preserves folder hierarchy, validates ZIP export, and strips secrets', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omniai-store-persist-'));
    tempDirs.push(dataDir);
    const dataFile = path.join(dataDir, 'store.json');

    const store1 = new MultiUserStore(dataFile);
    const baseUrl1 = await startApp(store1);

    const reg = await fetch(`${baseUrl1}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'persist@example.com',
        password: 'password1234',
        displayName: 'Persist User',
      }),
    });
    const sessionCookie = extractCookie(reg.headers.get('set-cookie'), 'omniai_auth_session');

    const proj: Project = {
      id: 'proj-zip-1',
      name: 'Hierarchy App',
      description: 'Backup verification project',
      framework: 'react-vite',
      files: [
        { path: 'package.json', content: '{"name":"hierarchy-app"}', updatedAt: 100 },
        { path: 'src/components/Header.tsx', content: 'export const Header = () => <header>OK</header>;', updatedAt: 100 },
      ],
      activities: [],
      createdAt: 100,
      updatedAt: 100,
    };

    const putRes = await fetch(`${baseUrl1}/api/workspace/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        folders: [{ id: 'fld-1', name: 'Core Architecture', createdAt: 100 }],
        conversations: [
          {
            id: 'conv-1',
            folderId: 'fld-1',
            title: 'Architecture Spec',
            messages: [{ id: 'm1', role: 'user', content: 'Design app', timestamp: 100 }],
            createdAt: 100,
            updatedAt: 100,
          },
        ],
        models: [
          {
            id: 'mdl-1',
            displayName: 'Custom Model',
            providerName: 'OpenAI',
            modelId: 'gpt-4o-mini',
            apiKey: 'sk-must-never-export-plaintext-12345',
            priority: 1,
            enabled: true,
          },
        ],
        projects: [proj],
      }),
    });
    expect(putRes.status).toBe(200);

    const exportRes = await fetch(`${baseUrl1}/api/workspace/export`, {
      headers: { Cookie: sessionCookie },
    });
    const exportPayload = (await exportRes.json()) as Record<string, unknown>;
    expect(validateBackupPayload(exportPayload).valid).toBe(true);
    expect(JSON.stringify(exportPayload)).not.toContain('sk-must-never-export-plaintext-12345');

    // Simulate server restart by loading fresh MultiUserStore instance from same disk file
    const store2 = new MultiUserStore(dataFile);
    const baseUrl2 = await startApp(store2);

    const loginRes = await fetch(`${baseUrl2}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'persist@example.com', password: 'password1234' }),
    });
    const loginCookie = extractCookie(loginRes.headers.get('set-cookie'), 'omniai_auth_session');

    // Wipe state then restore from exported payload across fresh store instance
    await fetch(`${baseUrl2}/api/workspace/state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: loginCookie },
      body: JSON.stringify({ folders: [], conversations: [], projects: [], models: [] }),
    });

    const restoreRes = await fetch(`${baseUrl2}/api/workspace/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: loginCookie },
      body: JSON.stringify(exportPayload),
    });
    expect(restoreRes.status).toBe(200);

    const restored = (await (
      await fetch(`${baseUrl2}/api/workspace/state`, { headers: { Cookie: loginCookie } })
    ).json()) as {
      folders: Array<{ id: string; name: string }>;
      conversations: Array<{ folderId?: string }>;
      projects: Project[];
    };
    expect(restored.folders[0]?.name).toBe('Core Architecture');
    expect(restored.conversations[0]?.folderId).toBe('fld-1');
    expect(restored.projects[0]?.files.map((f) => f.path)).toEqual([
      'package.json',
      'src/components/Header.tsx',
    ]);

    // Single-project ZIP export verification (including nested path & secret file exclusion)
    const zipArchive = await buildProjectZipArchive({
      ...restored.projects[0],
      files: [
        ...restored.projects[0].files,
        { path: '.env', content: 'SECRET_TOKEN=blocked', updatedAt: 100 },
      ],
    });
    expect(zipArchive.blob.size).toBeGreaterThan(100);
    expect(zipArchive.excludedCount).toBe(1);
    const JSZip = (await import('jszip')).default;
    const loadedZip = await JSZip.loadAsync(await zipArchive.blob.arrayBuffer());
    const zipEntries = Object.keys(loadedZip.files);
    expect(zipEntries.some((p) => p.endsWith('src/components/Header.tsx'))).toBe(true);
    expect(zipEntries.some((p) => p.endsWith('.env'))).toBe(false);

    // Tampered checksum check
    const tampered = { ...exportPayload, projects: [], checksum: computeSimpleChecksum({ fake: true }) };
    expect(validateBackupPayload(tampered).valid).toBe(false);
  });

  it('validates production env configuration, detects placeholders & weak keys, and keeps optional providers non-blocking', async () => {
    const { validateEnvironmentConfig } = await import('../server/config/envValidator.ts');

    const insecureProd = validateEnvironmentConfig({
      NODE_ENV: 'production',
      APP_URL: 'MY_APP_URL',
      DATABASE_URL: 'postgresql://user:password@localhost:5432/omniai',
      OMNIAI_MASTER_KEY: 'REPLACE_WITH_SECURE_RANDOM_32_BYTE_MASTER_KEY',
      GEMINI_API_KEY: 'MY_GEMINI_API_KEY',
    } as unknown as NodeJS.ProcessEnv);
    expect(insecureProd.valid).toBe(false);
    expect(insecureProd.errors.some((e) => e.includes('APP_URL'))).toBe(true);
    expect(insecureProd.errors.some((e) => e.includes('DATABASE_URL'))).toBe(true);
    expect(insecureProd.errors.some((e) => e.includes('OMNIAI_MASTER_KEY'))).toBe(true);

    const reusedGeminiProd = validateEnvironmentConfig({
      NODE_ENV: 'production',
      APP_URL: 'https://omniai.example.com',
      DATABASE_URL: 'postgresql://app:realpass@db.example.com:5432/omniai',
      OMNIAI_MASTER_KEY: 'AIzaSyFakeGeminiKeyValue123456',
      GEMINI_API_KEY: 'AIzaSyFakeGeminiKeyValue123456',
    } as unknown as NodeJS.ProcessEnv);
    expect(reusedGeminiProd.valid).toBe(false);
    expect(reusedGeminiProd.errors.some((e) => e.includes('GEMINI_API_KEY'))).toBe(true);

    const validProdMinimal = validateEnvironmentConfig({
      NODE_ENV: 'production',
      APP_URL: 'https://omniai.example.com',
      DATABASE_URL: 'postgresql://app:realpass@db.example.com:5432/omniai',
      OMNIAI_MASTER_KEY: 'prod_master_key_with_high_entropy_32_bytes_min',
    } as unknown as NodeJS.ProcessEnv);
    expect(validProdMinimal.valid).toBe(true);
    expect(validProdMinimal.errors).toEqual([]);
  });
});
