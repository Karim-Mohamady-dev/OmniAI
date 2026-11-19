export type ModelProtocol =
  | 'google-gemini'
  | 'openai-compatible'
  | 'anthropic'
  | 'custom-http';

export type ModelConnectionStatus =
  | 'untested'
  | 'connected'
  | 'error'
  | 'rate_limited';

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

export interface RoutingRule {
  id: string;
  name: string;
  chatMode?: ChatMode;
  requiresVision?: boolean;
  preferredModelIds: string[];
}

export interface TokenUsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelPricingConfig {
  inputPer1MUsd?: number;
  outputPer1MUsd?: number;
  source?: 'custom' | 'provider-reported' | 'unavailable';
}

export interface ModelHealthEvent {
  ts: number;
  ok: boolean;
  latencyMs?: number;
  errorKind?: string;
  message?: string;
}

export interface AIModelConfig {
  id: string;
  displayName: string;
  providerName: string;
  modelId: string;
  baseUrl?: string;
  /** Optional inline key for browser-only personal mode; migrated to credentialRefId when server vault is used */
  apiKey?: string;
  credentialRefId?: string;
  maskedApiKey?: string;
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
  /** Explicit pricing disclosure: only mark free if provider explicitly offers free access */
  pricingTier?: 'unspecified' | 'paid' | 'free-tier-explicit';
  pricing?: ModelPricingConfig;
  status: ModelConnectionStatus;
  lastError?: string;
  lastLatencyMs?: number;
  averageLatencyMs?: number;
  lastCheckedAt?: number;
  lastSuccessAt?: number;
  successCount?: number;
  failureCount?: number;
  consecutiveFailures?: number;
  cooldownUntil?: number;
  lastCooldownReason?: string;
  healthHistory?: ModelHealthEvent[];
  lastUsage?: TokenUsageInfo;
  createdAt: number;
}

export interface UsageRecord {
  id: string;
  timestamp: number;
  modelConfigId: string;
  modelId: string;
  displayName: string;
  providerName: string;
  context: 'chat' | 'studio' | 'supervisor' | 'diagnostics';
  projectId?: string;
  conversationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  tokenSource: 'provider-reported' | 'estimated' | 'unavailable';
  estimatedCostUsd?: number;
  costStatus: 'calculated' | 'estimated' | 'unavailable';
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

export interface FallbackPolicy {
  maxRetriesPerModel: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  timeoutMs: number;
}

export interface FallbackHistoryEntry {
  id: string;
  timestamp: number;
  originalModel: string;
  failedModel: string;
  failureReason: string;
  errorKind: string;
  nextSelectedModel: string;
  successfulModel?: string;
  context: 'chat' | 'studio' | 'supervisor';
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataBase64?: string;
  textContent?: string;
}

export interface FallbackEventNotice {
  fromModel: string;
  toModel: string;
  reason: string;
  errorKind: string;
  timestamp: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: ChatAttachment[];
  createdAt: number;
  modelId?: string;
  modelDisplayName?: string;
  providerName?: string;
  usage?: TokenUsageInfo;
  fallbackNotices?: FallbackEventNotice[];
  error?: string;
  isStreaming?: boolean;
}

export type ChatMode = 'general' | 'coding' | 'research' | 'debugging' | 'planning';

export interface ConversationFolder {
  id: string;
  name: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  pinned: boolean;
  folderId?: string;
  chatMode?: ChatMode;
  branchedFromTitle?: string;
  messages: ChatMessage[];
  systemInstruction?: string;
  selectedModelId: string | 'auto';
  createdAt: number;
  updatedAt: number;
}

export interface ProjectFile {
  path: string;
  content: string;
  updatedAt: number;
}

export interface ProjectActivity {
  id: string;
  action: string;
  detail: string;
  timestamp: number;
  modelName?: string;
}

export interface ProjectSnapshot {
  id: string;
  projectId: string;
  label: string;
  files: ProjectFile[];
  createdAt: number;
  createdBy: 'user' | 'ai' | 'auto-backup';
}

export interface ProjectGitHubLink {
  owner: string;
  repo: string;
  branch: string;
  lastCommitSha?: string;
  lastSyncedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  framework: 'react-vite' | 'html-js';
  status?: 'active' | 'draft' | 'archived';
  userInstructions?: string;
  localFolderPath?: string;
  files: ProjectFile[];
  activities: ProjectActivity[];
  github?: ProjectGitHubLink;
  createdAt: number;
  updatedAt: number;
}

export type LocalAgentPermission =
  | 'read-only'
  | 'edit-files'
  | 'run-commands'
  | 'install-deps'
  | 'delete-files'
  | 'publish-github';

export interface LocalAgentAuditEntry {
  id: string;
  timestamp: number;
  action: string;
  target: string;
  permissionUsed: LocalAgentPermission;
  outcome: 'allowed' | 'blocked' | 'completed' | 'failed';
  detail?: string;
}

export type SupervisorCategory =
  | 'architecture'
  | 'code-quality'
  | 'security'
  | 'performance'
  | 'accessibility'
  | 'responsive'
  | 'dependencies'
  | 'broken-imports'
  | 'typescript'
  | 'build-errors'
  | 'missing-requirements';

export interface SupervisorFinding {
  id: string;
  severity: 'critical' | 'warning' | 'suggestion';
  category: SupervisorCategory;
  title: string;
  description: string;
  evidence?: string;
  filePath?: string;
  proposedFix?: {
    path: string;
    content: string;
    rationale: string;
  };
  applied?: boolean;
}

export interface SupervisorReport {
  overallHealth: 'healthy' | 'needs-attention' | 'critical';
  healthScore: number;
  publishGate: 'PASS' | 'WARNING' | 'BLOCKED';
  summary: string;
  inspectedAt: number;
  modelName: string;
  findings: SupervisorFinding[];
}

export interface SupervisorConfig {
  enabled: boolean;
  modelConfigId: string | null;
  mode: 'advisory' | 'auto-review';
  autoVerifyAfterBuild?: boolean;
}

export type ThemePreference = 'dark' | 'light' | 'system';
export type LanguageCode = 'en' | 'ar';
export type RuntimeMode = 'local' | 'hosted';

export type NavRoute =
  | 'dashboard'
  | 'chat'
  | 'studio'
  | 'projects'
  | 'models'
  | 'diagnostics'
  | 'analytics'
  | 'github'
  | 'settings';

export interface UserSettings {
  language: LanguageCode;
  theme: ThemePreference;
  runtimeMode?: RuntimeMode;
  onboardingCompleted?: boolean;
  defaultSystemInstruction: string;
  routingMode: RoutingMode;
  routingRules: RoutingRule[];
  maxAgentIterations: number;
  fallbackPolicy: FallbackPolicy;
  supervisor: SupervisorConfig;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  createdAt: number;
}

export interface GitHubUser {
  login: string;
  name: string;
  avatarUrl: string;
  profileUrl: string;
  publicRepos: number;
}

export interface GitHubRepoSummary {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  htmlUrl: string;
  updatedAt: string;
}

export interface ToastItem {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  description?: string;
}
