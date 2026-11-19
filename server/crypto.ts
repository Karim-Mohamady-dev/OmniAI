import crypto from 'crypto';
import { isPlaceholderOrWeakSecret, isWeakEncryptionSecret } from './config/envValidator.ts';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

let ephemeralKey: Buffer | null = null;

function resolveValidConfiguredMasterSecret(): string | null {
  const master = process.env.OMNIAI_MASTER_KEY?.trim() || process.env.SESSION_SECRET?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (!master) return null;
  if (geminiKey && !isPlaceholderOrWeakSecret(geminiKey) && master === geminiKey) {
    return null;
  }
  const check = isWeakEncryptionSecret(master);
  if (check.weak) return null;
  return master;
}

export function isMasterEncryptionKeyConfigured(): boolean {
  return resolveValidConfiguredMasterSecret() !== null;
}

export function getCryptoStatus(): {
  configured: boolean;
  source: 'env_master_key' | 'ephemeral_dev';
  productionSafe: boolean;
} {
  if (resolveValidConfiguredMasterSecret() !== null) {
    return { configured: true, source: 'env_master_key', productionSafe: true };
  }
  return {
    configured: false,
    source: 'ephemeral_dev',
    productionSafe: process.env.NODE_ENV !== 'production',
  };
}

function getEncryptionKey(): Buffer {
  // Strictly separate master encryption key from external AI provider API keys (never use GEMINI_API_KEY).
  const secret = resolveValidConfiguredMasterSecret();
  if (secret) {
    return crypto.createHash('sha256').update(secret).digest();
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Server encryption key is invalid or unconfigured for production. Set a non-placeholder OMNIAI_MASTER_KEY (or SESSION_SECRET) with >= 16 characters and never reuse GEMINI_API_KEY.'
    );
  }

  if (!ephemeralKey) {
    ephemeralKey = crypto.randomBytes(32);
  }
  return ephemeralKey;
}

export function encryptString(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${authTag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptString(ciphertext: string): string | null {
  try {
    const parts = ciphertext.split('.');
    if (parts.length !== 3) return null;
    const [ivB64, tagB64, dataB64] = parts;
    const key = getEncryptionKey();
    const iv = Buffer.from(ivB64, 'base64url');
    const authTag = Buffer.from(tagB64, 'base64url');
    const data = Buffer.from(dataB64, 'base64url');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}
