import { GoogleGenAI, type Content, type Part } from '@google/genai';
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

function resolveGeminiKey(model: ServerModelConfig): string {
  const key = model.useServerEnvKey ? process.env.GEMINI_API_KEY : model.apiKey;
  if (!key || !key.trim()) {
    throw new AdapterCallError({
      kind: 'AUTH_ERROR',
      retryable: false,
      switchModel: true,
      statusCode: 401,
      message: model.useServerEnvKey
        ? 'Server GEMINI_API_KEY environment variable is not configured.'
        : 'API key is missing for this Gemini model configuration.',
    });
  }
  return key.trim();
}

function createGeminiClient(model: ServerModelConfig): GoogleGenAI {
  const idCheck = validateModelConfigId(model);
  if (!idCheck.valid) {
    throw new AdapterCallError(classifyHttpError(400, idCheck.reason || 'Invalid Gemini modelId.'));
  }

  const apiKey = resolveGeminiKey(model);
  const baseUrl = model.baseUrl?.trim();
  if (baseUrl) {
    const check = validateExternalModelUrl(baseUrl);
    if (!check.valid) {
      throw new AdapterCallError(
        classifyHttpError(400, check.reason || 'Blocked unsafe Gemini baseUrl override.')
      );
    }
  }
  const customHeaders = {
    ...((model.customConfig?.headers as Record<string, string>) || {}),
    ...(model.customHeaders || {}),
  };
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      ...(baseUrl ? { baseUrl } : {}),
      headers: {
        ...customHeaders,
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function mapMessagesToGeminiContents(messages: ChatMessageInput[]): Content[] {
  const contents: Content[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const parts: Part[] = [];
    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        if (att.mimeType.startsWith('image/') && att.dataBase64) {
          parts.push({
            inlineData: {
              mimeType: att.mimeType,
              data: att.dataBase64,
            },
          });
        } else if (att.textContent) {
          parts.push({
            text: `\n[Attached File: ${att.name}]\n\`\`\`\n${att.textContent}\n\`\`\`\n`,
          });
        } else if (
          att.dataBase64 &&
          (att.mimeType === 'application/pdf' || att.mimeType.startsWith('audio/'))
        ) {
          parts.push({
            inlineData: {
              mimeType: att.mimeType,
              data: att.dataBase64,
            },
          });
        }
      }
    }
    if (msg.content && msg.content.trim().length > 0) {
      parts.push({ text: msg.content });
    }
    if (parts.length > 0) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }
  }
  return contents;
}

function extractGeminiError(err: unknown, apiKey?: string): { status?: number; message: string } {
  if (err instanceof AdapterCallError) {
    return {
      status: err.classified.statusCode,
      message: sanitizeSecretFromText(err.message, [apiKey]),
    };
  }
  const anyErr = err as { status?: number; statusCode?: number; message?: string };
  const message = sanitizeSecretFromText(anyErr?.message || String(err), [apiKey]);
  let status = anyErr?.status ?? anyErr?.statusCode;
  if (!status) {
    const match = message.match(/\b(400|401|402|403|404|429|500|502|503|504)\b/);
    if (match) status = Number(match[1]);
  }
  return { status, message };
}

export class GeminiAdapter implements ProviderAdapter {
  readonly protocol = 'google-gemini' as const;

  async testConnection(model: ServerModelConfig, timeoutMs: number): Promise<ConnectionTestResult> {
    const started = Date.now();
    let timerId: ReturnType<typeof setTimeout> | undefined;
    try {
      const ai = createGeminiClient(model);
      const timerPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () => reject(new Error(`Connection timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      });
      await Promise.race([
        ai.models.generateContent({
          model: model.modelId.trim(),
          contents: 'Reply with a single word: OK',
        }),
        timerPromise,
      ]);
      const latencyMs = Date.now() - started;
      return {
        ok: true,
        latencyMs,
        message: `Connected (${latencyMs}ms)`,
        modelReported: model.modelId.trim(),
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const { status, message } = extractGeminiError(err, model.apiKey);
      const classified = classifyHttpError(status, message);
      return {
        ok: false,
        latencyMs,
        message: sanitizeSecretFromText(classified.message, [model.apiKey]),
        errorKind: classified.kind,
      };
    } finally {
      if (timerId !== undefined) clearTimeout(timerId);
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
    const { signal: mergedSignal, cleanup, didTimeout } = combineAbortSignals(signal, timeoutMs);
    try {
      const ai = createGeminiClient(model);
      const systemParts = [
        systemInstruction,
        ...messages.filter((m) => m.role === 'system').map((m) => m.content),
      ]
        .filter(Boolean)
        .join('\n\n');

      const contents = mapMessagesToGeminiContents(messages);
      if (contents.length === 0) {
        contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
      }

      const maxOutputTokens =
        typeof model.maxOutputTokens === 'number' && model.maxOutputTokens > 0
          ? model.maxOutputTokens
          : undefined;

      const responseStream = await ai.models.generateContentStream({
        model: model.modelId.trim(),
        contents,
        config: {
          ...(systemParts ? { systemInstruction: systemParts } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          abortSignal: mergedSignal,
        },
      });

      for await (const chunk of responseStream) {
        if (mergedSignal.aborted) {
          if (didTimeout()) {
            throw new AdapterCallError(
              classifyHttpError(undefined, `Request timed out after ${timeoutMs}ms`)
            );
          }
          break;
        }
        const delta = chunk.text ?? '';
        const meta = chunk.usageMetadata;
        yield {
          ...(delta ? { delta } : {}),
          ...(meta
            ? {
                usage: {
                  inputTokens: meta.promptTokenCount,
                  outputTokens: meta.candidatesTokenCount,
                  totalTokens: meta.totalTokenCount,
                },
              }
            : {}),
        };
      }
    } catch (err) {
      if (signal.aborted && !didTimeout()) {
        return;
      }
      if (didTimeout()) {
        throw new AdapterCallError(
          classifyHttpError(undefined, `Request timed out after ${timeoutMs}ms`)
        );
      }
      if (err instanceof AdapterCallError) throw err;
      const { status, message } = extractGeminiError(err, model.apiKey);
      throw new AdapterCallError(classifyHttpError(status, message));
    } finally {
      cleanup();
    }
  }
}
