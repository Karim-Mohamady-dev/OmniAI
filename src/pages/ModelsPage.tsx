import React, { useEffect, useRef, useState } from 'react';
import {
  Download,
  History,
  Info,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload,
} from 'lucide-react';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { ModelCard } from '../components/ModelCard.tsx';
import { ModelFormModal } from '../components/ModelFormModal.tsx';
import { useApp } from '../contexts/AppContext.tsx';
import type { AIModelConfig } from '../types/index.ts';
import { formatRelativeTime } from '../utils/helpers.ts';

export function ModelsPage() {
  const {
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
    testingModelIds,
    hasLegacyInlineKeys,
    migrateKeysToVault,
    fallbackHistory,
    clearFallbackHistory,
    pushToast,
    t,
  } = useApp();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<AIModelConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AIModelConfig | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragTargetId, setDragTargetId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handler = () => {
      setEditingModel(null);
      setModalOpen(true);
    };
    window.addEventListener('omniai:open-add-model', handler);
    return () => window.removeEventListener('omniai:open-add-model', handler);
  }, []);

  const sortedModels = [...models].sort((a, b) => a.priority - b.priority);

  const handleSaveModel = async (data: Omit<AIModelConfig, 'id' | 'createdAt' | 'status'>) => {
    if (editingModel) {
      await updateModel(editingModel.id, { ...data, status: 'untested', lastError: undefined });
      pushToast({
        type: 'success',
        title: 'Model updated',
        description: `${data.displayName} saved. Run Test Connection to verify endpoint health.`,
      });
    } else {
      await addModel(data);
      pushToast({
        type: 'success',
        title: 'Model added',
        description: `${data.displayName} added to priority #${data.priority}.`,
      });
    }
  };

  const handleDrop = async (targetId: string) => {
    if (!draggedId || draggedId === targetId) {
      setDraggedId(null);
      setDragTargetId(null);
      return;
    }
    const ids = sortedModels.map((m) => m.id);
    const fromIdx = ids.indexOf(draggedId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const nextIds = [...ids];
    const [moved] = nextIds.splice(fromIdx, 1);
    nextIds.splice(toIdx, 0, moved);
    await reorderModels(nextIds);
    setDraggedId(null);
    setDragTargetId(null);
    pushToast({
      type: 'info',
      title: 'Fallback order updated',
      description: 'Model priorities have been renumbered automatically.',
    });
  };

  const handleTestAll = async () => {
    for (const model of sortedModels.filter((m) => m.enabled)) {
      await testModel(model.id);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExportConfigs = () => {
    const exported = exportModelsConfig();
    const blob = new Blob([JSON.stringify(exported, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'omniai-models-config.json';
    a.click();
    URL.revokeObjectURL(url);
    pushToast({
      type: 'success',
      title: 'Configurations exported',
      description: `${exported.length} model definitions exported (API keys stripped for security).`,
    });
  };

  const handleImportConfigs = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw new Error('Expected a JSON array of model configurations.');
      }
      const count = await importModelsConfig(parsed);
      pushToast({
        type: 'success',
        title: 'Configurations imported',
        description: `Imported ${count} model(s). Add or verify API keys before running.`,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Import failed',
        description: err instanceof Error ? err.message : 'Invalid model configuration JSON.',
      });
    } finally {
      e.target.value = '';
    }
  };

  const targetBulkIds =
    selectedIds.size > 0 ? Array.from(selectedIds) : sortedModels.map((m) => m.id);

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {t('modelsTitle')}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {t('modelsSubtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {sortedModels.length > 0 && (
            <>
              <button
                type="button"
                onClick={handleExportConfigs}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <Download className="h-3.5 w-3.5" />
                <span>{t('exportConfig')}</span>
              </button>
              <button
                type="button"
                onClick={() => importInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <Upload className="h-3.5 w-3.5" />
                <span>{t('importConfig')}</span>
              </button>
              <button
                type="button"
                onClick={handleTestAll}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Test Enabled</span>
              </button>
            </>
          )}
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleImportConfigs}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => {
              setEditingModel(null);
              setModalOpen(true);
            }}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>{t('addNewModel')}</span>
          </button>
        </div>
      </div>

      {/* Legacy Key Migration Banner */}
      {hasLegacyInlineKeys && (
        <div className="rounded-xl border border-amber-300 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs text-amber-800 dark:text-amber-300">
            <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              One or more models have legacy inline browser keys. Migrate them to the encrypted HTTP-only Server Credential Vault.
            </span>
          </div>
          <button
            type="button"
            onClick={async () => {
              const count = await migrateKeysToVault();
              pushToast({
                type: 'success',
                title: 'Vault migration complete',
                description: `Encrypted and migrated ${count} API key(s) to server vault.`,
              });
            }}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 text-white shrink-0"
          >
            {t('migrateKeys')}
          </button>
        </div>
      )}

      {/* Security Disclosure */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 flex items-start gap-3 text-xs text-slate-600 dark:text-slate-400">
        <Info className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
        <p className="leading-relaxed">{t('browserStorageNotice')}</p>
      </div>

      {/* Bulk actions & Fallback History bar */}
      {sortedModels.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-slate-500 dark:text-slate-400">{t('dragToReorder')}</span>
            <span className="text-slate-300 dark:text-slate-700">|</span>
            <button
              type="button"
              onClick={() => bulkSetModelsEnabled(targetBulkIds, true)}
              className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {selectedIds.size > 0 ? `Enable (${selectedIds.size})` : t('enableSelected')}
            </button>
            <button
              type="button"
              onClick={() => bulkSetModelsEnabled(targetBulkIds, false)}
              className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {selectedIds.size > 0 ? `Disable (${selectedIds.size})` : t('disableSelected')}
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <History className="h-3.5 w-3.5" />
            <span>
              {t('fallbackHistory')} ({fallbackHistory.length})
            </span>
          </button>
        </div>
      )}

      {showHistory && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('fallbackHistory')}
            </h2>
            {fallbackHistory.length > 0 && (
              <button
                type="button"
                onClick={clearFallbackHistory}
                className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-500"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Clear</span>
              </button>
            )}
          </div>
          {fallbackHistory.length === 0 ? (
            <p className="text-xs text-slate-500">
              No automatic fallback switches recorded yet.
            </p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {fallbackHistory.slice(0, 20).map((entry) => (
                <div
                  key={entry.id}
                  className="text-xs rounded-lg border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div className="space-y-0.5">
                    <div className="font-medium text-slate-800 dark:text-slate-200">
                      {entry.failedModel} {'->'} {entry.nextSelectedModel}
                    </div>
                    <div className="text-slate-500 font-mono">
                      [{entry.context}] {entry.errorKind}: {entry.failureReason}
                    </div>
                  </div>
                  <span className="text-[11px] text-slate-400 shrink-0">
                    {formatRelativeTime(entry.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {sortedModels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-12 text-center">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {t('noModelsTitle')}
          </h2>
          <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            {t('noModelsDesc')}
          </p>
          <button
            type="button"
            onClick={() => {
              setEditingModel(null);
              setModalOpen(true);
            }}
            className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
          >
            <Plus className="h-4 w-4" />
            <span>{t('addNewModel')}</span>
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {sortedModels.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              testing={testingModelIds.has(model.id)}
              selected={selectedIds.has(model.id)}
              onToggleSelect={toggleSelect}
              onEdit={(m) => {
                setEditingModel(m);
                setModalOpen(true);
              }}
              onDuplicate={async (m) => {
                const copy = await duplicateModel(m.id);
                if (copy) {
                  pushToast({
                    type: 'success',
                    title: 'Model duplicated',
                    description: `Created ${copy.displayName} at priority #${copy.priority}.`,
                  });
                }
              }}
              onDelete={(m) => setDeleteTarget(m)}
              onTest={testModel}
              onToggleEnabled={(m) => updateModel(m.id, { enabled: !m.enabled })}
              onDragStart={(id) => setDraggedId(id)}
              onDragOver={(e, id) => {
                e.preventDefault();
                if (draggedId && draggedId !== id) setDragTargetId(id);
              }}
              onDrop={handleDrop}
              isDragTarget={dragTargetId === model.id}
            />
          ))}
        </div>
      )}

      <ModelFormModal
        open={modalOpen}
        editingModel={editingModel}
        nextPriority={sortedModels.length + 1}
        onClose={() => setModalOpen(false)}
        onSave={handleSaveModel}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete ${deleteTarget?.displayName || 'Model'}?`}
        description="This removes the model configuration and its stored key from your workspace."
        confirmLabel={t('delete')}
        onConfirm={async () => {
          if (deleteTarget) {
            await deleteModel(deleteTarget.id);
            pushToast({
              type: 'info',
              title: 'Model removed',
              description: `${deleteTarget.displayName} deleted.`,
            });
          }
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
