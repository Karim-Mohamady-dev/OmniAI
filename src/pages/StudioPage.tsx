import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Check,
  Code2,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  FileJson,
  FolderGit2,
  FolderOpen,
  HardDrive,
  History,
  Laptop,
  Play,
  Plus,
  RotateCcw,
  Search,
  Shield,
  ShieldCheck,
  Sliders,
  Sparkles,
  SplitSquareHorizontal,
  Square,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import { CodeEditorPanel } from '../components/CodeEditorPanel.tsx';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { FileExplorer } from '../components/FileExplorer.tsx';
import { LivePreviewPanel } from '../components/LivePreviewPanel.tsx';
import { SupervisorPanel } from '../components/SupervisorPanel.tsx';
import { TerminalOutputPanel, type TerminalLogEntry } from '../components/TerminalOutputPanel.tsx';
import { useApp } from '../contexts/AppContext.tsx';
import {
  getDesktopBridge,
  type DesktopEnvironmentInfo,
  type FolderInspectionSummary,
  type RecentLocalProject,
} from '../desktop/desktopBridge.ts';
import { streamOrchestratedChat } from '../orchestration/fallbackClient.ts';
import { bundleProjectForPreview, type PreviewBundleResult } from '../preview/previewBundler.ts';
import {
  detectProjectDependencies,
  parseAiProjectChanges,
  type ParsedProjectChangeSet,
} from '../project-engine/aiProjectParser.ts';
import {
  deleteProjectPath,
  renameProjectPath,
  upsertProjectFile,
} from '../project-engine/fileOperations.ts';
import { downloadProjectAsZip } from '../project-engine/zipExporter.ts';
import { createSingleProjectBackupPayload } from '../storage/backupValidator.ts';
import { computeCompactLineDiff } from '../studio/lineDiff.ts';
import type {
  LocalAgentAuditEntry,
  LocalAgentPermission,
  Project,
  ProjectFile,
  ProjectSnapshot,
} from '../types/index.ts';
import { createId, formatRelativeTime } from '../utils/helpers.ts';

type StudioAiMode = 'fast' | 'planning' | 'agent';

interface BuilderTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  plan?: string;
  modifiedFiles?: string[];
  modelName?: string;
}

interface PendingReviewPlan {
  changeSet: ParsedProjectChangeSet;
  modelName: string;
  rawOutput: string;
}

const DEFAULT_AGENT_PERMISSIONS: Record<LocalAgentPermission, boolean> = {
  'read-only': true,
  'edit-files': true,
  'run-commands': true,
  'install-deps': false,
  'delete-files': false,
  'publish-github': true,
};

export function StudioPage() {
  const {
    projects,
    activeProjectId,
    setActiveProjectId,
    saveProject,
    createProject,
    getProjectSnapshots,
    createProjectSnapshot,
    restoreProjectSnapshot,
    models,
    updateModel,
    recordModelHealth,
    recordUsage,
    recordFallbackEvent,
    settings,
    setRoute,
    pushToast,
    t,
  } = useApp();

  const desktopBridge = getDesktopBridge();
  const project = projects.find((p) => p.id === activeProjectId) || projects[0] || null;

  const [centerMode, setCenterMode] = useState<'split' | 'code' | 'preview'>('split');
  const [rightTab, setRightTab] = useState<'builder' | 'supervisor'>('builder');
  const [showTerminal, setShowTerminal] = useState(true);
  const [mobileFilesOpen, setMobileFilesOpen] = useState(false);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);

  const [bundle, setBundle] = useState<PreviewBundleResult | null>(null);
  const [bundling, setBundling] = useState(false);
  const [runtimeErrors, setRuntimeErrors] = useState<string[]>([]);
  const [logs, setLogs] = useState<TerminalLogEntry[]>([]);

  const [studioMode, setStudioMode] = useState<StudioAiMode>('fast');
  const [builderTurns, setBuilderTurns] = useState<BuilderTurn[]>([]);
  const [builderPrompt, setBuilderPrompt] = useState('');
  const [builderModelChoice, setBuilderModelChoice] = useState<string>('auto');
  const [generating, setGenerating] = useState(false);
  const [activeBuilderModel, setActiveBuilderModel] = useState<string | null>(null);
  const [pendingReviewPlan, setPendingReviewPlan] = useState<PendingReviewPlan | null>(null);
  const [expandedDiffPath, setExpandedDiffPath] = useState<string | null>(null);
  const [pendingAiDeletes, setPendingAiDeletes] = useState<{
    paths: string[];
    modelName: string;
  } | null>(null);

  const [showSnapshots, setShowSnapshots] = useState(false);
  const [snapshots, setSnapshots] = useState<ProjectSnapshot[]>([]);
  const [supervisorAutoToken, setSupervisorAutoToken] = useState(0);
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null);
  const [runningProcessId, setRunningProcessId] = useState<string | null>(null);

  const [panelWidth, setPanelWidth] = useState<'compact' | 'balanced' | 'wide'>('balanced');
  const [showSearchDrawer, setShowSearchDrawer] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showInstructions, setShowInstructions] = useState(false);
  const [showLocalAgentDrawer, setShowLocalAgentDrawer] = useState(false);
  const [agentPermissions, setAgentPermissions] =
    useState<Record<LocalAgentPermission, boolean>>(DEFAULT_AGENT_PERMISSIONS);
  const [agentAuditLog, setAgentAuditLog] = useState<LocalAgentAuditEntry[]>([]);
  const [desktopEnv, setDesktopEnv] = useState<DesktopEnvironmentInfo | null>(null);
  const [portStatus, setPortStatus] = useState<{ port5173: boolean | null; port3000: boolean | null }>({
    port5173: null,
    port3000: null,
  });
  const [recentLocalFolders, setRecentLocalFolders] = useState<RecentLocalProject[]>([]);
  const [detectedPreviewUrl, setDetectedPreviewUrl] = useState<string | null>(null);
  const [pendingFolderAttach, setPendingFolderAttach] = useState<{
    folder: string;
    inspection: FolderInspectionSummary;
    diskFiles: Array<{ path: string; content: string; updatedAt?: number }>;
  } | null>(null);
  const [pendingInstallCmd, setPendingInstallCmd] = useState<string | null>(null);
  const [autoFixBuildLoop, setAutoFixBuildLoop] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  const bundleTimerRef = useRef<number | null>(null);

  const appendAudit = useCallback(
    (
      action: string,
      target: string,
      permissionUsed: LocalAgentPermission,
      outcome: LocalAgentAuditEntry['outcome'],
      detail?: string
    ) => {
      setAgentAuditLog((prev) => [
        {
          id: createId('aud'),
          timestamp: Date.now(),
          action,
          target,
          permissionUsed,
          outcome,
          detail,
        },
        ...prev.slice(0, 79),
      ]);
    },
    []
  );

  const appendLog = useCallback(
    (level: TerminalLogEntry['level'], source: TerminalLogEntry['source'], message: string) => {
      setLogs((prev) => [
        ...prev.slice(-150),
        { id: createId('log'), level, source, message, timestamp: Date.now() },
      ]);
    },
    []
  );

  const refreshSnapshots = useCallback(
    async (projectId: string) => {
      const list = await getProjectSnapshots(projectId);
      setSnapshots(list);
    },
    [getProjectSnapshots]
  );

  const refreshDesktopDiagnostics = useCallback(async () => {
    if (!desktopBridge) return;
    try {
      const [env, recent, p5173, p3000] = await Promise.all([
        desktopBridge.checkEnvironment?.() ?? Promise.resolve(null),
        desktopBridge.getRecentProjects?.() ?? Promise.resolve([]),
        desktopBridge.checkPortAvailability?.(5173) ?? Promise.resolve(null),
        desktopBridge.checkPortAvailability?.(3000) ?? Promise.resolve(null),
      ]);
      if (env) setDesktopEnv(env);
      setRecentLocalFolders(recent);
      setPortStatus({
        port5173: p5173 ? p5173.inUse : null,
        port3000: p3000 ? p3000.inUse : null,
      });
    } catch {
      // Ignore optional desktop environment query failures
    }
  }, [desktopBridge]);

  useEffect(() => {
    refreshDesktopDiagnostics();
  }, [refreshDesktopDiagnostics]);

  // Sync active file tabs & snapshots when switching projects
  useEffect(() => {
    if (!project) return;
    const preferred =
      project.files.find((f) => f.path === 'src/App.tsx')?.path ||
      project.files.find((f) => f.path === 'index.html')?.path ||
      project.files[0]?.path ||
      null;
    setActiveFilePath(preferred);
    setOpenTabs(preferred ? [preferred] : []);
    setBuilderTurns([]);
    setRuntimeErrors([]);
    setPendingReviewPlan(null);
    refreshSnapshots(project.id);
  }, [project?.id, refreshSnapshots]);

  // Listen to Electron Desktop process stdout/stderr if running inside Electron
  useEffect(() => {
    if (!desktopBridge) return;
    const offOut = desktopBridge.onProcessOutput((evt) => {
      appendLog(evt.stream === 'stderr' ? 'warn' : 'info', 'bundler', evt.text.trimEnd());
      if (evt.detectedUrl) {
        setDetectedPreviewUrl(evt.detectedUrl);
        pushToast({
          type: 'success',
          title: 'Local Dev Server Running',
          description: `Preview URL detected at ${evt.detectedUrl}`,
        });
      }
    });
    const offExit = desktopBridge.onProcessExit((evt) => {
      appendLog('info', 'bundler', `Desktop process exited with code ${evt.code ?? 0}`);
      setRunningProcessId(null);
    });
    return () => {
      offOut();
      offExit();
    };
  }, [appendLog, desktopBridge, pushToast]);

  // Listen to sandboxed preview postMessage logs/errors
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        source?: string;
        level?: 'log' | 'warn' | 'error';
        message?: string;
      };
      if (!data || data.source !== 'omniai-preview' || !data.message) return;
      const lvl = data.level || 'log';
      appendLog(lvl, 'sandbox', data.message);
      if (lvl === 'error') {
        setRuntimeErrors((prev) => [...prev.slice(-5), data.message!]);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [appendLog]);

  const runPreviewBundle = useCallback(
    async (targetProj: Project): Promise<PreviewBundleResult | null> => {
      setBundling(true);
      setRuntimeErrors([]);
      try {
        const result = await bundleProjectForPreview(targetProj.files, targetProj.framework);
        setBundle(result);
        if (result.ok) {
          appendLog(
            'info',
            'bundler',
            `Preview bundle compiled in ${result.buildTimeMs}ms (${targetProj.files.length} files).`
          );
          const deps = detectProjectDependencies(targetProj.files);
          if (deps.unsupportedInPreview.length > 0) {
            appendLog(
              'warn',
              'bundler',
              `External packages not bundled in browser sandbox: ${deps.unsupportedInPreview.join(', ')}. Download ZIP or open in Desktop runner to install via npm.`
            );
          }
        } else {
          result.errors.forEach((err) => {
            appendLog(
              'error',
              'bundler',
              `${err.file ? `${err.file}:${err.line || 1} ` : ''}${err.text}`
            );
          });
        }
        return result;
      } catch (err) {
        appendLog(
          'error',
          'bundler',
          err instanceof Error ? err.message : 'Preview bundle failed'
        );
        return null;
      } finally {
        setBundling(false);
      }
    },
    [appendLog]
  );

  // Debounced auto-rebundle when project files change
  useEffect(() => {
    if (!project) return;
    if (bundleTimerRef.current) window.clearTimeout(bundleTimerRef.current);
    bundleTimerRef.current = window.setTimeout(() => {
      runPreviewBundle(project);
    }, 450);
    return () => {
      if (bundleTimerRef.current) window.clearTimeout(bundleTimerRef.current);
    };
  }, [project?.files, project?.id, runPreviewBundle]);

  if (!project) {
    return (
      <div className="p-8 text-center">
        <button
          type="button"
          onClick={() =>
            createProject('New Studio App', 'Generated in OmniAI Studio', 'react-vite')
          }
          className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium"
        >
          {t('newProject')}
        </button>
      </div>
    );
  }

  const enabledModels = [...models]
    .filter((m) => m.enabled)
    .sort((a, b) => a.priority - b.priority);

  const handleSelectFile = (filePath: string) => {
    setActiveFilePath(filePath);
    setOpenTabs((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]));
  };

  const handleCloseTab = (filePath: string) => {
    setOpenTabs((prev) => {
      const next = prev.filter((p) => p !== filePath);
      if (activeFilePath === filePath) {
        setActiveFilePath(next[next.length - 1] || null);
      }
      return next;
    });
  };

  const updateProjectFiles = async (
    nextFiles: ProjectFile[],
    activityAction: string,
    activityDetail: string,
    modelName?: string
  ): Promise<Project> => {
    const now = Date.now();
    const updated: Project = {
      ...project,
      files: nextFiles,
      updatedAt: now,
      activities: [
        {
          id: createId('act'),
          action: activityAction,
          detail: activityDetail,
          timestamp: now,
          modelName,
        },
        ...project.activities.slice(0, 29),
      ],
    };
    await saveProject(updated);

    // Sync writes to local Electron folder if attached and edit-files permission granted
    if (desktopBridge && project.localFolderPath) {
      if (!agentPermissions['edit-files']) {
        appendAudit(
          'sync_files',
          project.localFolderPath,
          'edit-files',
          'blocked',
          'Blocked disk write because "edit-files" permission is disabled.'
        );
        pushToast({
          type: 'warning',
          title: 'Disk sync paused (permission disabled)',
          description: 'Changes were saved to IndexedDB. Enable "edit-files" in Local Agent to write to disk.',
        });
      } else {
        let writtenCount = 0;
        for (const f of nextFiles) {
          const old = project.files.find((pf) => pf.path === f.path);
          if (!old || old.content !== f.content) {
            await desktopBridge.writeFile(project.localFolderPath, f.path, f.content).catch(() => {});
            writtenCount += 1;
          }
        }
        if (writtenCount > 0) {
          appendAudit(
            'write_files',
            `${project.localFolderPath} (${writtenCount} file(s))`,
            'edit-files',
            'completed'
          );
        }
      }
    }
    return updated;
  };

  const handleCreateFile = async (path: string) => {
    const { files: nextFiles, error } = upsertProjectFile(project.files, path, '');
    if (error) {
      pushToast({ type: 'error', title: 'Invalid file path', description: error });
      return;
    }
    await updateProjectFiles(nextFiles, 'File created', path);
    handleSelectFile(path);
  };

  const handleChangeEditorContent = async (path: string, content: string) => {
    const { files: nextFiles } = upsertProjectFile(project.files, path, content);
    await saveProject({ ...project, files: nextFiles, updatedAt: Date.now() });
    if (desktopBridge && project.localFolderPath && agentPermissions['edit-files']) {
      desktopBridge.writeFile(project.localFolderPath, path, content).catch(() => {});
    }
  };

  const handleRenamePath = async (oldPath: string, newPath: string) => {
    const { files: nextFiles, error } = renameProjectPath(project.files, oldPath, newPath);
    if (error) {
      pushToast({ type: 'error', title: 'Rename failed', description: error });
      return;
    }
    if (desktopBridge && project.localFolderPath && agentPermissions['edit-files']) {
      await desktopBridge.renamePath(project.localFolderPath, oldPath, newPath).catch(() => {});
      appendAudit('rename_path', `${oldPath} -> ${newPath}`, 'edit-files', 'completed');
    }
    await updateProjectFiles(nextFiles, 'Renamed path', `${oldPath} → ${newPath}`);
    setOpenTabs((prev) => prev.map((p) => (p === oldPath ? newPath : p)));
    if (activeFilePath === oldPath) setActiveFilePath(newPath);
  };

  const handleConfirmDeletePath = async () => {
    if (!pendingDeletePath) return;
    if (desktopBridge && project.localFolderPath) {
      if (!agentPermissions['delete-files']) {
        appendAudit(
          'delete_disk_file',
          pendingDeletePath,
          'delete-files',
          'blocked',
          'Removed in workspace only; disk deletion requires delete-files permission.'
        );
      } else {
        await desktopBridge.deletePath(project.localFolderPath, pendingDeletePath).catch(() => {});
        appendAudit('delete_disk_file', pendingDeletePath, 'delete-files', 'completed');
      }
    }
    const nextFiles = deleteProjectPath(project.files, pendingDeletePath);
    await updateProjectFiles(nextFiles, 'Deleted path', pendingDeletePath);
    handleCloseTab(pendingDeletePath);
    setPendingDeletePath(null);
  };

  const applyChangeSet = async (
    targetProject: Project,
    parsed: ParsedProjectChangeSet,
    modelName: string,
    createAutoBackup = true
  ): Promise<{ updatedProject: Project; appliedPaths: string[] }> => {
    if (createAutoBackup && (parsed.writes.length > 0 || parsed.renames.length > 0)) {
      await createProjectSnapshot(
        targetProject.id,
        `Before ${modelName} update`,
        'auto-backup'
      );
      await refreshSnapshots(targetProject.id);
    }

    let nextFiles = [...targetProject.files];
    const appliedPaths: string[] = [];

    for (const ren of parsed.renames) {
      const res = renameProjectPath(nextFiles, ren.from, ren.to);
      if (res.error) {
        appendLog('warn', 'bundler', `Skipped rename ${ren.from} -> ${ren.to}: ${res.error}`);
      } else {
        nextFiles = res.files;
        appliedPaths.push(ren.to);
      }
    }

    for (const write of parsed.writes) {
      const res = upsertProjectFile(nextFiles, write.path, write.content);
      if (res.error) {
        appendLog('warn', 'bundler', `Skipped unsafe write "${write.path}": ${res.error}`);
      } else {
        nextFiles = res.files;
        appliedPaths.push(write.path);
      }
    }

    let updatedProject = targetProject;
    if (appliedPaths.length > 0) {
      updatedProject = await updateProjectFiles(
        nextFiles,
        'AI Builder updated project',
        `Modified ${appliedPaths.length} file(s): ${appliedPaths.slice(0, 4).join(', ')}`,
        modelName
      );
      const firstTab = appliedPaths.find((p) => p.endsWith('App.tsx')) || appliedPaths[0];
      if (firstTab) handleSelectFile(firstTab);
    }

    if (parsed.deletes.length > 0) {
      setPendingAiDeletes({ paths: parsed.deletes, modelName });
    }

    return { updatedProject, appliedPaths };
  };

  const executeSingleBuilderCall = async (
    targetProject: Project,
    userPrompt: string,
    mode: StudioAiMode,
    pool: typeof enabledModels,
    controller: AbortController,
    aiTurnId: string
  ): Promise<{ rawOutput: string; modelName: string; failed?: string }> => {
    const fileInventory = targetProject.files
      .map((f) => `- ${f.path} (${f.content.length} chars)`)
      .join('\n');
    const keyContents = targetProject.files
      .filter((f) => !f.path.endsWith('package-lock.json'))
      .slice(0, 18)
      .map((f) => `<file path="${f.path}">\n${f.content.slice(0, 5000)}\n</file>`)
      .join('\n\n');

    const customAddon = targetProject.userInstructions?.trim()
      ? `\n\nUSER PROJECT INSTRUCTIONS:\n${targetProject.userInstructions.trim()}`
      : '';

    const systemInstruction = `You are OmniAI Studio's expert Full-Stack AI Software Architect running in ${mode.toUpperCase()} mode.
You are modifying an existing ${targetProject.framework} project named "${targetProject.name}".
IMPORTANT RUNTIME SANDBOX NOTE:
For live browser preview, only standard React ('react', 'react-dom', 'react-dom/client'), 'lucide-react' icons, Tailwind CSS classes, and local project relative imports (./...) are bundled in-browser. Prefer clean React + TypeScript + Tailwind CSS + lucide-react so the live preview compiles cleanly immediately.

OUTPUT FORMAT REQUIREMENT:
1. Start with a concise architectural plan inside <omni_plan>...</omni_plan>
2. Output each created or modified file with FULL complete file contents inside:
<omni_file path="src/App.tsx">
// complete file content here
</omni_file>
3. If renaming a file, emit: <omni_rename from="src/Old.tsx" to="src/New.tsx" />
4. If a file must be deleted, emit: <omni_delete path="path/to/file.tsx" />
5. End with a brief summary inside <omni_summary>...</omni_summary>

Never omit code with "// ... rest of file". Always output complete runnable files.${customAddon}`;

    const fullUserMessage = `Current Project Files:\n${fileInventory}\n\nCurrent File Contents:\n${keyContents}\n\nUser Request:\n${userPrompt}`;

    let rawOutput = '';
    let usedModelName = pool[0].displayName;
    let usedProviderName = pool[0].providerName;
    let fatalError: string | undefined;
    let recordedProviderUsage = false;

    await streamOrchestratedChat({
      models: pool,
      messages: [{ role: 'user', content: fullUserMessage }],
      systemInstruction,
      policy: settings.fallbackPolicy,
      routingMode: builderModelChoice === 'auto' ? settings.routingMode : 'manual',
      signal: controller.signal,
      callbacks: {
        onAttempt: (info) => {
          usedModelName = info.displayName;
          usedProviderName = info.providerName;
          setActiveBuilderModel(info.displayName);
        },
        onSwitched: (info) => {
          usedModelName = info.toModel;
          usedProviderName = info.toProvider;
          setActiveBuilderModel(info.toModel);
          recordFallbackEvent({
            timestamp: Date.now(),
            originalModel: pool[0].displayName,
            failedModel: info.fromModel,
            failureReason: info.reason,
            errorKind: info.errorKind,
            nextSelectedModel: info.toModel,
            context: 'studio',
          });
          pushToast({
            type: 'warning',
            title: `Builder switched to ${info.toModel}`,
            description: `${info.fromModel} failed (${info.errorKind})`,
          });
        },
        onCooldownNotice: (info) => {
          pushToast({
            type: 'warning',
            title: `${info.displayName} entered cooldown`,
            description: `${info.reason} (${info.consecutiveFailures} failures)`,
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
        onDelta: ({ text, displayName }) => {
          rawOutput += text;
          usedModelName = displayName;
          setBuilderTurns((prev) =>
            prev.map((turn) =>
              turn.id === aiTurnId
                ? { ...turn, text: rawOutput, modelName: usedModelName }
                : turn
            )
          );
        },
        onUsage: (u) => {
          const hasProviderNums =
            typeof u.inputTokens === 'number' ||
            typeof u.outputTokens === 'number' ||
            typeof u.totalTokens === 'number';
          if (hasProviderNums) {
            recordedProviderUsage = true;
            recordUsage({
              modelConfigId: u.configId,
              modelId: u.modelId,
              displayName: u.displayName || usedModelName,
              providerName: u.providerName || usedProviderName,
              context: 'studio',
              projectId: targetProject.id,
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
          });
        },
        onDone: (info) => {
          if (!recordedProviderUsage && !info.usage && rawOutput.length > 0) {
            const estIn = Math.max(1, Math.round(fullUserMessage.length / 4));
            const estOut = Math.max(1, Math.round(rawOutput.length / 4));
            recordUsage({
              modelConfigId: info.configId,
              modelId: info.modelId,
              displayName: info.displayName,
              providerName: info.providerName || usedProviderName,
              context: 'studio',
              projectId: targetProject.id,
              inputTokens: estIn,
              outputTokens: estOut,
              totalTokens: estIn + estOut,
              tokenSource: 'estimated',
              costStatus: 'unavailable',
            });
          }
        },
        onFatal: ({ message }) => {
          fatalError = message;
        },
      },
    });

    return { rawOutput, modelName: usedModelName, failed: fatalError };
  };

  const runAiBuilderPrompt = async (promptText: string) => {
    if (!promptText.trim() || generating) return;

    const pool =
      builderModelChoice === 'auto'
        ? enabledModels
        : enabledModels.filter((m) => m.id === builderModelChoice);

    if (pool.length === 0) {
      pushToast({
        type: 'error',
        title: 'No AI model enabled',
        description: 'Add or enable a model in the Models page before generating code.',
      });
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setGenerating(true);
    setPendingReviewPlan(null);
    setActiveBuilderModel(pool[0].displayName);
    const userTurnId = createId('turn');
    const aiTurnId = createId('turn');

    setBuilderTurns((prev) => [
      ...prev,
      { id: userTurnId, role: 'user', text: promptText.trim() },
      {
        id: aiTurnId,
        role: 'assistant',
        text:
          studioMode === 'planning'
            ? 'Generating architectural plan & proposed file changes...'
            : studioMode === 'agent'
              ? 'Agent loop starting...'
              : 'Planning & generating files...',
        modelName: pool[0].displayName,
      },
    ]);
    setBuilderPrompt('');

    try {
      if (studioMode === 'planning') {
        const res = await executeSingleBuilderCall(
          project,
          promptText.trim(),
          'planning',
          pool,
          controller,
          aiTurnId
        );
        if (res.failed) {
          setBuilderTurns((prev) =>
            prev.map((turn) =>
              turn.id === aiTurnId ? { ...turn, text: `Error: ${res.failed}` } : turn
            )
          );
          pushToast({ type: 'error', title: 'Planning failed', description: res.failed });
        } else {
          const parsed = parseAiProjectChanges(res.rawOutput);
          setPendingReviewPlan({
            changeSet: parsed,
            modelName: res.modelName,
            rawOutput: res.rawOutput,
          });
          setBuilderTurns((prev) =>
            prev.map((turn) =>
              turn.id === aiTurnId
                ? {
                    ...turn,
                    plan: parsed.plan,
                    text:
                      parsed.summary ||
                      `Plan ready: ${parsed.writes.length} write(s), ${parsed.renames.length} rename(s), ${parsed.deletes.length} delete(s). Review and approve below.`,
                    modelName: res.modelName,
                  }
                : turn
            )
          );
        }
        return;
      }

      if (studioMode === 'fast') {
        const res = await executeSingleBuilderCall(
          project,
          promptText.trim(),
          'fast',
          pool,
          controller,
          aiTurnId
        );
        if (res.failed) {
          setBuilderTurns((prev) =>
            prev.map((turn) =>
              turn.id === aiTurnId ? { ...turn, text: `Error: ${res.failed}` } : turn
            )
          );
          pushToast({ type: 'error', title: 'AI Builder failed', description: res.failed });
          return;
        }
        const parsed = parseAiProjectChanges(res.rawOutput);
        const { appliedPaths } = await applyChangeSet(project, parsed, res.modelName, true);
        if (appliedPaths.length > 0) {
          setSupervisorAutoToken((n) => n + 1);
          pushToast({
            type: 'success',
            title: `Applied ${appliedPaths.length} file(s)`,
            description: parsed.summary || appliedPaths.join(', '),
          });
        }
        setBuilderTurns((prev) =>
          prev.map((turn) =>
            turn.id === aiTurnId
              ? {
                  ...turn,
                  plan: parsed.plan,
                  text:
                    parsed.summary ||
                    (appliedPaths.length > 0
                      ? `Updated ${appliedPaths.join(', ')}`
                      : res.rawOutput),
                  modifiedFiles: appliedPaths,
                  modelName: res.modelName,
                }
              : turn
          )
        );
        return;
      }

      // Agent mode: iterate up to maxAgentIterations until preview compiles cleanly
      const maxSteps = Math.max(1, Math.min(settings.maxAgentIterations || 4, 8));
      let workingProject = project;
      let currentTask = promptText.trim();
      let combinedModified: string[] = [];
      let lastModelName = pool[0].displayName;
      let lastPlan = '';

      for (let step = 1; step <= maxSteps; step++) {
        if (controller.signal.aborted) break;
        appendLog('info', 'bundler', `Agent iteration ${step}/${maxSteps} started...`);
        const res = await executeSingleBuilderCall(
          workingProject,
          currentTask,
          'agent',
          pool,
          controller,
          aiTurnId
        );
        if (res.failed) {
          pushToast({ type: 'error', title: 'Agent step failed', description: res.failed });
          break;
        }
        lastModelName = res.modelName;
        const parsed = parseAiProjectChanges(res.rawOutput);
        if (parsed.plan) lastPlan = parsed.plan;

        const { updatedProject, appliedPaths } = await applyChangeSet(
          workingProject,
          parsed,
          res.modelName,
          step === 1
        );
        workingProject = updatedProject;
        combinedModified = Array.from(new Set([...combinedModified, ...appliedPaths]));

        const checkBundle = await runPreviewBundle(workingProject);
        if (!checkBundle || checkBundle.ok || checkBundle.errors.length === 0) {
          appendLog('info', 'bundler', `Agent verified clean build on iteration ${step}.`);
          break;
        }
        if (!autoFixBuildLoop) {
          appendLog('warn', 'bundler', 'Auto-fix build loop is disabled; stopping after step 1.');
          break;
        }

        const errText = checkBundle.errors
          .map((e) => `${e.file || ''}:${e.line || 1} ${e.text}`)
          .join('\n');
        currentTask = `The previous build produced errors:\n${errText}\n\nFix all errors cleanly while preserving the user goal: ${promptText.trim()}`;
      }

      if (combinedModified.length > 0) {
        setSupervisorAutoToken((n) => n + 1);
      }
      setBuilderTurns((prev) =>
        prev.map((turn) =>
          turn.id === aiTurnId
            ? {
                ...turn,
                plan: lastPlan || undefined,
                text: `Agent completed updates across ${combinedModified.length} file(s).`,
                modifiedFiles: combinedModified,
                modelName: lastModelName,
              }
            : turn
        )
      );
    } finally {
      setGenerating(false);
      setActiveBuilderModel(null);
    }
  };

  const attachFolderToProject = async (
    folder: string,
    diskFiles: Array<{ path: string; content: string; updatedAt?: number }>,
    mode: 'load-disk' | 'keep-workspace'
  ) => {
    const mapped: ProjectFile[] = diskFiles.map((f) => ({
      path: f.path,
      content: f.content,
      updatedAt: f.updatedAt || Date.now(),
    }));
    const nextFiles = mode === 'load-disk' && mapped.length > 0 ? mapped : project.files;
    const updated: Project = {
      ...project,
      localFolderPath: folder,
      files: nextFiles,
      updatedAt: Date.now(),
    };
    await saveProject(updated);
    appendAudit('attach_folder', folder, 'read-only', 'completed', `mode=${mode}`);
    appendLog('info', 'bundler', `Linked local desktop folder: ${folder} (${nextFiles.length} files)`);
    refreshDesktopDiagnostics();
  };

  const handleOpenDesktopFolder = async (recentFolder?: string) => {
    if (!desktopBridge) return;
    const folder = recentFolder
      ? (await desktopBridge.openRecentFolder?.(recentFolder)) || recentFolder
      : await desktopBridge.openFolderDialog();
    if (!folder) return;

    const [inspection, diskFiles] = await Promise.all([
      desktopBridge.inspectFolder?.(folder) ?? Promise.resolve(null),
      desktopBridge.readDirectoryFiles(folder),
    ]);

    if (inspection && !inspection.isEmpty && diskFiles.length > 0) {
      setPendingFolderAttach({ folder, inspection, diskFiles });
      return;
    }

    await attachFolderToProject(folder, diskFiles, 'load-disk');
  };

  const executeDesktopCommand = async (cmd: string) => {
    if (!desktopBridge || !project.localFolderPath) return;
    const res = await desktopBridge.runShellCommand(project.localFolderPath, cmd);
    if (!res.started) {
      appendAudit('run_command', cmd, 'run-commands', 'failed', res.error);
      appendLog('error', 'bundler', res.error || 'Command rejected or cancelled.');
      return;
    }
    setRunningProcessId(res.processId);
    appendAudit(
      'run_command',
      cmd,
      cmd.includes('install') ? 'install-deps' : 'run-commands',
      'allowed'
    );
    appendLog('info', 'bundler', `$ ${cmd}`);
  };

  const handleRunDesktopCommand = async (cmd: string) => {
    if (!desktopBridge || !project.localFolderPath) {
      pushToast({
        type: 'warning',
        title: 'Link a local folder first',
        description: 'Open or choose a local project folder in the Desktop app before running npm commands.',
      });
      return;
    }
    if (!agentPermissions['run-commands']) {
      appendAudit('run_command', cmd, 'run-commands', 'blocked', 'run-commands permission is off');
      pushToast({
        type: 'error',
        title: 'Command blocked by Local Agent Policy',
        description: 'Enable "run-commands" in the Local Agent drawer first.',
      });
      return;
    }
    if (/\b(npm|pnpm|yarn)\s+(install|i|ci)\b/i.test(cmd)) {
      setPendingInstallCmd(cmd);
      return;
    }
    await executeDesktopCommand(cmd);
  };

  const handleDownloadZip = async () => {
    const res = await downloadProjectAsZip(project);
    pushToast({
      type: 'success',
      title: 'Project ZIP downloaded',
      description: `Packaged ${res.fileCount} files into ${res.filename}.`,
    });
  };

  const handleExportProjectArchive = () => {
    const payload = createSingleProjectBackupPayload(project);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'project'}-archive.json`;
    a.click();
    URL.revokeObjectURL(url);
    pushToast({
      type: 'success',
      title: 'Single-project archive exported',
      description: 'Includes FNV-1a integrity checksum and excludes credentials.',
    });
  };

  const searchMatches = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const hits: Array<{ path: string; line: number; snippet: string }> = [];
    for (const file of project.files) {
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          hits.push({
            path: file.path,
            line: i + 1,
            snippet: lines[i].trim().slice(0, 110),
          });
          if (hits.length >= 40) return hits;
        }
      }
    }
    return hits;
  }, [project.files, searchQuery]);

  const buildErrorTexts =
    bundle && !bundle.ok
      ? bundle.errors.map((e) => `${e.file ? `${e.file}:${e.line || 1} ` : ''}${e.text}`)
      : [];

  return (
    <div className="h-[calc(100vh-3.5rem)] flex flex-col bg-slate-50 dark:bg-slate-950">
      {/* Studio Top Toolbar */}
      <div className="h-12 shrink-0 px-3 flex items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setMobileFilesOpen(true)}
            className="lg:hidden p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
            title={t('fileExplorer')}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
          <select
            value={project.id}
            onChange={(e) => setActiveProjectId(e.target.value)}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-slate-900 dark:text-slate-100 max-w-[180px]"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={async () => {
              const created = await createProject(
                `Project ${projects.length + 1}`,
                'AI-generated web application',
                'react-vite'
              );
              setActiveProjectId(created.id);
            }}
            className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            title={t('newProject')}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setShowSnapshots((s) => !s)}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              showSnapshots
                ? 'border-indigo-500/40 bg-indigo-600/10 text-indigo-600 dark:text-indigo-400'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
            }`}
          >
            <History className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">
              {t('snapshots')} ({snapshots.length})
            </span>
          </button>
        </div>

        {/* Center View Switcher */}
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 shrink-0">
          <button
            type="button"
            onClick={() => setCenterMode('code')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 ${
              centerMode === 'code'
                ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Code2 className="h-3.5 w-3.5" />
            <span>{t('codeEditor')}</span>
          </button>
          <button
            type="button"
            onClick={() => setCenterMode('split')}
            className={`hidden md:inline-flex px-2.5 py-1 rounded-md text-xs font-medium items-center gap-1.5 ${
              centerMode === 'split'
                ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <SplitSquareHorizontal className="h-3.5 w-3.5" />
            <span>{t('splitView')}</span>
          </button>
          <button
            type="button"
            onClick={() => setCenterMode('preview')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 ${
              centerMode === 'preview'
                ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Eye className="h-3.5 w-3.5" />
            <span>{t('livePreview')}</span>
          </button>
        </div>

        {/* Right Actions: Desktop Runner (Electron only), Search, Local Agent, Terminal, GitHub, Archive, ZIP */}
        <div className="flex items-center gap-1.5 shrink-0">
          {desktopBridge && (
            <>
              <button
                type="button"
                onClick={() => handleOpenDesktopFolder()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-emerald-500/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10"
              >
                <Laptop className="h-3.5 w-3.5" />
                <span>{project.localFolderPath ? 'Local Linked' : t('openLocalFolder')}</span>
              </button>
              {project.localFolderPath && (
                <>
                  <button
                    type="button"
                    onClick={() => handleRunDesktopCommand('npm install')}
                    className="px-2 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    npm install
                  </button>
                  {runningProcessId ? (
                    <button
                      type="button"
                      onClick={() => desktopBridge.stopProcess(runningProcessId)}
                      className="px-2 py-1.5 text-xs font-mono rounded-lg bg-red-600 text-white"
                    >
                      Stop Proc
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleRunDesktopCommand('npm run dev')}
                      className="px-2 py-1.5 text-xs font-mono rounded-lg bg-emerald-600 text-white"
                    >
                      npm run dev
                    </button>
                  )}
                </>
              )}
              {detectedPreviewUrl && desktopBridge.openExternalUrl && (
                <button
                  type="button"
                  onClick={() => desktopBridge.openExternalUrl!(detectedPreviewUrl)}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  <span>Open in System Browser</span>
                </button>
              )}
            </>
          )}

          <button
            type="button"
            onClick={() => setShowSearchDrawer((v) => !v)}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
              showSearchDrawer
                ? 'border-blue-500/40 bg-blue-600/10 text-blue-600 dark:text-blue-400'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
            }`}
            title="Search across project files"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Search</span>
          </button>

          <button
            type="button"
            onClick={() => setShowLocalAgentDrawer((v) => !v)}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
              showLocalAgentDrawer
                ? 'border-emerald-500/40 bg-emerald-600/10 text-emerald-600 dark:text-emerald-400'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
            }`}
            title="Desktop Local AI Agent & Permissions"
          >
            <Cpu className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Local Agent</span>
          </button>

          <button
            type="button"
            onClick={() => setShowTerminal((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap ${
              showTerminal
                ? 'border-blue-500/40 bg-blue-600/10 text-blue-600 dark:text-blue-400'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
            }`}
          >
            <TerminalIcon className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">{t('terminalOutput')}</span>
          </button>

          <button
            type="button"
            onClick={() => setRoute('github')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <FolderGit2 className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">{t('connectGitHubRepo')}</span>
          </button>

          <button
            type="button"
            onClick={handleExportProjectArchive}
            title="Export single-project JSON archive with checksum"
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap"
          >
            <FileJson className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Archive</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadZip}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90 whitespace-nowrap"
          >
            <Download className="h-3.5 w-3.5" />
            <span>{t('downloadProject')}</span>
          </button>
        </div>
      </div>

      {/* Cross-File Code Search Drawer */}
      {showSearchDrawer && (
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2">
          <div className="flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search across all project files (path, symbol, text)..."
              className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
            />
            <span className="text-[11px] font-mono text-slate-500">
              {searchQuery.trim() ? `${searchMatches.length} match(es)` : `${project.files.length} files`}
            </span>
            <button
              type="button"
              onClick={() => setShowSearchDrawer(false)}
              className="p-1 text-slate-400 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {searchMatches.length > 0 && (
            <div className="max-h-36 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
              {searchMatches.map((hit, idx) => (
                <button
                  key={`${hit.path}:${hit.line}:${idx}`}
                  type="button"
                  onClick={() => handleSelectFile(hit.path)}
                  className="w-full px-3 py-1.5 text-start hover:bg-blue-600/10 flex items-center justify-between gap-3 text-xs"
                >
                  <span className="font-mono text-blue-600 dark:text-blue-400 shrink-0">
                    {hit.path}:{hit.line}
                  </span>
                  <span className="font-mono text-slate-600 dark:text-slate-300 truncate">
                    {hit.snippet}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Desktop Local AI Agent & Runtime Drawer */}
      {showLocalAgentDrawer && (
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
              <Shield className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span>Local AI Agent, Runtime &amp; Granular Permissions</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setAgentPermissions({
                    'read-only': true,
                    'edit-files': false,
                    'run-commands': false,
                    'install-deps': false,
                    'delete-files': false,
                    'publish-github': false,
                  });
                  appendAudit('revoke_all', 'local-agent', 'read-only', 'completed');
                  pushToast({ type: 'info', title: 'Revoked all write/exec Local Agent permissions' });
                }}
                className="px-2.5 py-1 rounded-md border border-red-300 dark:border-red-900 text-red-600 dark:text-red-400 font-medium hover:bg-red-50 dark:hover:bg-red-950/30"
              >
                Revoke All Permissions
              </button>
              <button
                type="button"
                onClick={() => setShowLocalAgentDrawer(false)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            {/* Environment & Recent Folders */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 space-y-2">
              <div className="font-semibold text-slate-800 dark:text-slate-200">
                Desktop Toolchain ({desktopBridge ? desktopBridge.platform : 'web-sandbox'})
              </div>
              {desktopBridge ? (
                <>
                  <div className="font-mono text-[11px] text-slate-600 dark:text-slate-400 space-y-0.5">
                    <div>
                      Node: {desktopEnv?.nodeVersion || 'Checking...'} · npm: {desktopEnv?.npmVersion || '—'} · git: {desktopEnv?.gitVersion || '—'}
                    </div>
                    <div>
                      Ports: 5173 ({portStatus.port5173 === null ? '—' : portStatus.port5173 ? 'in use' : 'free'}), 3000 ({portStatus.port3000 === null ? '—' : portStatus.port3000 ? 'in use' : 'free'})
                    </div>
                  </div>
                  {recentLocalFolders.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[11px] font-medium text-slate-500">Recent Local Folders</div>
                      <div className="flex flex-wrap gap-1">
                        {recentLocalFolders.slice(0, 4).map((rf) => (
                          <button
                            key={rf.folderPath}
                            type="button"
                            onClick={() => handleOpenDesktopFolder(rf.folderPath)}
                            className="px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono text-[10px] hover:border-blue-500"
                            title={rf.folderPath}
                          >
                            {rf.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  Running inside Web Sandbox. Browser tabs cannot access local OS shells or folders directly. Open via <code className="font-mono">desktop/</code> Electron to unlock local disk sync, port inspection, and allowlisted npm/git execution.
                </p>
              )}
            </div>

            {/* Granular Permissions */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 space-y-2">
              <div className="font-semibold text-slate-800 dark:text-slate-200">
                Agent Capability Permissions
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-[11px]">
                {(
                  [
                    'read-only',
                    'edit-files',
                    'run-commands',
                    'install-deps',
                    'delete-files',
                    'publish-github',
                  ] as LocalAgentPermission[]
                ).map((perm) => (
                  <label key={perm} className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={agentPermissions[perm]}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setAgentPermissions((prev) => ({ ...prev, [perm]: checked }));
                        appendAudit('toggle_permission', perm, perm, checked ? 'allowed' : 'blocked');
                      }}
                    />
                    <span className="font-mono">{perm}</span>
                  </label>
                ))}
              </div>
              <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-400 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={autoFixBuildLoop}
                  onChange={(e) => setAutoFixBuildLoop(e.target.checked)}
                />
                <span>Auto-feed build errors in Agent mode</span>
              </label>
            </div>

            {/* Audit Trail */}
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 space-y-1.5">
              <div className="font-semibold text-slate-800 dark:text-slate-200">
                Local Agent Audit Log ({agentAuditLog.length})
              </div>
              <div className="max-h-24 overflow-y-auto space-y-1 font-mono text-[10px]">
                {agentAuditLog.length === 0 ? (
                  <p className="text-slate-400 font-sans">No local agent actions recorded yet.</p>
                ) : (
                  agentAuditLog.slice(0, 12).map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between gap-2 truncate">
                      <span className="truncate text-slate-700 dark:text-slate-300">
                        [{entry.outcome}] {entry.action}: {entry.target}
                      </span>
                      <span className="text-slate-400 shrink-0">
                        {new Date(entry.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Snapshots / Version History Bar */}
      {showSnapshots && (
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-200">
              <HardDrive className="h-4 w-4 text-indigo-500" />
              <span>Project Version History ({snapshots.length})</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  const snap = await createProjectSnapshot(
                    project.id,
                    `Manual snapshot (${project.files.length} files)`,
                    'user'
                  );
                  if (snap) {
                    await refreshSnapshots(project.id);
                    pushToast({ type: 'success', title: 'Snapshot saved' });
                  }
                }}
                className="px-2.5 py-1 text-xs font-medium rounded-md bg-indigo-600 hover:bg-indigo-500 text-white"
              >
                {t('saveSnapshot')}
              </button>
              <button
                type="button"
                onClick={() => setShowSnapshots(false)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {snapshots.length === 0 ? (
            <p className="text-xs text-slate-500">
              No snapshots yet. Save one manually or run AI Builder (auto-backups are created automatically).
            </p>
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {snapshots.slice(0, 10).map((snap) => (
                <div
                  key={snap.id}
                  className="shrink-0 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-xs flex items-center gap-3"
                >
                  <div>
                    <div className="font-medium text-slate-800 dark:text-slate-200">
                      {snap.label}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {formatRelativeTime(snap.createdAt)} · {snap.files.length} files
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await restoreProjectSnapshot(project.id, snap.id);
                      pushToast({
                        type: 'success',
                        title: 'Snapshot restored',
                        description: snap.label,
                      });
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-800 text-[11px]"
                  >
                    <RotateCcw className="h-3 w-3" />
                    <span>{t('restoreSnapshot')}</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Mobile File Explorer Drawer */}
      {mobileFilesOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setMobileFilesOpen(false)}
          />
          <div className="relative z-50 w-72 max-w-[85vw] h-full bg-white dark:bg-slate-900">
            <div className="h-10 px-3 flex items-center justify-between border-b border-slate-200 dark:border-slate-800">
              <span className="text-xs font-semibold">{t('fileExplorer')}</span>
              <button
                type="button"
                onClick={() => setMobileFilesOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="h-[calc(100%-2.5rem)]">
              <FileExplorer
                files={project.files}
                activeFilePath={activeFilePath}
                onSelectFile={(p) => {
                  handleSelectFile(p);
                  setMobileFilesOpen(false);
                }}
                onCreateFile={handleCreateFile}
                onRenamePath={handleRenamePath}
                onDeletePath={(p) => setPendingDeletePath(p)}
              />
            </div>
          </div>
        </div>
      )}

      {/* Main 3-Column IDE + Bottom Terminal */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
        {/* LEFT PANEL: File Explorer */}
        <div className="hidden lg:block w-60 shrink-0 h-full">
          <FileExplorer
            files={project.files}
            activeFilePath={activeFilePath}
            onSelectFile={handleSelectFile}
            onCreateFile={handleCreateFile}
            onRenamePath={handleRenamePath}
            onDeletePath={(p) => setPendingDeletePath(p)}
          />
        </div>

        {/* CENTER + BOTTOM TERMINAL */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <div className="flex-1 min-h-0 flex">
            {(centerMode === 'code' || centerMode === 'split') && (
              <div
                className={`min-w-0 h-full ${
                  centerMode === 'split'
                    ? 'w-1/2 border-e border-slate-200 dark:border-slate-800'
                    : 'w-full'
                }`}
              >
                <CodeEditorPanel
                  files={project.files}
                  openTabs={openTabs}
                  activeFilePath={activeFilePath}
                  onSelectTab={handleSelectFile}
                  onCloseTab={handleCloseTab}
                  onChangeContent={handleChangeEditorContent}
                />
              </div>
            )}

            {(centerMode === 'preview' || centerMode === 'split') && (
              <div className={`min-w-0 h-full ${centerMode === 'split' ? 'w-1/2' : 'w-full'}`}>
                <LivePreviewPanel
                  bundle={bundle}
                  bundling={bundling}
                  runtimeErrors={runtimeErrors}
                  onRefresh={() => runPreviewBundle(project)}
                  onAskAiFix={(err) =>
                    runAiBuilderPrompt(
                      `Fix the following build/runtime error in the project and output the corrected file(s):\n${err}`
                    )
                  }
                />
              </div>
            )}
          </div>

          {showTerminal && (
            <div className="h-44 shrink-0">
              <TerminalOutputPanel logs={logs} onClear={() => setLogs([])} />
            </div>
          )}
        </div>

        {/* RIGHT PANEL: AI Builder & Project Supervisor */}
        <aside
          className={`w-full shrink-0 h-72 lg:h-full flex flex-col border-t lg:border-t-0 lg:border-s border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 ${
            panelWidth === 'compact'
              ? 'lg:w-80'
              : panelWidth === 'wide'
                ? 'lg:w-[28rem]'
                : 'lg:w-96'
          }`}
        >
          <div className="h-10 shrink-0 px-2 flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setRightTab('builder')}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md inline-flex items-center justify-center gap-1.5 transition-colors ${
                rightTab === 'builder'
                  ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400'
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>{t('aiAssistant')}</span>
            </button>
            <button
              type="button"
              onClick={() => setRightTab('supervisor')}
              className={`flex-1 py-1.5 text-xs font-medium rounded-md inline-flex items-center justify-center gap-1.5 transition-colors ${
                rightTab === 'supervisor'
                  ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400'
                  : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>{t('supervisorTab')}</span>
            </button>
            <div
              className="hidden lg:flex items-center rounded border border-slate-200 dark:border-slate-700 p-0.5 text-[10px] font-mono"
              title="Adjust AI panel width"
            >
              {(['compact', 'balanced', 'wide'] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setPanelWidth(w)}
                  className={`px-1.5 py-0.5 rounded ${
                    panelWidth === w
                      ? 'bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-100'
                      : 'text-slate-400'
                  }`}
                >
                  {w === 'compact' ? 'S' : w === 'balanced' ? 'M' : 'L'}
                </button>
              ))}
            </div>
          </div>

          {rightTab === 'supervisor' ? (
            <SupervisorPanel
              project={project}
              buildErrors={[...buildErrorTexts, ...runtimeErrors]}
              autoTriggerToken={supervisorAutoToken}
              onApplyFileFix={async (path, content, rationale) => {
                const { files: nextFiles, error } = upsertProjectFile(project.files, path, content);
                if (error) {
                  pushToast({
                    type: 'error',
                    title: 'Supervisor fix rejected',
                    description: error,
                  });
                  return;
                }
                await updateProjectFiles(
                  nextFiles,
                  'Supervisor applied fix',
                  `${path}: ${rationale}`
                );
                appendLog('info', 'supervisor', `Applied fix to ${path}: ${rationale}`);
                pushToast({
                  type: 'success',
                  title: `Supervisor fixed ${path}`,
                  description: rationale,
                });
              }}
            />
          ) : (
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Mode Switcher + Model Selector + Project AI Instructions */}
              <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800/80 space-y-2">
                <div className="grid grid-cols-3 gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-medium">
                  {(['fast', 'planning', 'agent'] as StudioAiMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setStudioMode(m)}
                      className={`py-1 rounded-md transition-colors ${
                        studioMode === m
                          ? 'bg-white dark:bg-slate-950 text-blue-600 dark:text-blue-400 shadow-xs'
                          : 'text-slate-500'
                      }`}
                    >
                      {m === 'fast'
                        ? t('studioFastMode')
                        : m === 'planning'
                          ? t('studioPlanningMode')
                          : t('studioAgentMode')}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={builderModelChoice}
                    onChange={(e) => setBuilderModelChoice(e.target.value)}
                    className="flex-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-xs text-slate-900 dark:text-slate-100"
                  >
                    <option value="auto">Auto Fallback ({enabledModels.length} models)</option>
                    {enabledModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        #{m.priority} {m.displayName}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => setShowInstructions((v) => !v)}
                    title="Project AI Instructions"
                    className={`p-1.5 rounded-md border ${
                      showInstructions || project.userInstructions?.trim()
                        ? 'border-blue-500/40 bg-blue-600/10 text-blue-600 dark:text-blue-400'
                        : 'border-slate-200 dark:border-slate-700 text-slate-500'
                    }`}
                  >
                    <Sliders className="h-3.5 w-3.5" />
                  </button>
                </div>

                {showInstructions && (
                  <div className="space-y-1">
                    <label className="block text-[10px] font-medium text-slate-500">
                      Project AI Instructions (persisted per project)
                    </label>
                    <textarea
                      rows={2}
                      value={project.userInstructions || ''}
                      onChange={(e) =>
                        saveProject({
                          ...project,
                          userInstructions: e.target.value,
                          updatedAt: Date.now(),
                        })
                      }
                      placeholder="e.g. Use accessible semantic HTML, strict TypeScript interfaces, and clean table typography..."
                      className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-2 text-[11px]"
                    />
                  </div>
                )}
              </div>

              {/* Conversation History */}
              <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
                {builderTurns.length === 0 ? (
                  <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5 space-y-2 text-slate-600 dark:text-slate-400 leading-relaxed">
                    <p className="font-semibold text-slate-800 dark:text-slate-200">
                      Describe what to build or modify
                    </p>
                    <p>
                      Fast applies changes directly, Planning previews file diffs for approval, and Agent iterates up to {settings.maxAgentIterations} steps until preview compiles cleanly.
                    </p>
                    <div className="pt-1 flex flex-wrap gap-1.5">
                      {[
                        'Build a modern SaaS pricing & dashboard page',
                        'Add a responsive navbar and dark mode toggle',
                        'Create an interactive e-commerce storefront with cart',
                      ].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setBuilderPrompt(preset)}
                          className="text-start px-2.5 py-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-500 text-[11px] text-slate-700 dark:text-slate-300"
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  builderTurns.map((turn) => (
                    <div
                      key={turn.id}
                      className={`rounded-lg p-3 ${
                        turn.role === 'user'
                          ? 'bg-blue-600 text-white ms-4'
                          : 'border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200'
                      }`}
                    >
                      {turn.modelName && turn.role === 'assistant' && (
                        <p className="text-[11px] font-medium text-blue-600 dark:text-blue-400 mb-1">
                          {turn.modelName}
                        </p>
                      )}
                      {turn.plan && (
                        <div className="mb-2 pb-2 border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-600 dark:text-slate-400 whitespace-pre-wrap">
                          {turn.plan}
                        </div>
                      )}
                      <p className="whitespace-pre-wrap break-words leading-relaxed">
                        {turn.text.length > 900 && turn.modifiedFiles?.length
                          ? `Applied updates to ${turn.modifiedFiles.length} file(s).`
                          : turn.text}
                      </p>
                      {turn.modifiedFiles && turn.modifiedFiles.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {turn.modifiedFiles.map((fp) => (
                            <button
                              key={fp}
                              type="button"
                              onClick={() => handleSelectFile(fp)}
                              className="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 font-mono text-[10px] hover:text-blue-600"
                            >
                              {fp}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}

                {/* Pending Review Plan Card (Planning Mode) */}
                {pendingReviewPlan && (
                  <div className="rounded-lg border border-indigo-300 dark:border-indigo-700 bg-indigo-50/70 dark:bg-indigo-950/30 p-3 space-y-2.5">
                    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-indigo-900 dark:text-indigo-200">
                      <span>
                        {t('reviewChanges')} ({pendingReviewPlan.changeSet.writes.length} files)
                      </span>
                      <span className="text-[10px] font-normal text-indigo-600 dark:text-indigo-400">
                        Click a file to inspect diff
                      </span>
                    </div>
                    <ul className="space-y-1.5 text-[11px] font-mono text-indigo-800 dark:text-indigo-300">
                      {pendingReviewPlan.changeSet.writes.map((w) => {
                        const existing = project.files.find((pf) => pf.path === w.path);
                        const diff = computeCompactLineDiff(existing?.content, w.content);
                        const isExpanded = expandedDiffPath === w.path;
                        return (
                          <li
                            key={w.path}
                            className="rounded border border-indigo-200/80 dark:border-indigo-800/80 bg-white/80 dark:bg-slate-900/80 overflow-hidden"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedDiffPath((cur) => (cur === w.path ? null : w.path))
                              }
                              className="w-full px-2 py-1 flex items-center justify-between gap-2 text-start hover:bg-indigo-100/60 dark:hover:bg-indigo-900/30"
                            >
                              <span className="truncate">
                                {existing ? '~ modify' : '+ create'} {w.path}
                              </span>
                              <span className="shrink-0 text-[10px] tabular-nums">
                                <span className="text-emerald-600 dark:text-emerald-400">
                                  +{diff.addedCount}
                                </span>{' '}
                                <span className="text-red-600 dark:text-red-400">
                                  -{diff.removedCount}
                                </span>
                              </span>
                            </button>
                            {isExpanded && (
                              <div className="border-t border-indigo-200/60 dark:border-indigo-800/60 bg-slate-950 text-slate-200 p-2 max-h-44 overflow-auto text-[10px] leading-relaxed">
                                {diff.lines.map((line, idx) => (
                                  <div
                                    key={idx}
                                    className={`whitespace-pre ${
                                      line.type === 'add'
                                        ? 'bg-emerald-950/70 text-emerald-300'
                                        : line.type === 'remove'
                                          ? 'bg-red-950/70 text-red-300'
                                          : 'text-slate-400'
                                    }`}
                                  >
                                    {line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  '}
                                    {line.text}
                                  </div>
                                ))}
                                {diff.truncated && (
                                  <div className="text-slate-500 pt-1">
                                    ... diff truncated for compact preview
                                  </div>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                      {pendingReviewPlan.changeSet.renames.map((r) => (
                        <li key={r.from}>
                          ~ rename {r.from} → {r.to}
                        </li>
                      ))}
                      {pendingReviewPlan.changeSet.deletes.map((d) => (
                        <li key={d} className="text-red-600 dark:text-red-400">
                          - delete {d}
                        </li>
                      ))}
                    </ul>
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={async () => {
                          const { appliedPaths } = await applyChangeSet(
                            project,
                            pendingReviewPlan.changeSet,
                            pendingReviewPlan.modelName,
                            true
                          );
                          setExpandedDiffPath(null);
                          setPendingReviewPlan(null);
                          if (appliedPaths.length > 0) {
                            setSupervisorAutoToken((n) => n + 1);
                            pushToast({
                              type: 'success',
                              title: `Applied ${appliedPaths.length} planned file(s)`,
                            });
                          }
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium"
                      >
                        <Check className="h-3.5 w-3.5" />
                        <span>{t('approveApply')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedDiffPath(null);
                          setPendingReviewPlan(null);
                        }}
                        className="px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 text-xs"
                      >
                        {t('discardPlan')}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Prompt Input */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  runAiBuilderPrompt(builderPrompt);
                }}
                className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-2"
              >
                {generating && activeBuilderModel && (
                  <div className="flex items-center gap-1.5 text-[11px] text-blue-600 dark:text-blue-400">
                    <ArrowRightLeft className="h-3 w-3" />
                    <span>Generating via {activeBuilderModel}...</span>
                  </div>
                )}
                <textarea
                  rows={3}
                  value={builderPrompt}
                  onChange={(e) => setBuilderPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      runAiBuilderPrompt(builderPrompt);
                    }
                  }}
                  placeholder={t('describeAppPlaceholder')}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-2.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-400">Ctrl/Cmd+Enter</span>
                  {generating ? (
                    <button
                      type="button"
                      onClick={() => {
                        abortRef.current?.abort();
                        setGenerating(false);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium"
                    >
                      <Square className="h-3.5 w-3.5" />
                      <span>{t('stopGenerating')}</span>
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!builderPrompt.trim()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-xs font-medium"
                    >
                      <Play className="h-3.5 w-3.5" />
                      <span>{t('buildWithAI')}</span>
                    </button>
                  )}
                </div>
              </form>
            </div>
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={Boolean(pendingDeletePath)}
        title={`Delete ${pendingDeletePath || ''}?`}
        description="This will remove the file or folder from this project."
        confirmLabel={t('delete')}
        onConfirm={handleConfirmDeletePath}
        onCancel={() => setPendingDeletePath(null)}
      />

      <ConfirmDialog
        open={Boolean(pendingAiDeletes)}
        title="Confirm AI File Deletions"
        description={`The AI Builder (${pendingAiDeletes?.modelName}) proposed deleting: ${pendingAiDeletes?.paths.join(', ')}. Approve removing these files?`}
        confirmLabel={t('delete')}
        onConfirm={async () => {
          if (pendingAiDeletes) {
            let nextFiles = [...project.files];
            for (const delPath of pendingAiDeletes.paths) {
              if (desktopBridge && project.localFolderPath) {
                if (!agentPermissions['delete-files']) {
                  appendAudit(
                    'ai_delete_disk_file',
                    delPath,
                    'delete-files',
                    'blocked',
                    'Removed in browser workspace only; disk deletion blocked because delete-files permission is disabled.'
                  );
                } else {
                  await desktopBridge.deletePath(project.localFolderPath, delPath).catch(() => {});
                  appendAudit('ai_delete_disk_file', delPath, 'delete-files', 'completed');
                }
              }
              nextFiles = deleteProjectPath(nextFiles, delPath);
              handleCloseTab(delPath);
            }
            await updateProjectFiles(
              nextFiles,
              'AI deleted files (approved)',
              pendingAiDeletes.paths.join(', '),
              pendingAiDeletes.modelName
            );
          }
          setPendingAiDeletes(null);
        }}
        onCancel={() => setPendingAiDeletes(null)}
      />

      <ConfirmDialog
        open={Boolean(pendingFolderAttach)}
        title="Attach non-empty local folder?"
        description={`"${pendingFolderAttach?.folder}" already contains ${pendingFolderAttach?.inspection.entryCount} items. Load its files into "${project.name}" (or click Cancel to skip linking)?`}
        confirmLabel="Load Folder Files"
        onConfirm={async () => {
          if (pendingFolderAttach) {
            await attachFolderToProject(
              pendingFolderAttach.folder,
              pendingFolderAttach.diskFiles,
              'load-disk'
            );
          }
          setPendingFolderAttach(null);
        }}
        onCancel={() => setPendingFolderAttach(null)}
      />

      <ConfirmDialog
        open={Boolean(pendingInstallCmd)}
        title="Approve package installation?"
        description={`Allow Local Agent to run "${pendingInstallCmd}" inside ${project.localFolderPath || 'this folder'}? This grants install-deps permission for this run.`}
        confirmLabel="Approve & Run"
        onConfirm={async () => {
          const cmd = pendingInstallCmd;
          setPendingInstallCmd(null);
          setAgentPermissions((prev) => ({ ...prev, 'install-deps': true }));
          if (cmd) await executeDesktopCommand(cmd);
        }}
        onCancel={() => {
          if (pendingInstallCmd) {
            appendAudit('install_deps', pendingInstallCmd, 'install-deps', 'blocked', 'Cancelled by user');
          }
          setPendingInstallCmd(null);
        }}
      />
    </div>
  );
}
