import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import net from 'net';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export function structuredRequestLogger(req: Request, res: Response, next: NextFunction) {
  const incomingId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].trim() : '';
  const safeRequestId =
    incomingId && /^[a-zA-Z0-9_-]{4,64}$/.test(incomingId)
      ? incomingId
      : `req_${crypto.randomBytes(8).toString('hex')}`;
  req.requestId = safeRequestId;
  res.setHeader('X-Request-Id', safeRequestId);

  const started = Date.now();
  res.on('finish', () => {
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/auth/')) return;
    const logEntry = {
      ts: new Date().toISOString(),
      requestId: safeRequestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - started,
      ip: req.ip || 'unknown',
    };
    console.log(JSON.stringify(logEntry));
  });
  next();
}

export function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=()');
  next();
}

function isTrustedDefaultOrigin(origin: string, req: Request): boolean {
  try {
    const parsed = new URL(origin);
    const reqHost = (req.headers.host || '').toLowerCase();
    if (reqHost && parsed.host.toLowerCase() === reqHost) {
      return true;
    }
    const appUrl = process.env.APP_URL?.trim();
    if (appUrl && appUrl !== 'MY_APP_URL') {
      try {
        if (new URL(appUrl).origin === parsed.origin) return true;
      } catch {
        // ignore invalid APP_URL
      }
    }
    if (
      process.env.NODE_ENV !== 'production' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const allowedRaw = process.env.ALLOWED_ORIGINS?.trim();
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Vary', 'Origin');
    if (!allowedRaw) {
      if (isTrustedDefaultOrigin(origin, req)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    } else {
      const allowed = allowedRaw.split(',').map((s) => s.trim()).filter(Boolean);
      if (allowed.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      } else if (allowed.includes('*')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

export function createRateLimiter(options: { windowMs: number; maxRequests: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, val] of hits.entries()) {
      if (val.resetAt <= now) hits.delete(key);
    }
  }, options.windowMs);
  cleanupTimer.unref?.();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'global';
    const now = Date.now();
    const existing = hits.get(key);

    if (!existing || existing.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (existing.count >= options.maxRequests) {
      const retryAfterSec = Math.ceil((existing.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: `Too many requests. Please wait ${retryAfterSec}s before retrying.`,
      });
      return;
    }

    existing.count += 1;
    next();
  };
}

function normalizeIpv4MappedIpv6(cleanIp: string): string {
  // Handle dotted ::ffff:127.0.0.1
  if (cleanIp.startsWith('::ffff:')) {
    const rest = cleanIp.slice('::ffff:'.length);
    if (net.isIPv4(rest)) return rest;
    // Handle Node URL normalized hex form e.g. ::ffff:7f00:1 or ::ffff:a9fe:a9fe
    const hexMatch = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMatch) {
      const hi = parseInt(hexMatch[1], 16);
      const lo = parseInt(hexMatch[2], 16);
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return cleanIp;
}

function isPrivateOrMetadataIp(ip: string): { blocked: boolean; isLoopback: boolean; reason?: string } {
  const rawClean = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const clean = normalizeIpv4MappedIpv6(rawClean);

  if (clean === '::1' || clean === '127.0.0.1' || clean.startsWith('127.')) {
    return { blocked: true, isLoopback: true, reason: 'Loopback address' };
  }

  if (clean === '0.0.0.0' || clean === '::' || clean.startsWith('0.')) {
    return { blocked: true, isLoopback: false, reason: 'Unspecified bind address is blocked' };
  }

  if (clean.startsWith('169.254.') || clean.startsWith('fe80:')) {
    return { blocked: true, isLoopback: false, reason: 'Cloud metadata / link-local IP is blocked' };
  }

  if (net.isIPv4(clean)) {
    const [a, b] = clean.split('.').map(Number);
    if (a === 10) return { blocked: true, isLoopback: false, reason: 'Private 10.0.0.0/8 network is blocked' };
    if (a === 172 && b >= 16 && b <= 31) {
      return { blocked: true, isLoopback: false, reason: 'Private 172.16.0.0/12 network is blocked' };
    }
    if (a === 192 && b === 168) {
      return { blocked: true, isLoopback: false, reason: 'Private 192.168.0.0/16 network is blocked' };
    }
    if (a === 100 && b >= 64 && b <= 127) {
      return { blocked: true, isLoopback: false, reason: 'Carrier-grade NAT range is blocked' };
    }
  }

  if (clean.startsWith('fc') || clean.startsWith('fd')) {
    return { blocked: true, isLoopback: false, reason: 'Unique-local IPv6 address is blocked' };
  }

  return { blocked: false, isLoopback: false };
}

export function validateExternalModelUrl(
  rawUrl: string | undefined,
  options?: { allowLocalhost?: boolean }
): { valid: boolean; normalizedUrl?: string; reason?: string } {
  if (!rawUrl || !rawUrl.trim()) {
    return { valid: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, reason: 'Invalid endpoint URL format.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: `Unsupported URL protocol "${parsed.protocol}". Only http/https allowed.` };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, reason: 'Embedded credentials in endpoint URLs are not allowed.' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname === 'metadata.google.internal' ||
    hostname === 'metadata.goog' ||
    hostname.endsWith('.internal')
  ) {
    return { valid: false, reason: 'Internal cloud metadata hostnames are strictly blocked (SSRF protection).' };
  }

  const allowLocal =
    options?.allowLocalhost ??
    (process.env.NODE_ENV === 'production'
      ? process.env.ALLOW_LOCAL_MODEL_URLS === 'true'
      : process.env.ALLOW_LOCAL_MODEL_URLS !== 'false');

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    if (!allowLocal) {
      return {
        valid: false,
        reason: 'Localhost model endpoints are disabled in this hosted deployment (SSRF policy).',
      };
    }
    return { valid: true, normalizedUrl: parsed.toString() };
  }

  if (net.isIP(hostname.replace(/^\[|\]$/g, ''))) {
    const check = isPrivateOrMetadataIp(hostname);
    if (check.blocked) {
      if (check.isLoopback && allowLocal) {
        return { valid: true, normalizedUrl: parsed.toString() };
      }
      return {
        valid: false,
        reason: `${check.reason || 'Internal network address'} (SSRF security policy).`,
      };
    }
  }

  return { valid: true, normalizedUrl: parsed.toString() };
}
