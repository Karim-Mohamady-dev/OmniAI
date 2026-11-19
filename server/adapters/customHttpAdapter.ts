import { validateExternalModelUrl } from '../middleware/security.ts';
import type {
  AdapterStreamChunk,
  ChatMessageInput,
  ConnectionTestResult,
  ServerModelConfig,
} from '../types.ts';
import { sanitizeSecretFromText } from '../vault/secretVault.ts';
import {
  AdapterCallError,
  classifyHttpError,
  combineAbortSignals,
  validateModelConfigId,
  type ProviderAdapter,
} from './base.ts';

function readByPath(obj: unknown, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export class CustomHttpAdapter implements ProviderAdapter {
  readonly protocol = 'custom-http' as const;

  async testConnection(model: ServerModelConfig, timeoutMs: number): Promise<ConnectionTestResult> {
    const started = Date.now();
    const idCheck = validateModelConfigId(model);
    if (!idCheck.valid) {
      return {
        ok: false,
        latencyMs: 0,
        message: idCheck.reason || 'Invalid modelId.',
        errorKind: 'BAD_REQUEST',
      };
    }

    if (!model.baseUrl?.trim()) {
      return {
        ok: false,
        latencyMs: 0,
        message: 'API Base URL is required for Custom HTTP adapters.',
        errorKind: 'BAD_REQUEST',
      };
    }

    const urlCheck = validateExternalModelUrl(model.baseUrl.trim());
    if (!urlCheck.valid) {
      return {
        ok: false,
        latencyMs: 0,
        message: urlCheck.reason || 'Endpoint URL blocked by SSRF policy.',
        errorKind: 'BAD_REQUEST',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey.trim()}` } : {}),
        ...((model.customConfig?.headers as Record<string, string>) || {}),
        ...(model.customHeaders || {}),
      };

      const res = await fetch(model.baseUrl.trim(), {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: model.modelId.trim(),
          messages: [{ role: 'user', content: 'Reply OK' }],
          prompt: 'Reply OK',
        }),
      });

      const latencyMs = Date.now() - started;
      const bodyText = await res.text().catch(() => '');
      if (!res.ok) {
        const safeMsg = sanitizeSecretFromText(bodyText || `HTTP ${res.status}`, [model.apiKey]);
        const classified = classifyHttpError(res.status, safeMsg);
        return {
          ok: false,
          latencyMs,
          message: classified.message,
          errorKind: classified.kind,
        };
      }
      if (bodyText.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(bodyText) as { error?: unknown };
          if (parsed?.error) {
            const errObj = parsed.error as { message?: string };
            const rawErr =
              typeof parsed.error === 'string'
                ? parsed.error
                : errObj?.message || JSON.stringify(parsed.error);
            const safeMsg = sanitizeSecretFromText(rawErr, [model.apiKey]);
            const classified = classifyHttpError(500, safeMsg);
            return {
              ok: false,
              latencyMs,
              message: classified.message,
              errorKind: classified.kind,
            };
          }
        } catch {
          // ignore non-JSON payload
        }
      }
      return {
        ok: true,
        latencyMs,
        message: `Connected (${latencyMs}ms)`,
        modelReported: model.modelId.trim(),
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const msg = sanitizeSecretFromText(err instanceof Error ? err.message : String(err), [
        model.apiKey,
      ]);
      const classified = classifyHttpError(undefined, msg);
      return {
        ok: false,
        latencyMs,
        message: classified.message,
        errorKind: classified.kind,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async *streamChat({
    model,
    messages,
    systemInstruction,
    signal,
    timeoutMs,
  }: {
    model: ServerModelConfig;
    messages: ChatMessageInput[];
    systemInstruction?: string;
    signal: AbortSignal;
    timeoutMs: number;
  }): AsyncGenerator<AdapterStreamChunk, void, unknown> {
    const idCheck = validateModelConfigId(model);
    if (!idCheck.valid) {
      throw new AdapterCallError(classifyHttpError(400, idCheck.reason || 'Invalid modelId.'));
    }

    if (!model.baseUrl?.trim()) {
      throw new AdapterCallError(
        classifyHttpError(400, 'API Base URL is missing for custom HTTP endpoint.')
      );
    }
    const urlCheck = validateExternalModelUrl(model.baseUrl.trim());
    if (!urlCheck.valid) {
      throw new AdapterCallError(
        classifyHttpError(400, urlCheck.reason || 'Endpoint URL blocked by SSRF policy.')
      );
    }

    const { signal: mergedSignal, cleanup, didTimeout } = combineAbortSignals(signal, timeoutMs);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey.trim()}` } : {}),
        ...((model.customConfig?.headers as Record<string, string>) || {}),
        ...(model.customHeaders || {}),
      };

      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
      const payload = {
        model: model.modelId.trim(),
        system: systemInstruction,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        prompt: lastUserMsg,
        ...(typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0
          ? { max_tokens: model.maxOutputTokens }
          : {}),
        ...((model.customConfig?.parameters as Record<string, unknown>) || {}),
      };

      const res = await fetch(model.baseUrl.trim(), {
        method: 'POST',
        headers,
        signal: mergedSignal,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const safeMsg = sanitizeSecretFromText(text || `HTTP ${res.status}`, [model.apiKey]);
        throw new AdapterCallError(classifyHttpError(res.status, safeMsg));
      }

      const textBody = await res.text();
      let outputText = textBody;
      try {
        const json = JSON.parse(textBody) as Record<string, unknown>;
        if (json?.error) {
          const errObj = json.error as { message?: string };
          const safeMsg = sanitizeSecretFromText(
            errObj?.message || JSON.stringify(json.error),
            [model.apiKey]
          );
          throw new AdapterCallError(classifyHttpError(500, safeMsg));
        }
        const customPath =
          typeof model.customConfig?.responsePath === 'string'
            ? model.customConfig.responsePath
            : '';
        const extracted =
          (customPath ? readByPath(json, customPath) : undefined) ??
          readByPath(json, 'choices.0.message.content') ??
          readByPath(json, 'content.0.text') ??
          json?.response ??
          json?.output ??
          json?.text;
        if (typeof extracted === 'string') {
          outputText = extracted;
        }
      } catch (err) {
        if (err instanceof AdapterCallError) throw err;
        // plain text response
      }

      if (outputText) {
        yield { delta: outputText };
      }
    } catch (err) {
      if (signal.aborted && !didTimeout()) return;
      if (didTimeout()) {
        throw new AdapterCallError(
          classifyHttpError(undefined, `Request timed out after ${timeoutMs}ms`)
        );
      }
      if (err instanceof AdapterCallError) throw err;
      const msg = sanitizeSecretFromText(err instanceof Error ? err.message : String(err), [
        model.apiKey,
      ]);
      throw new AdapterCallError(classifyHttpError(undefined, msg));
    } finally {
      cleanup();
    }
  }
}
