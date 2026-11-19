import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runDiagnosticSuiteForModels } from '../server/routes/diagnostics.ts';
import type { AIModelConfig, UsageRecord } from '../src/types/index.ts';

const analyticsStore: {
  models: AIModelConfig[];
  usage: UsageRecord[];
} = {
  models: [],
  usage: [],
};

vi.mock('../src/storage/indexedDbStorage.ts', () => ({
  storageAdapter: {
    getModels: vi.fn(async () => [...analyticsStore.models]),
    saveModels: vi.fn(async (list: AIModelConfig[]) => {
      analyticsStore.models = list;
    }),
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
    getUsageRecords: vi.fn(async () => [...analyticsStore.usage]),
    addUsageRecord: vi.fn(async () => {}),
    clearUsageRecords: vi.fn(async () => {
      analyticsStore.usage = [];
    }),
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
import { AnalyticsPage } from '../src/pages/AnalyticsPage.tsx';

describe('Diagnostics Engine & Usage Analytics Integrity', () => {
  beforeEach(() => {
    const now = Date.now();
    analyticsStore.models = [
      {
        id: 'mdl-1',
        displayName: 'OpenAI Probe',
        providerName: 'OpenAI',
        modelId: 'gpt-4o-mini',
        protocol: 'openai-compatible',
        priority: 1,
        enabled: true,
        status: 'connected',
        createdAt: now,
      },
    ];
    analyticsStore.usage = [
      {
        id: 'u-1',
        timestamp: now - 1000,
        modelConfigId: 'mdl-1',
        modelId: 'gpt-4o-mini',
        displayName: 'OpenAI Probe',
        providerName: 'OpenAI',
        context: 'chat',
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        tokenSource: 'provider-reported',
        costStatus: 'unavailable',
      },
      {
        id: 'u-2',
        timestamp: now - 500,
        modelConfigId: 'mdl-2',
        modelId: 'custom-local',
        displayName: 'Local Proxy',
        providerName: 'Custom',
        context: 'studio',
        inputTokens: 400,
        outputTokens: 200,
        totalTokens: 600,
        tokenSource: 'estimated',
        costStatus: 'unavailable',
      },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/ai/capabilities')) {
          return new Response(JSON.stringify({ serverGeminiConfigured: false }), { status: 200 });
        }
        if (url.includes('/api/github/status')) {
          return new Response(
            JSON.stringify({ configured: false, connected: false, callbackUrl: '', user: null }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      })
    );
  });

  it('marks unconfigured credentials as NOT CONFIGURED and blocks SSRF metadata IPs cleanly', async () => {
    const results = await runDiagnosticSuiteForModels({
      models: [
        {
          id: 'no-key',
          displayName: 'Missing Key Model',
          providerName: 'Anthropic',
          modelId: 'claude-3-5-sonnet',
          protocol: 'anthropic',
          priority: 1,
          enabled: true,
        },
        {
          id: 'ssrf-mdl',
          displayName: 'SSRF Blocked Model',
          providerName: 'Custom',
          modelId: 'bad',
          protocol: 'openai-compatible',
          baseUrl: 'http://169.254.169.254/latest/meta-data',
          apiKey: 'sk-dummy',
          priority: 2,
          enabled: true,
        },
      ],
      tests: ['text', 'streaming', 'fallback'],
    });

    const missingKeyText = results.find((r) => r.modelConfigId === 'no-key' && r.test === 'text');
    expect(missingKeyText?.status).toBe('NOT CONFIGURED');

    const ssrfText = results.find((r) => r.modelConfigId === 'ssrf-mdl' && r.test === 'text');
    expect(ssrfText?.status).toBe('FAILED');
    expect(ssrfText?.detail).toMatch(/SSRF|Private|metadata|link-local/i);

    const fallbackDiag = results.find((r) => r.test === 'fallback');
    expect(fallbackDiag?.status).toBe('NOT CONFIGURED');
  });

  it('separates Provider-Reported vs Estimated tokens and shows Cost Unavailable when unpriced', async () => {
    render(
      <AppProvider>
        <AnalyticsPage />
      </AppProvider>
    );

    expect(await screen.findByText('Usage & Cost Analytics')).toBeInTheDocument();
    expect(screen.getByText('1,500')).toBeInTheDocument();
    expect(screen.getByText('600')).toBeInTheDocument();
    expect(screen.getByText('Cost Unavailable')).toBeInTheDocument();
  });

  it('computes spend when user-supplied token pricing rates are present', async () => {
    analyticsStore.usage = [
      {
        id: 'u-priced',
        timestamp: Date.now(),
        modelConfigId: 'mdl-1',
        modelId: 'gpt-4o-mini',
        displayName: 'OpenAI Probe',
        providerName: 'OpenAI',
        context: 'chat',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        totalTokens: 1_500_000,
        tokenSource: 'provider-reported',
        estimatedCostUsd: 0.45,
        costStatus: 'calculated',
      },
    ];

    render(
      <AppProvider>
        <AnalyticsPage />
      </AppProvider>
    );

    expect(await screen.findByText('$0.4500')).toBeInTheDocument();
  });
});
