import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateDesktopCommand, validateDesktopExternalUrl } from '../desktop/security/validators.ts';
import { trimRepeatedContinuationPrefix } from '../server/orchestrator/aiOrchestrator.ts';
import {
  orderModelsWithHealthAndRoles,
  recordModelAttemptFailure,
  resetHealthTrackerForTests,
} from '../server/orchestrator/healthTracker.ts';
import {
  computeSupervisorMetrics,
  runDeterministicStaticChecks,
} from '../src/components/SupervisorPanel.tsx';
import type { Project } from '../src/types/index.ts';

vi.mock('../src/storage/indexedDbStorage.ts', () => ({
  storageAdapter: {
    getModels: vi.fn(async () => []),
    saveModels: vi.fn(async () => {}),
    getConversations: vi.fn(async () => []),
    saveConversation: vi.fn(async () => {}),
    deleteConversation: vi.fn(async () => {}),
    getFolders: vi.fn(async () => []),
    saveFolder: vi.fn(async () => {}),
    deleteFolder: vi.fn(async () => {}),
    getProjects: vi.fn(async () => []),
    saveProject: vi.fn(async () => {}),
    deleteProject: vi.fn(async () => {}),
    getSnapshots: vi.fn(async () => []),
    saveSnapshot: vi.fn(async () => {}),
    deleteSnapshot: vi.fn(async () => {}),
    getFallbackHistory: vi.fn(async () => []),
    addFallbackHistory: vi.fn(async () => {}),
    clearFallbackHistory: vi.fn(async () => {}),
    getUsageRecords: vi.fn(async () => []),
    addUsageRecord: vi.fn(async () => {}),
    clearUsageRecords: vi.fn(async () => {}),
    getSettings: vi.fn(async () => null),
    saveSettings: vi.fn(async () => {}),
    getStorageStats: vi.fn(async () => ({
      usedBytes: 0,
      quotaBytes: 0,
      projectCount: 0,
      conversationCount: 0,
      snapshotCount: 0,
      schemaVersion: 3,
    })),
    exportBackup: vi.fn(async () => ({
      schemaVersion: 3,
      exportedAt: Date.now(),
      models: [],
      conversations: [],
      folders: [],
      projects: [],
      snapshots: [],
      usageRecords: [],
      settings: null,
    })),
    importBackup: vi.fn(async () => ({
      importedProjects: 0,
      importedConversations: 0,
      importedModels: 0,
    })),
    clearAll: vi.fn(async () => {}),
  },
}));

import { AppProvider } from '../src/contexts/AppContext.tsx';
import { CommandPalette } from '../src/components/CommandPalette.tsx';
import { OnboardingWizard } from '../src/components/OnboardingWizard.tsx';

describe('Phase 3 Core Workflows: Circuit Breaker, Continuation, Desktop Security, Supervisor & UI Wizards', () => {
  beforeEach(() => {
    resetHealthTrackerForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ serverGeminiConfigured: false }), { status: 200 }))
    );
  });

  it('orders healthy models ahead of cooling models and probes earliest-expiring cooldown on recovery', () => {
    const now = 1_000_000;
    const m1 = {
      id: 'm1',
      displayName: 'Model 1',
      providerName: 'OpenAI',
      modelId: 'm1',
      protocol: 'openai-compatible' as const,
      priority: 1,
      enabled: true,
    };
    const m2 = {
      id: 'm2',
      displayName: 'Model 2',
      providerName: 'OpenAI',
      modelId: 'm2',
      protocol: 'openai-compatible' as const,
      priority: 2,
      enabled: true,
    };

    recordModelAttemptFailure('m1', 'RATE_LIMIT', '429', 1, now);
    const first = orderModelsWithHealthAndRoles({
      models: [m1, m2],
      routingMode: 'auto',
      now: now + 1000,
    });
    expect(first.ordered[0].id).toBe('m2');
    expect(first.skippedCooldownIds).toContain('m1');
    expect(first.probingRecovery).toBe(false);

    // Cool m2 longer than m1
    recordModelAttemptFailure('m2', 'QUOTA_EXCEEDED', 'quota', 2, now + 5000);
    const recovery = orderModelsWithHealthAndRoles({
      models: [m1, m2],
      routingMode: 'auto',
      now: now + 6000,
    });
    expect(recovery.probingRecovery).toBe(true);
    expect(recovery.ordered[0].id).toBe('m1');
  });

  it('deduplicates repeated continuation overlaps seamlessly', () => {
    const existing = 'Here is the clean function:\nexport function sum(a: number, b: number) {\n';
    const overlapChunk = 'export function sum(a: number, b: number) {\n  return a + b;\n}';
    const trimmed = trimRepeatedContinuationPrefix(existing, overlapChunk);
    expect(trimmed).toBe('  return a + b;\n}');
  });

  it('blocks dangerous git flags and unsafe external desktop URLs', () => {
    expect(validateDesktopCommand('git commit -m "initial build"').allowed).toBe(true);
    expect(validateDesktopCommand('git -c core.sshCommand=evil pull').allowed).toBe(false);
    expect(validateDesktopCommand('git pull --upload-pack=/tmp/x').allowed).toBe(false);

    expect(validateDesktopExternalUrl('http://localhost:5173')).toBe(true);
    expect(validateDesktopExternalUrl('https://github.com/org/repo')).toBe(true);
    expect(validateDesktopExternalUrl('https://evil.example.com/phish')).toBe(false);
    expect(validateDesktopExternalUrl('file:///C:/Windows/System32')).toBe(false);
  });

  it('flags .env exposure & broken relative imports with BLOCKED publish gate in Supervisor', () => {
    const project: Project = {
      id: 'proj-audit',
      name: 'Audit Test',
      framework: 'react-vite',
      description: 'Test',
      createdAt: 1,
      updatedAt: 1,
      activities: [],
      files: [
        {
          path: 'src/App.tsx',
          content: "import { MissingWidget } from './MissingWidget';\nexport default () => <MissingWidget />;",
          updatedAt: 1,
        },
        {
          path: '.env',
          content: 'OPENAI_API_KEY=sk-test-secret',
          updatedAt: 1,
        },
      ],
    };

    const findings = runDeterministicStaticChecks(project, []);
    expect(findings.some((f) => f.category === 'security')).toBe(true);
    expect(findings.some((f) => f.category === 'broken-imports')).toBe(true);
    const metrics = computeSupervisorMetrics(findings);
    expect(metrics.publishGate).toBe('BLOCKED');
    expect(metrics.healthScore).toBeLessThan(60);
  });

  it('filters CommandPalette actions and navigates through all 8 OnboardingWizard steps', async () => {
    const onClose = vi.fn();
    render(
      <AppProvider>
        <CommandPalette open={true} onClose={onClose} onOpenOnboarding={vi.fn()} />
        <OnboardingWizard open={true} onClose={vi.fn()} />
      </AppProvider>
    );

    const searchBox = await screen.findByPlaceholderText(/Jump to page/i);
    fireEvent.change(searchBox, { target: { value: 'Diagnostics' } });
    expect(screen.getByText('Go to Provider Diagnostics')).toBeInTheDocument();

    expect(screen.getByText(/1\. Choose Runtime & Account Mode/i)).toBeInTheDocument();
    const nextBtn = screen.getByRole('button', { name: /Next Step/i });
    for (let i = 0; i < 7; i++) {
      fireEvent.click(nextBtn);
    }
    expect(screen.getByText(/8\. Export ZIP or Publish to GitHub/i)).toBeInTheDocument();
  });
});
