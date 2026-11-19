import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useApp } from '../contexts/AppContext.tsx';
import type { AIModelConfig } from '../types/index.ts';

interface OrchestratorModelMetric {
  configId: string;
  consecutiveFailures: number;
  cooldownUntil: number;
  cooldownReason?: string;
  successCount: number;
  failureCount: number;
  lastLatencyMs?: number;
  averageLatencyMs?: number;
  lastUpdated: number;
  recentSamples?: Array<{
    ts: number;
    ok: boolean;
    latencyMs?: number;
    errorKind?: string;
  }>;
}

interface OrchestratorMetricsResponse {
  generatedAt: number;
  totalSuccess: number;
  totalFailures: number;
  totalRequests: number;
  models: OrchestratorModelMetric[];
}

function formatCooldownRemaining(cooldownUntil?: number, now = Date.now()): string | null {
  if (!cooldownUntil || cooldownUntil <= now) return null;
  const secs = Math.max(1, Math.ceil((cooldownUntil - now) / 1000));
  return `${secs}s`;
}

export function ModelHealthDashboard({ onNavigateModels }: { onNavigateModels?: () => void }) {
  const {
    models,
    testingModelIds,
    testModel,
    testAllEnabledModels,
    resetModelHealthCooldown,
    setRoute,
    t,
  } = useApp();

  const [now, setNow] = useState(() => Date.now());
  const [testingAll, setTestingAll] = useState(false);
  const [refreshingMetrics, setRefreshingMetrics] = useState(false);
  const [serverMetrics, setServerMetrics] = useState<Record<string, OrchestratorModelMetric>>({});

  const fetchLiveMetrics = useCallback(async () => {
    setRefreshingMetrics(true);
    try {
      const res = await fetch('/api/ai/metrics', { credentials: 'include' });
      if (!res.ok) return;
      const data = (await res.json()) as Partial<OrchestratorMetricsResponse>;
      if (Array.isArray(data.models)) {
        const map: Record<string, OrchestratorModelMetric> = {};
        for (const item of data.models) {
          if (item && item.configId) {
            map[item.configId] = item;
          }
        }
        setServerMetrics(map);
      }
    } catch {
      // Non-fatal if server telemetry is not yet populated
    } finally {
      setRefreshingMetrics(false);
    }
  }, []);

  useEffect(() => {
    void fetchLiveMetrics();
  }, [fetchLiveMetrics]);

  const mergedModels = useMemo(() => {
    return [...models]
      .sort((a, b) => a.priority - b.priority)
      .map((m) => {
        const live = serverMetrics[m.id];
        if (!live) return m;
        const successCount = Math.max(m.successCount ?? 0, live.successCount ?? 0);
        const failureCount = Math.max(m.failureCount ?? 0, live.failureCount ?? 0);
        const consecutiveFailures = Math.max(
          m.consecutiveFailures ?? 0,
          live.consecutiveFailures ?? 0
        );
        const cooldownUntil = Math.max(m.cooldownUntil ?? 0, live.cooldownUntil ?? 0);
        const healthHistory =
          live.recentSamples && live.recentSamples.length > (m.healthHistory?.length ?? 0)
            ? live.recentSamples
            : m.healthHistory;

        return {
          ...m,
          successCount,
          failureCount,
          consecutiveFailures,
          cooldownUntil: cooldownUntil > 0 ? cooldownUntil : undefined,
          lastCooldownReason: live.cooldownReason ?? m.lastCooldownReason,
          lastLatencyMs: live.lastLatencyMs ?? m.lastLatencyMs,
          averageLatencyMs: live.averageLatencyMs ?? m.averageLatencyMs,
          healthHistory,
        };
      });
  }, [models, serverMetrics]);

  const enabledModels = mergedModels.filter((m) => m.enabled);
  const hasActiveCooldown = mergedModels.some((m) => m.cooldownUntil && m.cooldownUntil > now);

  useEffect(() => {
    if (!hasActiveCooldown) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActiveCooldown]);

  const totalSuccess = mergedModels.reduce((acc, m) => acc + (m.successCount ?? 0), 0);
  const totalFailures = mergedModels.reduce((acc, m) => acc + (m.failureCount ?? 0), 0);
  const totalAttempts = totalSuccess + totalFailures;
  const overallSuccessRate =
    totalAttempts > 0 ? Math.round((totalSuccess / totalAttempts) * 100) : null;

  const connectedCount = enabledModels.filter((m) => m.status === 'connected').length;
  const errorOrCooldownCount = enabledModels.filter(
    (m) =>
      m.status === 'error' ||
      m.status === 'rate_limited' ||
      (m.cooldownUntil && m.cooldownUntil > now)
  ).length;

  const latencies = mergedModels
    .map((m) => m.averageLatencyMs ?? m.lastLatencyMs)
    .filter((v): v is number => typeof v === 'number' && v > 0);
  const maxLatency = latencies.length > 0 ? Math.max(...latencies, 1000) : 1000;
  const avgOverallLatency =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;

  const latencyChartData = useMemo(() => {
    return mergedModels.map((m) => {
      const ok = m.successCount ?? 0;
      const fail = m.failureCount ?? 0;
      const total = ok + fail;
      return {
        name:
          m.displayName.length > 16 ? `${m.displayName.slice(0, 14)}…` : m.displayName,
        fullName: m.displayName,
        lastLatencyMs: m.lastLatencyMs ?? 0,
        avgLatencyMs: m.averageLatencyMs ?? m.lastLatencyMs ?? 0,
        reliability: total > 0 ? Math.round((ok / total) * 100) : 100,
      };
    });
  }, [mergedModels]);

  const timelineSeries = useMemo(() => {
    const events: Array<{
      ts: number;
      label: string;
      latencyMs: number;
      statusScore: number;
      model: string;
    }> = [];

    mergedModels.forEach((m) => {
      (m.healthHistory || []).forEach((evt) => {
        events.push({
          ts: evt.ts,
          label: new Date(evt.ts).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
          latencyMs: evt.latencyMs ?? 0,
          statusScore: evt.ok ? 100 : 0,
          model: m.displayName,
        });
      });
    });

    return events.sort((a, b) => a.ts - b.ts).slice(-20);
  }, [mergedModels]);

  const handleTestAll = async () => {
    setTestingAll(true);
    try {
      await testAllEnabledModels();
      await fetchLiveMetrics();
    } finally {
      setTestingAll(false);
    }
  };

  return (
    <section
      aria-label="Model Health Dashboard"
      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden"
    >
      {/* Header & Aggregate Telemetry Strip */}
      <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {t('modelHealth')}
            </h2>
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {connectedCount}/{enabledModels.length} connected · {errorOrCooldownCount} degraded ·{' '}
            {overallSuccessRate !== null
              ? `${overallSuccessRate}% success rate (${totalSuccess} ok / ${totalFailures} fail)`
              : 'No runtime requests recorded yet'}
            {avgOverallLatency !== null ? ` · avg ${avgOverallLatency} ms` : ''}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void fetchLiveMetrics()}
            disabled={refreshingMetrics}
            aria-label="Refresh live orchestrator metrics"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshingMetrics ? 'animate-spin' : ''}`} />
            <span>Sync Metrics</span>
          </button>

          <button
            type="button"
            onClick={handleTestAll}
            disabled={testingAll || enabledModels.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <Play className="h-3.5 w-3.5" />
            <span>{testingAll ? t('testing') : 'Test All Enabled'}</span>
          </button>

          <button
            type="button"
            onClick={() => (onNavigateModels ? onNavigateModels() : setRoute('models'))}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1 whitespace-nowrap px-2 py-1"
          >
            <span>Manage Models</span>
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {mergedModels.length === 0 ? (
        <div className="p-8 text-center">
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('noModelsDesc')}</p>
          <button
            type="button"
            onClick={() => setRoute('models')}
            className="mt-3 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700"
          >
            {t('addNewModel')}
          </button>
        </div>
      ) : (
        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          {/* Performance Visualization Grid (Recharts) */}
          <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-4 bg-slate-50/70 dark:bg-slate-950/40">
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                    Model Latency Comparison (ms)
                  </h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Latest vs. rolling average response latency per configured model
                  </p>
                </div>
                <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                  {avgOverallLatency !== null ? `Mean ${avgOverallLatency} ms` : 'Awaiting runs'}
                </span>
              </div>
              <div className="h-44 w-full min-w-0">
                <ResponsiveContainer width="100%" height={176}>
                  <BarChart data={latencyChartData} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#64748b" strokeOpacity={0.2} />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 11, fill: '#94a3b8' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#94a3b8' }}
                      axisLine={false}
                      tickLine={false}
                      unit="ms"
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#0f172a',
                        borderColor: '#334155',
                        borderRadius: '8px',
                        fontSize: '12px',
                        color: '#f8fafc',
                      }}
                    />
                    <Bar dataKey="avgLatencyMs" name="Avg Latency (ms)" fill="#2563eb" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="lastLatencyMs" name="Last Latency (ms)" fill="#10b981" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                    Recent Orchestrator Telemetry Stream
                  </h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    Chronological latency trace across the latest {timelineSeries.length || 0} dispatch sample(s)
                  </p>
                </div>
                <span className="text-[11px] font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                  {totalSuccess} ok / {totalFailures} fail
                </span>
              </div>
              {timelineSeries.length > 0 ? (
                <div className="h-44 w-full min-w-0">
                  <ResponsiveContainer width="100%" height={176}>
                    <AreaChart data={timelineSeries} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                      <defs>
                        <linearGradient id="omniaiLatencyFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#2563eb" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#2563eb" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#64748b" strokeOpacity={0.2} />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 10, fill: '#94a3b8' }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: '#94a3b8' }}
                        axisLine={false}
                        tickLine={false}
                        unit="ms"
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#0f172a',
                          borderColor: '#334155',
                          borderRadius: '8px',
                          fontSize: '12px',
                          color: '#f8fafc',
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="latencyMs"
                        name="Latency (ms)"
                        stroke="#2563eb"
                        strokeWidth={2}
                        fill="url(#omniaiLatencyFill)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-44 flex items-center justify-center text-xs text-slate-400">
                  Run a connection test or chat prompt to populate live latency samples.
                </div>
              )}
            </div>
          </div>

          {/* Per-Model Detailed Health Table */}
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 px-5 text-start font-medium">{t('priority')}</th>
                  <th className="py-2.5 px-4 text-start font-medium">Model & Roles</th>
                  <th className="py-2.5 px-4 text-start font-medium">{t('status')}</th>
                  <th className="py-2.5 px-4 text-start font-medium">Requests</th>
                  <th className="py-2.5 px-4 text-start font-medium">{t('latency')}</th>
                  <th className="py-2.5 px-4 text-start font-medium">Recent Runs</th>
                  <th className="py-2.5 px-5 text-end font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {mergedModels.map((m) => (
                  <ModelHealthRow
                    key={m.id}
                    model={m}
                    now={now}
                    maxLatency={maxLatency}
                    isTesting={testingModelIds.has(m.id)}
                    onTest={async () => {
                      await testModel(m.id);
                      await fetchLiveMetrics();
                    }}
                    onResetCooldown={async () => {
                      await resetModelHealthCooldown(m.id);
                      await fetchLiveMetrics();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function ModelHealthRow({
  model,
  now,
  maxLatency,
  isTesting,
  onTest,
  onResetCooldown,
}: {
  model: AIModelConfig;
  now: number;
  maxLatency: number;
  isTesting: boolean;
  onTest: () => void;
  onResetCooldown: () => void;
}) {
  const cooldownLeft = formatCooldownRemaining(model.cooldownUntil, now);
  const okCount = model.successCount ?? 0;
  const failCount = model.failureCount ?? 0;
  const total = okCount + failCount;
  const rate = total > 0 ? Math.round((okCount / total) * 100) : null;
  const effectiveLatency = model.averageLatencyMs ?? model.lastLatencyMs;
  const barPct =
    typeof effectiveLatency === 'number' && effectiveLatency > 0
      ? Math.min(100, Math.max(8, Math.round((effectiveLatency / maxLatency) * 100)))
      : 0;

  return (
    <tr className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
      <td className="py-3 px-5 font-mono tabular-nums text-xs text-slate-600 dark:text-slate-300 align-top">
        #{model.priority}
      </td>

      <td className="py-3 px-4 align-top">
        <div className="font-medium text-slate-900 dark:text-slate-100">{model.displayName}</div>
        <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
          {model.providerName} · {model.modelId}
        </div>
        {model.roleTags && model.roleTags.length > 0 && (
          <div className="mt-1 text-[11px] font-mono text-blue-600 dark:text-blue-400">
            Roles: {model.roleTags.join(' · ')}
          </div>
        )}
      </td>

      <td className="py-3 px-4 align-top">
        {!model.enabled ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
            Disabled
          </span>
        ) : cooldownLeft ? (
          <div className="space-y-0.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400 tabular-nums">
              <ShieldAlert className="h-3.5 w-3.5" />
              <span>Cooldown ({cooldownLeft})</span>
            </span>
            {model.lastCooldownReason && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400 max-w-[200px] truncate">
                {model.lastCooldownReason}
              </p>
            )}
          </div>
        ) : model.status === 'connected' ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>Connected</span>
          </span>
        ) : model.status === 'rate_limited' ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            <Clock className="h-3.5 w-3.5" />
            <span>Rate Limited</span>
          </span>
        ) : model.status === 'error' ? (
          <div className="space-y-0.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
              <AlertCircle className="h-3.5 w-3.5" />
              <span>Error</span>
            </span>
            {model.lastError && (
              <p className="text-[11px] text-red-500/90 dark:text-red-400/90 max-w-[200px] truncate">
                {model.lastError}
              </p>
            )}
          </div>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            Untested
          </span>
        )}
      </td>

      <td className="py-3 px-4 font-mono tabular-nums text-xs align-top">
        <div className="text-slate-800 dark:text-slate-200">
          <span className="text-emerald-600 dark:text-emerald-400">{okCount}</span> ok ·{' '}
          <span className={failCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-500'}>
            {failCount}
          </span>{' '}
          fail
        </div>
        <div className="text-[11px] text-slate-500 dark:text-slate-400">
          {rate !== null ? `${rate}% reliability` : 'No traffic'}
          {(model.consecutiveFailures ?? 0) >= 2 && (
            <span className="text-amber-600 dark:text-amber-400">
              {' '}
              · {model.consecutiveFailures} streak fail
            </span>
          )}
        </div>
      </td>

      <td className="py-3 px-4 font-mono tabular-nums text-xs align-top min-w-[130px]">
        <div className="text-slate-700 dark:text-slate-300">
          {typeof model.lastLatencyMs === 'number' ? `${model.lastLatencyMs} ms` : '—'}
          {typeof model.averageLatencyMs === 'number' &&
            model.averageLatencyMs !== model.lastLatencyMs && (
              <span className="text-slate-400"> (avg {model.averageLatencyMs} ms)</span>
            )}
        </div>
        {barPct > 0 && (
          <div className="mt-1.5 h-1.5 w-24 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
            <div
              className={`h-full rounded-full ${
                effectiveLatency! > 3000 ? 'bg-amber-500' : 'bg-blue-500 dark:bg-blue-400'
              }`}
              style={{ width: `${barPct}%` }}
            />
          </div>
        )}
      </td>

      <td className="py-3 px-4 align-top">
        {model.healthHistory && model.healthHistory.length > 0 ? (
          <div className="flex items-center gap-1" title="Recent requests (oldest to newest)">
            {model.healthHistory.slice(-10).map((evt, idx) => (
              <span
                key={`${evt.ts}-${idx}`}
                title={`${evt.ok ? 'OK' : evt.errorKind || 'Error'}${evt.latencyMs ? ` (${evt.latencyMs}ms)` : ''}`}
                className={`inline-block w-2 h-4 rounded-xs ${
                  evt.ok
                    ? 'bg-emerald-500'
                    : evt.errorKind === 'RATE_LIMIT' || evt.errorKind === 'QUOTA_EXCEEDED'
                      ? 'bg-amber-500'
                      : 'bg-red-500'
                }`}
              />
            ))}
          </div>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        )}
      </td>

      <td className="py-3 px-5 text-end align-top">
        <div className="inline-flex items-center gap-1.5">
          {cooldownLeft && (
            <button
              type="button"
              onClick={onResetCooldown}
              title="Clear cooldown circuit breaker"
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 whitespace-nowrap"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Reset</span>
            </button>
          )}
          <button
            type="button"
            onClick={onTest}
            disabled={isTesting}
            className="px-2.5 py-1 text-xs font-medium rounded-md border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
          >
            {isTesting ? 'Testing...' : 'Test'}
          </button>
        </div>
      </td>
    </tr>
  );
}
