import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getGitHubStatus, type GitHubStatusResponse } from '../github/githubClient.ts';
import { translate, type TranslationKey } from '../i18n/translations.ts';
import {
  fetchServerCapabilities,
  resetServerModelCooldown,
  testModelConnection,
} from '../orchestration/fallbackClient.ts';
import {
  migrateLegacyKeysToVault,
  removeKeyFromServerVault,
  storeKeyInServerVault,
} from '../orchestration/vaultClient.ts';
import { createStarterProject } from '../project-engine/projectTemplates.ts';
import { storageAdapter } from '../storage/indexedDbStorage.ts';
import type { StorageUsageStats, WorkspaceBackupPayload } from '../storage/storageAdapter.ts';
import type {
  AIModelConfig,
  AuthUser,
  Conversation,
  ConversationFolder,
  FallbackHistoryEntry,
  LanguageCode,
  ModelHealthEvent,
  NavRoute,
  Project,
  ProjectSnapshot,
  ToastItem,
  UsageRecord,
  UserSettings,
} from '../types/index.ts';
import { createId, maskApiKey } from '../utils/helpers.ts';

const DEFAULT_SETTINGS: UserSettings = {
  language: 'en',
  theme: 'dark',
  runtimeMode: 'local',
  onboardingCompleted: false,
  defaultSystemInstruction:
    'You are an expert senior software architect and helpful assistant. Provide accurate, concise, and production-quality answers.',
  routingMode: 'auto',
  routingRules: [],
  maxAgentIterations: 4,
  fallbackPolicy: {
    maxRetriesPerModel: 1,
    initialBackoffMs: 600,
    maxBackoffMs: 4000,
    timeoutMs: 45000,
  },
  supervisor: {
    enabled: false,
    modelConfigId: null,
    mode: 'advisory',
    autoVerifyAfterBuild: true,
  },
};

export interface ModelHealthUpdateInput {
  ok: boolean;
  latencyMs?: number;
  errorKind?: string;
  message?: string;
  cooldownUntil?: number;
  consecutiveFailures?: number;
  successCount?: number;
  failureCount?: number;
  averageLatencyMs?: number;
}

interface AppContextValue {
  ready: boolean;
  route: NavRoute;
  setRoute: (r: NavRoute) => void;
  models: AIModelConfig[];
  addModel: (model: Omit<AIModelConfig, 'id' | 'createdAt' | 'status'>) => Promise<AIModelConfig>;
  updateModel: (id: string, patch: Partial<AIModelConfig>) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  duplicateModel: (id: string) => Promise<AIModelConfig | null>;
  bulkSetModelsEnabled: (ids: string[], enabled: boolean) => Promise<void>;
  exportModelsConfig: () => Array<Omit<AIModelConfig, 'apiKey' | 'credentialRefId' | 'maskedApiKey'>>;
  importModelsConfig: (items: Array<Partial<AIModelConfig>>) => Promise<number>;
  reorderModels: (orderedIds: string[]) => Promise<void>;
  testModel: (id: string) => Promise<void>;
  testAllEnabledModels: () => Promise<void>;
  recordModelHealth: (id: string, update: ModelHealthUpdateInput) => Promise<void>;
  resetModelHealthCooldown: (id: string) => Promise<void>;
  testingModelIds: Set<string>;
  hasLegacyInlineKeys: boolean;
  migrateKeysToVault: () => Promise<number>;
  conversations: Conversation[];
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;
  saveConversation: (conv: Conversation) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  createNewConversation: (folderId?: string) => Promise<Conversation>;
  branchConversation: (convId: string, upToMessageId: string) => Promise<Conversation | null>;
  folders: ConversationFolder[];
  createFolder: (name: string) => Promise<ConversationFolder>;
  deleteFolder: (id: string) => Promise<void>;
  projects: Project[];
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
  saveProject: (proj: Project) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  createProject: (name: string, description: string, framework?: 'react-vite' | 'html-js') => Promise<Project>;
  duplicateProject: (id: string) => Promise<Project | null>;
  getProjectSnapshots: (projectId: string) => Promise<ProjectSnapshot[]>;
  createProjectSnapshot: (
    projectId: string,
    label: string,
    createdBy?: ProjectSnapshot['createdBy']
  ) => Promise<ProjectSnapshot | null>;
  restoreProjectSnapshot: (projectId: string, snapshotId: string) => Promise<Project | null>;
  deleteProjectSnapshot: (snapshotId: string) => Promise<void>;
  fallbackHistory: FallbackHistoryEntry[];
  recordFallbackEvent: (entry: Omit<FallbackHistoryEntry, 'id'>) => Promise<void>;
  clearFallbackHistory: () => Promise<void>;
  usageRecords: UsageRecord[];
  recordUsage: (entry: Omit<UsageRecord, 'id' | 'timestamp'>) => Promise<void>;
  clearUsageRecords: () => Promise<void>;
  authUser: AuthUser | null;
  authChecked: boolean;
  databaseConfigured: boolean;
  loginUser: (email: string, password: string) => Promise<AuthUser>;
  registerUser: (email: string, password: string, displayName: string) => Promise<AuthUser>;
  logoutUser: () => Promise<void>;
  syncWorkspaceToCloud: () => Promise<void>;
  pullWorkspaceFromCloud: () => Promise<void>;
  settings: UserSettings;
  updateSettings: (patch: Partial<UserSettings>) => Promise<void>;
  serverGeminiConfigured: boolean;
  githubStatus: GitHubStatusResponse;
  refreshGitHubStatus: () => Promise<void>;
  toasts: ToastItem[];
  pushToast: (toast: Omit<ToastItem, 'id'>) => void;
  dismissToast: (id: string) => void;
  getStorageStats: () => Promise<StorageUsageStats>;
  exportWorkspaceBackup: () => Promise<WorkspaceBackupPayload>;
  importWorkspaceBackup: (
    payload: WorkspaceBackupPayload
  ) => Promise<{ importedProjects: number; importedConversations: number; importedModels: number }>;
  resetAllWorkspaceData: () => Promise<void>;
  t: (key: TranslationKey) => string;
  isRtl: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [route, setRoute] = useState<NavRoute>('dashboard');
  const [models, setModels] = useState<AIModelConfig[]>([]);
  const [testingModelIds, setTestingModelIds] = useState<Set<string>>(new Set());
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [folders, setFolders] = useState<ConversationFolder[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [fallbackHistory, setFallbackHistory] = useState<FallbackHistoryEntry[]>([]);
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([]);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [databaseConfigured, setDatabaseConfigured] = useState(false);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [serverGeminiConfigured, setServerGeminiConfigured] = useState(false);
  const [githubStatus, setGithubStatus] = useState<GitHubStatusResponse>({
    configured: false,
    connected: false,
    callbackUrl: '',
    user: null,
  });
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = createId('toast');
    setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 5000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const refreshGitHubStatus = useCallback(async () => {
    const status = await getGitHubStatus();
    setGithubStatus(status);
  }, []);

  // Load persisted data on startup
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [
          storedModels,
          storedConvs,
          storedFolders,
          storedProjects,
          storedHistory,
          storedUsage,
          storedSettings,
          caps,
          gh,
          authRes,
        ] = await Promise.all([
          storageAdapter.getModels(),
          storageAdapter.getConversations(),
          storageAdapter.getFolders(),
          storageAdapter.getProjects(),
          storageAdapter.getFallbackHistory(),
          storageAdapter.getUsageRecords(),
          storageAdapter.getSettings(),
          fetchServerCapabilities(),
          getGitHubStatus(),
          fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);

        if (!active) return;

        setServerGeminiConfigured(caps.serverGeminiConfigured);
        setGithubStatus(gh);
        if (authRes) {
          setAuthUser(authRes.user ?? null);
          setDatabaseConfigured(Boolean(authRes.databaseConfigured));
        }
        setAuthChecked(true);

        let initialModels = storedModels;
        if (initialModels.length === 0 && caps.serverGeminiConfigured) {
          initialModels = [
            {
              id: createId('mdl'),
              displayName: 'Gemini 4 Hydrogen (Server Managed)',
              providerName: 'Google Gemini',
              modelId: 'gemini-4-hydrogen',
              protocol: 'google-gemini',
              useServerEnvKey: true,
              priority: 1,
              enabled: true,
              maxContextWindow: 1000000,
              maxOutputTokens: 8192,
              capabilities: {
                text: true,
                streaming: true,
                vision: true,
                imageUnderstanding: true,
                toolCalling: true,
                jsonOutput: true,
                longContext: true,
              },
              pricingTier: 'unspecified',
              status: 'connected',
              createdAt: Date.now(),
            },
          ];
          await storageAdapter.saveModels(initialModels);
        }

        let initialProjects = storedProjects;
        if (initialProjects.length === 0) {
          const starter = createStarterProject(
            'Starter Workspace App',
            'Interactive React + TypeScript starter project ready for AI Studio editing.',
            'react-vite'
          );
          initialProjects = [starter];
          await storageAdapter.saveProject(starter);
        }

        setModels([...initialModels].sort((a, b) => a.priority - b.priority));
        setConversations(storedConvs);
        if (storedConvs.length > 0) setActiveConversationId(storedConvs[0].id);
        setFolders(storedFolders);
        setProjects(initialProjects);
        if (initialProjects.length > 0) setActiveProjectId(initialProjects[0].id);
        setFallbackHistory(storedHistory);
        setUsageRecords(storedUsage);

        if (storedSettings) {
          setSettings({
            ...DEFAULT_SETTINGS,
            ...storedSettings,
            runtimeMode: storedSettings.runtimeMode || 'local',
            routingMode: storedSettings.routingMode || 'auto',
            routingRules: Array.isArray(storedSettings.routingRules)
              ? storedSettings.routingRules
              : [],
            maxAgentIterations: storedSettings.maxAgentIterations || 4,
            fallbackPolicy: {
              ...DEFAULT_SETTINGS.fallbackPolicy,
              ...(storedSettings.fallbackPolicy || {}),
            },
            supervisor: {
              ...DEFAULT_SETTINGS.supervisor,
              ...(storedSettings.supervisor || {}),
            },
          });
        }
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Listen for GitHub OAuth popup completion
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const origin = event.origin || '';
      if (
        origin &&
        !origin.endsWith('.run.app') &&
        !origin.includes('localhost') &&
        origin !== window.location.origin
      ) {
        return;
      }
      if (event.data?.type === 'GITHUB_OAUTH_SUCCESS') {
        refreshGitHubStatus();
        pushToast({
          type: 'success',
          title: 'GitHub connected',
          description: 'Your GitHub account is now authorized for repository operations.',
        });
      } else if (event.data?.type === 'GITHUB_OAUTH_ERROR') {
        pushToast({
          type: 'error',
          title: 'GitHub authorization failed',
          description: String(event.data.error || 'OAuth authorization was cancelled or rejected.'),
        });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pushToast, refreshGitHubStatus]);

  // Apply theme class
  useEffect(() => {
    const applyTheme = () => {
      const prefersDark =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      const shouldBeDark =
        settings.theme === 'dark' || (settings.theme === 'system' && prefersDark);
      document.documentElement.classList.toggle('dark', shouldBeDark);
    };
    applyTheme();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [settings.theme]);

  // Apply RTL/LTR language direction
  useEffect(() => {
    const dir = settings.language === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.dir = dir;
    document.documentElement.lang = settings.language;
  }, [settings.language]);

  const hasLegacyInlineKeys = useMemo(
    () =>
      models.some(
        (m) => !m.useServerEnvKey && Boolean(m.apiKey && m.apiKey.trim()) && !m.credentialRefId
      ),
    [models]
  );

  const migrateKeysToVault = useCallback(async () => {
    const entries = models
      .filter((m) => !m.useServerEnvKey && Boolean(m.apiKey && m.apiKey.trim()))
      .map((m) => ({ modelId: m.id, apiKey: m.apiKey!.trim() }));
    if (entries.length === 0) return 0;

    const migrated = await migrateLegacyKeysToVault(entries);
    const byModelId = new Map(migrated.map((item) => [item.modelId, item]));
    setModels((prev) => {
      const next = prev.map((m) => {
        const hit = byModelId.get(m.id);
        if (!hit) return m;
        return {
          ...m,
          apiKey: undefined,
          credentialRefId: hit.refId,
          maskedApiKey: hit.maskedKey,
        };
      });
      storageAdapter.saveModels(next);
      return next;
    });
    return migrated.length;
  }, [models]);

  const addModel = useCallback(
    async (input: Omit<AIModelConfig, 'id' | 'createdAt' | 'status'>) => {
      let credentialRefId = input.credentialRefId;
      let maskedApiKey = input.maskedApiKey;
      let inlineApiKey = input.apiKey;

      if (!input.useServerEnvKey && input.apiKey && input.apiKey.trim()) {
        try {
          const vaulted = await storeKeyInServerVault(input.apiKey.trim(), input.credentialRefId);
          credentialRefId = vaulted.refId;
          maskedApiKey = vaulted.maskedKey;
          inlineApiKey = undefined;
        } catch {
          maskedApiKey = maskApiKey(input.apiKey.trim(), false);
        }
      }

      const created: AIModelConfig = {
        ...input,
        apiKey: inlineApiKey,
        credentialRefId,
        maskedApiKey,
        id: createId('mdl'),
        status: 'untested',
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        healthHistory: [],
        createdAt: Date.now(),
      };
      setModels((prev) => {
        const next = [...prev, created].sort((a, b) => a.priority - b.priority);
        storageAdapter.saveModels(next);
        return next;
      });
      return created;
    },
    []
  );

  const updateModel = useCallback(
    async (id: string, patch: Partial<AIModelConfig>) => {
      let resolvedPatch = { ...patch };
      if (!patch.useServerEnvKey && patch.apiKey && patch.apiKey.trim()) {
        const existing = models.find((m) => m.id === id);
        try {
          const vaulted = await storeKeyInServerVault(
            patch.apiKey.trim(),
            patch.credentialRefId ?? existing?.credentialRefId
          );
          resolvedPatch = {
            ...resolvedPatch,
            apiKey: undefined,
            credentialRefId: vaulted.refId,
            maskedApiKey: vaulted.maskedKey,
          };
        } catch {
          resolvedPatch = {
            ...resolvedPatch,
            maskedApiKey: maskApiKey(patch.apiKey.trim(), false),
          };
        }
      }

      setModels((prev) => {
        const next = prev
          .map((m) => (m.id === id ? { ...m, ...resolvedPatch } : m))
          .sort((a, b) => a.priority - b.priority);
        storageAdapter.saveModels(next);
        return next;
      });
    },
    [models]
  );

  const recordModelHealth = useCallback(async (id: string, update: ModelHealthUpdateInput) => {
    const now = Date.now();
    setModels((prev) => {
      const next = prev.map((m) => {
        if (m.id !== id) return m;
        const prevSuccess = m.successCount ?? 0;
        const prevFailure = m.failureCount ?? 0;
        const successCount = update.successCount ?? (update.ok ? prevSuccess + 1 : prevSuccess);
        const failureCount = update.failureCount ?? (update.ok ? prevFailure : prevFailure + 1);
        const consecutiveFailures =
          update.consecutiveFailures ?? (update.ok ? 0 : (m.consecutiveFailures ?? 0) + 1);
        const avgLatency =
          update.averageLatencyMs ??
          (update.latencyMs !== undefined
            ? m.averageLatencyMs !== undefined
              ? Math.round(m.averageLatencyMs * 0.7 + update.latencyMs * 0.3)
              : update.latencyMs
            : m.averageLatencyMs);

        const evt: ModelHealthEvent = {
          ts: now,
          ok: update.ok,
          latencyMs: update.latencyMs,
          errorKind: update.errorKind,
          message: update.message,
        };
        const healthHistory = [...(m.healthHistory ?? []), evt].slice(-12);

        const nextStatus: AIModelConfig['status'] = update.ok
          ? 'connected'
          : update.errorKind === 'RATE_LIMIT' || update.errorKind === 'QUOTA_EXCEEDED'
            ? 'rate_limited'
            : 'error';

        return {
          ...m,
          status: nextStatus,
          lastCheckedAt: now,
          lastLatencyMs: update.latencyMs ?? m.lastLatencyMs,
          averageLatencyMs: avgLatency,
          successCount,
          failureCount,
          consecutiveFailures,
          cooldownUntil: update.ok ? undefined : (update.cooldownUntil ?? m.cooldownUntil),
          lastCooldownReason: update.ok ? undefined : (update.message ?? m.lastCooldownReason),
          lastSuccessAt: update.ok ? now : m.lastSuccessAt,
          lastError: update.ok ? undefined : (update.message ?? m.lastError),
          healthHistory,
        };
      });
      storageAdapter.saveModels(next);
      return next;
    });
  }, []);

  const resetModelHealthCooldown = useCallback(
    async (id: string) => {
      await resetServerModelCooldown(id).catch(() => {});
      setModels((prev) => {
        const next = prev.map((m) =>
          m.id === id
            ? {
                ...m,
                cooldownUntil: undefined,
                consecutiveFailures: 0,
                lastCooldownReason: undefined,
                status: m.status === 'rate_limited' ? 'untested' : m.status,
              }
            : m
        );
        storageAdapter.saveModels(next);
        return next;
      });
      pushToast({
        type: 'info',
        title: 'Cooldown cleared',
        description: 'Model circuit breaker was reset for immediate routing.',
      });
    },
    [pushToast]
  );

  const deleteModel = useCallback(
    async (id: string) => {
      const target = models.find((m) => m.id === id);
      const refId = target?.credentialRefId;
      const sharedElsewhere =
        refId && models.some((m) => m.id !== id && m.credentialRefId === refId);
      if (refId && !sharedElsewhere) {
        removeKeyFromServerVault(refId).catch(() => {});
      }

      setModels((prev) => {
        const filtered = prev.filter((m) => m.id !== id);
        const renumbered = filtered.map((m, idx) => ({ ...m, priority: idx + 1 }));
        storageAdapter.saveModels(renumbered);
        return renumbered;
      });
    },
    [models]
  );

  const duplicateModel = useCallback(
    async (id: string) => {
      const source = models.find((m) => m.id === id);
      if (!source) return null;
      const copy: AIModelConfig = {
        ...source,
        id: createId('mdl'),
        displayName: `${source.displayName} (Copy)`,
        priority: models.length + 1,
        status: 'untested',
        lastError: undefined,
        lastLatencyMs: undefined,
        averageLatencyMs: undefined,
        lastCheckedAt: undefined,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        cooldownUntil: undefined,
        healthHistory: [],
        createdAt: Date.now(),
      };
      setModels((prev) => {
        const next = [...prev, copy].sort((a, b) => a.priority - b.priority);
        storageAdapter.saveModels(next);
        return next;
      });
      return copy;
    },
    [models]
  );

  const bulkSetModelsEnabled = useCallback(async (ids: string[], enabled: boolean) => {
    const idSet = new Set(ids);
    setModels((prev) => {
      const next = prev.map((m) => (idSet.has(m.id) ? { ...m, enabled } : m));
      storageAdapter.saveModels(next);
      return next;
    });
  }, []);

  const exportModelsConfig = useCallback(() => {
    return models.map(
      ({ apiKey: _k, credentialRefId: _r, maskedApiKey: _m, ...rest }) => rest
    );
  }, [models]);

  const importModelsConfig = useCallback(
    async (items: Array<Partial<AIModelConfig>>) => {
      let importedCount = 0;
      const startPriority = models.length + 1;
      const newModels: AIModelConfig[] = [];

      for (const item of items) {
        if (!item?.modelId || !item?.protocol) continue;
        newModels.push({
          id: createId('mdl'),
          displayName: item.displayName || item.modelId,
          providerName: item.providerName || 'Custom Provider',
          modelId: item.modelId,
          baseUrl: item.baseUrl,
          useServerEnvKey: Boolean(item.useServerEnvKey),
          protocol: item.protocol,
          priority: startPriority + importedCount,
          enabled: item.enabled ?? true,
          maxContextWindow: item.maxContextWindow,
          maxOutputTokens: item.maxOutputTokens,
          capabilities: item.capabilities,
          roleTags: item.roleTags,
          customHeaders: item.customHeaders,
          customConfig: item.customConfig,
          pricingTier: item.pricingTier || 'unspecified',
          pricing: item.pricing,
          status: 'untested',
          successCount: 0,
          failureCount: 0,
          consecutiveFailures: 0,
          healthHistory: [],
          createdAt: Date.now(),
        });
        importedCount += 1;
      }

      if (newModels.length > 0) {
        setModels((prev) => {
          const next = [...prev, ...newModels].sort((a, b) => a.priority - b.priority);
          storageAdapter.saveModels(next);
          return next;
        });
      }
      return importedCount;
    },
    [models.length]
  );

  const reorderModels = useCallback(async (orderedIds: string[]) => {
    setModels((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      const reordered: AIModelConfig[] = [];
      orderedIds.forEach((id, idx) => {
        const item = byId.get(id);
        if (item) reordered.push({ ...item, priority: idx + 1 });
      });
      prev.forEach((m) => {
        if (!orderedIds.includes(m.id)) {
          reordered.push({ ...m, priority: reordered.length + 1 });
        }
      });
      storageAdapter.saveModels(reordered);
      return reordered;
    });
  }, []);

  const testModel = useCallback(
    async (id: string) => {
      const target = models.find((m) => m.id === id);
      if (!target) return;
      setTestingModelIds((prev) => new Set(prev).add(id));
      try {
        const result = await testModelConnection(target, settings.fallbackPolicy.timeoutMs);
        await recordModelHealth(id, {
          ok: result.ok,
          latencyMs: result.latencyMs,
          errorKind: result.errorKind,
          message: result.message,
        });
        if (result.detectedCapabilities) {
          await updateModel(id, {
            capabilities: {
              ...result.detectedCapabilities,
              ...(target.capabilities || {}),
            },
          });
        }
        pushToast({
          type: result.ok ? 'success' : 'error',
          title: result.ok
            ? `${target.displayName}: Connected`
            : `${target.displayName}: Connection Failed`,
          description: result.message,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Test request failed';
        await recordModelHealth(id, {
          ok: false,
          errorKind: 'NETWORK_ERROR',
          message: msg,
        });
        pushToast({
          type: 'error',
          title: `${target.displayName}: Test Error`,
          description: msg,
        });
      } finally {
        setTestingModelIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [models, pushToast, recordModelHealth, settings.fallbackPolicy.timeoutMs, updateModel]
  );

  const testAllEnabledModels = useCallback(async () => {
    const enabled = models.filter((m) => m.enabled);
    for (const mdl of enabled) {
      await testModel(mdl.id);
    }
  }, [models, testModel]);

  const saveConversation = useCallback(async (conv: Conversation) => {
    setConversations((prev) => {
      const exists = prev.some((c) => c.id === conv.id);
      const next = exists
        ? prev.map((c) => (c.id === conv.id ? conv : c))
        : [conv, ...prev];
      return [...next].sort((a, b) => b.updatedAt - a.updatedAt);
    });
    await storageAdapter.saveConversation(conv);
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== id);
        if (activeConversationId === id) {
          setActiveConversationId(next[0]?.id ?? null);
        }
        return next;
      });
      await storageAdapter.deleteConversation(id);
    },
    [activeConversationId]
  );

  const createNewConversation = useCallback(
    async (folderId?: string) => {
      const now = Date.now();
      const conv: Conversation = {
        id: createId('conv'),
        title: 'New Conversation',
        pinned: false,
        folderId,
        chatMode: 'general',
        messages: [],
        systemInstruction: settings.defaultSystemInstruction,
        selectedModelId: 'auto',
        createdAt: now,
        updatedAt: now,
      };
      await saveConversation(conv);
      setActiveConversationId(conv.id);
      return conv;
    },
    [saveConversation, settings.defaultSystemInstruction]
  );

  const branchConversation = useCallback(
    async (convId: string, upToMessageId: string) => {
      const source = conversations.find((c) => c.id === convId);
      if (!source) return null;
      const idx = source.messages.findIndex((m) => m.id === upToMessageId);
      if (idx === -1) return null;

      const now = Date.now();
      const branched: Conversation = {
        ...source,
        id: createId('conv'),
        title: `${source.title} (Branch)`,
        pinned: false,
        branchedFromTitle: source.title,
        messages: source.messages.slice(0, idx + 1).map((m) => ({
          ...m,
          isStreaming: false,
        })),
        createdAt: now,
        updatedAt: now,
      };
      await saveConversation(branched);
      setActiveConversationId(branched.id);
      return branched;
    },
    [conversations, saveConversation]
  );

  const createFolder = useCallback(async (name: string) => {
    const folder: ConversationFolder = {
      id: createId('fld'),
      name: name.trim() || 'Untitled Folder',
      createdAt: Date.now(),
    };
    setFolders((prev) => [...prev, folder]);
    await storageAdapter.saveFolder(folder);
    return folder;
  }, []);

  const deleteFolder = useCallback(
    async (id: string) => {
      setFolders((prev) => prev.filter((f) => f.id !== id));
      await storageAdapter.deleteFolder(id);
      const affected = conversations.filter((c) => c.folderId === id);
      for (const conv of affected) {
        await saveConversation({ ...conv, folderId: undefined });
      }
    },
    [conversations, saveConversation]
  );

  const saveProject = useCallback(async (proj: Project) => {
    setProjects((prev) => {
      const exists = prev.some((p) => p.id === proj.id);
      const next = exists ? prev.map((p) => (p.id === proj.id ? proj : p)) : [proj, ...prev];
      return [...next].sort((a, b) => b.updatedAt - a.updatedAt);
    });
    await storageAdapter.saveProject(proj);
  }, []);

  const deleteProject = useCallback(
    async (id: string) => {
      setProjects((prev) => {
        const next = prev.filter((p) => p.id !== id);
        if (activeProjectId === id) {
          setActiveProjectId(next[0]?.id ?? null);
        }
        return next;
      });
      await storageAdapter.deleteProject(id);
    },
    [activeProjectId]
  );

  const createProject = useCallback(
    async (name: string, description: string, framework: 'react-vite' | 'html-js' = 'react-vite') => {
      const proj = createStarterProject(name, description, framework);
      await saveProject(proj);
      setActiveProjectId(proj.id);
      return proj;
    },
    [saveProject]
  );

  const duplicateProject = useCallback(
    async (id: string) => {
      const source = projects.find((p) => p.id === id);
      if (!source) return null;
      const now = Date.now();
      const copy: Project = {
        ...source,
        id: createId('proj'),
        name: `${source.name} (Copy)`,
        github: undefined,
        files: source.files.map((f) => ({ ...f })),
        activities: [
          {
            id: createId('act'),
            action: 'Duplicated project',
            detail: `Copied from ${source.name}`,
            timestamp: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      await saveProject(copy);
      setActiveProjectId(copy.id);
      return copy;
    },
    [projects, saveProject]
  );

  const getProjectSnapshots = useCallback((projectId: string) => {
    return storageAdapter.getSnapshots(projectId);
  }, []);

  const createProjectSnapshot = useCallback(
    async (
      projectId: string,
      label: string,
      createdBy: ProjectSnapshot['createdBy'] = 'user'
    ) => {
      const proj = projects.find((p) => p.id === projectId);
      if (!proj) return null;
      const snap: ProjectSnapshot = {
        id: createId('snap'),
        projectId,
        label,
        files: proj.files.map((f) => ({ ...f })),
        createdAt: Date.now(),
        createdBy,
      };
      await storageAdapter.saveSnapshot(snap);
      return snap;
    },
    [projects]
  );

  const restoreProjectSnapshot = useCallback(
    async (projectId: string, snapshotId: string) => {
      const proj = projects.find((p) => p.id === projectId);
      if (!proj) return null;
      const snaps = await storageAdapter.getSnapshots(projectId);
      const snap = snaps.find((s) => s.id === snapshotId);
      if (!snap) return null;

      const updated: Project = {
        ...proj,
        files: snap.files.map((f) => ({ ...f })),
        updatedAt: Date.now(),
        activities: [
          {
            id: createId('act'),
            action: 'Restored snapshot',
            detail: snap.label,
            timestamp: Date.now(),
          },
          ...proj.activities,
        ].slice(0, 40),
      };
      await saveProject(updated);
      return updated;
    },
    [projects, saveProject]
  );

  const deleteProjectSnapshot = useCallback((snapshotId: string) => {
    return storageAdapter.deleteSnapshot(snapshotId);
  }, []);

  const recordFallbackEvent = useCallback(async (entry: Omit<FallbackHistoryEntry, 'id'>) => {
    const full: FallbackHistoryEntry = {
      ...entry,
      id: createId('fbk'),
    };
    setFallbackHistory((prev) => [full, ...prev].slice(0, 100));
    await storageAdapter.addFallbackHistory(full);
  }, []);

  const clearFallbackHistory = useCallback(async () => {
    setFallbackHistory([]);
    await storageAdapter.clearFallbackHistory();
  }, []);

  const recordUsage = useCallback(
    async (entry: Omit<UsageRecord, 'id' | 'timestamp'>) => {
      const mdl = models.find((m) => m.id === entry.modelConfigId);
      let estimatedCostUsd = entry.estimatedCostUsd;
      let costStatus = entry.costStatus;

      if (
        estimatedCostUsd === undefined &&
        mdl?.pricing &&
        typeof mdl.pricing.inputPer1MUsd === 'number' &&
        typeof mdl.pricing.outputPer1MUsd === 'number' &&
        entry.inputTokens !== undefined &&
        entry.outputTokens !== undefined
      ) {
        estimatedCostUsd =
          (entry.inputTokens / 1_000_000) * mdl.pricing.inputPer1MUsd +
          (entry.outputTokens / 1_000_000) * mdl.pricing.outputPer1MUsd;
        costStatus = entry.tokenSource === 'provider-reported' ? 'calculated' : 'estimated';
      }

      const full: UsageRecord = {
        ...entry,
        estimatedCostUsd,
        costStatus,
        id: createId('usg'),
        timestamp: Date.now(),
      };
      setUsageRecords((prev) => [full, ...prev].slice(0, 500));
      await storageAdapter.addUsageRecord(full);
    },
    [models]
  );

  const clearUsageRecords = useCallback(async () => {
    setUsageRecords([]);
    await storageAdapter.clearUsageRecords();
  }, []);

  const loginUser = useCallback(
    async (email: string, password: string): Promise<AuthUser> => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Sign-in failed.');
      setAuthUser(json.user);
      await refreshGitHubStatus();
      return json.user as AuthUser;
    },
    [refreshGitHubStatus]
  );

  const registerUser = useCallback(
    async (email: string, password: string, displayName: string): Promise<AuthUser> => {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, displayName }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Registration failed.');
      setAuthUser(json.user);
      await refreshGitHubStatus();
      return json.user as AuthUser;
    },
    [refreshGitHubStatus]
  );

  const logoutUser = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    setAuthUser(null);
    await refreshGitHubStatus();
  }, [refreshGitHubStatus]);

  const syncWorkspaceToCloud = useCallback(async () => {
    if (!authUser) throw new Error('Sign in to sync your hosted workspace.');
    const backup = await storageAdapter.exportBackup();
    const res = await fetch('/api/workspace/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerUserId: authUser.id,
        models: backup.models,
        conversations: backup.conversations,
        folders: backup.folders,
        projects: backup.projects,
        snapshots: backup.snapshots,
        usageRecords: backup.usageRecords,
        settings: backup.settings,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Cloud workspace sync failed.');
  }, [authUser]);

  const pullWorkspaceFromCloud = useCallback(async () => {
    if (!authUser) throw new Error('Sign in to restore your hosted workspace.');
    const res = await fetch('/api/workspace/state');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to load hosted workspace.');
    const payload: WorkspaceBackupPayload = {
      schemaVersion: 3,
      exportedAt: Date.now(),
      models: json.models || [],
      conversations: json.conversations || [],
      folders: json.folders || [],
      projects: json.projects || [],
      snapshots: json.snapshots || [],
      usageRecords: json.usageRecords || [],
      settings: json.settings || null,
    };
    await storageAdapter.importBackup(payload);
    const [reloadedModels, reloadedConvs, reloadedFolders, reloadedProjects, reloadedUsage] =
      await Promise.all([
        storageAdapter.getModels(),
        storageAdapter.getConversations(),
        storageAdapter.getFolders(),
        storageAdapter.getProjects(),
        storageAdapter.getUsageRecords(),
      ]);
    setModels([...reloadedModels].sort((a, b) => a.priority - b.priority));
    setConversations(reloadedConvs);
    setFolders(reloadedFolders);
    setProjects(reloadedProjects);
    setUsageRecords(reloadedUsage);
  }, [authUser]);

  const updateSettings = useCallback(async (patch: Partial<UserSettings>) => {
    setSettings((prev) => {
      const next: UserSettings = {
        ...prev,
        ...patch,
        fallbackPolicy: {
          ...prev.fallbackPolicy,
          ...(patch.fallbackPolicy || {}),
        },
        supervisor: {
          ...prev.supervisor,
          ...(patch.supervisor || {}),
        },
      };
      storageAdapter.saveSettings(next);
      return next;
    });
  }, []);

  const getStorageStats = useCallback(() => storageAdapter.getStorageStats(), []);
  const exportWorkspaceBackup = useCallback(() => storageAdapter.exportBackup(), []);
  const importWorkspaceBackup = useCallback(async (payload: WorkspaceBackupPayload) => {
    const summary = await storageAdapter.importBackup(payload);
    const [
      reloadedModels,
      reloadedConvs,
      reloadedFolders,
      reloadedProjects,
      reloadedUsage,
      reloadedSettings,
    ] = await Promise.all([
      storageAdapter.getModels(),
      storageAdapter.getConversations(),
      storageAdapter.getFolders(),
      storageAdapter.getProjects(),
      storageAdapter.getUsageRecords(),
      storageAdapter.getSettings(),
    ]);
    setModels([...reloadedModels].sort((a, b) => a.priority - b.priority));
    setConversations(reloadedConvs);
    setFolders(reloadedFolders);
    setProjects(reloadedProjects);
    setUsageRecords(reloadedUsage);
    if (reloadedSettings) {
      setSettings((prev) => ({ ...prev, ...reloadedSettings }));
    }
    return summary;
  }, []);

  const resetAllWorkspaceData = useCallback(async () => {
    await storageAdapter.clearAll();
    setConversations([]);
    setFolders([]);
    setFallbackHistory([]);
    setUsageRecords([]);
    setActiveConversationId(null);
    const starter = createStarterProject(
      'Starter Workspace App',
      'Interactive React + TypeScript starter project ready for AI Studio editing.',
      'react-vite'
    );
    await storageAdapter.saveProject(starter);
    setProjects([starter]);
    setActiveProjectId(starter.id);
    setSettings(DEFAULT_SETTINGS);

    if (serverGeminiConfigured) {
      const defaultMdl: AIModelConfig = {
        id: createId('mdl'),
        displayName: 'Gemini 4 Hydrogen (Server Managed)',
        providerName: 'Google Gemini',
        modelId: 'gemini-4-hydrogen',
        protocol: 'google-gemini',
        useServerEnvKey: true,
        priority: 1,
        enabled: true,
        maxContextWindow: 1000000,
        maxOutputTokens: 8192,
        capabilities: {
          text: true,
          streaming: true,
          vision: true,
          imageUnderstanding: true,
          toolCalling: true,
          jsonOutput: true,
          longContext: true,
        },
        pricingTier: 'unspecified',
        status: 'connected',
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        healthHistory: [],
        createdAt: Date.now(),
      };
      setModels([defaultMdl]);
      await storageAdapter.saveModels([defaultMdl]);
    } else {
      setModels([]);
    }

    pushToast({
      type: 'info',
      title: 'Workspace reset',
      description: 'Local conversations, custom models, and settings have been cleared.',
    });
  }, [pushToast, serverGeminiConfigured]);

  const t = useCallback(
    (key: TranslationKey) => translate(settings.language as LanguageCode, key),
    [settings.language]
  );

  const value = useMemo<AppContextValue>(
    () => ({
      ready,
      route,
      setRoute,
      models,
      addModel,
      updateModel,
      deleteModel,
      duplicateModel,
      bulkSetModelsEnabled,
      exportModelsConfig,
      importModelsConfig,
      reorderModels,
      testModel,
      testAllEnabledModels,
      recordModelHealth,
      resetModelHealthCooldown,
      testingModelIds,
      hasLegacyInlineKeys,
      migrateKeysToVault,
      conversations,
      activeConversationId,
      setActiveConversationId,
      saveConversation,
      deleteConversation,
      createNewConversation,
      branchConversation,
      folders,
      createFolder,
      deleteFolder,
      projects,
      activeProjectId,
      setActiveProjectId,
      saveProject,
      deleteProject,
      createProject,
      duplicateProject,
      getProjectSnapshots,
      createProjectSnapshot,
      restoreProjectSnapshot,
      deleteProjectSnapshot,
      fallbackHistory,
      recordFallbackEvent,
      clearFallbackHistory,
      usageRecords,
      recordUsage,
      clearUsageRecords,
      authUser,
      authChecked,
      databaseConfigured,
      loginUser,
      registerUser,
      logoutUser,
      syncWorkspaceToCloud,
      pullWorkspaceFromCloud,
      settings,
      updateSettings,
      serverGeminiConfigured,
      githubStatus,
      refreshGitHubStatus,
      toasts,
      pushToast,
      dismissToast,
      getStorageStats,
      exportWorkspaceBackup,
      importWorkspaceBackup,
      resetAllWorkspaceData,
      t,
      isRtl: settings.language === 'ar',
    }),
    [
      ready,
      route,
      models,
      addModel,
      updateModel,
      deleteModel,
      duplicateModel,
      bulkSetModelsEnabled,
      exportModelsConfig,
      importModelsConfig,
      reorderModels,
      testModel,
      testAllEnabledModels,
      recordModelHealth,
      resetModelHealthCooldown,
      testingModelIds,
      hasLegacyInlineKeys,
      migrateKeysToVault,
      conversations,
      activeConversationId,
      saveConversation,
      deleteConversation,
      createNewConversation,
      branchConversation,
      folders,
      createFolder,
      deleteFolder,
      projects,
      activeProjectId,
      saveProject,
      deleteProject,
      createProject,
      duplicateProject,
      getProjectSnapshots,
      createProjectSnapshot,
      restoreProjectSnapshot,
      deleteProjectSnapshot,
      fallbackHistory,
      recordFallbackEvent,
      clearFallbackHistory,
      usageRecords,
      recordUsage,
      clearUsageRecords,
      authUser,
      authChecked,
      databaseConfigured,
      loginUser,
      registerUser,
      logoutUser,
      syncWorkspaceToCloud,
      pullWorkspaceFromCloud,
      settings,
      updateSettings,
      serverGeminiConfigured,
      githubStatus,
      refreshGitHubStatus,
      toasts,
      pushToast,
      dismissToast,
      getStorageStats,
      exportWorkspaceBackup,
      importWorkspaceBackup,
      resetAllWorkspaceData,
      t,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
