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
  const clean = (baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const check = validateExternalModelUrl(clean);
  if (!check.valid) {
    throw new AdapterCallError(
      classifyHttpError(400, check.reason || 'Blocked unsafe endpoint URL.')
    );
  }
  if (clean.endsWith('/chat/completions')) return clean;
  return `${clean}/chat/completions`;
}

function supportsStreamIncludeUsage(endpoint: string): boolean {
  const lower = endpoint.toLowerCase();
  return (
    lower.includes('api.openai.com') ||
    lower.includes('openrouter.ai') ||
    lower.includes('api.groq.com') ||
    lower.includes('api.deepseek.com') ||
    lower.includes('api.together.xyz')
  );
}

function buildMessages(messages: ChatMessageInput[], systemInstruction?: string) {
  const out: Array<{ role: string; content: unknown }> = [];
  if (systemInstruction && systemInstruction.trim()) {
    out.push({ role: 'system', content: systemInstruction.trim() });
  }
  for (const msg of messages) {
    const hasImages = msg.attachments?.some((a) => a.mimeType.startsWith('image/') && a.dataBase64);
    const textAttachments = (msg.attachments || [])
      .filter((a) => a.textContent)
      .map((a) => `\n[Attached File: ${a.name}]\n\`\`\`\n${a.textContent}\n\`\`\``)
      .join('\n');

    const fullText = [msg.content, textAttachments].filter(Boolean).join('\n');

    if (hasImages && msg.role === 'user') {
      const parts: Array<Record<string, unknown>> = [];
      if (fullText) {
        parts.push({ type: 'text', text: fullText });
      }
      for (const att of msg.attachments || []) {
        if (att.mimeType.startsWith('image/') && att.dataBase64) {
          parts.push({
            type: 'image_url',
            image_url: {
              url: `data:${att.mimeType};base64,${att.dataBase64}`,
            },
          });
        }
      }
      out.push({ role: msg.role, content: parts });
    } else {
      out.push({ role: msg.role, content: fullText || '' });
    }
  }
  return out;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly protocol = 'openai-compatible' as const;

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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const endpoint = resolveEndpoint(model.baseUrl);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey.trim()}` } : {}),
        ...((model.customConfig?.headers as Record<string, string>) || {}),
        ...(model.customHeaders || {}),
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: model.modelId.trim(),
          messages: [{ role: 'user', content: 'Reply with OK' }],
          max_tokens: 5,
          stream: false,
        }),
      });

      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        let errMsg = bodyText;
        try {
          const parsed = JSON.parse(bodyText);
          errMsg = parsed?.error?.message || parsed?.message || bodyText;
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

    const { signal: mergedSignal, cleanup, didTimeout } = combineAbortSignals(signal, timeoutMs);
    try {
      const endpoint = resolveEndpoint(model.baseUrl);
      const customHeaders = {
        ...((model.customConfig?.headers as Record<string, string>) || {}),
        ...(model.customHeaders || {}),
      };
      const customParams = (model.customConfig?.parameters as Record<string, unknown>) || {};

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey.trim()}` } : {}),
        ...customHeaders,
      };

      const bodyPayload: Record<string, unknown> = {
        model: model.modelId.trim(),
        messages: buildMessages(messages, systemInstruction),
        stream: true,
        ...(supportsStreamIncludeUsage(endpoint) && customParams.stream_options === undefined
          ? { stream_options: { include_usage: true } }
          : {}),
        ...(typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0
          ? { max_tokens: model.maxOutputTokens }
          : {}),
        ...customParams,
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        signal: mergedSignal,
        body: JSON.stringify(bodyPayload),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        let errMsg = errText;
        try {
          const parsed = JSON.parse(errText);
          errMsg = parsed?.error?.message || parsed?.message || errText;
        } catch {
          // keep raw
        }
        const safeMsg = sanitizeSecretFromText(errMsg || `HTTP ${res.status}`, [model.apiKey]);
        throw new AdapterCallError(classifyHttpError(res.status, safeMsg));
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream') && res.body) {
        const rawText = await res.text();
        try {
          const json = JSON.parse(rawText);
          if (json?.error) {
            const safeMsg = sanitizeSecretFromText(
              json.error?.message || JSON.stringify(json.error),
              [model.apiKey]
            );
            throw new AdapterCallError(classifyHttpError(json.error?.status || 500, safeMsg));
          }
          const content = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || '';
          const usage = json?.usage;
          if (content) {
            yield {
              delta: content,
              ...(usage
                ? {
                    usage: {
                      inputTokens: usage.prompt_tokens,
                      outputTokens: usage.completion_tokens,
                      totalTokens: usage.total_tokens,
                    },
                  }
                : {}),
            };
          }
          return;
        } catch (parseOrAdapterErr) {
          if (parseOrAdapterErr instanceof AdapterCallError) {
            throw parseOrAdapterErr;
          }
        }
      }

      if (!res.body) {
        throw new AdapterCallError(classifyHttpError(500, 'Empty response stream from provider.'));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;

          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            // Ignore malformed partial SSE JSON
            continue;
          }

          if (parsed?.error) {
            const errObj = parsed.error as { message?: string; code?: string; status?: number };
            const safeMsg = sanitizeSecretFromText(
              errObj?.message || errObj?.code || JSON.stringify(parsed.error),
              [model.apiKey]
            );
            throw new AdapterCallError(
              classifyHttpError(typeof errObj?.status === 'number' ? errObj.status : undefined, safeMsg)
            );
          }

          const choices = parsed?.choices as
            | Array<{ delta?: { content?: string }; finish_reason?: string }>
            | undefined;
          const delta = choices?.[0]?.delta?.content;
          const finishReason = choices?.[0]?.finish_reason;
          const usage = parsed?.usage as
            | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
            | undefined;

          if (delta || usage || finishReason) {
            yield {
              ...(typeof delta === 'string' && delta.length > 0 ? { delta } : {}),
              ...(finishReason ? { finishReason } : {}),
              ...(usage
                ? {
                    usage: {
                      inputTokens: usage.prompt_tokens,
                      outputTokens: usage.completion_tokens,
                      totalTokens: usage.total_tokens,
                    },
                  }
                : {}),
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
