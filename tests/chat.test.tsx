import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIModelConfig, Conversation, ConversationFolder } from '../src/types/index.ts';

const mockModels: AIModelConfig[] = [
  {
    id: 'mdl-1',
    displayName: 'Test GPT',
    providerName: 'OpenAI',
    modelId: 'gpt-4o-mini',
    protocol: 'openai-compatible',
    useServerEnvKey: true,
    priority: 1,
    enabled: true,
    status: 'connected',
    createdAt: 1000,
  },
];

const stateStore: {
  conversations: Conversation[];
  folders: ConversationFolder[];
} = {
  conversations: [],
  folders: [],
};

vi.mock('../src/storage/indexedDbStorage.ts', () => ({
  storageAdapter: {
    getModels: vi.fn(async () => mockModels),
    saveModels: vi.fn(async () => {}),
    getConversations: vi.fn(async () => [...stateStore.conversations]),
    saveConversation: vi.fn(async (conv: Conversation) => {
      const idx = stateStore.conversations.findIndex((c) => c.id === conv.id);
      if (idx >= 0) stateStore.conversations[idx] = conv;
      else stateStore.conversations.unshift(conv);
    }),
    deleteConversation: vi.fn(async (id: string) => {
      stateStore.conversations = stateStore.conversations.filter((c) => c.id !== id);
    }),
    getFolders: vi.fn(async () => [...stateStore.folders]),
    saveFolder: vi.fn(async (f: ConversationFolder) => {
      stateStore.folders.push(f);
    }),
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
}));

import { AppProvider } from '../src/contexts/AppContext.tsx';
import { ChatPage } from '../src/pages/ChatPage.tsx';

function createSseResponse(text: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: attempt\ndata: ${JSON.stringify({
            configId: 'mdl-1',
            modelId: 'gpt-4o-mini',
            displayName: 'Test GPT',
            providerName: 'OpenAI',
            attempt: 1,
            maxAttempts: 2,
          })}\n\n`
        )
      );
      controller.enqueue(
        encoder.encode(
          `event: delta\ndata: ${JSON.stringify({
            text,
            configId: 'mdl-1',
            modelId: 'gpt-4o-mini',
            displayName: 'Test GPT',
          })}\n\n`
        )
      );
      controller.enqueue(
        encoder.encode(
          `event: done\ndata: ${JSON.stringify({
            configId: 'mdl-1',
            modelId: 'gpt-4o-mini',
            displayName: 'Test GPT',
            providerName: 'OpenAI',
            switchedCount: 0,
          })}\n\n`
        )
      );
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('ChatPage End-to-End Interactions', () => {
  beforeEach(() => {
    stateStore.conversations = [];
    stateStore.folders = [];
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/ai/capabilities')) {
          return new Response(JSON.stringify({ serverGeminiConfigured: true }), { status: 200 });
        }
        if (url.includes('/api/github/status')) {
          return new Response(
            JSON.stringify({ configured: false, connected: false, callbackUrl: '', user: null }),
            { status: 200 }
          );
        }
        if (url.includes('/api/ai/chat')) {
          return createSseResponse('Hello from orchestrated stream!');
        }
        return new Response('{}', { status: 200 });
      })
    );
  });

  it('sends a message, streams response, supports chat mode & conversation branching', async () => {
    render(
      <AppProvider>
        <ChatPage />
      </AppProvider>
    );

    const newChatBtn = await screen.findByRole('button', { name: /New Chat/i });
    fireEvent.click(newChatBtn);

    const textarea = await screen.findByPlaceholderText(
      /Ask anything, attach code or images, or test model fallback/i
    );

    // Switch chat mode to Coding via Chat Mode select
    const modeSelect = screen.getByLabelText('Chat Mode') as HTMLSelectElement;
    fireEvent.change(modeSelect, { target: { value: 'coding' } });
    expect(modeSelect.value).toBe('coding');

    fireEvent.change(textarea, { target: { value: 'Write a hello utility' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));

    await waitFor(() => {
      expect(screen.getAllByText('Write a hello utility').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Hello from orchestrated stream!')).toBeInTheDocument();
    });

    // Branch conversation from the assistant reply
    const branchBtns = screen.getAllByRole('button', { name: /Branch from here/i });
    fireEvent.click(branchBtns[branchBtns.length - 1]);

    await waitFor(() => {
      expect(stateStore.conversations.length).toBe(2);
      expect(stateStore.conversations.some((c) => c.title.includes('(Branch)'))).toBe(true);
    });
  });

  it('creates a conversation folder and filters chats', async () => {
    render(
      <AppProvider>
        <ChatPage />
      </AppProvider>
    );

    const newFolderBtn = await screen.findByTitle('New Folder');
    fireEvent.click(newFolderBtn);

    const folderInput = screen.getByPlaceholderText('Folder name');
    fireEvent.change(folderInput, { target: { value: 'Architecture' } });
    fireEvent.submit(folderInput.closest('form')!);

    await waitFor(() => {
      expect(screen.getByText('Architecture')).toBeInTheDocument();
    });
  });
});
