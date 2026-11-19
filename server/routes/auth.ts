import express, { type NextFunction, type Request, type Response } from 'express';
import { decryptString, encryptString } from '../crypto.ts';
import { getActiveStore, getDatabaseUnavailableReason } from '../db/index.ts';
import type { PublicUserRecord, UserWorkspaceStore } from '../db/storeTypes.ts';

export const AUTH_COOKIE_NAME = 'omniai_auth_session';

export type AuthSessionUser = PublicUserRecord;

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthSessionUser | null;
      authSessionId?: string | null;
    }
  }
}

export function getCookieOptions(req: Request, maxAge?: number) {
  const isHttps =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    (process.env.APP_URL?.trim().startsWith('https://') ?? false);
  return {
    httpOnly: true,
    secure: isHttps,
    sameSite: (isHttps ? 'none' : 'lax') as 'none' | 'lax',
    ...(maxAge !== undefined ? { maxAge } : {}),
  };
}

export function parseSessionCookie(req: Request): {
  userId: string;
  sid: string;
  exp: number;
} | null {
  const raw = req.cookies?.[AUTH_COOKIE_NAME];
  if (!raw || typeof raw !== 'string') return null;
  const decrypted = decryptString(raw);
  if (!decrypted) return null;
  try {
    const parsed = JSON.parse(decrypted) as { userId?: string; sid?: string; exp?: number };
    if (!parsed.userId || !parsed.sid || !parsed.exp || parsed.exp < Date.now()) {
      return null;
    }
    return { userId: parsed.userId, sid: parsed.sid, exp: parsed.exp };
  } catch {
    return null;
  }
}

export async function getAuthUserFromRequest(
  req: Request,
  store?: UserWorkspaceStore
): Promise<AuthSessionUser | null> {
  const parsed = parseSessionCookie(req);
  if (!parsed) return null;
  const targetStore = store ?? getActiveStore();
  return targetStore.validateSession(parsed.sid, parsed.userId);
}

export function attachAuthUserMiddleware(customStore?: UserWorkspaceStore) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const parsed = parseSessionCookie(req);
      if (!parsed) {
        req.authUser = null;
        req.authSessionId = null;
        next();
        return;
      }
      if (!customStore && getDatabaseUnavailableReason()) {
        req.authUser = null;
        req.authSessionId = null;
        next();
        return;
      }
      const targetStore = customStore ?? getActiveStore();
      const user = await targetStore.validateSession(parsed.sid, parsed.userId);
      req.authUser = user;
      req.authSessionId = user ? parsed.sid : null;
      next();
    } catch {
      req.authUser = null;
      req.authSessionId = null;
      next();
    }
  };
}

export function requireAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required for hosted multi-user mode.' });
    return;
  }
  next();
}

function setSessionCookie(
  req: Request,
  res: Response,
  userId: string,
  sessionId: string,
  ttlMs: number = 7 * 24 * 60 * 60 * 1000
) {
  const token = encryptString(
    JSON.stringify({
      userId,
      sid: sessionId,
      exp: Date.now() + ttlMs,
    })
  );
  res.cookie(AUTH_COOKIE_NAME, token, getCookieOptions(req, ttlMs));
}

function clearAnonymousBridgeCookies(req: Request, res: Response) {
  const opts = getCookieOptions(req);
  for (const name of ['omniai_gh_session', 'omniai_gh_state', 'omniai_key_vault', 'omniai_anon_vault']) {
    if (req.cookies && name in req.cookies) {
      res.clearCookie(name, opts);
    }
  }
}

export function createAuthRouter(customStore?: UserWorkspaceStore) {
  const router = express.Router();
  const resolveStore = () => customStore ?? getActiveStore();

  const guardDbReady = (_req: Request, res: Response, next: NextFunction) => {
    if (!customStore) {
      const unavailable = getDatabaseUnavailableReason();
      if (unavailable) {
        res.status(503).json({ error: unavailable });
        return;
      }
    }
    next();
  };

  router.get('/me', async (req, res) => {
    if (!customStore && getDatabaseUnavailableReason()) {
      res.status(503).json({
        authenticated: false,
        user: null,
        databaseConfigured: false,
        error: getDatabaseUnavailableReason(),
      });
      return;
    }
    const store = resolveStore();
    const user = await getAuthUserFromRequest(req, store);
    res.json({
      authenticated: Boolean(user),
      user,
      databaseConfigured: store.backendType === 'postgres',
      storageBackend: store.backendType,
    });
  });

  router.post('/register', guardDbReady, async (req, res) => {
    try {
      const store = resolveStore();
      const { email, password, displayName } = req.body as {
        email?: string;
        password?: string;
        displayName?: string;
      };
      const user = await store.registerUser({
        email: email || '',
        password: password || '',
        displayName: displayName || '',
      });
      const session = await store.createSession(user.id);
      await store.appendAuditLog({
        userId: user.id,
        action: 'auth_register',
        target: user.email,
        outcome: 'success',
      });
      setSessionCookie(req, res, user.id, session.sessionId);
      clearAnonymousBridgeCookies(req, res);
      res.status(201).json({ user });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Registration failed.',
      });
    }
  });

  router.post('/login', guardDbReady, async (req, res) => {
    try {
      const store = resolveStore();
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || !password) {
        res.status(400).json({ error: 'Email and password are required.' });
        return;
      }
      const user = await store.authenticateUser(email, password);
      if (!user) {
        await store.appendAuditLog({
          userId: null,
          action: 'auth_login',
          target: email.trim().toLowerCase(),
          outcome: 'denied',
        });
        res.status(401).json({ error: 'Invalid email or password.' });
        return;
      }
      const session = await store.createSession(user.id);
      await store.appendAuditLog({
        userId: user.id,
        action: 'auth_login',
        target: user.email,
        outcome: 'success',
      });
      setSessionCookie(req, res, user.id, session.sessionId);
      clearAnonymousBridgeCookies(req, res);
      res.json({ user });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Authentication service error.',
      });
    }
  });

  router.post('/logout', async (req, res) => {
    const store = resolveStore();
    const parsed = parseSessionCookie(req);
    if (parsed?.sid) {
      await store.revokeSession(parsed.sid);
      await store.appendAuditLog({
        userId: parsed.userId,
        action: 'auth_logout',
        target: parsed.sid,
        outcome: 'success',
      });
    }
    res.clearCookie(AUTH_COOKIE_NAME, getCookieOptions(req));
    clearAnonymousBridgeCookies(req, res);
    res.json({ ok: true });
  });

  return router;
}

export default createAuthRouter();
