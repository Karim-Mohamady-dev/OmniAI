import React, { useMemo, useState } from 'react';
import { BarChart3, Download, Info, Trash2 } from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';

type TimeWindow = '24h' | '7d' | '30d' | 'all';

export function AnalyticsPage() {
  const { models, projects, usageRecords, updateModel, clearUsageRecords, pushToast } = useApp();
  const [windowFilter, setWindowFilter] = useState<TimeWindow>('all');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>('all');

  const providers = useMemo(
    () => Array.from(new Set(usageRecords.map((r) => r.providerName))),
    [usageRecords]
  );

  const filteredRecords = useMemo(() => {
    const now = Date.now();
    const cutoff =
      windowFilter === '24h'
        ? now - 24 * 60 * 60 * 1000
        : windowFilter === '7d'
          ? now - 7 * 24 * 60 * 60 * 1000
          : windowFilter === '30d'
            ? now - 30 * 24 * 60 * 60 * 1000
            : 0;

    return usageRecords.filter((r) => {
      if (r.timestamp < cutoff) return false;
      if (providerFilter !== 'all' && r.providerName !== providerFilter) return false;
      if (projectFilter !== 'all' && r.projectId !== projectFilter) return false;
      return true;
    });
  }, [usageRecords, windowFilter, providerFilter, projectFilter]);

  const metrics = useMemo(() => {
    let reportedTokens = 0;
    let estimatedTokens = 0;
    let calculatedCostUsd = 0;
    let estimatedCostUsd = 0;
    let hasAnyCost = false;

    const byModel = new Map<
      string,
      {
        key: string;
        displayName: string;
        providerName: string;
        reportedTokens: number;
        estimatedTokens: number;
        calls: number;
        costUsd: number;
        hasCost: boolean;
      }
    >();

    for (const r of filteredRecords) {
      const total = r.totalTokens ?? (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
      if (r.tokenSource === 'provider-reported') reportedTokens += total;
      else if (r.tokenSource === 'estimated') estimatedTokens += total;

      if (typeof r.estimatedCostUsd === 'number') {
        hasAnyCost = true;
        if (r.costStatus === 'calculated') calculatedCostUsd += r.estimatedCostUsd;
        else estimatedCostUsd += r.estimatedCostUsd;
      }

      const key = `${r.providerName}::${r.displayName}`;
      const existing = byModel.get(key) || {
        key,
        displayName: r.displayName,
        providerName: r.providerName,
        reportedTokens: 0,
        estimatedTokens: 0,
        calls: 0,
        costUsd: 0,
        hasCost: false,
      };
      existing.calls += 1;
      if (r.tokenSource === 'provider-reported') existing.reportedTokens += total;
      else if (r.tokenSource === 'estimated') existing.estimatedTokens += total;
      if (typeof r.estimatedCostUsd === 'number') {
        existing.hasCost = true;
        existing.costUsd += r.estimatedCostUsd;
      }
      byModel.set(key, existing);
    }

    const perModelList = Array.from(byModel.values()).sort(
      (a, b) => b.reportedTokens + b.estimatedTokens - (a.reportedTokens + a.estimatedTokens)
    );
    const maxTokens = Math.max(
      1,
      ...perModelList.map((m) => m.reportedTokens + m.estimatedTokens)
    );

    return {
      reportedTokens,
      estimatedTokens,
      calculatedCostUsd,
      estimatedCostUsd,
      hasAnyCost,
      perModelList,
      maxTokens,
    };
  }, [filteredRecords]);

  const exportCsv = () => {
    const header = [
      'id',
      'timestamp',
      'displayName',
      'providerName',
      'context',
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'tokenSource',
      'estimatedCostUsd',
      'costStatus',
    ].join(',');
    const rows = filteredRecords.map((r) =>
      [
        r.id,
        new Date(r.timestamp).toISOString(),
        `"${r.displayName.replace(/"/g, '""')}"`,
        `"${r.providerName.replace(/"/g, '""')}"`,
        r.context,
        r.inputTokens ?? '',
        r.outputTokens ?? '',
        r.totalTokens ?? '',
        r.tokenSource,
        r.estimatedCostUsd ?? '',
        r.costStatus,
      ].join(',')
    );
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `omniai-usage-analytics-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 flex items-center gap-2.5">
            <BarChart3 className="h-6 w-6 text-blue-600 dark:text-blue-400" />
            <span>Usage &amp; Cost Analytics</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Tracks exact provider-reported usage separately from character-heuristic estimates and custom pricing rates.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={exportCsv}
            disabled={filteredRecords.length === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export CSV</span>
          </button>
          <button
            type="button"
            onClick={async () => {
              await clearUsageRecords();
              pushToast({ type: 'info', title: 'Usage analytics cleared' });
            }}
            disabled={usageRecords.length === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Clear History</span>
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-slate-500">Window:</span>
          {(['24h', '7d', '30d', 'all'] as TimeWindow[]).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindowFilter(w)}
              className={`px-2.5 py-1 rounded-md font-medium ${
                windowFilter === w
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {w.toUpperCase()}
            </button>
          ))}
        </div>

        <select
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
          className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
        >
          <option value="all">All Providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
        >
          <option value="all">All Projects &amp; Chats</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              Project: {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="text-xs font-medium text-slate-500">Provider-Reported Tokens</div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
            {metrics.reportedTokens.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">Verified directly from API payloads</p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="text-xs font-medium text-slate-500">Estimated Tokens</div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-amber-600 dark:text-amber-400">
            {metrics.estimatedTokens.toLocaleString()}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">Labeled approximate (~4 chars/token) when omitted</p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="text-xs font-medium text-slate-500">Recorded Requests</div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {filteredRecords.length}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">Across chat &amp; studio builds</p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="text-xs font-medium text-slate-500">Spend (Configured Rates)</div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {metrics.hasAnyCost
              ? `$${(metrics.calculatedCostUsd + metrics.estimatedCostUsd).toFixed(4)}`
              : 'Cost Unavailable'}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">
            {metrics.hasAnyCost
              ? `$${metrics.calculatedCostUsd.toFixed(4)} verified · $${metrics.estimatedCostUsd.toFixed(4)} estimated`
              : 'Configure model token pricing below to calculate'}
          </p>
        </div>
      </div>

      {/* Token Breakdown Bar Chart */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Token Consumption by Model
          </h2>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500">
            <Info className="h-3.5 w-3.5" />
            <span>Green = Provider-Reported · Amber = Estimated</span>
          </span>
        </div>

        {metrics.perModelList.length === 0 ? (
          <p className="text-xs text-slate-500 py-6 text-center">
            No usage records recorded in the selected window yet. Send a chat or run AI Builder to start tracking.
          </p>
        ) : (
          <div className="space-y-3">
            {metrics.perModelList.map((row) => {
              const total = row.reportedTokens + row.estimatedTokens;
              const repPct = Math.round((row.reportedTokens / metrics.maxTokens) * 100);
              const estPct = Math.round((row.estimatedTokens / metrics.maxTokens) * 100);
              return (
                <div key={row.key} className="space-y-1 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-800 dark:text-slate-200">
                      {row.displayName}{' '}
                      <span className="text-slate-400 font-normal">({row.providerName})</span>
                    </span>
                    <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {total.toLocaleString()} tokens · {row.calls} calls
                      {row.hasCost ? ` · $${row.costUsd.toFixed(4)}` : ' · Cost unavailable'}
                    </span>
                  </div>
                  <div className="h-2.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex">
                    {repPct > 0 && (
                      <div className="h-full bg-emerald-500" style={{ width: `${repPct}%` }} />
                    )}
                    {estPct > 0 && (
                      <div className="h-full bg-amber-500" style={{ width: `${estPct}%` }} />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Model Pricing Configuration */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            User-Supplied Token Pricing ($ per 1M tokens)
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            OmniAI Studio never guesses vendor pricing. Enter exact provider rates here to enable cost tracking.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                <th className="py-2.5 px-5 text-start font-medium">Model</th>
                <th className="py-2.5 px-4 text-start font-medium">Provider</th>
                <th className="py-2.5 px-4 text-start font-medium">Input $ / 1M</th>
                <th className="py-2.5 px-5 text-start font-medium">Output $ / 1M</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {models.map((m) => (
                <tr key={m.id}>
                  <td className="py-2.5 px-5 font-medium text-slate-900 dark:text-slate-100">
                    {m.displayName}
                  </td>
                  <td className="py-2.5 px-4 text-slate-600 dark:text-slate-300">{m.providerName}</td>
                  <td className="py-2.5 px-4">
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      placeholder="Unavailable"
                      value={m.pricing?.inputPer1MUsd ?? ''}
                      onChange={(e) => {
                        const val = e.target.value.trim();
                        updateModel(m.id, {
                          pricing: {
                            ...m.pricing,
                            inputPer1MUsd: val === '' ? undefined : Number(val),
                            source: 'custom',
                          },
                        });
                      }}
                      className="w-28 font-mono tabular-nums rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1"
                    />
                  </td>
                  <td className="py-2.5 px-5">
                    <input
                      type="number"
                      step="0.01"
                      min={0}
                      placeholder="Unavailable"
                      value={m.pricing?.outputPer1MUsd ?? ''}
                      onChange={(e) => {
                        const val = e.target.value.trim();
                        updateModel(m.id, {
                          pricing: {
                            ...m.pricing,
                            outputPer1MUsd: val === '' ? undefined : Number(val),
                            source: 'custom',
                          },
                        });
                      }}
                      className="w-28 font-mono tabular-nums rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
