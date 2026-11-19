export type ModelProtocol =
  | 'google-gemini'
  | 'openai-compatible'
  | 'anthropic'
  | 'custom-http';

export type ModelRoleTag =
  | 'preferred'
  | 'backup'
  | 'coding'
  | 'vision'
  | 'long-context';

export interface ModelCapabilities {
  text: boolean;
  streaming: boolean;
  vision: boolean;
  imageUnderstanding: boolean;
  toolCalling: boolean;
  jsonOutput: boolean;
  longContext: boolean;
}

export type RoutingMode = 'auto' | 'manual' | 'priority' | 'capability' | 'rules';

export interface ServerModelConfig {
  id: string;
  displayName: string;
  providerName: string;
  modelId: string;
  baseUrl?: string;
  apiKey?: string;
  credentialRefId?: string;
  useServerEnvKey?: boolean;
  protocol: ModelProtocol;
  priority: number;
  enabled: boolean;
  maxContextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
  roleTags?: ModelRoleTag[];
  customHeaders?: Record<string, string>;
  customConfig?: Record<string, unknown>;
  cooldownUntil?: number;
  consecutiveFailures?: number;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataBase64?: string;
  textContent?: string;
}

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant';
  content: string;
  attachments?: ChatAttachment[];
}

export interface FallbackPolicy {
  maxRetriesPerModel: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  timeoutMs: number;
}

export type AdapterErrorKind =
  | 'RATE_LIMIT'
  | 'QUOTA_EXCEEDED'
  | 'TOKEN_LIMIT'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'AUTH_ERROR'
  | 'INVALID_MODEL'
  | 'INCOMPATIBLE_CAPABILITY'
  | 'BAD_REQUEST';

export interface ClassifiedAdapterError {
  kind: AdapterErrorKind;
  retryable: boolean;
  switchModel: boolean;
  message: string;
  statusCode?: number;
}

export interface TokenUsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AdapterStreamChunk {
  delta?: string;
  usage?: TokenUsageInfo;
  finishReason?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  errorKind?: AdapterErrorKind;
  modelReported?: string;
  detectedCapabilities?: Partial<ModelCapabilities>;
}

export type DiagnosticCategory =
  | 'text'
  | 'streaming'
  | 'long-context'
  | 'image'
  | 'json'
  | 'tool-calling'
  | 'fallback';

export type DiagnosticOutcomeStatus =
  | 'PASSED'
  | 'FAILED'
  | 'NOT CONFIGURED'
  | 'UNSUPPORTED'
  | 'SKIPPED';

export interface DiagnosticTestResult {
  test: DiagnosticCategory;
  modelConfigId: string;
  modelDisplayName: string;
  providerName: string;
  status: DiagnosticOutcomeStatus;
  latencyMs: number;
  detail: string;
  checkedAt: number;
}
