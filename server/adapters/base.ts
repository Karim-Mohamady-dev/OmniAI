import type {
  AdapterStreamChunk,
  ChatMessageInput,
  ClassifiedAdapterError,
  ConnectionTestResult,
  ServerModelConfig,
} from '../types.ts';

export interface ProviderAdapter {
  readonly protocol: ServerModelConfig['protocol'];
  testConnection(model: ServerModelConfig, timeoutMs: number): Promise<ConnectionTestResult>;
  streamChat(params: {
    model: ServerModelConfig;
    messages: ChatMessageInput[];
    systemInstruction?: string;
    signal: AbortSignal;
    timeoutMs: number;
  }): AsyncGenerator<AdapterStreamChunk, void, unknown>;
}

export class AdapterCallError extends Error {
  readonly classified: ClassifiedAdapterError;

  constructor(classified: ClassifiedAdapterError) {
    super(classified.message);
    this.name = 'AdapterCallError';
    this.classified = classified;
  }
}

export function validateModelConfigId(model: ServerModelConfig): { valid: boolean; reason?: string } {
  const id = model.modelId?.trim();
  if (!id) {
    return { valid: false, reason: 'Model ID is required and cannot be empty.' };
  }
  if (id.length > 200 || /[\r\n\0]/.test(id)) {
    return { valid: false, reason: 'Model ID contains invalid control characters or exceeds maximum length.' };
  }
  return { valid: true };
}

export function classifyHttpError(
  statusCode: number | undefined,
  rawMessage: string
): ClassifiedAdapterError {
  const lower = rawMessage.toLowerCase();

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    lower.includes('api_key_invalid') ||
    lower.includes('invalid_api_key') ||
    lower.includes('invalid api key') ||
    lower.includes('incorrect api key') ||
    lower.includes('authentication') ||
    lower.includes('unauthorized') ||
    lower.includes('permission_denied')
  ) {
    return {
      kind: 'AUTH_ERROR',
      retryable: false,
      switchModel: true,
      statusCode,
      message: rawMessage || 'Authentication failed. Check API key and permissions.',
    };
  }

  if (
    statusCode === 429 ||
    lower.includes('rate limit') ||
    lower.includes('rate_limit') ||
    lower.includes('too many requests') ||
    lower.includes('resource_exhausted')
  ) {
    const isQuota =
      lower.includes('quota') ||
      lower.includes('insufficient_quota') ||
      lower.includes('billing') ||
      lower.includes('exceeded your current quota') ||
      lower.includes('daily limit') ||
      lower.includes('monthly limit');
    return {
      kind: isQuota ? 'QUOTA_EXCEEDED' : 'RATE_LIMIT',
      retryable: !isQuota,
      switchModel: true,
      statusCode: 429,
      message:
        rawMessage || (isQuota ? 'Provider quota exceeded.' : 'Rate limit reached (HTTP 429).'),
    };
  }

  if (
    statusCode === 402 ||
    lower.includes('insufficient balance') ||
    lower.includes('credit balance is too low') ||
    lower.includes('insufficient_quota') ||
    lower.includes('quota') ||
    lower.includes('credit')
  ) {
    return {
      kind: 'QUOTA_EXCEEDED',
      retryable: false,
      switchModel: true,
      statusCode,
      message: rawMessage || 'Quota or credit limit exceeded.',
    };
  }

  if (
    lower.includes('context length') ||
    lower.includes('context_length_exceeded') ||
    lower.includes('maximum context') ||
    lower.includes('input token count') ||
    lower.includes('exceeds the maximum') ||
    lower.includes('token limit') ||
    lower.includes('too many tokens') ||
    lower.includes('prompt is too long')
  ) {
    return {
      kind: 'TOKEN_LIMIT',
      retryable: false,
      switchModel: true,
      statusCode,
      message: rawMessage || 'Model token/context window limit exceeded.',
    };
  }

  if (statusCode === 404 || lower.includes('model_not_found') || lower.includes('not_found')) {
    return {
      kind: 'INVALID_MODEL',
      retryable: false,
      switchModel: true,
      statusCode: 404,
      message: rawMessage || 'Requested model ID was not found on this provider.',
    };
  }

  if (
    lower.includes('image') &&
    (lower.includes('not support') || lower.includes('unsupported') || lower.includes('vision'))
  ) {
    return {
      kind: 'INCOMPATIBLE_CAPABILITY',
      retryable: false,
      switchModel: true,
      statusCode,
      message: rawMessage || 'Model does not support requested multimodal capability.',
    };
  }

  if (statusCode && statusCode >= 500) {
    return {
      kind: 'SERVER_ERROR',
      retryable: true,
      switchModel: true,
      statusCode,
      message: rawMessage || `Provider server error (HTTP ${statusCode}).`,
    };
  }

  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('aborted')) {
    return {
      kind: 'TIMEOUT',
      retryable: true,
      switchModel: true,
      statusCode,
      message: rawMessage || 'Request timed out waiting for provider response.',
    };
  }

  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return {
      kind: 'NETWORK',
      retryable: true,
      switchModel: true,
      statusCode,
      message: rawMessage || 'Network connection error reaching provider endpoint.',
    };
  }

  return {
    kind: 'BAD_REQUEST',
    retryable: false,
    switchModel: true,
    statusCode,
    message: rawMessage || 'Provider rejected request.',
  };
}

export function combineAbortSignals(
  parent: AbortSignal,
  timeoutMs: number
): {
  signal: AbortSignal;
  cleanup: () => void;
  didTimeout: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;

  const onParentAbort = () => {
    controller.abort(parent.reason);
  };
  if (parent.aborted) {
    controller.abort(parent.reason);
  } else {
    parent.addEventListener('abort', onParentAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onParentAbort);
    },
  };
}
