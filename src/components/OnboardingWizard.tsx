import React, { useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Compass, X } from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';
import type { NavRoute } from '../types/index.ts';

interface OnboardingStep {
  title: string;
  summary: string;
  checklist: string[];
  actionLabel?: string;
  targetRoute?: NavRoute;
}

const STEPS: OnboardingStep[] = [
  {
    title: '1. Choose Runtime & Account Mode',
    summary:
      'Run OmniAI Studio purely in Local Personal Mode with IndexedDB, or enable Hosted Multi-User accounts in Settings for isolated cloud workspace sync.',
    checklist: [
      'Local Personal Mode works immediately without registration.',
      'Hosted Mode isolates credentials, projects, and chats per user account.',
    ],
    actionLabel: 'Review Settings',
    targetRoute: 'settings',
  },
  {
    title: '2. Add AI Models & Credentials',
    summary:
      'Configure OpenAI-compatible, Google Gemini, Anthropic, Groq, Ollama, or custom HTTP endpoints.',
    checklist: [
      'API keys are stored encrypted inside the HTTP-only Server Vault.',
      'Assign role tags (Preferred, Coding, Vision, Backup) and custom $/1M token rates.',
    ],
    actionLabel: 'Open Models Manager',
    targetRoute: 'models',
  },
  {
    title: '3. Prioritize & Monitor Model Health',
    summary:
      'Drag models into fallback priority order and monitor live latency, success/failure reliability, and cooldown circuit breakers from Dashboard.',
    checklist: [
      'Rate limits and 5xx outages trigger automatic cooldowns and instant failover.',
      'Clear cooldowns manually anytime after fixing provider billing or quotas.',
    ],
    actionLabel: 'View Model Health',
    targetRoute: 'dashboard',
  },
  {
    title: '4. Run Live Provider Diagnostics',
    summary:
      'Verify text, streaming, JSON mode, tool-calling, vision, and multi-model failover readiness using real API probes.',
    checklist: [
      'Missing credentials honestly report NOT CONFIGURED.',
      'Unsupported capabilities report UNSUPPORTED without fake passes.',
    ],
    actionLabel: 'Run Diagnostics',
    targetRoute: 'diagnostics',
  },
  {
    title: '5. Chat with Automatic Failover',
    summary:
      'Use Unified AI Chat for text, code, files, and images across General, Coding, Research, Debugging, and Planning modes.',
    checklist: [
      'Partial responses are preserved cleanly without duplication when models switch mid-stream.',
      'Organize threads with folders and branch from any reply.',
    ],
    actionLabel: 'Open AI Chat',
    targetRoute: 'chat',
  },
  {
    title: '6. Build Apps in AI Studio',
    summary:
      'Generate, edit, and preview React/Vite or HTML/JS web apps with Monaco Editor, in-browser esbuild live preview, snapshots, and cross-file search.',
    checklist: [
      'Use Fast, Planning (review diff first), or Agent (auto build-error fix loop) modes.',
      'Add project-specific AI instructions for consistent coding conventions.',
    ],
    actionLabel: 'Launch AI Studio',
    targetRoute: 'studio',
  },
  {
    title: '7. Audit Quality with AI Supervisor',
    summary:
      'Combine deterministic static checks with independent AI review to get a 0–100 health score and PASS / WARNING / BLOCKED publish gate.',
    checklist: [
      'Detects broken relative imports, .env secret exposure, accessibility, and build errors.',
      'Save version snapshots automatically before applying AI fixes.',
    ],
    actionLabel: 'Inspect in Studio',
    targetRoute: 'studio',
  },
  {
    title: '8. Export ZIP or Publish to GitHub / Desktop',
    summary:
      'Download complete ZIP archives, sync branches via the guided GitHub Publish Wizard, or link a local folder inside the Electron Windows Desktop app.',
    checklist: [
      'Local AI Agent enforces granular folder & command permissions.',
      'Press Ctrl+K / Cmd+K anytime to jump anywhere in OmniAI Studio.',
    ],
    actionLabel: 'Open GitHub Sync',
    targetRoute: 'github',
  },
];

export function OnboardingWizard({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { setRoute, updateSettings } = useApp();
  const [stepIdx, setStepIdx] = useState(0);

  if (!open) return null;

  const step = STEPS[stepIdx];

  const finishWizard = async () => {
    await updateSettings({ onboardingCompleted: true });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Onboarding Wizard"
    >
      <div className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xl">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Compass className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              OmniAI Studio Guided Walkthrough ({stepIdx + 1}/{STEPS.length})
            </h2>
          </div>
          <button
            type="button"
            onClick={finishWizard}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            aria-label="Dismiss walkthrough"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex gap-1">
            {STEPS.map((_, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setStepIdx(idx)}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  idx <= stepIdx ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-800'
                }`}
                aria-label={`Step ${idx + 1}`}
              />
            ))}
          </div>

          <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">{step.title}</h3>
          <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            {step.summary}
          </p>

          <ul className="space-y-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-4 text-xs text-slate-700 dark:text-slate-300">
            {step.checklist.map((line) => (
              <li key={line} className="flex items-start gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                <span>{line}</span>
              </li>
            ))}
          </ul>

          {step.actionLabel && step.targetRoute && (
            <button
              type="button"
              onClick={() => {
                setRoute(step.targetRoute!);
                finishWizard();
              }}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
            >
              {step.actionLabel} →
            </button>
          )}
        </div>

        <div className="px-6 py-3.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={stepIdx === 0}
            onClick={() => setStepIdx((i) => Math.max(0, i - 1))}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span>Previous</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={finishWizard}
              className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            >
              Skip Tour
            </button>
            {stepIdx < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={() => setStepIdx((i) => Math.min(STEPS.length - 1, i + 1))}
                className="inline-flex items-center gap-1 px-4 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
              >
                <span>Next Step</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={finishWizard}
                className="px-4 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                Finish Setup
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
