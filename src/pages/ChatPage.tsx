import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  Copy,
  Download,
  Edit2,
  Eraser,
  FileText,
  Folder,
  FolderPlus,
  GitBranch,
  History,
  Image as ImageIcon,
  MessageSquare,
  Mic,
  MicOff,
  Paperclip,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { useApp } from '../contexts/AppContext.tsx';
import { streamOrchestratedChat } from '../orchestration/fallbackClient.ts';
import type {
  ChatAttachment,
  ChatMessage,
  ChatMode,
  Conversation,
  FallbackEventNotice,
} from '../types/index.ts';
import { createId, formatBytes, formatRelativeTime } from '../utils/helpers.ts';

const CHAT_MODE_SYSTEM_ADDONS: Record<ChatMode, string> = {
  general: '',
  coding:
    'Focus on clean, production-grade TypeScript/software engineering code with edge-case safety and minimal boilerplate.',
  research:
    'Provide thorough, structured analysis comparing approaches, trade-offs, and concrete evidence.',
  debugging:
    'Systematically isolate root causes, identify failing assumptions, and propose minimal verified fixes.',
  planning:
    'Outline clear architectural steps, milestones, risks, and validation criteria before writing implementation details.',
};

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const codeText = String(children).replace(/\n$/, '');
  const langMatch = /language-([\w-]+)/.exec(className || '');
  const isBlock = Boolean(langMatch) || codeText.includes('\n');

  if (!isBlock) {
    return (
      <code className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-[0.85em]">
        {children}
      </code>
    );
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(codeText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div
      className="my-3 rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-950 text-slate-100"
      dir="ltr"
    >
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-900 border-b border-slate-800 text-xs text-slate-400">
        <span className="font-mono">{langMatch?.[1] || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 hover:text-white transition-colors"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto text-xs font-mono leading-relaxed">
        <code>{codeText}</code>
      </pre>
    </div>
  );
}

export function ChatPage() {
  const {
    models,
    updateModel,
    recordModelHealth,
    conversations,
    activeConversationId,
    setActiveConversationId,
    saveConversation,
    deleteConversation,
    createNewConversation,
    branchConversation,
    folders,
    createFolder,
    deleteFolder,
    fallbackHistory,
    recordFallbackEvent,
    recordUsage,
    settings,
    pushToast,
    t,
  } = useApp();

  const [search, setSearch] = useState('');
  const [selectedFolderId, setSelectedFolderId] = useState<string>('all');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showFallbackHistory, setShowFallbackHistory] = useState(false);

  const [inputText, setInputText] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeRespondingModel, setActiveRespondingModel] = useState<string | null>(null);
  const [liveFallbackNotices, setLiveFallbackNotices] = useState<FallbackEventNotice[]>([]);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [renamingConvId, setRenamingConvId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [deleteConvTarget, setDeleteConvTarget] = useState<Conversation | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [listeningVoice, setListeningVoice] = useState(false);
  const [mobileConvOpen, setMobileConvOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  const activeConv = conversations.find((c) => c.id === activeConversationId) || null;
  const enabledModels = [...models]
    .filter((m) => m.enabled)
    .sort((a, b) => a.priority - b.priority);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConv?.messages.length, isStreaming]);

  const readSelectedFiles = async (fileList: FileList | File[]) => {
    const next: ChatAttachment[] = [];
    for (const file of Array.from(fileList)) {
      if (file.size > 5 * 1024 * 1024) {
        pushToast({
          type: 'warning',
          title: `File too large: ${file.name}`,
          description: 'Attachments are limited to 5 MB per file.',
        });
        continue;
      }

      if (file.type.startsWith('image/')) {
        const dataBase64 = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const res = String(reader.result || '');
            resolve(res.split(',')[1] || '');
          };
          reader.readAsDataURL(file);
        });
        next.push({
          id: createId('att'),
          name: file.name,
          mimeType: file.type,
          size: file.size,
          dataBase64,
        });
      } else {
        const textContent = await file.text();
        next.push({
          id: createId('att'),
          name: file.name,
          mimeType: file.type || 'text/plain',
          size: file.size,
          textContent: textContent.slice(0, 60000),
        });
      }
    }
    setAttachments((prev) => [...prev, ...next]);
  };

  const handleVoiceToggle = () => {
    if (listeningVoice) {
      recognitionRef.current?.stop();
      setListeningVoice(false);
      return;
    }

    const SpeechRec =
      (
        window as unknown as {
          SpeechRecognition?: new () => unknown;
          webkitSpeechRecognition?: new () => unknown;
        }
      ).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: new () => unknown })
        .webkitSpeechRecognition;

    if (!SpeechRec) {
      pushToast({
        type: 'info',
        title: 'Voice input unavailable',
        description: 'Your current browser does not expose the Web Speech Recognition API.',
      });
      return;
    }

    const rec = new SpeechRec() as {
      lang: string;
      interimResults: boolean;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onerror: () => void;
      onend: () => void;
      start: () => void;
      stop: () => void;
    };
    rec.lang = settings.language === 'ar' ? 'ar-SA' : 'en-US';
    rec.interimResults = false;
    rec.onresult = (e) => {
      const transcript = e.results?.[0]?.[0]?.transcript || '';
      if (transcript) {
        setInputText((prev) => (prev ? `${prev} ${transcript}` : transcript));
      }
    };
    rec.onerror = () => setListeningVoice(false);
    rec.onend = () => setListeningVoice(false);
    recognitionRef.current = rec;
    setListeningVoice(true);
    rec.start();
  };

  const sendPrompt = async (baseConv: Conversation, historyBeforeReply: ChatMessage[]) => {
    const mode: ChatMode = baseConv.chatMode || 'general';
    const hasImages = historyBeforeReply.some((m) =>
      m.attachments?.some((a) => a.mimeType.startsWith('image/'))
    );

    let routingPool =
      baseConv.selectedModelId === 'auto'
        ? enabledModels
        : enabledModels.filter((m) => m.id === baseConv.selectedModelId);

    // Apply user-defined routing rules when in 'rules' mode and auto model selection
    if (baseConv.selectedModelId === 'auto' && settings.routingMode === 'rules') {
      const matchingRule = settings.routingRules.find((r) => {
        if (r.chatMode && r.chatMode !== mode) return false;
        if (r.requiresVision && !hasImages) return false;
        return r.preferredModelIds.length > 0;
      });
      if (matchingRule) {
        const preferred = matchingRule.preferredModelIds
          .map((id) => routingPool.find((m) => m.id === id))
          .filter((m): m is NonNullable<typeof m> => Boolean(m));
        const remaining = routingPool.filter(
          (m) => !matchingRule.preferredModelIds.includes(m.id)
        );
        if (preferred.length > 0) {
          routingPool = [...preferred, ...remaining];
        }
      }
    }

    if (routingPool.length === 0) {
      pushToast({
        type: 'error',
        title: 'No enabled AI model available',
        description: 'Add or enable a model in the Models page first.',
      });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setLiveFallbackNotices([]);
    setActiveRespondingModel(routingPool[0].displayName);

    const assistantMsgId = createId('msg');
    const placeholderAssistant: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      isStreaming: true,
      fallbackNotices: [],
    };

    const withPlaceholder: Conversation = {
      ...baseConv,
      messages: [...historyBeforeReply, placeholderAssistant],
      updatedAt: Date.now(),
    };
    await saveConversation(withPlaceholder);

    let fullContent = '';
    let latestModelId = routingPool[0].modelId;
    let latestModelName = routingPool[0].displayName;
    let latestProvider = routingPool[0].providerName;
    const notices: FallbackEventNotice[] = [];

    const updateAssistant = async (patch: Partial<ChatMessage>) => {
      const updatedMsgs = withPlaceholder.messages.map((m) =>
        m.id === assistantMsgId ? { ...m, ...patch } : m
      );
      await saveConversation({
        ...withPlaceholder,
        messages: updatedMsgs,
        updatedAt: Date.now(),
      });
    };

    const modeAddon = CHAT_MODE_SYSTEM_ADDONS[mode];
    const effectiveSystemInstruction = [baseConv.systemInstruction, modeAddon]
      .filter(Boolean)
      .join('\n\n');

    await streamOrchestratedChat({
      models: routingPool,
      messages: historyBeforeReply.map((m) => ({
        role: m.role,
        content: m.content,
        attachments: m.attachments,
      })),
      systemInstruction: effectiveSystemInstruction || undefined,
      policy: settings.fallbackPolicy,
      routingMode: baseConv.selectedModelId === 'auto' ? settings.routingMode : 'manual',
      requiredCapabilities: hasImages ? { vision: true } : undefined,
      signal: controller.signal,
      callbacks: {
        onAttempt: (info) => {
          latestModelId = info.modelId;
          latestModelName = info.displayName;
          latestProvider = info.providerName;
          setActiveRespondingModel(info.displayName);
        },
        onSwitched: (info) => {
          const notice: FallbackEventNotice = {
            fromModel: info.fromModel,
            toModel: info.toModel,
            reason: info.reason,
            errorKind: info.errorKind,
            timestamp: Date.now(),
          };
          notices.push(notice);
          setLiveFallbackNotices([...notices]);
          setActiveRespondingModel(info.toModel);
          recordFallbackEvent({
            timestamp: Date.now(),
            originalModel: routingPool[0].displayName,
            failedModel: info.fromModel,
            failureReason: info.reason,
            errorKind: info.errorKind,
            nextSelectedModel: info.toModel,
            context: 'chat',
          });
          pushToast({
            type: 'warning',
            title: `${t('switchedNoticePrefix')} ${info.toModel}`,
            description: `${info.fromModel} failed (${info.errorKind}): ${info.reason}`,
          });
        },
        onCooldownNotice: (info) => {
          pushToast({
            type: 'warning',
            title: `${info.displayName} entered cooldown`,
            description: `${info.reason} (${info.consecutiveFailures} consecutive failures)`,
          });
        },
        onHealthUpdate: (info) => {
          recordModelHealth(info.configId, {
            ok: info.ok,
            latencyMs: info.latencyMs,
            errorKind: info.errorKind,
            message: info.message,
            cooldownUntil: info.cooldownUntil,
            consecutiveFailures: info.consecutiveFailures,
            successCount: info.successCount,
            failureCount: info.failureCount,
            averageLatencyMs: info.averageLatencyMs,
          });
        },
        onCapabilityAdapted: (info) => {
          pushToast({
            type: 'info',
            title: `Adapted input for ${info.displayName}`,
            description: info.reason,
          });
        },
        onDelta: ({ text, modelId, displayName }) => {
          fullContent += text;
          latestModelId = modelId;
          latestModelName = displayName;
          updateAssistant({
            content: fullContent,
            modelId: latestModelId,
            modelDisplayName: latestModelName,
            providerName: latestProvider,
            fallbackNotices: [...notices],
          });
        },
        onUsage: (u) => {
          const hasProviderNums =
            typeof u.inputTokens === 'number' ||
            typeof u.outputTokens === 'number' ||
            typeof u.totalTokens === 'number';
          if (hasProviderNums) {
            recordUsage({
              modelConfigId: u.configId,
              modelId: u.modelId,
              displayName: u.displayName || latestModelName,
              providerName: u.providerName || latestProvider,
              context: 'chat',
              conversationId: baseConv.id,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              totalTokens: u.totalTokens,
              tokenSource: 'provider-reported',
              costStatus: 'unavailable',
            });
          }
        },
        onModelStatus: (st) => {
          updateModel(st.configId, {
            status: st.status,
            lastError: st.lastError,
            ...(st.latencyMs ? { lastLatencyMs: st.latencyMs } : {}),
            ...(st.lastSuccessAt ? { lastSuccessAt: st.lastSuccessAt } : {}),
            ...(st.usage ? { lastUsage: st.usage } : {}),
          });
        },
        onDone: async (info) => {
          if (!info.usage && fullContent.length > 0) {
            const promptChars = historyBeforeReply.reduce((s, m) => s + m.content.length, 0);
            const estIn = Math.max(1, Math.round(promptChars / 4));
            const estOut = Math.max(1, Math.round(fullContent.length / 4));
            recordUsage({
              modelConfigId: info.configId,
              modelId: info.modelId,
              displayName: info.displayName,
              providerName: info.providerName || latestProvider,
              context: 'chat',
              conversationId: baseConv.id,
              inputTokens: estIn,
              outputTokens: estOut,
              totalTokens: estIn + estOut,
              tokenSource: 'estimated',
              costStatus: 'unavailable',
            });
          }
          await updateAssistant({
            content: fullContent,
            modelId: info.modelId,
            modelDisplayName: info.displayName,
            providerName: info.providerName || latestProvider,
            usage: info.usage,
            fallbackNotices: [...notices],
            isStreaming: false,
          });
          setIsStreaming(false);
          setActiveRespondingModel(null);
        },
        onFatal: async ({ message, attempts }) => {
          const detail = attempts
            .map((a) => `• ${a.displayName} (${a.providerName}): [${a.errorKind}] ${a.message}`)
            .join('\n');
          await updateAssistant({
            content: fullContent,
            error: detail ? `${message}\n\n${detail}` : message,
            fallbackNotices: [...notices],
            isStreaming: false,
          });
          setIsStreaming(false);
          setActiveRespondingModel(null);
        },
      },
    });
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isStreaming) return;
    if (!inputText.trim() && attachments.length === 0) return;

    let conv = activeConv;
    if (!conv) {
      conv = await createNewConversation(
        selectedFolderId !== 'all' ? selectedFolderId : undefined
      );
    }

    const userMsg: ChatMessage = {
      id: createId('msg'),
      role: 'user',
      content: inputText.trim(),
      attachments: attachments.length > 0 ? [...attachments] : undefined,
      createdAt: Date.now(),
    };

    const isFirstMessage = conv.messages.length === 0;
    const derivedTitle = isFirstMessage
      ? (inputText.trim() || attachments[0]?.name || 'New Conversation').slice(0, 46)
      : conv.title;

    const updatedConv: Conversation = {
      ...conv,
      title: derivedTitle,
      messages: [...conv.messages, userMsg],
      updatedAt: Date.now(),
    };

    setInputText('');
    setAttachments([]);
    await saveConversation(updatedConv);
    await sendPrompt(updatedConv, updatedConv.messages);
  };

  const handleRegenerate = async () => {
    if (!activeConv || isStreaming || activeConv.messages.length === 0) return;
    const msgs = [...activeConv.messages];
    if (msgs[msgs.length - 1].role === 'assistant') {
      msgs.pop();
    }
    if (msgs.length === 0) return;
    await sendPrompt(activeConv, msgs);
  };

  const handleSaveEditAndResend = async (msgId: string) => {
    if (!activeConv || isStreaming || !editingText.trim()) return;
    const idx = activeConv.messages.findIndex((m) => m.id === msgId);
    if (idx === -1) return;

    const truncated = activeConv.messages
      .slice(0, idx + 1)
      .map((m, i) =>
        i === idx ? { ...m, content: editingText.trim(), createdAt: Date.now() } : m
      );
    const updatedConv = { ...activeConv, messages: truncated, updatedAt: Date.now() };
    setEditingMessageId(null);
    setEditingText('');
    await saveConversation(updatedConv);
    await sendPrompt(updatedConv, truncated);
  };

  const handleExportConversation = () => {
    if (!activeConv) return;
    const md = [
      `# ${activeConv.title}`,
      '',
      ...activeConv.messages.map(
        (m) =>
          `## ${m.role.toUpperCase()}${m.modelDisplayName ? ` (${m.modelDisplayName})` : ''}\n\n${m.content}\n`
      ),
    ].join('\n');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeConv.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'conversation'}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    const fld = await createFolder(newFolderName.trim());
    setSelectedFolderId(fld.id);
    setNewFolderName('');
    setCreatingFolder(false);
  };

  const filteredConvs = conversations.filter((c) => {
    const matchesSearch = c.title.toLowerCase().includes(search.toLowerCase());
    const matchesFolder =
      selectedFolderId === 'all' ? true : c.folderId === selectedFolderId;
    return matchesSearch && matchesFolder;
  });
  const pinnedConvs = filteredConvs.filter((c) => c.pinned);
  const recentConvs = filteredConvs.filter((c) => !c.pinned);

  return (
    <div className="h-[calc(100vh-3.5rem)] flex bg-slate-50 dark:bg-slate-950">
      {/* Conversation Sidebar */}
      <aside className="hidden md:flex w-72 shrink-0 flex-col border-e border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="p-3 border-b border-slate-200 dark:border-slate-800 space-y-2.5">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={async () => {
                const c = await createNewConversation(
                  selectedFolderId !== 'all' ? selectedFolderId : undefined
                );
                setActiveConversationId(c.id);
              }}
              className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
            >
              <Plus className="h-4 w-4" />
              <span>{t('newChat')}</span>
            </button>
            <button
              type="button"
              onClick={() => setCreatingFolder((v) => !v)}
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
              title="New Folder"
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </div>

          {creatingFolder && (
            <form onSubmit={handleCreateFolder} className="flex items-center gap-1.5">
              <input
                type="text"
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder={t('newFolderPrompt')}
                className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1 text-xs"
              />
              <button
                type="submit"
                className="px-2 py-1 text-xs rounded-lg bg-blue-600 text-white"
              >
                {t('save')}
              </button>
            </form>
          )}

          {/* Folder Filter */}
          {folders.length > 0 && (
            <div className="flex items-center gap-1 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setSelectedFolderId('all')}
                className={`px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap ${
                  selectedFolderId === 'all'
                    ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400'
                    : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {t('allFolders')}
              </button>
              {folders.map((fld) => (
                <div key={fld.id} className="inline-flex items-center group">
                  <button
                    type="button"
                    onClick={() => setSelectedFolderId(fld.id)}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap ${
                      selectedFolderId === fld.id
                        ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400'
                        : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Folder className="h-3 w-3" />
                    <span>{fld.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedFolderId === fld.id) setSelectedFolderId('all');
                      deleteFolder(fld.id);
                    }}
                    className="hidden group-hover:inline-flex p-0.5 text-slate-400 hover:text-red-500"
                    title="Remove folder"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="relative">
            <Search className="h-3.5 w-3.5 text-slate-400 absolute start-2.5 top-2.5" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('searchConversations')}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 ps-8 pe-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-600"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          {pinnedConvs.length > 0 && (
            <div>
              <p className="px-2 pb-1 text-[11px] font-semibold text-slate-400">
                {t('pinned')}
              </p>
              <div className="space-y-0.5">
                {pinnedConvs.map((conv) => (
                  <ConversationRow
                    key={conv.id}
                    conv={conv}
                    active={conv.id === activeConversationId}
                    renaming={renamingConvId === conv.id}
                    renameValue={renameValue}
                    setRenameValue={setRenameValue}
                    onSelect={() => setActiveConversationId(conv.id)}
                    onStartRename={() => {
                      setRenamingConvId(conv.id);
                      setRenameValue(conv.title);
                    }}
                    onSubmitRename={async () => {
                      if (renameValue.trim()) {
                        await saveConversation({ ...conv, title: renameValue.trim() });
                      }
                      setRenamingConvId(null);
                    }}
                    onTogglePin={() => saveConversation({ ...conv, pinned: !conv.pinned })}
                    onDelete={() => setDeleteConvTarget(conv)}
                  />
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="px-2 pb-1 text-[11px] font-semibold text-slate-400">
              {t('recent')}
            </p>
            {recentConvs.length === 0 && pinnedConvs.length === 0 ? (
              <p className="px-2 py-4 text-xs text-slate-400">No conversations</p>
            ) : (
              <div className="space-y-0.5">
                {recentConvs.map((conv) => (
                  <ConversationRow
                    key={conv.id}
                    conv={conv}
                    active={conv.id === activeConversationId}
                    renaming={renamingConvId === conv.id}
                    renameValue={renameValue}
                    setRenameValue={setRenameValue}
                    onSelect={() => setActiveConversationId(conv.id)}
                    onStartRename={() => {
                      setRenamingConvId(conv.id);
                      setRenameValue(conv.title);
                    }}
                    onSubmitRename={async () => {
                      if (renameValue.trim()) {
                        await saveConversation({ ...conv, title: renameValue.trim() });
                      }
                      setRenamingConvId(null);
                    }}
                    onTogglePin={() => saveConversation({ ...conv, pinned: !conv.pinned })}
                    onDelete={() => setDeleteConvTarget(conv)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Mobile Conversation Drawer */}
      {mobileConvOpen && (
        <div className="fixed inset-0 z-40 md:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setMobileConvOpen(false)}
          />
          <aside className="relative z-50 w-72 max-w-[85vw] flex flex-col bg-white dark:bg-slate-900 border-e border-slate-200 dark:border-slate-800">
            <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={async () => {
                  const c = await createNewConversation();
                  setActiveConversationId(c.id);
                  setMobileConvOpen(false);
                }}
                className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white"
              >
                <Plus className="h-4 w-4" />
                <span>{t('newChat')}</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileConvOpen(false)}
                className="p-2 text-slate-400 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {filteredConvs.map((conv) => (
                <ConversationRow
                  key={conv.id}
                  conv={conv}
                  active={conv.id === activeConversationId}
                  renaming={renamingConvId === conv.id}
                  renameValue={renameValue}
                  setRenameValue={setRenameValue}
                  onSelect={() => {
                    setActiveConversationId(conv.id);
                    setMobileConvOpen(false);
                  }}
                  onStartRename={() => {
                    setRenamingConvId(conv.id);
                    setRenameValue(conv.title);
                  }}
                  onSubmitRename={async () => {
                    if (renameValue.trim()) {
                      await saveConversation({ ...conv, title: renameValue.trim() });
                    }
                    setRenamingConvId(null);
                  }}
                  onTogglePin={() => saveConversation({ ...conv, pinned: !conv.pinned })}
                  onDelete={() => setDeleteConvTarget(conv)}
                />
              ))}
            </div>
          </aside>
        </div>
      )}

      {/* Main Chat Area */}
      <div
        className="flex-1 flex flex-col min-w-0 relative"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (e.dataTransfer.files?.length) {
            readSelectedFiles(e.dataTransfer.files);
          }
        }}
      >
        {/* Chat Sub-Header */}
        <div className="min-h-12 shrink-0 px-4 py-1.5 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setMobileConvOpen(true)}
              className="md:hidden p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
              title="Conversations"
            >
              <MessageSquare className="h-4 w-4" />
            </button>

            <select
              aria-label={t('modelSelector')}
              value={activeConv?.selectedModelId || 'auto'}
              onChange={(e) => {
                if (!activeConv) return;
                saveConversation({ ...activeConv, selectedModelId: e.target.value });
              }}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-slate-900 dark:text-slate-100 max-w-[230px]"
            >
              <option value="auto">
                {t('autoMode')} ({settings.routingMode} · {enabledModels.length})
              </option>
              {enabledModels.map((m) => (
                <option key={m.id} value={m.id}>
                  #{m.priority} {m.displayName} ({m.providerName})
                </option>
              ))}
            </select>

            <select
              aria-label={t('chatModeLabel')}
              value={activeConv?.chatMode || 'general'}
              onChange={(e) => {
                if (!activeConv) return;
                saveConversation({ ...activeConv, chatMode: e.target.value as ChatMode });
              }}
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs font-medium text-slate-900 dark:text-slate-100"
            >
              <option value="general">Mode: General</option>
              <option value="coding">Mode: Coding</option>
              <option value="research">Mode: Research</option>
              <option value="debugging">Mode: Debugging</option>
              <option value="planning">Mode: Planning</option>
            </select>

            {activeConv && folders.length > 0 && (
              <select
                aria-label="Conversation Folder"
                value={activeConv.folderId || ''}
                onChange={(e) =>
                  saveConversation({
                    ...activeConv,
                    folderId: e.target.value || undefined,
                  })
                }
                className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1.5 text-xs text-slate-700 dark:text-slate-300"
              >
                <option value="">No folder</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    Folder: {f.name}
                  </option>
                ))}
              </select>
            )}

            {isStreaming && activeRespondingModel && (
              <span className="text-xs text-blue-600 dark:text-blue-400 font-medium truncate">
                {t('currentlyResponding')}: {activeRespondingModel}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setShowFallbackHistory((v) => !v)}
              className={`p-1.5 rounded-lg text-xs inline-flex items-center gap-1 transition-colors ${
                showFallbackHistory
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
              title={t('fallbackHistory')}
            >
              <History className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">{t('fallbackHistory')}</span>
            </button>

            <button
              type="button"
              onClick={() => setShowSystemPrompt((s) => !s)}
              className={`p-1.5 rounded-lg text-xs inline-flex items-center gap-1.5 transition-colors ${
                showSystemPrompt
                  ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400'
                  : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
              title="System Instruction"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">System Prompt</span>
            </button>

            {activeConv && activeConv.messages.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={handleExportConversation}
                  className="p-1.5 rounded-lg text-xs text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                  title={t('exportConversation')}
                >
                  <Download className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t('exportConversation')}</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    saveConversation({ ...activeConv, messages: [], updatedAt: Date.now() })
                  }
                  className="p-1.5 rounded-lg text-xs text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 inline-flex items-center gap-1"
                  title={t('clearContext')}
                >
                  <Eraser className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t('clearContext')}</span>
                </button>
              </>
            )}
          </div>
        </div>

        {/* Optional System Prompt Bar */}
        {showSystemPrompt && activeConv && (
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
              Conversation System Instruction (preserved across automatic model switches)
            </label>
            <textarea
              rows={2}
              value={activeConv.systemInstruction || ''}
              onChange={(e) =>
                saveConversation({ ...activeConv, systemInstruction: e.target.value })
              }
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-900 dark:text-slate-100"
            />
          </div>
        )}

        {/* Fallback History Panel */}
        {showFallbackHistory && (
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 max-h-48 overflow-y-auto space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-200">
              <span>{t('fallbackHistory')}</span>
              <button
                type="button"
                onClick={() => setShowFallbackHistory(false)}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            {fallbackHistory.length === 0 ? (
              <p className="text-xs text-slate-500">No fallback events recorded yet.</p>
            ) : (
              fallbackHistory.slice(0, 10).map((f) => (
                <div
                  key={f.id}
                  className="text-xs rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-2.5 py-1.5 flex items-center justify-between gap-2"
                >
                  <span className="truncate">
                    <strong>{f.failedModel}</strong> → <strong>{f.nextSelectedModel}</strong> ({f.errorKind})
                  </span>
                  <span className="text-[11px] text-slate-400 shrink-0">
                    {formatRelativeTime(f.timestamp)}
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        {/* Live Fallback Switch Banner */}
        {liveFallbackNotices.length > 0 && (
          <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-900/60 flex items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
            <ArrowRightLeft className="h-4 w-4 shrink-0" />
            <span className="truncate">
              {liveFallbackNotices[liveFallbackNotices.length - 1].fromModel} →{' '}
              {liveFallbackNotices[liveFallbackNotices.length - 1].toModel} (
              {liveFallbackNotices[liveFallbackNotices.length - 1].errorKind}:{' '}
              {liveFallbackNotices[liveFallbackNotices.length - 1].reason})
            </span>
          </div>
        )}

        {/* Messages Scroll Area */}
        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="max-w-3xl mx-auto space-y-6">
            {activeConv?.branchedFromTitle && (
              <div className="text-xs text-slate-500 flex items-center gap-1.5 border-b border-slate-200 dark:border-slate-800 pb-2">
                <GitBranch className="h-3.5 w-3.5" />
                <span>Branched from {activeConv.branchedFromTitle}</span>
              </div>
            )}

            {!activeConv || activeConv.messages.length === 0 ? (
              <div className="py-16 text-center space-y-3">
                <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
                  Unified Multi-Model AI Chat
                </h2>
                <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
                  Send text, code files, or images. In Auto Fallback Mode, OmniAI Studio automatically routes across your configured priority models if rate limits or outages occur.
                </p>
              </div>
            ) : (
              activeConv.messages.map((msg, idx) => {
                const isUser = msg.role === 'user';
                const isLastAssistant = !isUser && idx === activeConv.messages.length - 1;

                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                  >
                    {msg.fallbackNotices && msg.fallbackNotices.length > 0 && (
                      <div className="mb-2 w-full rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 space-y-1">
                        {msg.fallbackNotices.map((n, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />
                            <span>
                              Switched <strong>{n.fromModel}</strong> → <strong>{n.toModel}</strong> ({n.errorKind})
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div
                      className={`max-w-[92%] sm:max-w-[85%] rounded-xl px-4 py-3 text-sm ${
                        isUser
                          ? 'bg-blue-600 text-white'
                          : 'w-full border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100'
                      }`}
                    >
                      {/* Attachments */}
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-2">
                          {msg.attachments.map((att) =>
                            att.mimeType.startsWith('image/') && att.dataBase64 ? (
                              <img
                                key={att.id}
                                src={`data:${att.mimeType};base64,${att.dataBase64}`}
                                alt={att.name}
                                className="max-h-48 rounded-lg border border-white/20 object-contain"
                              />
                            ) : (
                              <div
                                key={att.id}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-black/15 text-xs font-mono"
                              >
                                <FileText className="h-3.5 w-3.5" />
                                <span>{att.name}</span>
                              </div>
                            )
                          )}
                        </div>
                      )}

                      {editingMessageId === msg.id ? (
                        <div className="space-y-2 min-w-[260px]">
                          <textarea
                            rows={3}
                            value={editingText}
                            onChange={(e) => setEditingText(e.target.value)}
                            className="w-full rounded-lg bg-white text-slate-900 p-2 text-sm focus:outline-none"
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingMessageId(null)}
                              className="px-2.5 py-1 text-xs rounded bg-white/20 text-white"
                            >
                              {t('cancel')}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSaveEditAndResend(msg.id)}
                              className="px-2.5 py-1 text-xs font-medium rounded bg-white text-blue-600"
                            >
                              {t('editAndResend')}
                            </button>
                          </div>
                        </div>
                      ) : isUser ? (
                        <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                      ) : (
                        <div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed">
                          {msg.content ? (
                            <Markdown
                              remarkPlugins={[remarkGfm]}
                              components={{
                                code: ({ className, children }) => (
                                  <CodeBlock className={className}>{children}</CodeBlock>
                                ),
                              }}
                            >
                              {msg.content}
                            </Markdown>
                          ) : msg.isStreaming ? (
                            <span className="text-slate-400">Generating response...</span>
                          ) : null}

                          {msg.error && (
                            <div className="mt-3 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 p-3 text-xs text-red-700 dark:text-red-300">
                              <div className="flex items-center gap-1.5 font-semibold mb-1">
                                <AlertTriangle className="h-4 w-4 shrink-0" />
                                <span>All Attempted Models Failed</span>
                              </div>
                              <pre className="whitespace-pre-wrap font-mono text-[11px]">{msg.error}</pre>
                              <button
                                type="button"
                                onClick={handleRegenerate}
                                className="mt-2 inline-flex items-center gap-1 px-3 py-1 rounded bg-red-600 text-white text-xs font-medium hover:bg-red-700"
                              >
                                <RefreshCw className="h-3 w-3" />
                                <span>{t('retry')}</span>
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Message Footer Metadata & Actions */}
                    <div className="mt-1.5 px-1 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                      {!isUser && msg.modelDisplayName && (
                        <span>
                          {msg.modelDisplayName}
                          {msg.providerName ? ` · ${msg.providerName}` : ''}
                        </span>
                      )}
                      {!isUser && msg.usage?.totalTokens && (
                        <span className="font-mono tabular-nums">
                          {msg.usage.totalTokens.toLocaleString()} tokens
                        </span>
                      )}

                      {isUser && !isStreaming && editingMessageId !== msg.id && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingMessageId(msg.id);
                            setEditingText(msg.content);
                          }}
                          className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200"
                        >
                          <Edit2 className="h-3 w-3" />
                          <span>{t('edit')}</span>
                        </button>
                      )}

                      {!isUser && !msg.isStreaming && msg.content && (
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(msg.content);
                            setCopiedMsgId(msg.id);
                            setTimeout(() => setCopiedMsgId(null), 1500);
                          }}
                          className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200"
                        >
                          {copiedMsgId === msg.id ? (
                            <Check className="h-3 w-3 text-emerald-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                          <span>{copiedMsgId === msg.id ? t('copied') : t('copy')}</span>
                        </button>
                      )}

                      {!isStreaming && (
                        <button
                          type="button"
                          onClick={async () => {
                            const branched = await branchConversation(activeConv.id, msg.id);
                            if (branched) {
                              pushToast({
                                type: 'info',
                                title: 'Conversation branched',
                                description: `Created "${branched.title}".`,
                              });
                            }
                          }}
                          className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200"
                        >
                          <GitBranch className="h-3 w-3" />
                          <span>{t('branchConversation')}</span>
                        </button>
                      )}

                      {isLastAssistant && !isStreaming && (
                        <button
                          type="button"
                          onClick={handleRegenerate}
                          className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200"
                        >
                          <RefreshCw className="h-3 w-3" />
                          <span>{t('regenerate')}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Drag-and-Drop Overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-30 bg-blue-600/10 border-2 border-dashed border-blue-500 flex items-center justify-center pointer-events-none">
            <div className="rounded-xl bg-white dark:bg-slate-900 border border-blue-500 px-6 py-4 text-sm font-medium text-blue-600 dark:text-blue-400">
              Drop images, code, or documents to attach
            </div>
          </div>
        )}

        {/* Composer */}
        <div className="shrink-0 p-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <form onSubmit={handleSend} className="max-w-3xl mx-auto space-y-2.5">
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {attachments.map((att) => (
                  <div
                    key={att.id}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs"
                  >
                    {att.mimeType.startsWith('image/') ? (
                      <ImageIcon className="h-3.5 w-3.5 text-blue-500" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 text-slate-500" />
                    )}
                    <span className="max-w-[140px] truncate font-mono">{att.name}</span>
                    <span className="text-slate-400 tabular-nums">{formatBytes(att.size)}</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((p) => p.filter((a) => a.id !== att.id))}
                      className="text-slate-400 hover:text-red-500"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.jsx,.css,.html,.py,.sql,.csv,.yml,.yaml"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) {
                    readSelectedFiles(e.target.files);
                    e.target.value = '';
                  }
                }}
              />

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="p-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                title={t('attachFiles')}
              >
                <Paperclip className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={handleVoiceToggle}
                className={`p-2.5 rounded-lg border shrink-0 transition-colors ${
                  listeningVoice
                    ? 'border-red-500 bg-red-50 dark:bg-red-950/40 text-red-600'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
                title={t('voiceInput')}
              >
                {listeningVoice ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>

              <textarea
                rows={1}
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={t('typeMessagePlaceholder')}
                className="flex-1 min-h-[42px] max-h-36 resize-y rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />

              {isStreaming ? (
                <button
                  type="button"
                  onClick={() => {
                    abortRef.current?.abort();
                    setIsStreaming(false);
                    setActiveRespondingModel(null);
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium shrink-0"
                >
                  <Square className="h-4 w-4" />
                  <span>{t('stopGenerating')}</span>
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!inputText.trim() && attachments.length === 0}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm font-medium shrink-0"
                >
                  <Send className="h-4 w-4" />
                  <span>{t('send')}</span>
                </button>
              )}
            </div>
          </form>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(deleteConvTarget)}
        title={`Delete "${deleteConvTarget?.title || 'conversation'}"?`}
        description="This conversation history will be permanently deleted from local browser storage."
        confirmLabel={t('delete')}
        onConfirm={async () => {
          if (deleteConvTarget) {
            await deleteConversation(deleteConvTarget.id);
          }
          setDeleteConvTarget(null);
        }}
        onCancel={() => setDeleteConvTarget(null)}
      />
    </div>
  );
}

function ConversationRow({
  conv,
  active,
  renaming,
  renameValue,
  setRenameValue,
  onSelect,
  onStartRename,
  onSubmitRename,
  onTogglePin,
  onDelete,
}: {
  conv: Conversation;
  active: boolean;
  renaming: boolean;
  renameValue: string;
  setRenameValue: (v: string) => void;
  onSelect: () => void;
  onStartRename: () => void;
  onSubmitRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  if (renaming) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmitRename();
        }}
        className="px-2 py-1"
      >
        <input
          type="text"
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={onSubmitRename}
          className="w-full rounded border border-blue-500 bg-white dark:bg-slate-950 px-2 py-1 text-xs"
        />
      </form>
    );
  }

  return (
    <div
      onClick={onSelect}
      className={`group flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
        active
          ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400'
          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium truncate">{conv.title}</p>
        <p className="text-[11px] text-slate-400 tabular-nums">
          {formatRelativeTime(conv.updatedAt)}
          {conv.chatMode && conv.chatMode !== 'general' ? ` · ${conv.chatMode}` : ''}
        </p>
      </div>

      <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          title={conv.pinned ? 'Unpin' : 'Pin'}
        >
          {conv.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onStartRename();
          }}
          className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          title="Rename"
        >
          <Edit2 className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950/60 text-slate-400 hover:text-red-600"
          title="Delete"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
