import type { Response } from 'express';
import { AdapterCallError, classifyHttpError } from '../adapters/base.ts';
import { inferCapabilitiesForModel } from '../adapters/capabilities.ts';
import { getAdapterForProtocol } from '../adapters/registry.ts';
import { validateExternalModelUrl } from '../middleware/security.ts';
import type {
  ChatMessageInput,
  FallbackPolicy,
  ModelCapabilities,
  RoutingMode,
  ServerModelConfig,
  TokenUsageInfo,
} from '../types.ts';
import { sanitizeSecretFromText } from '../vault/secretVault.ts';
import {
  orderModelsWithHealthAndRoles,
  recordModelAttemptFailure,
  recordModelAttemptSuccess,
} from './healthTracker.ts';

export interface AttemptFailureRecord {
  modelId: string;
  configId: string;
  displayName: string;
  providerName: string;
  errorKind: string;
  message: string;
  retriesAttempted: number;
  timestamp: number;
}

function sendSseEvent(res: Response, event: string, data: unknown) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function buildContinuationMessages(
  originalMessages: ChatMessageInput[],
  partialOutput: string
): ChatMessageInput[] {
  const tail = partialOutput.slice(-1200);
  return [
    ...originalMessages,
    {
      role: 'assistant',
      content: partialOutput,
    },
    {
      role: 'user',
      content: `The previous model stream was interrupted mid-response. Continue seamlessly from the exact end of the text below WITHOUT repeating any already-generated sentences or code blocks. End tail:\n"""\n${tail}\n"""`,
    },
  ];
}

export function trimRepeatedContinuationPrefix(accumulated: string, incomingChunk: string): string {
  if (!accumulated || !incomingChunk) return incomingChunk;
  const tail = accumulated.slice(-120);
  // Check longest suffix of `accumulated` that matches a prefix of `incomingChunk`
  const maxOverlap = Math.min(tail.length, incomingChunk.length);
  for (let len = maxOverlap; len >= 12; len--) {
    if (tail.endsWith(incomingChunk.slice(0, len))) {
      return incomingChunk.slice(len);
    }
  }
  return incomingChunk;
}

function adaptMessagesForModel(
  messages: ChatMessageInput[],
  caps: ModelCapabilities
): { adapted: ChatMessageInput[]; strippedImages: string[] } {
  const strippedImages: string[] = [];
  if (caps.vision && caps.imageUnderstanding) {
    return { adapted: messages, strippedImages };
  }

  const adapted = messages.map((msg) => {
    if (!msg.attachments || msg.attachments.length === 0) return msg;
    const kept = [];
    const notes: string[] = [];
    for (const att of msg.attachments) {
      if (att.mimeType.startsWith('image/')) {
        strippedImages.push(att.name);
        notes.push(
          `[Image attachment "${att.name}" omitted: selected model does not advertise vision support]`
        );
      } else {
        kept.push(att);
      }
    }
    if (notes.length === 0) return msg;
    return {
      ...msg,
      attachments: kept,
      content: [msg.content, ...notes].filter(Boolean).join('\n\n'),
    };
  });

  return { adapted, strippedImages };
}

export async function runOrchestratedChatStream(params: {
  res: Response;
  models: ServerModelConfig[];
  messages: ChatMessageInput[];
  systemInstruction?: string;
  policy: FallbackPolicy;
  routingMode?: RoutingMode;
  requiredCapabilities?: Partial<ModelCapabilities>;
  preferredRole?: 'coding' | 'vision' | 'long-context';
  signal: AbortSignal;
}) {
  const {
    res,
    models,
    messages,
    systemInstruction,
    policy,
    routingMode = 'auto',
    requiredCapabilities,
    preferredRole,
    signal,
  } = params;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const hasImages = messages.some((m) =>
    m.attachments?.some((a) => a.mimeType.startsWith('image/') && a.dataBase64)
  );

  const { ordered: orderedModels, skippedCooldownIds, probingRecovery } =
    orderModelsWithHealthAndRoles({
      models,
      routingMode,
      requiredCapabilities,
      hasImages,
      preferredRole,
    });

  if (orderedModels.length === 0) {
    sendSseEvent(res, 'fatal', {
      message:
        'No enabled AI models are available. Add or enable at least one model in Model Manager.',
      attempts: [],
    });
    res.end();
    return;
  }

  if (skippedCooldownIds.length > 0) {
    sendSseEvent(res, 'cooldown_notice', {
      skippedCooldownIds,
      probingRecovery,
      timestamp: Date.now(),
    });
  }

  const secretBag = orderedModels.map((m) => m.apiKey);
  const maxRetries = Math.min(Math.max(policy.maxRetriesPerModel ?? 1, 0), 3);
  const initialBackoff = Math.min(Math.max(policy.initialBackoffMs ?? 600, 100), 5000);
  const maxBackoff = Math.min(Math.max(policy.maxBackoffMs ?? 4000, initialBackoff), 15000);
  const timeoutMs = Math.min(Math.max(policy.timeoutMs ?? 45000, 5000), 120000);

  let accumulatedText = '';
  let switchedCount = 0;
  let lastFailedModel: { displayName: string; providerName: string } | null = null;
  const failureRecords: AttemptFailureRecord[] = [];
  const triedConfigIds = new Set<string>();

  for (const model of orderedModels) {
    if (signal.aborted) break;
    if (triedConfigIds.has(model.id)) continue;
    triedConfigIds.add(model.id);

    // SSRF Guard before contacting external endpoint
    const urlCheck = validateExternalModelUrl(model.baseUrl);
    if (!urlCheck.valid) {
      const blockedMsg = urlCheck.reason || 'Blocked unsafe model endpoint URL.';
      const health = recordModelAttemptFailure(
        model.id,
        'BAD_REQUEST',
        blockedMsg,
        model.consecutiveFailures ?? 0
      );
      sendSseEvent(res, 'health_update', {
        configId: model.id,
        ok: false,
        errorKind: 'BAD_REQUEST',
        consecutiveFailures: health.consecutiveFailures,
        cooldownUntil: health.cooldownUntil,
        cooldownReason: health.cooldownReason,
      });
      failureRecords.push({
        modelId: model.modelId,
        configId: model.id,
        displayName: model.displayName,
        providerName: model.providerName,
        errorKind: 'BAD_REQUEST',
        message: blockedMsg,
        retriesAttempted: 0,
        timestamp: Date.now(),
      });
      lastFailedModel = {
        displayName: model.displayName,
        providerName: model.providerName,
      };
      continue;
    }

    const adapter = getAdapterForProtocol(model.protocol);
    const caps = inferCapabilitiesForModel(model);
    let attempt = 0;
    let modelSucceeded = false;

    while (attempt <= maxRetries && !signal.aborted) {
      attempt += 1;

      if (lastFailedModel && attempt === 1) {
        switchedCount += 1;
        const lastFailure = failureRecords[failureRecords.length - 1];
        sendSseEvent(res, 'switched', {
          fromModel: lastFailedModel.displayName,
          fromProvider: lastFailedModel.providerName,
          toModel: model.displayName,
          toProvider: model.providerName,
          toConfigId: model.id,
          reason: lastFailure?.message || 'Model unavailable',
          errorKind: lastFailure?.errorKind || 'UNKNOWN',
          preservingPartialOutput: accumulatedText.length > 0,
          timestamp: Date.now(),
        });
      }

      sendSseEvent(res, 'attempt', {
        configId: model.id,
        modelId: model.modelId,
        displayName: model.displayName,
        providerName: model.providerName,
        attempt,
        maxAttempts: maxRetries + 1,
      });

      const { adapted, strippedImages } = adaptMessagesForModel(messages, caps);
      if (strippedImages.length > 0 && attempt === 1) {
        sendSseEvent(res, 'capability_adapted', {
          modelId: model.modelId,
          displayName: model.displayName,
          omittedImages: strippedImages,
          reason:
            'Selected model does not advertise vision capability; image attachments were adapted to text placeholders.',
        });
      }

      const isContinuingFromPartial = accumulatedText.length > 0;
      const effectiveMessages = isContinuingFromPartial
        ? buildContinuationMessages(adapted, accumulatedText)
        : adapted;

      let latestUsage: TokenUsageInfo | undefined;
      const startedAt = Date.now();
      let emittedThisAttempt = 0;

      try {
        for await (const chunk of adapter.streamChat({
          model,
          messages: effectiveMessages,
          systemInstruction,
          signal,
          timeoutMs,
        })) {
          if (signal.aborted) break;
          if (chunk.delta) {
            let cleanDelta = chunk.delta;
            if (isContinuingFromPartial && emittedThisAttempt === 0) {
              cleanDelta = trimRepeatedContinuationPrefix(accumulatedText, cleanDelta);
            }
            if (cleanDelta.length > 0) {
              accumulatedText += cleanDelta;
              emittedThisAttempt += cleanDelta.length;
              sendSseEvent(res, 'delta', {
                text: cleanDelta,
                configId: model.id,
                modelId: model.modelId,
                displayName: model.displayName,
              });
            }
          }
          if (chunk.usage) {
            latestUsage = chunk.usage;
          }
        }

        if (signal.aborted) {
          sendSseEvent(res, 'done', {
            configId: model.id,
            modelId: model.modelId,
            displayName: model.displayName,
            switchedCount,
            aborted: true,
          });
          res.end();
          return;
        }

        const latencyMs = Date.now() - startedAt;
        const health = recordModelAttemptSuccess(model.id, latencyMs);

        sendSseEvent(res, 'model_status', {
          configId: model.id,
          status: 'connected',
          latencyMs,
          usage: latestUsage,
          lastSuccessAt: Date.now(),
        });

        sendSseEvent(res, 'health_update', {
          configId: model.id,
          ok: true,
          latencyMs,
          consecutiveFailures: health.consecutiveFailures,
          cooldownUntil: 0,
        });

        if (latestUsage) {
          sendSseEvent(res, 'usage', {
            configId: model.id,
            modelId: model.modelId,
            displayName: model.displayName,
            providerName: model.providerName,
            ...latestUsage,
          });
        }

        sendSseEvent(res, 'done', {
          configId: model.id,
          modelId: model.modelId,
          displayName: model.displayName,
          providerName: model.providerName,
          switchedCount,
          usage: latestUsage,
          attempts: failureRecords,
        });
        modelSucceeded = true;
        break;
      } catch (err) {
        if (signal.aborted) {
          sendSseEvent(res, 'done', {
            configId: model.id,
            modelId: model.modelId,
            displayName: model.displayName,
            switchedCount,
            aborted: true,
          });
          res.end();
          return;
        }

        const classified =
          err instanceof AdapterCallError
            ? err.classified
            : classifyHttpError(undefined, err instanceof Error ? err.message : String(err));

        const safeMessage = sanitizeSecretFromText(classified.message, secretBag);
        const isRateOrQuota =
          classified.kind === 'RATE_LIMIT' || classified.kind === 'QUOTA_EXCEEDED';

        const health = recordModelAttemptFailure(
          model.id,
          classified.kind,
          safeMessage,
          model.consecutiveFailures ?? 0
        );

        sendSseEvent(res, 'model_status', {
          configId: model.id,
          status: isRateOrQuota ? 'rate_limited' : 'error',
          lastError: safeMessage,
          errorKind: classified.kind,
        });

        sendSseEvent(res, 'health_update', {
          configId: model.id,
          ok: false,
          errorKind: classified.kind,
          consecutiveFailures: health.consecutiveFailures,
          cooldownUntil: health.cooldownUntil,
          cooldownReason: health.cooldownReason,
        });

        const canRetrySameModel =
          classified.retryable && attempt <= maxRetries && emittedThisAttempt === 0;

        if (canRetrySameModel) {
          const delayMs = Math.min(initialBackoff * Math.pow(2, attempt - 1), maxBackoff);
          try {
            await sleep(delayMs, signal);
            continue;
          } catch {
            break;
          }
        }

        failureRecords.push({
          modelId: model.modelId,
          configId: model.id,
          displayName: model.displayName,
          providerName: model.providerName,
          errorKind: classified.kind,
          message: safeMessage,
          retriesAttempted: attempt - 1,
          timestamp: Date.now(),
        });
        lastFailedModel = {
          displayName: model.displayName,
          providerName: model.providerName,
        };
        break;
      }
    }

    if (modelSucceeded) {
      res.end();
      return;
    }
  }

  sendSseEvent(res, 'fatal', {
    message:
      'All configured AI models failed or are currently unavailable. Review the model errors below, verify API keys/quotas, or add another fallback model.',
    attempts: failureRecords,
    partialOutputPreserved: accumulatedText.length > 0,
  });
  res.end();
}
