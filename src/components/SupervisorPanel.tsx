import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Play, ShieldAlert, ShieldCheck, Square, Wrench } from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';
import { streamOrchestratedChat } from '../orchestration/fallbackClient.ts';
import type {
  Project,
  SupervisorCategory,
  SupervisorFinding,
  SupervisorReport,
} from '../types/index.ts';
import { createId, formatRelativeTime } from '../utils/helpers.ts';

interface SupervisorPanelProps {
  project: Project;
  buildErrors: string[];
  autoTriggerToken?: number;
  onApplyFileFix: (path: string, content: string, rationale: string) => void;
}

const ALL_CATEGORIES: SupervisorCategory[] = [
  'architecture',
  'code-quality',
  'security',
  'performance',
  'accessibility',
  'responsive',
  'dependencies',
  'broken-imports',
  'typescript',
  'build-errors',
  'missing-requirements',
];

function resolveRelativeTarget(fromPath: string, spec: string, projectPaths: Set<string>): boolean {
  const normalizedFrom = fromPath.replace(/\\/g, '/');
  const dirParts = normalizedFrom.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      dirParts.pop();
    } else {
      dirParts.push(part);
    }
  }
  const base = dirParts.join('/');
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.css`,
    `${base}.json`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  return candidates.some((c) => projectPaths.has(c));
}

export function runDeterministicStaticChecks(
  project: Project,
  buildErrors: string[]
): SupervisorFinding[] {
  const findings: SupervisorFinding[] = [];
  const filePaths = new Set(project.files.map((f) => f.path.replace(/\\/g, '/')));

  // 1. Committed secret files or exposed key patterns
  for (const file of project.files) {
    const fileName = file.path.split('/').pop() || '';
    if (/^(\.env(\..+)?|id_rsa|.*\.pem|.*\.key)$/i.test(fileName)) {
      findings.push({
        id: createId('sup_stat'),
        severity: 'critical',
        category: 'security',
        title: `Sensitive file "${file.path}" committed in project`,
        description:
          'Environment or private key files should never be bundled into frontend source trees or published to GitHub.',
        evidence: `Matched sensitive filename: ${file.path}`,
        filePath: file.path,
      });
    } else if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b/.test(file.content)) {
      findings.push({
        id: createId('sup_stat'),
        severity: 'critical',
        category: 'security',
        title: `Potential hardcoded secret or private key in "${file.path}"`,
        description:
          'Move API keys and private credentials to server environment secrets rather than client code.',
        evidence: `Secret signature detected in ${file.path}`,
        filePath: file.path,
      });
    }

    // 2. Empty source files
    if (/\.(ts|tsx|js|jsx|css|html)$/i.test(file.path) && file.content.trim().length === 0) {
      findings.push({
        id: createId('sup_stat'),
        severity: 'warning',
        category: 'code-quality',
        title: `Empty source file "${file.path}"`,
        description: 'Empty files often indicate incomplete generation or leftover placeholders.',
        evidence: `${file.path} contains 0 non-whitespace characters`,
        filePath: file.path,
      });
    }

    // 3. Broken relative imports
    if (/\.(ts|tsx|js|jsx)$/i.test(file.path)) {
      const importRegex = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(file.content)) !== null) {
        const spec = match[1];
        if (!resolveRelativeTarget(file.path, spec, filePaths)) {
          findings.push({
            id: createId('sup_stat'),
            severity: 'critical',
            category: 'broken-imports',
            title: `Broken relative import "${spec}" in ${file.path}`,
            description: `Module "${spec}" could not be resolved against any file in this project.`,
            evidence: `${file.path}: import "${spec}" -> target file missing`,
            filePath: file.path,
          });
        }
      }
    }
  }

  // 4. Active esbuild / runtime errors
  for (const err of buildErrors) {
    if (!err.trim()) continue;
    findings.push({
      id: createId('sup_stat'),
      severity: 'critical',
      category: 'build-errors',
      title: 'Build / runtime compilation failure',
      description: err,
      evidence: err,
    });
  }

  return findings;
}

export function computeSupervisorMetrics(findings: SupervisorFinding[]): {
  healthScore: number;
  publishGate: SupervisorReport['publishGate'];
  overallHealth: SupervisorReport['overallHealth'];
} {
  const active = findings.filter((f) => !f.applied);
  const criticalCount = active.filter((f) => f.severity === 'critical').length;
  const warningCount = active.filter((f) => f.severity === 'warning').length;
  const suggestionCount = active.filter((f) => f.severity === 'suggestion').length;

  const rawScore = 100 - criticalCount * 25 - warningCount * 10 - suggestionCount * 3;
  const healthScore = Math.max(0, Math.min(100, rawScore));
  const publishGate: SupervisorReport['publishGate'] =
    criticalCount > 0 ? 'BLOCKED' : warningCount > 0 ? 'WARNING' : 'PASS';
  const overallHealth: SupervisorReport['overallHealth'] =
    criticalCount > 0 ? 'critical' : warningCount > 0 ? 'needs-attention' : 'healthy';

  return { healthScore, publishGate, overallHealth };
}

export function SupervisorPanel({
  project,
  buildErrors,
  autoTriggerToken = 0,
  onApplyFileFix,
}: SupervisorPanelProps) {
  const { models, settings, updateSettings, recordFallbackEvent, pushToast, t } = useApp();
  const [inspecting, setInspecting] = useState(false);
  const [report, setReport] = useState<SupervisorReport | null>(null);
  const [rawReport, setRawReport] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const lastTriggerRef = useRef<number>(0);

  const enabledModels = [...models].filter((m) => m.enabled).sort((a, b) => a.priority - b.priority);
  const selectedSupervisorModel =
    enabledModels.find((m) => m.id === settings.supervisor.modelConfigId) || enabledModels[0] || null;

  const runStaticAuditOnly = useCallback(() => {
    const staticFindings = runDeterministicStaticChecks(project, buildErrors);
    const metrics = computeSupervisorMetrics(staticFindings);
    setReport({
      ...metrics,
      summary:
        staticFindings.length === 0
          ? 'Deterministic static audit passed with zero security, import, or build errors.'
          : `Deterministic static audit detected ${staticFindings.length} issue(s) requiring review.`,
      inspectedAt: Date.now(),
      modelName: 'Static Analyzer',
      findings: staticFindings,
    });
  }, [buildErrors, project]);

  const runInspection = useCallback(async () => {
    if (!settings.supervisor.enabled) return;

    const staticFindings = runDeterministicStaticChecks(project, buildErrors);
    if (!selectedSupervisorModel) {
      const metrics = computeSupervisorMetrics(staticFindings);
      setReport({
        ...metrics,
        summary:
          'No AI Supervisor model enabled — displaying deterministic static audit results only.',
        inspectedAt: Date.now(),
        modelName: 'Static Analyzer',
        findings: staticFindings,
      });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setInspecting(true);
    setReport(null);
    setRawReport('');

    const filesSnapshot = project.files
      .slice(0, 28)
      .map((f) => `--- FILE: ${f.path} ---\n${f.content.slice(0, 4500)}`)
      .join('\n\n');

    const prompt = `Audit this software project across all 11 engineering quality dimensions:
Categories: ${ALL_CATEGORIES.join(', ')}.

Project Name: ${project.name}
Framework: ${project.framework}
Recent Build/Runtime Errors: ${buildErrors.length > 0 ? buildErrors.join('\n') : 'None reported'}

Project Files:
${filesSnapshot}

Return ONLY valid JSON matching this schema:
{
  "overallHealth": "healthy" | "needs-attention" | "critical",
  "summary": "Brief architectural and code quality assessment",
  "findings": [
    {
      "severity": "critical" | "warning" | "suggestion",
      "category": "${ALL_CATEGORIES.join('" | "')}",
      "title": "Short issue title",
      "description": "Concrete explanation referencing exact file paths",
      "evidence": "Specific line or code snippet proving this finding",
      "filePath": "optional/path.tsx",
      "proposedFix": {
        "path": "optional/path.tsx",
        "content": "complete corrected file content if a safe fix applies",
        "rationale": "why this fix is safe"
      }
    }
  ]
}`;

    const pool = [
      selectedSupervisorModel,
      ...enabledModels.filter((m) => m.id !== selectedSupervisorModel.id),
    ];

    let accumulated = '';
    let activeModelName = selectedSupervisorModel.displayName;
    try {
      await streamOrchestratedChat({
        models: pool,
        messages: [{ role: 'user', content: prompt }],
        systemInstruction:
          'You are an independent Senior Code Reviewer, Security Auditor, and Accessibility Supervisor. Output strict JSON only.',
        policy: settings.fallbackPolicy,
        routingMode: settings.routingMode,
        signal: controller.signal,
        callbacks: {
          onAttempt: (info) => {
            activeModelName = info.displayName;
          },
          onSwitched: (info) => {
            activeModelName = info.toModel;
            recordFallbackEvent({
              timestamp: Date.now(),
              originalModel: selectedSupervisorModel.displayName,
              failedModel: info.fromModel,
              failureReason: info.reason,
              errorKind: info.errorKind,
              nextSelectedModel: info.toModel,
              context: 'supervisor',
            });
          },
          onDelta: ({ text }) => {
            accumulated += text;
            setRawReport(accumulated);
          },
          onDone: () => {
            try {
              const cleaned = accumulated
                .replace(/^```json\s*/i, '')
                .replace(/^```\s*/i, '')
                .replace(/```$/i, '')
                .trim();
              const parsed = JSON.parse(cleaned) as {
                overallHealth?: SupervisorReport['overallHealth'];
                summary?: string;
                findings?: Omit<SupervisorFinding, 'id'>[];
              };
              const aiFindings: SupervisorFinding[] = (parsed.findings || []).map((f) => ({
                ...f,
                id: createId('sup'),
                applied: false,
              }));

              if (settings.supervisor.mode === 'auto-review') {
                aiFindings.forEach((finding) => {
                  if (
                    finding.proposedFix?.path &&
                    finding.proposedFix?.content &&
                    finding.severity !== 'suggestion'
                  ) {
                    onApplyFileFix(
                      finding.proposedFix.path,
                      finding.proposedFix.content,
                      finding.proposedFix.rationale
                    );
                    finding.applied = true;
                  }
                });
              }

              const combinedFindings = [...staticFindings, ...aiFindings];
              const metrics = computeSupervisorMetrics(combinedFindings);

              setReport({
                overallHealth: metrics.overallHealth,
                healthScore: metrics.healthScore,
                publishGate: metrics.publishGate,
                summary:
                  parsed.summary ||
                  (combinedFindings.length === 0
                    ? 'No critical issues detected across reviewed files.'
                    : `Identified ${combinedFindings.length} finding(s) across project files.`),
                inspectedAt: Date.now(),
                modelName: activeModelName,
                findings: combinedFindings,
              });
            } catch {
              const metrics = computeSupervisorMetrics(staticFindings);
              setReport({
                ...metrics,
                summary:
                  'AI Supervisor returned non-JSON prose; displaying deterministic static checks below.',
                inspectedAt: Date.now(),
                modelName: `${activeModelName} + Static`,
                findings: staticFindings,
              });
            }
            setInspecting(false);
          },
          onFatal: ({ message }) => {
            const metrics = computeSupervisorMetrics(staticFindings);
            setReport({
              ...metrics,
              summary: `AI inspection failed (${message}); showing deterministic static checks.`,
              inspectedAt: Date.now(),
              modelName: 'Static Analyzer',
              findings: staticFindings,
            });
            pushToast({
              type: 'error',
              title: 'Supervisor AI inspection failed',
              description: message,
            });
            setInspecting(false);
          },
        },
      });
    } finally {
      setInspecting(false);
    }
  }, [
    buildErrors,
    enabledModels,
    onApplyFileFix,
    project,
    pushToast,
    recordFallbackEvent,
    selectedSupervisorModel,
    settings.fallbackPolicy,
    settings.routingMode,
    settings.supervisor.enabled,
    settings.supervisor.mode,
  ]);

  useEffect(() => {
    if (
      autoTriggerToken > 0 &&
      autoTriggerToken !== lastTriggerRef.current &&
      settings.supervisor.enabled &&
      settings.supervisor.autoVerifyAfterBuild
    ) {
      lastTriggerRef.current = autoTriggerToken;
      runInspection();
    }
  }, [
    autoTriggerToken,
    runInspection,
    settings.supervisor.autoVerifyAfterBuild,
    settings.supervisor.enabled,
  ]);

  const criticalCount =
    report?.findings.filter((f) => !f.applied && f.severity === 'critical').length || 0;
  const warningCount =
    report?.findings.filter((f) => !f.applied && f.severity === 'warning').length || 0;
  const suggestionCount =
    report?.findings.filter((f) => !f.applied && f.severity === 'suggestion').length || 0;

  return (
    <div className="h-full flex flex-col p-3 space-y-3 overflow-y-auto">
      <div className="flex items-center justify-between gap-2 pb-2 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
            {t('supervisorTitle')}
          </span>
        </div>

        <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={settings.supervisor.enabled}
            onChange={(e) =>
              updateSettings({
                supervisor: { ...settings.supervisor, enabled: e.target.checked },
              })
            }
            className="rounded border-slate-300 dark:border-slate-700 text-blue-600"
          />
          <span>{settings.supervisor.enabled ? t('enabled') : t('disabled')}</span>
        </label>
      </div>

      {!settings.supervisor.enabled ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            {t('supervisorDisabled')}
          </div>
          <button
            type="button"
            onClick={runStaticAuditOnly}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <Wrench className="h-3.5 w-3.5" />
            <span>Run Deterministic Static Checks</span>
          </button>
        </div>
      ) : (
        <>
          <div className="space-y-2.5">
            <div>
              <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                Supervisor Model (Independent from Builder)
              </label>
              <select
                value={selectedSupervisorModel?.id || ''}
                onChange={(e) =>
                  updateSettings({
                    supervisor: { ...settings.supervisor, modelConfigId: e.target.value },
                  })
                }
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100"
              >
                {enabledModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName} ({m.providerName})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                Supervision Mode
              </label>
              <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
                <button
                  type="button"
                  onClick={() =>
                    updateSettings({
                      supervisor: { ...settings.supervisor, mode: 'advisory' },
                    })
                  }
                  className={`py-1 px-2 text-[11px] font-medium rounded-md transition-colors ${
                    settings.supervisor.mode === 'advisory'
                      ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-500'
                  }`}
                >
                  {t('supervisorAdvisory')}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateSettings({
                      supervisor: { ...settings.supervisor, mode: 'auto-review' },
                    })
                  }
                  className={`py-1 px-2 text-[11px] font-medium rounded-md transition-colors ${
                    settings.supervisor.mode === 'auto-review'
                      ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-500'
                  }`}
                >
                  {t('supervisorAutoReview')}
                </button>
              </div>
            </div>

            <label className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.supervisor.autoVerifyAfterBuild ?? true}
                onChange={(e) =>
                  updateSettings({
                    supervisor: {
                      ...settings.supervisor,
                      autoVerifyAfterBuild: e.target.checked,
                    },
                  })
                }
              />
              <span>Auto-inspect after AI Builder completes</span>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={inspecting ? () => abortRef.current?.abort() : runInspection}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg text-white transition-colors ${
                  inspecting ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {inspecting ? (
                  <>
                    <Square className="h-3.5 w-3.5" />
                    <span>{t('stopGenerating')}</span>
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" />
                    <span>{t('runInspection')}</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={runStaticAuditOnly}
                title="Run local deterministic static checks without calling an AI model"
                className="px-2.5 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Static
              </button>
            </div>
          </div>
        </>
      )}

      {report && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <span
                className={`font-bold font-mono tabular-nums ${
                  report.publishGate === 'PASS'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : report.publishGate === 'WARNING'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-red-600 dark:text-red-400'
                }`}
              >
                {report.healthScore}/100
              </span>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold font-mono ${
                  report.publishGate === 'PASS'
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : report.publishGate === 'WARNING'
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'bg-red-500/10 text-red-600 dark:text-red-400'
                }`}
              >
                Gate: {report.publishGate}
              </span>
            </div>
            <span className="text-[10px] text-slate-400">
              {formatRelativeTime(report.inspectedAt)}
            </span>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            {report.summary}
          </p>
          <div className="flex items-center gap-3 text-[11px] font-mono tabular-nums text-slate-500">
            <span className="text-red-500">Critical: {criticalCount}</span>
            <span className="text-amber-500">Warnings: {warningCount}</span>
            <span className="text-blue-500">Suggestions: {suggestionCount}</span>
          </div>
        </div>
      )}

      {/* Findings */}
      <div className="space-y-2.5">
        {(report?.findings || []).map((finding) => (
          <div
            key={finding.id}
            className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 space-y-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <ShieldAlert
                  className={`h-3.5 w-3.5 shrink-0 ${
                    finding.severity === 'critical'
                      ? 'text-red-600 dark:text-red-400'
                      : finding.severity === 'warning'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-blue-600 dark:text-blue-400'
                  }`}
                />
                <span className="text-slate-900 dark:text-slate-100">{finding.title}</span>
              </div>
              <span className="text-[11px] font-mono text-slate-500">{finding.category}</span>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {finding.description}
            </p>

            {finding.evidence && (
              <div className="rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-1 text-[10px] font-mono text-slate-600 dark:text-slate-300 break-words">
                Evidence: {finding.evidence}
              </div>
            )}

            {finding.filePath && (
              <p className="text-[11px] font-mono text-slate-500">{finding.filePath}</p>
            )}

            {finding.proposedFix?.path && finding.proposedFix?.content && (
              <div className="pt-1">
                {finding.applied ? (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3.5 w-3.5" />
                    <span>Fix applied to {finding.proposedFix.path}</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onApplyFileFix(
                        finding.proposedFix!.path,
                        finding.proposedFix!.content,
                        finding.proposedFix!.rationale
                      );
                      setReport((prev) => {
                        if (!prev) return prev;
                        const nextFindings = prev.findings.map((item) =>
                          item.id === finding.id ? { ...item, applied: true } : item
                        );
                        return {
                          ...prev,
                          ...computeSupervisorMetrics(nextFindings),
                          findings: nextFindings,
                        };
                      });
                    }}
                    className="px-2.5 py-1 text-xs font-medium rounded-md bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90"
                  >
                    {t('applyFix')} ({finding.proposedFix.path})
                  </button>
                )}
              </div>
            )}
          </div>
        ))}

        {!report && rawReport && (
          <pre className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-[11px] font-mono text-slate-600 dark:text-slate-300 whitespace-pre-wrap break-words">
            {rawReport}
          </pre>
        )}
      </div>
    </div>
  );
}
