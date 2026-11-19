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

function resolveEndpoint(baseUrl?: string): string {
  const clean = (baseUrl || 'https://api.anthropic.com').trim().replace(/\/+$/, '');
  const check = validateExternalModelUrl(clean);
  if (!check.valid) {
    throw new AdapterCallError(
      classifyHttpError(400, check.reason || 'Blocked unsafe endpoint URL.')
    );
  }
  if (clean.endsWith('/v1/messages')) return clean;
  if (clean.endsWith('/v1')) return `${clean}/messages`;
  return `${clean}/v1/messages`;
}

function buildAnthropicMessages(messages: ChatMessageInput[]) {
  return messages
    .filter((m) => m.role !== 'system')
    .map((msg) => {
      const blocks: Array<Record<string, unknown>> = [];
      for (const att of msg.attachments || []) {
        if (att.mimeType.startsWith('image/') && att.dataBase64) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: att.mimeType,
              data: att.dataBase64,
            },
          });
        } else if (att.textContent) {
          blocks.push({
            type: 'text',
            text: `\n[Attached File: ${att.name}]\n\`\`\`\n${att.textContent}\n\`\`\``,
          });
        }
      }
      if (msg.content) {
        blocks.push({ type: 'text', text: msg.content });
      }
      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: ' ' });
      }
      return {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: blocks,
      };
    });
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly protocol = 'anthropic' as const;

  async testConnection(model: ServerModelConfig, timeoutMs: number): Promise<ConnectionTestResult> {
    const started = Date.now();
    const idCheck = validateModelConfigId(model);
    if (!idCheck.valid) {
      return {
        ok: false,
        latencyMs: 0,
        message: idCheck.reason || 'Invalid Anthropic modelId.',
        errorKind: 'BAD_REQUEST',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (!model.apiKey?.trim()) {
        return {
          ok: false,
          latencyMs: 0,
          message: 'API key is required for Anthropic models.',
          errorKind: 'AUTH_ERROR',
        };
      }

      const res = await fetch(resolveEndpoint(model.baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': model.apiKey.trim(),
          'anthropic-version': '2023-06-01',
          ...((model.customConfig?.headers as Record<string, string>) || {}),
          ...(model.customHeaders || {}),
        },
        body: JSON.stringify({
          model: model.modelId.trim(),
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply OK' }],
        }),
      });

      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let errMsg = text;
        try {
          const parsed = JSON.parse(text);
          errMsg = parsed?.error?.message || text;
        } catch {
          // keep text
        }
        const safeMsg = sanitizeSecretFromText(errMsg || `HTTP ${res.status}`, [model.apiKey]);
        const classified = classifyHttpError(res.status, safeMsg);
        return {
          ok: false,
          latencyMs,
          message: classified.message,
          errorKind: classified.kind,
        };
      }

      const data = (await res.json().catch(() => ({}))) as { model?: string };
      return {
        ok: true,
        latencyMs,
        message: `Connected (${latencyMs}ms)`,
        modelReported: data.model || model.modelId.trim(),
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

    if (!model.apiKey?.trim()) {
      throw new AdapterCallError(classifyHttpError(401, 'Missing API key for Anthropic model.'));
    }

    const { signal: mergedSignal, cleanup, didTimeout } = combineAbortSignals(signal, timeoutMs);
    try {
      const systemParts = [
        systemInstruction,
        ...messages.filter((m) => m.role === 'system').map((m) => m.content),
      ]
        .filter(Boolean)
        .join('\n\n');

      const maxTokens =
        typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0
          ? model.maxOutputTokens
          : typeof model.customConfig?.maxTokens === 'number'
            ? model.customConfig.maxTokens
            : 4096;

      const res = await fetch(resolveEndpoint(model.baseUrl), {
        method: 'POST',
        signal: mergedSignal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': model.apiKey.trim(),
          'anthropic-version': '2023-06-01',
          ...((model.customConfig?.headers as Record<string, string>) || {}),
          ...(model.customHeaders || {}),
        },
        body: JSON.stringify({
          model: model.modelId.trim(),
          max_tokens: maxTokens,
          stream: true,
          ...(systemParts ? { system: systemParts } : {}),
          messages: buildAnthropicMessages(messages),
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let errMsg = errText;
        try {
          const parsed = JSON.parse(errText);
          errMsg = parsed?.error?.message || errText;
        } catch {
          // raw
        }
        const safeMsg = sanitizeSecretFromText(errMsg || `HTTP ${res.status}`, [model.apiKey]);
        throw new AdapterCallError(classifyHttpError(res.status, safeMsg));
      }

      if (!res.body) {
        throw new AdapterCallError(classifyHttpError(500, 'Empty stream from Anthropic API.'));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let inputTokens: number | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (parsed.type === 'error' || parsed.error) {
            const errObj = parsed.error as { message?: string; type?: string } | undefined;
            const safeMsg = sanitizeSecretFromText(
              errObj?.message || errObj?.type || 'Anthropic streaming error',
              [model.apiKey]
            );
            throw new AdapterCallError(classifyHttpError(undefined, safeMsg));
          }

          const messageObj = parsed.message as { usage?: { input_tokens?: number } } | undefined;
          const deltaObj = parsed.delta as { text?: string; stop_reason?: string } | undefined;
          const usageObj = parsed.usage as { output_tokens?: number } | undefined;

          if (parsed.type === 'message_start' && messageObj?.usage?.input_tokens) {
            inputTokens = messageObj.usage.input_tokens;
          } else if (parsed.type === 'content_block_delta' && deltaObj?.text) {
            yield { delta: deltaObj.text };
          } else if (parsed.type === 'message_delta' && usageObj) {
            const outputTokens = usageObj.output_tokens;
            yield {
              usage: {
                inputTokens,
                outputTokens,
                totalTokens:
                  typeof inputTokens === 'number' && typeof outputTokens === 'number'
                    ? inputTokens + outputTokens
                    : undefined,
              },
              finishReason: deltaObj?.stop_reason,
            };
          }
        }
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
