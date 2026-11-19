import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIModelConfig } from '../src/types/index.ts';

const testState: { models: AIModelConfig[] } = {
  models: [],
};

vi.mock('../src/storage/indexedDbStorage.ts', () => ({
  storageAdapter: {
    getModels: vi.fn(async () => [...testState.models]),
    saveModels: vi.fn(async (list: AIModelConfig[]) => {
      testState.models = list;
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
import { ModelHealthDashboard } from '../src/components/ModelHealthDashboard.tsx';

describe('ModelHealthDashboard Component', () => {
  beforeEach(() => {
    const now = Date.now();
    testState.models = [
      {
        id: 'mdl-healthy',
        displayName: 'Primary Alpha',
        providerName: 'OpenAI',
        modelId: 'gpt-4o',
        protocol: 'openai-compatible',
        useServerEnvKey: true,
        priority: 1,
        enabled: true,
        roleTags: ['preferred', 'coding'],
        status: 'connected',
        lastLatencyMs: 240,
        averageLatencyMs: 210,
        successCount: 12,
        failureCount: 1,
        consecutiveFailures: 0,
        healthHistory: [
          { ts: now - 5000, ok: true, latencyMs: 200 },
          { ts: now - 1000, ok: true, latencyMs: 240 },
        ],
        createdAt: now - 10000,
      },
      {
        id: 'mdl-cooling',
        displayName: 'Backup Beta',
        providerName: 'Anthropic',
        modelId: 'claude-3-5-sonnet',
        protocol: 'anthropic',
        useServerEnvKey: true,
        priority: 2,
        enabled: true,
        roleTags: ['backup'],
        status: 'rate_limited',
        lastLatencyMs: 920,
        successCount: 3,
        failureCount: 2,
        consecutiveFailures: 2,
        cooldownUntil: now + 45_000,
        lastCooldownReason: 'RATE_LIMIT: 429 Too Many Requests',
        createdAt: now - 9000,
      },
    ];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/ai/capabilities')) {
          return new Response(JSON.stringify({ serverGeminiConfigured: false }), { status: 200 });
        }
        if (url.includes('/api/ai/metrics')) {
          return new Response(
            JSON.stringify({
              generatedAt: Date.now(),
              totalSuccess: 15,
              totalFailures: 3,
              totalRequests: 18,
              models: [
                {
                  configId: 'mdl-healthy',
                  consecutiveFailures: 0,
                  cooldownUntil: 0,
                  successCount: 14,
                  failureCount: 1,
                  lastLatencyMs: 240,
                  averageLatencyMs: 210,
                  lastUpdated: Date.now(),
                  recentSamples: [
                    { ts: Date.now() - 4000, ok: true, latencyMs: 195 },
                    { ts: Date.now() - 1000, ok: true, latencyMs: 240 },
                  ],
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes('/api/github/status')) {
          return new Response(
            JSON.stringify({ configured: false, connected: false, callbackUrl: '', user: null }),
            { status: 200 }
          );
        }
        if (url.includes('/api/auth/me')) {
          return new Response(JSON.stringify({ authenticated: false, user: null }), { status: 200 });
        }
        if (url.includes('/api/ai/cooldown/reset')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.includes('/api/ai/test')) {
          return new Response(
            JSON.stringify({ ok: true, latencyMs: 145, message: 'HTTP 200 OK' }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      })
    );
  });

  it('renders connection status, latency, reliability metrics, cooldown timer, Recharts charts, and resets cooldown', async () => {
    render(
      <AppProvider>
        <ModelHealthDashboard />
      </AppProvider>
    );

    expect(await screen.findByText('Primary Alpha')).toBeInTheDocument();
    expect(screen.getByText('Backup Beta')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/Cooldown \(/i)).toBeInTheDocument();
    expect(screen.getByText(/240 ms/i)).toBeInTheDocument();
    expect(screen.getByText(/avg 210 ms/i)).toBeInTheDocument();
    expect(screen.getByText(/93% reliability/i)).toBeInTheDocument();
    expect(screen.getByText(/2 streak fail/i)).toBeInTheDocument();
    expect(screen.getByText('Model Latency Comparison (ms)')).toBeInTheDocument();
    expect(screen.getByText('Recent Orchestrator Telemetry Stream')).toBeInTheDocument();

    const syncBtn = screen.getByRole('button', { name: /Refresh live orchestrator metrics/i });
    fireEvent.click(syncBtn);
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/api/ai/metrics'));
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    // Click Reset circuit breaker button on Backup Beta
    const resetBtn = screen.getByRole('button', { name: /Reset/i });
    fireEvent.click(resetBtn);

    await waitFor(() => {
      expect(screen.queryByText(/Cooldown \(/i)).not.toBeInTheDocument();
    });
  });

  it('runs Test and Test All Enabled via backend /api/ai/test', async () => {
    render(
      <AppProvider>
        <ModelHealthDashboard />
      </AppProvider>
    );

    const testAllBtn = await screen.findByRole('button', { name: /Test All Enabled/i });
    fireEvent.click(testAllBtn);

    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      const testCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/ai/test'));
      expect(testCalls.length).toBe(2);
    });
  });
});

