// @vitest-environment node
import cookieParser from 'cookie-parser';
import express from 'express';
import http from 'http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encryptString } from '../server/crypto.ts';
import githubRouter from '../server/routes/github.ts';

describe('GitHub Integration API Routes', () => {
  let server: http.Server;
  let baseUrl = '';
  const origClientId = process.env.GITHUB_CLIENT_ID;
  const origClientSecret = process.env.GITHUB_CLIENT_SECRET;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(githubRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (origClientId === undefined) delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = origClientId;
    if (origClientSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
    else process.env.GITHUB_CLIENT_SECRET = origClientSecret;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reports disconnected status and unconfigured auth URL cleanly when OAuth env is missing', async () => {
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;

    const statusRes = await fetch(`${baseUrl}/api/github/status`);
    const statusJson = (await statusRes.json()) as {
      configured: boolean;
      connected: boolean;
      callbackUrl: string;
    };
    expect(statusJson.configured).toBe(false);
    expect(statusJson.connected).toBe(false);
    expect(statusJson.callbackUrl).toContain('/auth/callback');

    const authRes = await fetch(`${baseUrl}/api/github/auth/url`);
    expect(authRes.status).toBe(400);
    const authJson = (await authRes.json()) as { configured: boolean };
    expect(authJson.configured).toBe(false);
  });

  it('generates OAuth state cookie with HttpOnly + SameSite=None when configured', async () => {
    process.env.GITHUB_CLIENT_ID = 'gh-client-123';
    process.env.GITHUB_CLIENT_SECRET = 'gh-secret-456';

    const res = await fetch(`${baseUrl}/api/github/auth/url`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean; url: string };
    expect(body.configured).toBe(true);
    expect(body.url).toContain('https://github.com/login/oauth/authorize');
    expect(body.url).toContain('client_id=gh-client-123');

    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).toContain('omniai_gh_state=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=None');
  });

  it('rejects unauthenticated repository access with 401', async () => {
    const res = await fetch(`${baseUrl}/api/github/repos`);
    expect(res.status).toBe(401);
  });

  it('lists repos, pulls files skipping .env, and pushes atomic commits with encrypted cookie', async () => {
    const encryptedCookie = encryptString(JSON.stringify({ accessToken: 'gho_mock_token_123' }));
    const cookieHeader = `omniai_gh_session=${encodeURIComponent(encryptedCookie)}`;

    const realFetch = globalThis.fetch;
    const mockGitHubFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) {
        return realFetch(input, init);
      }
      if (url.includes('https://api.github.com/user/repos?')) {
        return new Response(
          JSON.stringify([
            {
              id: 101,
              name: 'omniai-demo',
              full_name: 'octocat/omniai-demo',
              private: true,
              description: 'Demo repo',
              default_branch: 'main',
              html_url: 'https://github.com/octocat/omniai-demo',
              updated_at: '2026-01-01T00:00:00Z',
              owner: { login: 'octocat' },
            },
          ]),
          { status: 200 }
        );
      }
      if (url.endsWith('/git/ref/heads/main') || url.endsWith('/git/refs/heads/main')) {
        if (init?.method === 'PATCH') {
          return new Response(JSON.stringify({ ref: 'refs/heads/main' }), { status: 200 });
        }
        return new Response(JSON.stringify({ object: { sha: 'sha-head-111' } }), { status: 200 });
      }
      if (url.includes('/git/trees/sha-head-111')) {
        return new Response(
          JSON.stringify({
            sha: 'tree-1',
            truncated: false,
            tree: [
              { path: 'src/App.tsx', type: 'blob', sha: 'blob-app', size: 30 },
              { path: '.env', type: 'blob', sha: 'blob-env', size: 20 },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/git/blobs/blob-app')) {
        return new Response(
          JSON.stringify({
            encoding: 'base64',
            content: Buffer.from('export default function App(){}', 'utf8').toString('base64'),
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/git/commits/sha-head-111')) {
        return new Response(JSON.stringify({ tree: { sha: 'base-tree-sha' } }), { status: 200 });
      }
      if (url.endsWith('/git/blobs') && init?.method === 'POST') {
        return new Response(JSON.stringify({ sha: 'new-blob-sha' }), { status: 201 });
      }
      if (url.endsWith('/git/trees') && init?.method === 'POST') {
        return new Response(JSON.stringify({ sha: 'new-tree-sha' }), { status: 201 });
      }
      if (url.endsWith('/git/commits') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ sha: 'new-commit-sha-222', html_url: 'https://github.com/commit/222' }),
          { status: 201 }
        );
      }
      return new Response(JSON.stringify({ message: 'Not mocked: ' + url }), { status: 404 });
    });

    vi.stubGlobal('fetch', mockGitHubFetch);

    const reposRes = await realFetch(`${baseUrl}/api/github/repos`, {
      headers: { Cookie: cookieHeader },
    });
    const reposJson = (await reposRes.json()) as { repos: Array<{ fullName: string }> };
    expect(reposJson.repos[0].fullName).toBe('octocat/omniai-demo');

    const pullRes = await realFetch(`${baseUrl}/api/github/repos/octocat/omniai-demo/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ branch: 'main' }),
    });
    const pullJson = (await pullRes.json()) as { files: Array<{ path: string }> };
    expect(pullJson.files.map((f) => f.path)).toEqual(['src/App.tsx']);

    const pushRes = await realFetch(`${baseUrl}/api/github/repos/octocat/omniai-demo/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({
        branch: 'main',
        message: 'feat: sync studio app',
        files: [
          { path: 'src/App.tsx', content: 'console.log(1);' },
          { path: '.env', content: 'SECRET=should_be_filtered' },
        ],
      }),
    });
    const pushJson = (await pushRes.json()) as { ok: boolean; filesPushed: number; commitSha: string };
    expect(pushJson.ok).toBe(true);
    expect(pushJson.filesPushed).toBe(1);
    expect(pushJson.commitSha).toBe('new-commit-sha-222');
  });

  it('rejects OAuth callback with mismatched CSRF state (403), detects 409 branch divergence, supports forceOverwrite, handles 401 reauthRequired, and revokes on disconnect', async () => {
    process.env.GITHUB_CLIENT_ID = 'gh-client-123';
    process.env.GITHUB_CLIENT_SECRET = 'gh-secret-456';

    // 1. CSRF state mismatch -> 403
    const badStateCookie = `omniai_gh_state=${encodeURIComponent(encryptString('expected-state-abc'))}`;
    const cbRes = await fetch(`${baseUrl}/auth/callback?code=code123&state=wrong-state-xyz`, {
      headers: { Cookie: badStateCookie },
    });
    expect(cbRes.status).toBe(403);

    const encryptedCookie = encryptString(JSON.stringify({ accessToken: 'gho_mock_token_123' }));
    const cookieHeader = `omniai_gh_session=${encodeURIComponent(encryptedCookie)}`;
    const realFetch = globalThis.fetch;

    let remoteRevokeCalled = false;
    let simulateExpired = false;

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return realFetch(input, init);

      if (url.includes('/applications/gh-client-123/token') && init?.method === 'DELETE') {
        remoteRevokeCalled = true;
        return new Response(null, { status: 204 });
      }
      if (simulateExpired) {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
      }
      if (url.includes('/branches?per_page=50')) {
        return new Response(
          JSON.stringify([
            { name: 'main', commit: { sha: 'sha-remote-999' } },
            { name: 'dev', commit: { sha: 'sha-dev-111' } },
          ]),
          { status: 200 }
        );
      }
      if (url.endsWith('/git/refs') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ref: 'refs/heads/feature-x' }), { status: 201 });
      }
      if (url.includes('/commits?sha=main')) {
        return new Response(
          JSON.stringify([
            {
              sha: 'sha-remote-999',
              html_url: 'https://github.com/octocat/demo/commit/sha-remote-999',
              commit: { message: 'Remote teammate commit', author: { name: 'Teammate', date: '2026-01-02T00:00:00Z' } },
            },
          ]),
          { status: 200 }
        );
      }
      if (url.endsWith('/git/ref/heads/main') || url.endsWith('/git/refs/heads/main')) {
        if (init?.method === 'PATCH') {
          return new Response(JSON.stringify({ ref: 'refs/heads/main' }), { status: 200 });
        }
        return new Response(JSON.stringify({ object: { sha: 'sha-remote-999' } }), { status: 200 });
      }
      if (url.endsWith('/git/commits/sha-remote-999')) {
        return new Response(JSON.stringify({ tree: { sha: 'base-tree-sha' } }), { status: 200 });
      }
      if (url.endsWith('/git/blobs') && init?.method === 'POST') {
        return new Response(JSON.stringify({ sha: 'blob-sha' }), { status: 201 });
      }
      if (url.endsWith('/git/trees') && init?.method === 'POST') {
        return new Response(JSON.stringify({ sha: 'tree-sha' }), { status: 201 });
      }
      if (url.endsWith('/git/commits') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ sha: 'forced-commit-777', html_url: 'https://github.com/commit/777' }),
          { status: 201 }
        );
      }
      return new Response(JSON.stringify({ message: 'Not mocked' }), { status: 404 });
    });

    vi.stubGlobal('fetch', mockFetch);

    // 2. Branch listing & creation + Commit history
    const branchesRes = await realFetch(`${baseUrl}/api/github/repos/octocat/demo/branches`, {
      headers: { Cookie: cookieHeader },
    });
    expect(branchesRes.status).toBe(200);
    expect(((await branchesRes.json()) as { branches: Array<{ name: string }> }).branches).toHaveLength(2);

    const createBranchRes = await realFetch(`${baseUrl}/api/github/repos/octocat/demo/branches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ branchName: 'feature-x', sourceSha: 'sha-remote-999' }),
    });
    expect(createBranchRes.status).toBe(200);

    const commitsRes = await realFetch(`${baseUrl}/api/github/repos/octocat/demo/commits?branch=main`, {
      headers: { Cookie: cookieHeader },
    });
    expect(commitsRes.status).toBe(200);
    expect(((await commitsRes.json()) as { commits: Array<{ shortSha: string }> }).commits[0].shortSha).toBe(
      'sha-rem'
    );

    // 3. Conflict detection: expectedParentSha !== remoteHeadSha -> 409
    const conflictRes = await realFetch(`${baseUrl}/api/github/repos/octocat/demo/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({
        branch: 'main',
        message: 'feat: conflicting change',
        expectedParentSha: 'sha-stale-000',
        files: [{ path: 'README.md', content: '# Updated' }],
      }),
    });
    expect(conflictRes.status).toBe(409);
    const conflictJson = (await conflictRes.json()) as { conflict: boolean; remoteHeadSha: string };
    expect(conflictJson.conflict).toBe(true);
    expect(conflictJson.remoteHeadSha).toBe('sha-remote-999');

    // 4. Explicit forceOverwrite bypasses conflict cleanly
    const forceRes = await realFetch(`${baseUrl}/api/github/repos/octocat/demo/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({
        branch: 'main',
        message: 'feat: force overwrite',
        expectedParentSha: 'sha-stale-000',
        forceOverwrite: true,
        files: [{ path: 'README.md', content: '# Forced' }],
      }),
    });
    expect(forceRes.status).toBe(200);
    expect(((await forceRes.json()) as { commitSha: string }).commitSha).toBe('forced-commit-777');

    // 5. Expired/revoked token returns HTTP 401 with reauthRequired: true and clears cookie
    simulateExpired = true;
    const expiredRes = await realFetch(`${baseUrl}/api/github/repos`, {
      headers: { Cookie: cookieHeader },
    });
    expect(expiredRes.status).toBe(401);
    const expiredJson = (await expiredRes.json()) as { reauthRequired?: boolean };
    expect(expiredJson.reauthRequired).toBe(true);
    simulateExpired = false;

    // 6. Disconnect calls remote revocation endpoint & clears session
    const disconnectRes = await realFetch(`${baseUrl}/api/github/disconnect`, {
      method: 'POST',
      headers: { Cookie: cookieHeader },
    });
    expect(disconnectRes.status).toBe(200);
    expect(((await disconnectRes.json()) as { revokedRemotely: boolean }).revokedRemotely).toBe(true);
    expect(remoteRevokeCalled).toBe(true);
  });
});

