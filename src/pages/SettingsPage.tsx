import React, { useEffect, useRef, useState } from 'react';
import {
  CloudDownload,
  CloudUpload,
  Compass,
  Database,
  Download,
  Globe,
  Laptop,
  LogOut,
  Moon,
  Plus,
  Route as RouteIcon,
  Shield,
  Sliders,
  Sun,
  Trash2,
  Upload,
  UserCheck,
} from 'lucide-react';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { useApp } from '../contexts/AppContext.tsx';
import { getDesktopCapabilities } from '../desktop/desktopBridge.ts';
import type { StorageUsageStats, WorkspaceBackupPayload } from '../storage/storageAdapter.ts';
import type {
  ChatMode,
  LanguageCode,
  RoutingMode,
  RoutingRule,
  ThemePreference,
} from '../types/index.ts';
import { createId, formatBytes } from '../utils/helpers.ts';

export function SettingsPage() {
  const {
    models,
    settings,
    updateSettings,
    authUser,
    databaseConfigured,
    logoutUser,
    syncWorkspaceToCloud,
    pullWorkspaceFromCloud,
    hasLegacyInlineKeys,
    migrateKeysToVault,
    getStorageStats,
    exportWorkspaceBackup,
    importWorkspaceBackup,
    resetAllWorkspaceData,
    setRoute,
    pushToast,
    t,
  } = useApp();

  const [confirmReset, setConfirmReset] = useState(false);
  const [storageStats, setStorageStats] = useState<StorageUsageStats | null>(null);
  const [newRuleName, setNewRuleName] = useState('');
  const [newRuleMode, setNewRuleMode] = useState<ChatMode | ''>('coding');
  const [newRuleVision, setNewRuleVision] = useState(false);
  const [newRuleModelId, setNewRuleModelId] = useState('');
  const backupInputRef = useRef<HTMLInputElement | null>(null);
  const desktopCaps = getDesktopCapabilities();

  useEffect(() => {
    getStorageStats().then(setStorageStats).catch(() => {});
  }, [getStorageStats]);

  const handleSaveFallback = (field: keyof typeof settings.fallbackPolicy, value: number) => {
    updateSettings({
      fallbackPolicy: {
        ...settings.fallbackPolicy,
        [field]: value,
      },
    });
  };

  const handleAddRule = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRuleName.trim() || !newRuleModelId) return;
    const rule: RoutingRule = {
      id: createId('rule'),
      name: newRuleName.trim(),
      ...(newRuleMode ? { chatMode: newRuleMode } : {}),
      ...(newRuleVision ? { requiresVision: true } : {}),
      preferredModelIds: [newRuleModelId],
    };
    updateSettings({
      routingRules: [...settings.routingRules, rule],
    });
    setNewRuleName('');
  };

  const handleExportBackup = async () => {
    const payload = await exportWorkspaceBackup();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `omniai-workspace-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    pushToast({
      type: 'success',
      title: 'Workspace backup exported',
      description: 'API keys and GitHub OAuth secrets were stripped for security.',
    });
  };

  const handleImportBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text()) as WorkspaceBackupPayload;
      const summary = await importWorkspaceBackup(payload);
      const stats = await getStorageStats();
      setStorageStats(stats);
      pushToast({
        type: 'success',
        title: 'Backup restored',
        description: `Imported ${summary.importedProjects} project(s), ${summary.importedConversations} chat(s), ${summary.importedModels} model(s).`,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Backup restore failed',
        description: err instanceof Error ? err.message : 'Invalid backup file.',
      });
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          {t('settingsTitle')}
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Configure language (English / Arabic RTL), theme, routing rules, automatic fallback policy, and workspace backups.
        </p>
      </div>

      {/* General & Localization */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
        <div className="flex items-center gap-2.5 text-base font-semibold text-slate-900 dark:text-slate-100">
          <Globe className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <h2>{t('generalSettings')}</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
              {t('languageLabel')}
            </label>
            <div className="grid grid-cols-2 gap-2 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              {(
                [
                  { code: 'en', label: 'English (LTR)' },
                  { code: 'ar', label: 'العربية (RTL)' },
                ] as Array<{ code: LanguageCode; label: string }>
              ).map((item) => (
                <button
                  key={item.code}
                  type="button"
                  onClick={() => updateSettings({ language: item.code })}
                  className={`py-2 px-3 rounded-md text-xs font-medium transition-colors ${
                    settings.language === item.code
                      ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
              {t('themeLabel')}
            </label>
            <div className="grid grid-cols-3 gap-1.5 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              {(
                [
                  { id: 'dark', label: t('themeDark'), icon: <Moon className="h-3.5 w-3.5" /> },
                  { id: 'light', label: t('themeLight'), icon: <Sun className="h-3.5 w-3.5" /> },
                  { id: 'system', label: t('themeSystem'), icon: <Laptop className="h-3.5 w-3.5" /> },
                ] as Array<{ id: ThemePreference; label: string; icon: React.ReactNode }>
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => updateSettings({ theme: opt.id })}
                  className={`py-2 px-2 rounded-md text-xs font-medium inline-flex items-center justify-center gap-1.5 transition-colors ${
                    settings.theme === opt.id
                      ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {opt.icon}
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
            Default System Instruction
          </label>
          <textarea
            rows={3}
            value={settings.defaultSystemInstruction}
            onChange={(e) => updateSettings({ defaultSystemInstruction: e.target.value })}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Need a quick walkthrough of models, chat, AI Studio, diagnostics, and GitHub publishing?
          </p>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('omniai:open-onboarding'))}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <Compass className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
            <span>{t('guidedTour')}</span>
          </button>
        </div>
      </section>

      {/* Account & Hosted Multi-User Mode */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-base font-semibold text-slate-900 dark:text-slate-100">
            <UserCheck className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <h2>{t('accountMode')} &amp; Workspace Isolation</h2>
          </div>
          <div className="inline-flex rounded-lg bg-slate-100 dark:bg-slate-800 p-1 text-xs">
            <button
              type="button"
              onClick={() => updateSettings({ runtimeMode: 'local' })}
              className={`px-3 py-1 rounded-md font-medium transition-colors ${
                (settings.runtimeMode || 'local') === 'local'
                  ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500'
              }`}
            >
              Local Personal
            </button>
            <button
              type="button"
              onClick={() => updateSettings({ runtimeMode: 'hosted' })}
              className={`px-3 py-1 rounded-md font-medium transition-colors ${
                settings.runtimeMode === 'hosted'
                  ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-500'
              }`}
            >
              Hosted Multi-User
            </button>
          </div>
        </div>

        <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          {databaseConfigured
            ? 'Hosted PostgreSQL (DATABASE_URL) detected. Signed-in sessions isolate workspaces, credentials, and usage history per authenticated user.'
            : 'Personal browser data persists in IndexedDB v3. Switch to Hosted Multi-User to register/sign in with isolated server workspaces and encrypted per-user vaults.'}
        </p>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4 text-xs">
          {authUser ? (
            <>
              <div>
                <div className="font-semibold text-slate-900 dark:text-slate-100">
                  Signed in as {authUser.displayName} ({authUser.role})
                </div>
                <div className="font-mono text-slate-500 mt-0.5">{authUser.email}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await syncWorkspaceToCloud();
                      pushToast({ type: 'success', title: 'Workspace pushed to hosted vault' });
                    } catch (err) {
                      pushToast({
                        type: 'error',
                        title: 'Cloud sync failed',
                        description: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
                >
                  <CloudUpload className="h-3.5 w-3.5" />
                  <span>Sync to Cloud</span>
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await pullWorkspaceFromCloud();
                      pushToast({ type: 'success', title: 'Workspace pulled from hosted vault' });
                    } catch (err) {
                      pushToast({
                        type: 'error',
                        title: 'Cloud pull failed',
                        description: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-900 font-medium"
                >
                  <CloudDownload className="h-3.5 w-3.5" />
                  <span>Pull from Cloud</span>
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await logoutUser();
                    pushToast({ type: 'info', title: 'Signed out' });
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 font-medium"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Sign Out</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="text-slate-600 dark:text-slate-300">
                Not signed in — currently operating in Local Personal workspace mode.
              </span>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent('omniai:open-account'))}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium"
              >
                <UserCheck className="h-3.5 w-3.5" />
                <span>Sign In / Register Account</span>
              </button>
            </>
          )}
        </div>
      </section>

      {/* Routing Mode & User-Defined Routing Rules */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
        <div className="flex items-center gap-2.5 text-base font-semibold text-slate-900 dark:text-slate-100">
          <RouteIcon className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          <h2>{t('routingModeLabel')} &amp; Agent Loop</h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Default Orchestration Routing Strategy
            </label>
            <select
              value={settings.routingMode}
              onChange={(e) => updateSettings({ routingMode: e.target.value as RoutingMode })}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
            >
              <option value="auto">Auto (Priority + Health + Capability Match)</option>
              <option value="priority">Strict Priority Order</option>
              <option value="capability">Capability-First (Vision / Long Context)</option>
              <option value="rules">User-Defined Routing Rules</option>
              <option value="manual">Manual Only (No automatic switch)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Max Studio Agent Iterations (1–8)
            </label>
            <input
              type="number"
              min={1}
              max={8}
              value={settings.maxAgentIterations}
              onChange={(e) =>
                updateSettings({
                  maxAgentIterations: Math.min(8, Math.max(1, Number(e.target.value) || 4)),
                })
              }
              className="w-full font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
          <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
            {t('routingRulesTitle')}
          </h3>

          <form onSubmit={handleAddRule} className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <input
              type="text"
              value={newRuleName}
              onChange={(e) => setNewRuleName(e.target.value)}
              placeholder="Rule name (e.g. Coding Tasks)"
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs"
            />
            <select
              value={newRuleMode}
              onChange={(e) => setNewRuleMode(e.target.value as ChatMode | '')}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs"
            >
              <option value="">Any Chat Mode</option>
              <option value="coding">Coding</option>
              <option value="debugging">Debugging</option>
              <option value="planning">Planning</option>
              <option value="research">Research</option>
              <option value="general">General</option>
            </select>
            <select
              value={newRuleModelId}
              onChange={(e) => setNewRuleModelId(e.target.value)}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs"
            >
              <option value="">Select Preferred Model...</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-400">
                <input
                  type="checkbox"
                  checked={newRuleVision}
                  onChange={(e) => setNewRuleVision(e.target.checked)}
                />
                <span>Images</span>
              </label>
              <button
                type="submit"
                disabled={!newRuleName.trim() || !newRuleModelId}
                className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add</span>
              </button>
            </div>
          </form>

          {settings.routingRules.length > 0 && (
            <div className="space-y-1.5">
              {settings.routingRules.map((rule) => {
                const targetMdl = models.find((m) => m.id === rule.preferredModelIds[0]);
                return (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                  >
                    <span>
                      <strong>{rule.name}</strong>
                      {rule.chatMode ? ` · mode=${rule.chatMode}` : ''}
                      {rule.requiresVision ? ' · vision' : ''} →{' '}
                      <span className="font-mono">{targetMdl?.displayName || rule.preferredModelIds[0]}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        updateSettings({
                          routingRules: settings.routingRules.filter((r) => r.id !== rule.id),
                        })
                      }
                      className="text-slate-400 hover:text-red-500"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Fallback Policy */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5 text-base font-semibold text-slate-900 dark:text-slate-100">
            <Sliders className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <h2>{t('fallbackSettings')}</h2>
          </div>
          <button
            type="button"
            onClick={() => setRoute('models')}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            Manage Model Priority
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Retries Per Model (0–3)
            </label>
            <input
              type="number"
              min={0}
              max={3}
              value={settings.fallbackPolicy.maxRetriesPerModel}
              onChange={(e) =>
                handleSaveFallback('maxRetriesPerModel', Math.min(3, Math.max(0, Number(e.target.value))))
              }
              className="w-full font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Initial Backoff (ms)
            </label>
            <input
              type="number"
              min={100}
              max={5000}
              step={100}
              value={settings.fallbackPolicy.initialBackoffMs}
              onChange={(e) => handleSaveFallback('initialBackoffMs', Number(e.target.value))}
              className="w-full font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Max Backoff (ms)
            </label>
            <input
              type="number"
              min={500}
              max={15000}
              step={500}
              value={settings.fallbackPolicy.maxBackoffMs}
              onChange={(e) => handleSaveFallback('maxBackoffMs', Number(e.target.value))}
              className="w-full font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
              Request Timeout (ms)
            </label>
            <input
              type="number"
              min={5000}
              max={120000}
              step={5000}
              value={settings.fallbackPolicy.timeoutMs}
              onChange={(e) => handleSaveFallback('timeoutMs', Number(e.target.value))}
              className="w-full font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm"
            />
          </div>
        </div>
      </section>

      {/* Storage Stats, Backup/Restore & Credential Vault */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
        <div className="flex items-center gap-2.5 text-base font-semibold text-slate-900 dark:text-slate-100">
          <Database className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          <h2>{t('dataManagement')} &amp; Backup</h2>
        </div>

        {storageStats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-slate-500">Projects</div>
              <div className="mt-1 text-base font-bold font-mono tabular-nums">
                {storageStats.projectCount}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-slate-500">Conversations</div>
              <div className="mt-1 text-base font-bold font-mono tabular-nums">
                {storageStats.conversationCount}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-slate-500">Snapshots</div>
              <div className="mt-1 text-base font-bold font-mono tabular-nums">
                {storageStats.snapshotCount}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3">
              <div className="text-slate-500">IndexedDB Used</div>
              <div className="mt-1 text-base font-bold font-mono tabular-nums">
                {storageStats.usedBytes !== null ? formatBytes(storageStats.usedBytes) : 'N/A'}
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExportBackup}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              <span>{t('exportBackup')}</span>
            </button>
            <button
              type="button"
              onClick={() => backupInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>{t('importBackup')}</span>
            </button>
            <input
              ref={backupInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleImportBackup}
              className="hidden"
            />
            {hasLegacyInlineKeys && (
              <button
                type="button"
                onClick={async () => {
                  const n = await migrateKeysToVault();
                  pushToast({ type: 'success', title: `Migrated ${n} key(s) to Server Vault` });
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-amber-600 text-white hover:bg-amber-700"
              >
                <Shield className="h-3.5 w-3.5" />
                <span>{t('migrateKeys')}</span>
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t('clearAllData')}</span>
          </button>
        </div>

        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          Backups include an FNV-1a integrity checksum and strict schema validation; corrupted files, path traversal entries (<code className="font-mono">../</code>), and inline secrets are rejected automatically on import.
        </p>
      </section>

      {/* Desktop Readiness & Security Architecture */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
        <div className="flex items-center gap-2.5 text-base font-semibold text-slate-900 dark:text-slate-100">
          <Shield className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <h2>{t('desktopReadiness')} &amp; Security</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-1.5">
            <p className="font-semibold text-slate-800 dark:text-slate-200">
              Runtime Environment: <span className="font-mono">{desktopCaps.environment}</span>
            </p>
            <p>
              In browsers, the preview sandbox compiles safely in-memory without shell access. Running via the included <code className="font-mono">desktop/</code> Electron app unlocks authorized local folder read/write and allowlisted <code className="font-mono">npm</code> &amp; <code className="font-mono">git</code> runners.
            </p>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-1.5">
            <p className="font-semibold text-slate-800 dark:text-slate-200">
              Credential &amp; Storage Architecture
            </p>
            <p>
              Projects, folders, snapshots, usage records, and conversations persist in versioned IndexedDB (v3). API keys and GitHub tokens are encrypted with AES-256-GCM inside HTTP-only <code className="font-mono">SameSite=None</code> server cookies and excluded from all exports.
            </p>
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={confirmReset}
        title="Reset all local workspace data?"
        description="This permanently clears all saved conversations, custom model configurations, snapshots, and IndexedDB projects from this browser."
        confirmLabel={t('clearAllData')}
        onConfirm={async () => {
          await resetAllWorkspaceData();
          setConfirmReset(false);
          const stats = await getStorageStats();
          setStorageStats(stats);
          pushToast({ type: 'info', title: 'Workspace reset complete' });
        }}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
