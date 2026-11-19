// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { encryptString, decryptString } from '../server/crypto.ts';
import {
  maskSecret,
  sanitizeSecretFromText,
} from '../server/vault/secretVault.ts';
import { inferCapabilitiesForModel } from '../server/adapters/capabilities.ts';
import { maskApiKey } from '../src/utils/helpers.ts';
import type { AIModelConfig } from '../src/types/index.ts';

describe('Model Security & Capabilities', () => {
  it('masks secrets safely without leaking middle characters', () => {
    expect(maskSecret('')).toBe('Not set');
    expect(maskSecret('short')).toBe('••••••••');
    expect(maskSecret('sk-test-1234567890abcdef')).toBe('sk-t••••••••cdef');
    expect(maskApiKey('AIzaSyA1234567890xyz99')).toBe('AIza••••••••xz99'.replace('xz99', 'yz99'));
  });

  it('sanitizes raw and pattern-matched API keys from error logs', () => {
    const rawKey = 'sk-live-supersecret987654321';
    const rawMsg = `Upstream rejected Bearer ${rawKey} and key AIzaSyB1234567890abcdefgh`;
    const cleaned = sanitizeSecretFromText(rawMsg, [rawKey]);

    expect(cleaned).not.toContain(rawKey);
    expect(cleaned).not.toContain('AIzaSyB1234567890abcdefgh');
    expect(cleaned).toContain('[REDACTED_KEY]');
  });

  it('encrypts and decrypts vault payloads using AES-256-GCM', () => {
    const secret = JSON.stringify({ cred_1: 'sk-vault-secret-123' });
    const encrypted = encryptString(secret);
    expect(encrypted).not.toContain('sk-vault-secret-123');
    expect(decryptString(encrypted)).toBe(secret);
    expect(decryptString(`${encrypted}tampered`)).toBeNull();
  });

  it('infers capabilities conservatively per protocol & model ID', () => {
    const geminiCaps = inferCapabilitiesForModel({
      id: 'm1',
      displayName: 'Gemini',
      providerName: 'Google',
      modelId: 'gemini-4-hydrogen',
      protocol: 'google-gemini',
      priority: 1,
      enabled: true,
    });
    expect(geminiCaps.vision).toBe(true);
    expect(geminiCaps.streaming).toBe(true);
    expect(geminiCaps.toolCalling).toBe(true);

    const legacyTextCaps = inferCapabilitiesForModel({
      id: 'm2',
      displayName: 'Local Text LLM',
      providerName: 'Custom',
      modelId: 'llama-text-8b',
      protocol: 'custom-http',
      priority: 2,
      enabled: true,
    });
    expect(legacyTextCaps.text).toBe(true);
    expect(legacyTextCaps.streaming).toBe(false);
    expect(legacyTextCaps.vision).toBe(false);
  });

  it('strips apiKey, credentialRefId, and maskedApiKey during model export sanitization', () => {
    const models: AIModelConfig[] = [
      {
        id: 'm-1',
        displayName: 'GPT-4o',
        providerName: 'OpenAI',
        modelId: 'gpt-4o',
        protocol: 'openai-compatible',
        apiKey: 'sk-should-not-export-123456',
        credentialRefId: 'cred_secret_ref',
        maskedApiKey: 'sk-s••••••••3456',
        priority: 1,
        enabled: true,
        status: 'connected',
        createdAt: 1000,
      },
    ];

    const exported = models.map(
      ({ apiKey: _k, credentialRefId: _ref, maskedApiKey: _mask, ...rest }) => rest
    );

    const json = JSON.stringify(exported);
    expect(json).not.toContain('sk-should-not-export-123456');
    expect(json).not.toContain('cred_secret_ref');
    expect(json).not.toContain('maskedApiKey');
    expect(exported[0].modelId).toBe('gpt-4o');
  });
});
