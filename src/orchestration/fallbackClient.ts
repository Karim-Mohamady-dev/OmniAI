import type {
  AIModelConfig,
  ChatAttachment,
  DiagnosticCategory,
  DiagnosticTestResult,
  FallbackPolicy,
  ModelCapabilities,
  ModelConnectionStatus,
  RoutingMode,
  TokenUsageInfo,
} from '../types/index.ts';

export interface StreamMessagePayload {
  role: 'system' | 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
}

export interface StreamCallbacks {
  onAttempt?: (info: {
    configId: string;
    modelId: string;
    displayName: string;
    providerName: string;
    attempt: number;
    maxAttempts: number;
  }) => void;
  onSwitched?: (info: {
    fromModel: string;
    fromProvider: string;
    toModel: string;
    toProvider: string;
    toConfigId: string;
    reason: string;
    errorKind: string;
    preservingPartialOutput: boolean;
    timestamp: number;
  }) => void;
  onCooldownNotice?: (info: {
    configId: string;
    displayName: string;
    cooldownUntil: number;
    consecutiveFailures: number;
    reason: string;
  }) => void;
  onHealthUpdate?: (info: {
    configId: string;
    ok: boolean;
    latencyMs?: number;
    errorKind?: string;
    message?: string;
    cooldownUntil?: number;
    consecutiveFailures?: number;
    successCount?: number;
    failureCount?: number;
    averageLatencyMs?: number;
  }) => void;
  onCapabilityAdapted?: (info: {
    modelId: string;
    displayName: string;
    omittedImages: string[];
    reason: string;
  }) => void;
  onDelta?: (info: {
    text: string;
    configId: string;
    modelId: string;
    displayName: string;
  }) => void;
  onUsage?: (
    usage: TokenUsageInfo & {
      configId: string;
      modelId: string;
      displayName?: string;
      providerName?: string;
    }
  ) => void;
  onModelStatus?: (status: {
    configId: string;
    status: ModelConnectionStatus;
    lastError?: string;
    latencyMs?: number;
    lastSuccessAt?: number;
    usage?: TokenUsageInfo;
  }) => void;
  onDone?: (info: {
    configId: string;
    modelId: string;
    displayName: string;
    providerName?: string;
    switchedCount: number;
    aborted?: boolean;
    usage?: TokenUsageInfo;
    attempts?: Array<{
      displayName: string;
      providerName: string;
      errorKind: string;
      message: string;
      timestamp: number;
    }>;
  }) => void;
  onFatal?: (info: {
    message: string;
    attempts: Array<{
      displayName: string;
      providerName: string;
      errorKind: string;
      message: string;
      timestamp?: number;
    }>;
  }) => void;
}

export async function fetchServerCapabilities(): Promise<{
  serverGeminiConfigured: boolean;
  supportedProtocols: string[];
  routingModes?: string[];
}> {
  const res = await fetch('/api/ai/capabilities');
  if (!res.ok) {
    return { serverGeminiConfigured: false, supportedProtocols: [] };
  }
  return res.json();
}

export async function testModelConnection(
  model: AIModelConfig,
  timeoutMs = 15000
): Promise<{
  ok: boolean;
  latencyMs: number;
  message: string;
  errorKind?: string;
  modelReported?: string;
  detectedCapabilities?: Partial<ModelCapabilities>;
}> {
  const res = await fetch('/api/ai/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, timeoutMs }),
  });
  return res.json();
}

export async function resetServerModelCooldown(configId: string): Promise<void> {
  await fetch('/api/ai/cooldown/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ configId }),
  });
}

export async function runProviderDiagnostics(params: {
  models: AIModelConfig[];
  tests: DiagnosticCategory[];
  timeoutMs?: number;
}): Promise<{ ranAt: number; results: DiagnosticTestResult[] }> {
  const res = await fetch('/api/diagnostics/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || 'Diagnostics run failed.');
  }
  return res.json();
}

export async function streamOrchestratedChat(params: {
  models: AIModelConfig[];
  messages: StreamMessagePayload[];
  systemInstruction?: string;
  policy: FallbackPolicy;
  routingMode?: RoutingMode;
  requiredCapabilities?: Partial<ModelCapabilities>;
  signal: AbortSignal;
  callbacks: StreamCallbacks;
}): Promise<void> {
  const {
    models,
    messages,
    systemInstruction,
    policy,
    routingMode = 'auto',
    requiredCapabilities,
    signal,
    callbacks,
  } = params;

  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      models,
      messages,
      systemInstruction,
      policy,
      routingMode,
      requiredCapabilities,
    }),
  });

  if (!res.ok) {
    const errJson = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    callbacks.onFatal?.({
      message: errJson.error || `Request failed with HTTP ${res.status}`,
      attempts: [],
    });
    return;
  }

  if (!res.body) {
    callbacks.onFatal?.({
      message: 'Empty response stream received from server.',
      attempts: [],
    });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (line === '') {
          currentEvent = 'message';
          continue;
        }
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          const payloadStr = line.slice(5).trim();
          if (!payloadStr) continue;
          try {
            const payload = JSON.parse(payloadStr);
            switch (currentEvent) {
              case 'attempt':
                callbacks.onAttempt?.(payload);
                break;
              case 'switched':
                callbacks.onSwitched?.(payload);
                break;
              case 'cooldown_notice':
                callbacks.onCooldownNotice?.(payload);
                break;
              case 'health_update':
                callbacks.onHealthUpdate?.(payload);
                break;
              case 'capability_adapted':
                callbacks.onCapabilityAdapted?.(payload);
                break;
              case 'delta':
                callbacks.onDelta?.(payload);
                break;
              case 'usage':
                callbacks.onUsage?.(payload);
                break;
              case 'model_status':
                callbacks.onModelStatus?.(payload);
                break;
              case 'done':
                callbacks.onDone?.(payload);
                break;
              case 'fatal':
                callbacks.onFatal?.(payload);
                break;
            }
          } catch {
            // ignore malformed JSON chunk
          }
        }
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    callbacks.onFatal?.({
      message: err instanceof Error ? err.message : 'Stream connection interrupted.',
      attempts: [],
    });
  }
}
