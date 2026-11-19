import crypto from 'crypto';
import express, { type Request, type Response } from 'express';
import { isValidAppUrl } from '../config/envValidator.ts';
import { decryptString, encryptString } from '../crypto.ts';
import { getActiveStore } from '../db/index.ts';
import type { UserWorkspaceStore } from '../db/storeTypes.ts';
import { getCookieOptions } from './auth.ts';

const GITHUB_COOKIE_NAME = 'omniai_gh_session';
const GITHUB_STATE_COOKIE = 'omniai_gh_state';

function getAppBaseUrl(): string {
  const check = isValidAppUrl(process.env.APP_URL);
  if (check.valid && check.normalized) {
    return check.normalized;
  }
  return 'http://localhost:3000';
}

function getCallbackUrl(): string {
  return `${getAppBaseUrl()}/auth/callback`;
}

function isGitHubOAuthConfigured(): boolean {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  return Boolean(
    clientId &&
      clientSecret &&
      clientId !== 'YOUR_GITHUB_CLIENT_ID' &&
      clientSecret !== 'YOUR_GITHUB_CLIENT_SECRET'
  );
}

class GitHubHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function githubFetch<T>(
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'OmniAI-Studio',
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = `GitHub API error (${res.status})`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.message) msg = parsed.message;
    } catch {
      if (text) msg = text;
    }
    throw new GitHubHttpError(res.status, msg);
  }

  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

const BLOCKED_REPO_FILENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'id_rsa',
  'id_ed25519',
]);
const BLOCKED_REPO_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];

function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeRepoPath(filePath: string): boolean {
  if (!filePath || filePath.includes('\0') || filePath.startsWith('/') || filePath.includes('\\')) {
    return false;
  }
  const segments = filePath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s === '.git')) {
    return false;
  }
  const fileName = segments[segments.length - 1].toLowerCase();
  if (
    BLOCKED_REPO_FILENAMES.has(fileName) ||
    (fileName.startsWith('.env.') && fileName !== '.env.example') ||
    BLOCKED_REPO_EXTENSIONS.some((ext) => fileName.endsWith(ext))
  ) {
    return false;
  }
  return true;
}

export function createGitHubRouter(customStore?: UserWorkspaceStore) {
  const router = express.Router();
  const resolveStore = () => customStore ?? getActiveStore();

  async function getTokenFromRequest(req: Request): Promise<string | null> {
    if (req.authUser?.id) {
      return resolveStore().getUserGitHubToken(req.authUser.id);
    }
    const rawCookie = req.cookies?.[GITHUB_COOKIE_NAME];
    if (!rawCookie || typeof rawCookie !== 'string') return null;
    const decrypted = decryptString(rawCookie);
    if (!decrypted) return null;
    try {
      const parsed = JSON.parse(decrypted) as { accessToken?: string };
      return parsed.accessToken || null;
    } catch {
      return null;
    }
  }

  async function clearStoredToken(req: Request, res: Response): Promise<void> {
    if (req.authUser?.id) {
      await resolveStore().setUserGitHubToken(req.authUser.id, null);
    }
    res.clearCookie(GITHUB_COOKIE_NAME, getCookieOptions(req));
  }

  async function handleGitHubRouteError(
    req: Request,
    res: Response,
    err: unknown,
    fallbackMessage: string
  ) {
    if (err instanceof GitHubHttpError && err.status === 401) {
      await clearStoredToken(req, res);
      res.status(401).json({
        error: 'GitHub token expired or revoked. Please reconnect your GitHub account.',
        reauthRequired: true,
      });
      return;
    }
    const status =
      err instanceof GitHubHttpError && err.status >= 400 && err.status < 600
        ? err.status
        : 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : fallbackMessage,
    });
  }

  router.get('/api/github/status', async (req, res) => {
    const configured = isGitHubOAuthConfigured();
    const callbackUrl = getCallbackUrl();
    const token = await getTokenFromRequest(req);

    if (!token) {
      res.json({
        configured,
        connected: false,
        callbackUrl,
        user: null,
      });
      return;
    }

    try {
      const user = await githubFetch<{
        login: string;
        name: string | null;
        avatar_url: string;
        html_url: string;
        public_repos: number;
      }>(token, '/user');

      res.json({
        configured,
        connected: true,
        callbackUrl,
        user: {
          login: user.login,
          name: user.name || user.login,
          avatarUrl: user.avatar_url,
          profileUrl: user.html_url,
          publicRepos: user.public_repos,
        },
      });
    } catch {
      await clearStoredToken(req, res);
      res.json({
        configured,
        connected: false,
        callbackUrl,
        user: null,
      });
    }
  });

  router.get('/api/github/auth/url', (req, res) => {
    const configured = isGitHubOAuthConfigured();
    const callbackUrl = getCallbackUrl();

    if (!configured) {
      res.status(400).json({
        configured: false,
        callbackUrl,
        error:
          'GitHub OAuth credentials (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET) are not configured on the server.',
      });
      return;
    }

    const state = crypto.randomBytes(16).toString('hex');
    const statePayload = JSON.stringify({
      state,
      userId: req.authUser?.id ?? null,
      exp: Date.now() + 10 * 60 * 1000,
    });
    res.cookie(GITHUB_STATE_COOKIE, encryptString(statePayload), getCookieOptions(req, 10 * 60 * 1000));

    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID!.trim(),
      redirect_uri: callbackUrl,
      scope: 'repo read:user user:email',
      state,
    });

    res.json({
      configured: true,
      callbackUrl,
      url: `https://github.com/login/oauth/authorize?${params.toString()}`,
    });
  });

  async function handleGitHubCallback(req: Request, res: Response) {
    const { code, state, error, error_description } = req.query as Record<string, string>;

    if (error) {
      const safeError = error_description || error;
      const safeScriptError = JSON.stringify(safeError).replace(/</g, '\\u003c');
      res.status(400).send(`
        <html>
          <body style="font-family: system-ui, sans-serif; padding: 24px; background: #0f172a; color: #f8fafc;">
            <h2>GitHub Authorization Failed</h2>
            <p>${escapeHtml(safeError)}</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'GITHUB_OAUTH_ERROR', error: ${safeScriptError} }, '*');
              }
            </script>
          </body>
        </html>
      `);
      return;
    }

    if (!code) {
      res.status(400).send('Missing authorization code.');
      return;
    }

    const savedStateEnc = req.cookies?.[GITHUB_STATE_COOKIE];
    const savedRaw = savedStateEnc ? decryptString(savedStateEnc) : null;
    let stateValid = false;
    if (savedRaw) {
      try {
        const parsed = JSON.parse(savedRaw) as { state?: string; userId?: string | null; exp?: number };
        const currentUserId = req.authUser?.id ?? null;
        if (
          parsed &&
          typeof parsed.state === 'string' &&
          parsed.state === state &&
          (!parsed.exp || parsed.exp > Date.now()) &&
          (parsed.userId ?? null) === currentUserId
        ) {
          stateValid = true;
        }
      } catch {
        stateValid = savedRaw === state;
      }
    }
    if (!stateValid) {
      res.status(403).send('Invalid or expired OAuth state parameter.');
      return;
    }

    try {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID?.trim(),
          client_secret: process.env.GITHUB_CLIENT_SECRET?.trim(),
          code,
          redirect_uri: getCallbackUrl(),
        }),
      });

      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (!tokenJson.access_token) {
        throw new Error(
          tokenJson.error_description || tokenJson.error || 'Failed to exchange code for token'
        );
      }

      if (req.authUser?.id) {
        await resolveStore().setUserGitHubToken(req.authUser.id, tokenJson.access_token);
      } else {
        const encryptedSession = encryptString(
          JSON.stringify({
            accessToken: tokenJson.access_token,
            createdAt: Date.now(),
          })
        );

        res.cookie(
          GITHUB_COOKIE_NAME,
          encryptedSession,
          getCookieOptions(req, 7 * 24 * 60 * 60 * 1000)
        );
      }

      res.clearCookie(GITHUB_STATE_COOKIE, getCookieOptions(req));

      res.send(`
        <html>
          <body style="font-family: system-ui, sans-serif; padding: 32px; background: #0f172a; color: #f8fafc;">
            <p>GitHub account connected. Closing window...</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'GITHUB_OAUTH_SUCCESS' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
          </body>
        </html>
      `);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'GitHub token exchange failed';
      const safeScriptMsg = JSON.stringify(message).replace(/</g, '\\u003c');
      res.status(500).send(`
        <html>
          <body style="font-family: system-ui, sans-serif; padding: 24px; background: #0f172a; color: #f8fafc;">
            <h2>Connection Error</h2>
            <p>${escapeHtml(message)}</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'GITHUB_OAUTH_ERROR', error: ${safeScriptMsg} }, '*');
              }
            </script>
          </body>
        </html>
      `);
    }
  }

  router.get(['/auth/callback', '/auth/callback/'], handleGitHubCallback);

  router.post('/api/github/disconnect', async (req, res) => {
    const token = await getTokenFromRequest(req);
    let revokedRemotely = false;
    if (token && isGitHubOAuthConfigured()) {
      const clientId = process.env.GITHUB_CLIENT_ID!.trim();
      const clientSecret = process.env.GITHUB_CLIENT_SECRET!.trim();
      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      try {
        const revokeRes = await fetch(`https://api.github.com/applications/${clientId}/token`, {
          method: 'DELETE',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Basic ${basicAuth}`,
            'Content-Type': 'application/json',
            'User-Agent': 'OmniAI-Studio',
          },
          body: JSON.stringify({ access_token: token }),
        });
        revokedRemotely = revokeRes.ok || revokeRes.status === 204;
      } catch {
        // Best-effort remote revocation; always clear local token
      }
    }

    await clearStoredToken(req, res);
    res.json({ ok: true, revokedRemotely });
  });

  router.get('/api/github/repos', async (req, res) => {
    const token = await getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: 'Not authenticated with GitHub.', reauthRequired: true });
      return;
    }
    try {
      const repos = await githubFetch<
        Array<{
          id: number;
          name: string;
          full_name: string;
          private: boolean;
          description: string | null;
          default_branch: string;
          html_url: string;
          updated_at: string;
          owner: { login: string };
        }>
      >(token, '/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator');

      res.json({
        repos: repos.map((r) => ({
          id: r.id,
          name: r.name,
          fullName: r.full_name,
          owner: r.owner.login,
          private: r.private,
          description: r.description || '',
          defaultBranch: r.default_branch,
          htmlUrl: r.html_url,
          updatedAt: r.updated_at,
        })),
      });
    } catch (err) {
      await handleGitHubRouteError(req, res, err, 'Failed to list repositories');
    }
  });

  router.post('/api/github/repos', async (req, res) => {
    const token = await getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: 'Not authenticated with GitHub.', reauthRequired: true });
      return;
    }
    try {
      const { name, description, isPrivate } = req.body as {
        name?: string;
        description?: string;
        isPrivate?: boolean;
      };
      if (!name || !name.trim()) {
        res.status(400).json({ error: 'Repository name is required.' });
        return;
      }

      const created = await githubFetch<{
        id: number;
        name: string;
        full_name: string;
        private: boolean;
        description: string | null;
        default_branch: string;
        html_url: string;
        owner: { login: string };
      }>(token, '/user/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description || 'Created with OmniAI Studio',
          private: Boolean(isPrivate),
          auto_init: true,
        }),
      });

      res.json({
        repo: {
          id: created.id,
          name: created.name,
          fullName: created.full_name,
          owner: created.owner.login,
          private: created.private,
          description: created.description || '',
          defaultBranch: created.default_branch || 'main',
          htmlUrl: created.html_url,
        },
      });
    } catch (err) {
      await handleGitHubRouteError(req, res, err, 'Failed to create repository');
    }
  });

  router.get('/api/github/repos/:owner/:repo/branches', async (req, res) => {
    const token = await getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: 'Not authenticated with GitHub.', reauthRequired: true });
      return;
    }
    try {
      const { owner, repo } = req.params;
      const branches = await githubFetch<Array<{ name: string; commit: { sha: string } }>>(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=50`
      );
      res.json({
        branches: branches.map((b) => ({ name: b.name, sha: b.commit.sha })),
      });
    } catch (err) {
      await handleGitHubRouteError(req, res, err, 'Failed to fetch branches');
    }
  });

  router.post('/api/github/repos/:owner/:repo/branches', async (req, res) => {
    const token = await getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: 'Not authenticated with GitHub.', reauthRequired: true });
      return;
    }
    try {
      const { owner, repo } = req.params;
      const { branchName, sourceSha } = req.body as { branchName?: string; sourceSha?: string };
      if (!branchName || !sourceSha) {
        res.status(400).json({ error: 'branchName and sourceSha are required.' });
        return;
      }

      await githubFetch(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ref: `refs/heads/${branchName.trim()}`,
            sha: sourceSha,
          }),
        }
      );

      res.json({ ok: true, name: branchName.trim(), sha: sourceSha });
    } catch (err) {
      await handleGitHubRouteError(req, res, err, 'Failed to create branch');
    }
  });

  router.get('/api/github/repos/:owner/:repo/commits', async (req, res) => {
    const token = await getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: 'Not authenticated with GitHub.', reauthRequired: true });
      return;
    }
    try {
      const { owner, repo } = req.params;
      const branch = (req.query.branch as string) || 'main';
      const commits = await githubFetch<
        Array<{
          sha: string;
          html_url: string;
          commit: { message: string; author: { name: string; date: string } };
        }>
      >(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(branch)}&per_page=20`
      );

      res.json({
        commits: commits.map((c) => ({
          sha: c.sha,
          shortSha: c.sha.slice(0, 7),
          message: c.commit.message,
          authorName: c.commit.author.name,
          date: c.commit.author.date,
          url: c.html_url,
        })),
      });
    } catch (err) {
      await handleGitHubRouteError(req, res, err, 'Failed to load commits');
    }
  });

  router.post('/api/github/repos/:owner/:repo/pull', async (req, res) => {
    const token = await getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: 'Not authenticated with GitHub.', reauthRequired: true });
      return;
    }
    try {
      const { owner, repo } = req.params;
      const { branch = 'main' } = req.body as { branch?: string };

      const ref = await githubFetch<{ object: { sha: string } }>(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`
      );

      const treeResp = await githubFetch<{
        sha: string;
        truncated: boolean;
        tree: Array<{ path: string; type: string; sha: string; size?: number }>;
      }>(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${ref.object.sha}?recursive=1`
      );

      const blobs = treeResp.tree
        .filter((item) => item.type === 'blob' && isSafeRepoPath(item.path) && (item.size ?? 0) < 400_000)
        .slice(0, 120);

      const files: Array<{ path: string; content: string }> = [];
      for (const item of blobs) {
        const blob = await githubFetch<{ content: string; encoding: string }>(
          token,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${item.sha}`
        );
        if (blob.encoding === 'base64') {
          const buf = Buffer.from(blob.content.replace(/\n/g, ''), 'base64');
          if (!buf.includes(0)) {
            files.push({ path: item.path, content: buf.toString('utf8') });
          }
        }
      }

      res.json({
        commitSha: ref.object.sha,
        branch,
        files,
        truncated: treeResp.truncated,
      });
    } catch (err) {
      await handleGitHubRouteError(req, res, err, 'Failed to pull repository files');
    }
  });

  router.post('/api/github/repos/:owner/:repo/push', async (req, res) => {
    const token = await getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ error: 'Not authenticated with GitHub.', reauthRequired: true });
      return;
    }
    try {
      const { owner, repo } = req.params;
      const {
        branch = 'main',
        message,
        files,
        expectedParentSha,
        forceOverwrite,
      } = req.body as {
        branch?: string;
        message?: string;
        files?: Array<{ path: string; content: string }>;
        expectedParentSha?: string;
        forceOverwrite?: boolean;
      };

      if (!message || !message.trim()) {
        res.status(400).json({ error: 'Commit message is required.' });
        return;
      }
      if (!Array.isArray(files) || files.length === 0) {
        res.status(400).json({ error: 'Project files array cannot be empty.' });
        return;
      }

      const sanitizedFiles = files.filter((f) => isSafeRepoPath(f.path));
      if (sanitizedFiles.length === 0) {
        res.status(400).json({ error: 'No valid project files to commit.' });
        return;
      }

      const baseRef = await githubFetch<{ object: { sha: string } }>(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`
      );
      const parentSha = baseRef.object.sha;

      if (expectedParentSha && expectedParentSha !== parentSha && !forceOverwrite) {
        res.status(409).json({
          conflict: true,
          remoteHeadSha: parentSha,
          expectedParentSha,
          error: `Remote branch "${branch}" has newer commits (${parentSha.slice(0, 7)}) than your last synced commit (${expectedParentSha.slice(0, 7)}). Pull changes first or confirm force overwrite.`,
        });
        return;
      }

      const parentCommit = await githubFetch<{ tree: { sha: string } }>(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${parentSha}`
      );

      const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];
      for (const file of sanitizedFiles) {
        const blob = await githubFetch<{ sha: string }>(
          token,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: file.content,
              encoding: 'utf-8',
            }),
          }
        );
        treeItems.push({
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: blob.sha,
        });
      }

      const newTree = await githubFetch<{ sha: string }>(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base_tree: parentCommit.tree.sha,
            tree: treeItems,
          }),
        }
      );

      const newCommit = await githubFetch<{ sha: string; html_url: string }>(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: message.trim(),
            tree: newTree.sha,
            parents: [parentSha],
          }),
        }
      );

      await githubFetch(
        token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs/heads/${encodeURIComponent(branch)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sha: newCommit.sha,
            force: false,
          }),
        }
      );

      res.json({
        ok: true,
        commitSha: newCommit.sha,
        commitUrl: newCommit.html_url,
        branch,
        filesPushed: sanitizedFiles.length,
      });
    } catch (err) {
      await handleGitHubRouteError(req, res, err, 'Failed to push to GitHub');
    }
  });

  return router;
}

export default createGitHubRouter();
