import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Download,
  HelpCircle,
  Play,
  Stethoscope,
  XCircle,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';
import { runProviderDiagnostics } from '../orchestration/fallbackClient.ts';
import type {
  DiagnosticCategory,
  DiagnosticOutcomeStatus,
  DiagnosticTestResult,
} from '../types/index.ts';

const ALL_TESTS: Array<{ id: DiagnosticCategory; label: string; description: string }> = [
  { id: 'text', label: 'Basic Text Completion', description: 'Verify provider endpoint & auth reachability.' },
  { id: 'streaming', label: 'SSE Streaming', description: 'Confirm incremental token streaming.' },
  { id: 'json', label: 'Structured JSON', description: 'Check strict JSON object generation.' },
  { id: 'tool-calling', label: 'Tool / Function Calling', description: 'Check structured tool call JSON intent.' },
  { id: 'image', label: 'Image / Vision Probe', description: 'Send a 1x1 test PNG if multimodal.' },
  { id: 'long-context', label: 'Long Context Recall', description: 'Probe extended prompt processing.' },
  { id: 'fallback', label: 'Orchestrator Failover', description: 'Verify >= 2 enabled models are ready.' },
];

export function DiagnosticsPage() {
  const { models, settings, pushToast } = useApp();

  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(() =>
    models.filter((m) => m.enabled).map((m) => m.id)
  );
  const [selectedTests, setSelectedTests] = useState<DiagnosticCategory[]>([
    'text',
    'streaming',
    'json',
    'fallback',
  ]);
  const [running, setRunning] = useState(false);
  const [ranAt, setRanAt] = useState<number | null>(null);
  const [results, setResults] = useState<DiagnosticTestResult[]>([]);

  const toggleModel = (id: string) => {
    setSelectedModelIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleTest = (id: DiagnosticCategory) => {
    setSelectedTests((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleRunDiagnostics = async () => {
    const targetModels =
      selectedModelIds.length > 0
        ? models.filter((m) => selectedModelIds.includes(m.id))
        : models;

    if (targetModels.length === 0) {
      pushToast({
        type: 'warning',
        title: 'No models available',
        description: 'Add at least one AI model before running diagnostics.',
      });
      return;
    }

    setRunning(true);
    try {
      const resp = await runProviderDiagnostics({
        models: targetModels,
        tests: selectedTests,
        timeoutMs: Math.min(settings.fallbackPolicy.timeoutMs, 20000),
      });
      setResults(resp.results);
      setRanAt(resp.ranAt);
      pushToast({
        type: 'info',
        title: 'Diagnostics complete',
        description: `Executed ${resp.results.length} live check(s). Missing keys are marked NOT CONFIGURED.`,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Diagnostics failed',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(false);
    }
  };

  const handleExportReport = () => {
    if (results.length === 0) return;
    const payload = {
      exportedAt: Date.now(),
      ranAt,
      results,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `omniai-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderStatusBadge = (status: DiagnosticOutcomeStatus) => {
    switch (status) {
      case 'PASSED':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>PASSED</span>
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400">
            <XCircle className="h-3.5 w-3.5" />
            <span>FAILED</span>
          </span>
        );
      case 'NOT CONFIGURED':
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
            <AlertCircle className="h-3.5 w-3.5" />
            <span>NOT CONFIGURED</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
            <HelpCircle className="h-3.5 w-3.5" />
            <span>{status}</span>
          </span>
        );
    }
  };

  const summary = {
    passed: results.filter((r) => r.status === 'PASSED').length,
    failed: results.filter((r) => r.status === 'FAILED').length,
    notConfigured: results.filter((r) => r.status === 'NOT CONFIGURED').length,
    unsupported: results.filter((r) => r.status === 'UNSUPPORTED' || r.status === 'SKIPPED').length,
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100 flex items-center gap-2.5">
            <Stethoscope className="h-6 w-6 text-blue-600 dark:text-blue-400" />
            <span>Provider Integration Diagnostics</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Execute real provider probes without mocked successes. Missing credentials explicitly report <code className="font-mono">NOT CONFIGURED</code>.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {results.length > 0 && (
            <button
              type="button"
              onClick={handleExportReport}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export JSON Report</span>
            </button>
          )}
          <button
            type="button"
            onClick={handleRunDiagnostics}
            disabled={running || models.length === 0 || selectedTests.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
          >
            <Play className="h-4 w-4" />
            <span>{running ? 'Running Live Probes...' : 'Run Diagnostics'}</span>
          </button>
        </div>
      </div>

      {/* Configuration Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            1. Select Models ({selectedModelIds.length}/{models.length})
          </h2>
          {models.length === 0 ? (
            <p className="text-xs text-slate-500">No models configured yet.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {models.map((m) => (
                <label
                  key={m.id}
                  className="flex items-center justify-between gap-3 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-950/60 cursor-pointer text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <input
                      type="checkbox"
                      checked={selectedModelIds.includes(m.id)}
                      onChange={() => toggleModel(m.id)}
                    />
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                        #{m.priority} {m.displayName}
                      </div>
                      <div className="font-mono text-[11px] text-slate-500 truncate">
                        {m.providerName} · {m.modelId} · {m.protocol}
                      </div>
                    </div>
                  </div>
                  <span className="text-[11px] font-mono text-slate-500 shrink-0">
                    {m.useServerEnvKey
                      ? 'Env Key'
                      : m.credentialRefId
                        ? 'Vaulted Key'
                        : m.apiKey
                          ? 'Inline Key'
                          : 'No Key'}
                  </span>
                </label>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            2. Diagnostic Test Probes
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {ALL_TESTS.map((probe) => (
              <label
                key={probe.id}
                className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-950/60 cursor-pointer text-xs"
              >
                <input
                  type="checkbox"
                  checked={selectedTests.includes(probe.id)}
                  onChange={() => toggleTest(probe.id)}
                  className="mt-0.5"
                />
                <div>
                  <div className="font-medium text-slate-900 dark:text-slate-100">{probe.label}</div>
                  <div className="text-[11px] text-slate-500">{probe.description}</div>
                </div>
              </label>
            ))}
          </div>
        </section>
      </div>

      {/* Results Matrix */}
      {results.length > 0 && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Diagnostic Matrix {ranAt ? `· ${new Date(ranAt).toLocaleTimeString()}` : ''}
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">PASSED: {summary.passed}</span>
              <span className="text-red-600 dark:text-red-400">FAILED: {summary.failed}</span>
              <span className="text-amber-600 dark:text-amber-400">
                NOT CONFIGURED: {summary.notConfigured}
              </span>
              <span className="text-slate-500">UNSUPPORTED: {summary.unsupported}</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 px-5 text-start font-medium">Model</th>
                  <th className="py-2.5 px-4 text-start font-medium">Provider</th>
                  <th className="py-2.5 px-4 text-start font-medium">Test Category</th>
                  <th className="py-2.5 px-4 text-start font-medium">Outcome</th>
                  <th className="py-2.5 px-4 text-end font-medium">Latency</th>
                  <th className="py-2.5 px-5 text-start font-medium">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {results.map((r, idx) => (
                  <tr key={`${r.modelConfigId}-${r.test}-${idx}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2.5 px-5 font-medium text-slate-900 dark:text-slate-100">
                      {r.modelDisplayName}
                    </td>
                    <td className="py-2.5 px-4 text-slate-600 dark:text-slate-300">{r.providerName}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-700 dark:text-slate-300">{r.test}</td>
                    <td className="py-2.5 px-4">{renderStatusBadge(r.status)}</td>
                    <td className="py-2.5 px-4 text-end font-mono tabular-nums text-slate-500">
                      {r.latencyMs > 0 ? `${r.latencyMs} ms` : '—'}
                    </td>
                    <td className="py-2.5 px-5 text-slate-600 dark:text-slate-400 max-w-md break-words">
                      {r.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
