import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { translate, translations } from '../src/i18n/translations.ts';

vi.mock('../src/storage/indexedDbStorage.ts', () => {
  let settings: Record<string, unknown> | null = null;
  return {
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
      getSettings: vi.fn(async () => settings),
      saveSettings: vi.fn(async (s) => {
        settings = s;
      }),
      getStorageStats: vi.fn(async () => ({
        usedBytes: 1024,
        quotaBytes: 1000000,
        projectCount: 1,
        conversationCount: 0,
        snapshotCount: 0,
        schemaVersion: 2,
      })),
      exportBackup: vi.fn(async () => ({
        schemaVersion: 2,
        exportedAt: Date.now(),
        models: [],
        conversations: [],
        folders: [],
        projects: [],
        snapshots: [],
        settings: null,
      })),
      importBackup: vi.fn(async () => ({
        importedProjects: 0,
        importedConversations: 0,
        importedModels: 0,
      })),
      clearAll: vi.fn(async () => {}),
    },
  };
});

import { AppProvider } from '../src/contexts/AppContext.tsx';
import { SettingsPage } from '../src/pages/SettingsPage.tsx';

describe('Localization (EN / AR RTL) & Theme Switching', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.dir = 'ltr';
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

  it('maintains complete translation key parity between English and Arabic', () => {
    const enKeys = Object.keys(translations.en).sort();
    const arKeys = Object.keys(translations.ar).sort();
    expect(arKeys).toEqual(enKeys);
    expect(translate('en', 'appName')).toBe('OmniAI Studio');
    expect(translate('ar', 'appName')).toBe('ستوديو OmniAI');
  });

  it('switches document direction to RTL for Arabic and toggles Light/Dark classes', async () => {
    render(
      <AppProvider>
        <SettingsPage />
      </AppProvider>
    );

    const arButton = await screen.findByText('العربية (RTL)');
    fireEvent.click(arButton);

    await waitFor(() => {
      expect(document.documentElement.dir).toBe('rtl');
      expect(document.documentElement.lang).toBe('ar');
      expect(screen.getByText('الإعدادات والتفضيلات')).toBeInTheDocument();
    });

    const lightBtn = screen.getByRole('button', { name: /فاتح/i });
    fireEvent.click(lightBtn);

    await waitFor(() => {
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
  });
});
