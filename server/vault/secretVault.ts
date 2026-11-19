import crypto from 'crypto';
import type { Request, Response } from 'express';
import { decryptString, encryptString, isMasterEncryptionKeyConfigured } from '../crypto.ts';
import { getActiveStore } from '../db/index.ts';
import { getCookieOptions } from '../routes/auth.ts';

const VAULT_COOKIE_NAME = 'omniai_key_vault';
const ANON_VAULT_ID_COOKIE = 'omniai_anon_vault';

type VaultMap = Record<string, string>;

const scopedAnonMemoryVault = new Map<string, Map<string, string>>();

function assertCryptoReadyForVault(): void {
  if (process.env.NODE_ENV === 'production' && !isMasterEncryptionKeyConfigured()) {
    throw new Error(
      'Server master encryption key is not configured for production credential storage. Set OMNIAI_MASTER_KEY or SESSION_SECRET.'
    );
  }
}

function getOrCreateAnonVaultId(req: Request, res?: Response): string | null {
  const raw = req.cookies?.[ANON_VAULT_ID_COOKIE];
  if (raw && typeof raw === 'string') {
    const dec = decryptString(raw);
    if (dec && /^[a-f0-9]{24,64}$/i.test(dec)) {
      return dec;
    }
  }
  if (!res) return null;
  const newId = crypto.randomBytes(16).toString('hex');
  res.cookie(ANON_VAULT_ID_COOKIE, encryptString(newId), getCookieOptions(req, 30 * 24 * 60 * 60 * 1000));
  return newId;
}

export function maskSecret(secret?: string): string {
  if (!secret || secret.trim().length === 0) return 'Not set';
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
}

export function sanitizeSecretFromText(
  text: string,
  candidateSecrets: Array<string | undefined> = []
): string {
  let clean = text;
  for (const s of candidateSecrets) {
    if (s && s.trim().length >= 6) {
      clean = clean.split(s.trim()).join('[REDACTED_KEY]');
    }
  }
  clean = clean.replace(
    /\b(sk-ant-[a-zA-Z0-9_-]{8,}|sk-[a-zA-Z0-9_-]{10,}|AIza[0-9A-Za-z_-]{15,}|ghp_[a-zA-Z0-9]{15,}|gho_[a-zA-Z0-9]{15,}|ghu_[a-zA-Z0-9]{15,}|ghs_[a-zA-Z0-9]{15,})\b/g,
    '[REDACTED_KEY]'
  );
  clean = clean.replace(
    /(Bearer\s+)[a-zA-Z0-9._~+/=-]{12,}/gi,
    '$1[REDACTED_KEY]'
  );
  clean = clean.replace(
    /((?:postgres(?:ql)?|mysql|redis|https?):\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi,
    '$1[REDACTED]$3'
  );
  return clean;
}

export function readVaultFromRequest(req: Request): VaultMap {
  const rawCookie = req.cookies?.[VAULT_COOKIE_NAME];
  if (!rawCookie || typeof rawCookie !== 'string') return {};
  const decrypted = decryptString(rawCookie);
  if (!decrypted) return {};
  try {
    const parsed = JSON.parse(decrypted) as VaultMap;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function writeVaultCookie(req: Request, res: Response, vault: VaultMap): void {
  const serialized = JSON.stringify(vault);
  const encrypted = encryptString(serialized);
  if (Buffer.byteLength(encrypted, 'utf8') <= 3600) {
    res.cookie(VAULT_COOKIE_NAME, encrypted, getCookieOptions(req, 30 * 24 * 60 * 60 * 1000));
  }
}

export async function listVaultCredentialsForRequest(
  req: Request
): Promise<Array<{ refId: string; maskedKey: string }>> {
  if (req.authUser?.id) {
    return getActiveStore().listUserSecretRefs(req.authUser.id);
  }
  const combined: Record<string, string> = {};
  const anonId = getOrCreateAnonVaultId(req);
  if (anonId) {
    const mem = scopedAnonMemoryVault.get(anonId);
    if (mem) {
      for (const [k, v] of mem.entries()) combined[k] = v;
    }
  }
  const cookieVault = readVaultFromRequest(req);
  for (const [k, v] of Object.entries(cookieVault)) {
    combined[k] = v;
  }
  return Object.entries(combined).map(([refId, secret]) => ({
    refId,
    maskedKey: maskSecret(secret),
  }));
}

export async function storeSecretInVault(
  req: Request,
  res: Response,
  refId: string | undefined,
  apiKey: string,
  providerName?: string
): Promise<{ refId: string; maskedKey: string }> {
  assertCryptoReadyForVault();
  const id =
    refId && refId.trim() ? refId.trim() : `cred_${crypto.randomBytes(8).toString('hex')}`;
  const trimmed = apiKey.trim();

  if (req.authUser?.id) {
    await getActiveStore().setUserSecret(req.authUser.id, id, trimmed, providerName);
    return {
      refId: id,
      maskedKey: maskSecret(trimmed),
    };
  }

  const anonId = getOrCreateAnonVaultId(req, res)!;
  let mem = scopedAnonMemoryVault.get(anonId);
  if (!mem) {
    mem = new Map<string, string>();
    scopedAnonMemoryVault.set(anonId, mem);
  }
  mem.set(id, trimmed);

  const currentVault = readVaultFromRequest(req);
  currentVault[id] = trimmed;
  writeVaultCookie(req, res, currentVault);

  return {
    refId: id,
    maskedKey: maskSecret(trimmed),
  };
}

export async function removeSecretFromVault(
  req: Request,
  res: Response,
  refId: string
): Promise<void> {
  if (req.authUser?.id) {
    await getActiveStore().deleteUserSecret(req.authUser.id, refId);
    return;
  }

  const anonId = getOrCreateAnonVaultId(req);
  if (anonId) {
    scopedAnonMemoryVault.get(anonId)?.delete(refId);
  }
  const currentVault = readVaultFromRequest(req);
  if (refId in currentVault) {
    delete currentVault[refId];
    writeVaultCookie(req, res, currentVault);
  }
}

export async function resolveSecretForModel(
  req: Request,
  credentialRefId?: string,
  inlineApiKey?: string
): Promise<string | undefined> {
  if (credentialRefId) {
    if (req.authUser?.id) {
      return getActiveStore().getUserSecret(req.authUser.id, credentialRefId);
    }

    const vault = readVaultFromRequest(req);
    if (vault[credentialRefId]) return vault[credentialRefId];

    const anonId = getOrCreateAnonVaultId(req);
    if (anonId) {
      const mem = scopedAnonMemoryVault.get(anonId);
      if (mem?.has(credentialRefId)) return mem.get(credentialRefId);
    }
  }
  return inlineApiKey?.trim() || undefined;
}
