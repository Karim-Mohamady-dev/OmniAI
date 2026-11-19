import React from 'react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  Copy,
  Edit3,
  GripVertical,
  Power,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';
import type { AIModelConfig } from '../types/index.ts';
import { formatRelativeTime, maskApiKey } from '../utils/helpers.ts';

interface ModelCardProps {
  model: AIModelConfig;
  testing: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
  onEdit: (model: AIModelConfig) => void;
  onDuplicate: (model: AIModelConfig) => void;
  onDelete: (model: AIModelConfig) => void;
  onTest: (id: string) => void;
  onToggleEnabled: (model: AIModelConfig) => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDrop: (id: string) => void;
  isDragTarget: boolean;
}

export function ModelCard({
  model,
  testing,
  selected = false,
  onToggleSelect,
  onEdit,
  onDuplicate,
  onDelete,
  onTest,
  onToggleEnabled,
  onDragStart,
  onDragOver,
  onDrop,
  isDragTarget,
}: ModelCardProps) {
  const { t } = useApp();

  const statusMeta =
    model.status === 'connected'
      ? {
          icon: <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />,
          label: 'Connected',
          colorClass: 'text-emerald-600 dark:text-emerald-400',
        }
      : model.status === 'rate_limited'
        ? {
            icon: <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />,
            label: 'Rate Limited / Quota',
            colorClass: 'text-amber-600 dark:text-amber-400',
          }
        : model.status === 'error'
          ? {
              icon: <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />,
              label: 'Connection Error',
              colorClass: 'text-red-600 dark:text-red-400',
            }
          : {
              icon: <Activity className="h-4 w-4 text-slate-400" />,
              label: 'Not Tested',
              colorClass: 'text-slate-500 dark:text-slate-400',
            };

  const activeCaps = Object.entries(model.capabilities || {})
    .filter(([, enabled]) => Boolean(enabled))
    .map(([key]) => key)
    .slice(0, 5);

  const displayedKey = model.useServerEnvKey
    ? 'Server Environment Managed'
    : model.credentialRefId
      ? `${model.maskedApiKey || 'Encrypted'} (Vault)`
      : maskApiKey(model.apiKey, false);

  return (
    <div
      draggable
      onDragStart={() => onDragStart(model.id)}
      onDragOver={(e) => onDragOver(e, model.id)}
      onDrop={() => onDrop(model.id)}
      className={`rounded-xl border transition-colors bg-white dark:bg-slate-900 p-5 ${
        isDragTarget
          ? 'border-blue-500 ring-2 ring-blue-500/20'
          : selected
            ? 'border-indigo-500/70'
            : 'border-slate-200 dark:border-slate-800'
      } ${!model.enabled ? 'opacity-70' : ''}`}
    >
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(model.id)}
              aria-label={`Select ${model.displayName}`}
              className="mt-1.5 rounded border-slate-300 dark:border-slate-700"
            />
          )}

          <button
            type="button"
            className="mt-1 p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-grab active:cursor-grabbing shrink-0"
            title={t('dragToReorder')}
            aria-label="Drag to reorder"
          >
            <GripVertical className="h-4 w-4" />
          </button>

          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono tabular-nums text-xs font-semibold text-blue-600 dark:text-blue-400">
                #{model.priority}
              </span>
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
                {model.displayName}
              </h3>
            </div>

            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <span>{model.providerName}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-slate-700 dark:text-slate-300">{model.modelId}</span>
              <span aria-hidden="true">·</span>
              <span>{model.protocol}</span>
              {model.pricingTier === 'free-tier-explicit' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                    Provider Free Access
                  </span>
                </>
              )}
              {model.maxContextWindow && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {model.maxContextWindow.toLocaleString()} ctx
                  </span>
                </>
              )}
              {model.maxOutputTokens && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {model.maxOutputTokens.toLocaleString()} max out
                  </span>
                </>
              )}
            </div>

            {activeCaps.length > 0 && (
              <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                Capabilities: {activeCaps.join(' · ')}
                {model.roleTags && model.roleTags.length > 0 ? ` | Roles: ${model.roleTags.join(', ')}` : ''}
              </div>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => onTest(model.id)}
            disabled={testing}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
          >
            {testing ? t('testing') : t('testConnection')}
          </button>

          <button
            type="button"
            onClick={() => onToggleEnabled(model)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              model.enabled
                ? 'border-emerald-200 dark:border-emerald-900/60 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40'
                : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Power className="h-3.5 w-3.5" />
            <span>{model.enabled ? t('enabled') : t('disabled')}</span>
          </button>

          <button
            type="button"
            onClick={() => onDuplicate(model)}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title={t('duplicate')}
            aria-label={t('duplicate')}
          >
            <Copy className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => onEdit(model)}
            className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label={t('edit')}
          >
            <Edit3 className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => onDelete(model)}
            className="p-2 rounded-lg text-slate-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
            aria-label={t('delete')}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Status, API Key Mask, Usage & Last Error Row */}
      <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className={`inline-flex items-center gap-1.5 font-medium ${statusMeta.colorClass}`}>
            {statusMeta.icon}
            <span>{statusMeta.label}</span>
          </span>

          <span className="text-slate-500 dark:text-slate-400">
            Availability: <strong className="font-medium text-slate-700 dark:text-slate-300">{model.enabled ? 'Active in Pool' : 'Paused'}</strong>
          </span>

          <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400 font-mono">
            {model.credentialRefId && <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />}
            Key: {displayedKey}
          </span>

          {typeof model.lastLatencyMs === 'number' && (
            <span className="text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              Latency: {model.lastLatencyMs}ms
            </span>
          )}

          {((model.successCount ?? 0) > 0 || (model.failureCount ?? 0) > 0) && (
            <span className="text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              Runs: {model.successCount ?? 0} ok / {model.failureCount ?? 0} fail
            </span>
          )}

          {model.cooldownUntil && model.cooldownUntil > Date.now() && (
            <span className="text-amber-600 dark:text-amber-400 font-mono tabular-nums font-medium">
              Cooling down ({Math.ceil((model.cooldownUntil - Date.now()) / 1000)}s)
            </span>
          )}

          {model.lastSuccessAt && (
            <span className="text-slate-500 dark:text-slate-400">
              Last OK: {formatRelativeTime(model.lastSuccessAt)}
            </span>
          )}

          {model.lastUsage?.totalTokens && (
            <span className="text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              Usage: {model.lastUsage.totalTokens.toLocaleString()} tokens
            </span>
          )}
        </div>

        {model.lastError && (
          <p className="text-red-600 dark:text-red-400 font-mono text-xs truncate max-w-full">
            Last error: {model.lastError}
          </p>
        )}
      </div>
    </div>
  );
}
