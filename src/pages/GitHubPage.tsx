import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  Link2,
  LogOut,
  Plus,
  RefreshCw,
  UploadCloud,
  DownloadCloud,
  Compass,
  Terminal,
} from 'lucide-react';
import { GitHubPublishWizard } from '../components/GitHubPublishWizard.tsx';
import { useApp } from '../contexts/AppContext.tsx';
import { getDesktopBridge, type LocalGitCommandResult } from '../desktop/desktopBridge.ts';
import {
  createGitHubBranch,
  createGitHubRepo,
  disconnectGitHub,
  getGitHubAuthUrl,
  listGitHubBranches,
  listGitHubCommits,
  listGitHubRepos,
  pullGitHubFiles,
  pushGitHubFiles,
  type GitHubBranch,
  type GitHubCommit,
} from '../github/githubClient.ts';
import type { GitHubRepoSummary, ProjectFile } from '../types/index.ts';
import { createId, formatRelativeTime } from '../utils/helpers.ts';

export function GitHubPage() {
  const {
    githubStatus,
    refreshGitHubStatus,
    projects,
    activeProjectId,
    setActiveProjectId,
    saveProject,
    createProjectSnapshot,
    setRoute,
    pushToast,
    t,
  } = useApp();

  const [repos, setRepos] = useState<GitHubRepoSummary[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoSummary | null>(null);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [selectedBranch, setSelectedBranch] = useState('main');
  const [commits, setCommits] = useState<GitHubCommit[]>([]);
  const [commitMessage, setCommitMessage] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [showCreateRepo, setShowCreateRepo] = useState(false);
  const [newRepoName, setNewRepoName] = useState('');
  const [newRepoDesc, setNewRepoDesc] = useState('');
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [repoFilter, setRepoFilter] = useState('');
  const [syncDiff, setSyncDiff] = useState<{
    checkedAt: number;
    modified: string[];
    localOnly: string[];
    remoteOnly: string[];
  } | null>(null);
  const [confirmForcePush, setConfirmForcePush] = useState(false);
  const [showPublishWizard, setShowPublishWizard] = useState(false);
  const [localCommitMsg, setLocalCommitMsg] = useState('');
  const [localGitBusy, setLocalGitBusy] = useState(false);
  const [localGitResult, setLocalGitResult] = useState<LocalGitCommandResult | null>(null);

  const desktopBridge = getDesktopBridge();
  const activeProject = projects.find((p) => p.id === activeProjectId) || projects[0] || null;

  const latestRemoteSha = commits[0]?.sha;
  const hasRemoteDivergence = Boolean(
    activeProject?.github &&
      selectedRepo &&
      activeProject.github.owner === selectedRepo.owner &&
      activeProject.github.repo === selectedRepo.name &&
      activeProject.github.branch === selectedBranch &&
      activeProject.github.lastCommitSha &&
      latestRemoteSha &&
      activeProject.github.lastCommitSha !== latestRemoteSha
  );

  const loadRepos = useCallback(async () => {
    if (!githubStatus.connected) return;
    setLoadingRepos(true);
    try {
      const list = await listGitHubRepos();
      setRepos(list);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load repositories',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoadingRepos(false);
    }
  }, [githubStatus.connected, pushToast]);

  useEffect(() => {
    if (githubStatus.connected) {
      loadRepos();
    } else {
      setRepos([]);
      setSelectedRepo(null);
    }
  }, [githubStatus.connected, loadRepos]);

  const loadRepoDetails = useCallback(
    async (repo: GitHubRepoSummary, branchOverride?: string) => {
      setSyncDiff(null);
      try {
        const brList = await listGitHubBranches(repo.owner, repo.name);
        setBranches(brList);
        const branchToUse =
          branchOverride ||
          (brList.some((b) => b.name === repo.defaultBranch)
            ? repo.defaultBranch
            : brList[0]?.name || 'main');
        setSelectedBranch(branchToUse);
        const cmList = await listGitHubCommits(repo.owner, repo.name, branchToUse);
        setCommits(cmList);
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Failed to load repository metadata',
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [pushToast]
  );

  const handleCheckSyncStatus = async () => {
    if (!selectedRepo || !activeProject) return;
    setBusyAction('diff');
    try {
      const pulled = await pullGitHubFiles(selectedRepo.owner, selectedRepo.name, selectedBranch);
      const remoteMap = new Map(pulled.files.map((f) => [f.path, f.content]));
      const localMap = new Map(activeProject.files.map((f) => [f.path, f.content]));

      const modified: string[] = [];
      const localOnly: string[] = [];
      const remoteOnly: string[] = [];

      for (const [p, content] of localMap.entries()) {
        if (!remoteMap.has(p)) localOnly.push(p);
        else if (remoteMap.get(p) !== content) modified.push(p);
      }
      for (const p of remoteMap.keys()) {
        if (!localMap.has(p)) remoteOnly.push(p);
      }

      setSyncDiff({
        checkedAt: Date.now(),
        modified,
        localOnly,
        remoteOnly,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Sync comparison failed',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleConnectGitHub = async () => {
    try {
      const res = await getGitHubAuthUrl();
      if (!res.configured || !res.url) {
        pushToast({
          type: 'warning',
          title: 'GitHub OAuth not configured',
          description: 'Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in environment secrets.',
        });
        return;
      }
      const popup = window.open(res.url, 'github_oauth_popup', 'width=600,height=720');
      if (!popup) {
        pushToast({
          type: 'warning',
          title: 'Popup blocked',
          description: 'Please allow popups for this site to authorize GitHub.',
        });
      }
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'OAuth initialization failed',
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDisconnect = async () => {
    await disconnectGitHub();
    await refreshGitHubStatus();
    pushToast({ type: 'info', title: 'Disconnected from GitHub' });
  };

  const handleCreateRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRepoName.trim()) return;
    setBusyAction('create-repo');
    try {
      const created = await createGitHubRepo({
        name: newRepoName.trim(),
        description: newRepoDesc.trim(),
        isPrivate: newRepoPrivate,
      });
      setRepos((prev) => [created, ...prev]);
      setSelectedRepo(created);
      await loadRepoDetails(created);
      setShowCreateRepo(false);
      setNewRepoName('');
      setNewRepoDesc('');
      pushToast({ type: 'success', title: `Repository ${created.fullName} created` });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Create repository failed',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRepo || !newBranchName.trim()) return;
    const baseBranch = branches.find((b) => b.name === selectedBranch);
    if (!baseBranch) return;
    setBusyAction('create-branch');
    try {
      const created = await createGitHubBranch(
        selectedRepo.owner,
        selectedRepo.name,
        newBranchName.trim(),
        baseBranch.sha
      );
      setBranches((prev) => [...prev, created]);
      setSelectedBranch(created.name);
      setNewBranchName('');
      pushToast({ type: 'success', title: `Branch "${created.name}" created` });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Branch creation failed',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleImportAsProject = async () => {
    if (!selectedRepo) return;
    setBusyAction('import');
    try {
      const pulled = await pullGitHubFiles(selectedRepo.owner, selectedRepo.name, selectedBranch);
      const now = Date.now();
      const files: ProjectFile[] = pulled.files.map((f) => ({
        path: f.path,
        content: f.content,
        updatedAt: now,
      }));
      const isReact = files.some((f) => f.path.endsWith('.tsx') || f.path.endsWith('.jsx'));
      const newProject = {
        id: createId('proj'),
        name: selectedRepo.name,
        description: selectedRepo.description || `Imported from ${selectedRepo.fullName}`,
        framework: (isReact ? 'react-vite' : 'html-js') as 'react-vite' | 'html-js',
        status: 'active' as const,
        files,
        activities: [
          {
            id: createId('act'),
            action: 'Imported from GitHub',
            detail: `${selectedRepo.fullName}@${selectedBranch} (${files.length} files)`,
            timestamp: now,
          },
        ],
        github: {
          owner: selectedRepo.owner,
          repo: selectedRepo.name,
          branch: selectedBranch,
          lastCommitSha: pulled.commitSha,
          lastSyncedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      };
      await saveProject(newProject);
      setActiveProjectId(newProject.id);
      pushToast({
        type: 'success',
        title: `Imported ${selectedRepo.fullName}`,
        description: `${files.length} files imported. Opening in AI Studio...`,
      });
      setRoute('studio');
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Import failed',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handlePullIntoActive = async () => {
    if (!selectedRepo || !activeProject) return;
    setBusyAction('pull');
    try {
      await createProjectSnapshot(
        activeProject.id,
        `Before GitHub Pull (${selectedRepo.fullName}@${selectedBranch})`,
        'auto-backup'
      );
      const pulled = await pullGitHubFiles(selectedRepo.owner, selectedRepo.name, selectedBranch);
      const now = Date.now();
      const files: ProjectFile[] = pulled.files.map((f) => ({
        path: f.path,
        content: f.content,
        updatedAt: now,
      }));
      await saveProject({
        ...activeProject,
        files,
        github: {
          owner: selectedRepo.owner,
          repo: selectedRepo.name,
          branch: selectedBranch,
          lastCommitSha: pulled.commitSha,
          lastSyncedAt: now,
        },
        activities: [
          {
            id: createId('act'),
            action: 'Pulled from GitHub',
            detail: `${selectedRepo.fullName}@${selectedBranch}`,
            timestamp: now,
          },
          ...activeProject.activities.slice(0, 29),
        ],
        updatedAt: now,
      });
      setSyncDiff(null);
      pushToast({
        type: 'success',
        title: 'Pulled latest changes',
        description: `Updated "${activeProject.name}" with ${files.length} files (snapshot saved before overwrite).`,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Pull failed',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handlePushActiveProject = async (e: React.FormEvent, forceConfirmed = false) => {
    e.preventDefault();
    if (!selectedRepo || !activeProject || !commitMessage.trim()) return;
    if (hasRemoteDivergence && !forceConfirmed && !confirmForcePush) {
      setConfirmForcePush(true);
      return;
    }
    setConfirmForcePush(false);
    setBusyAction('push');
    try {
      const sameTarget =
        activeProject.github &&
        activeProject.github.owner === selectedRepo.owner &&
        activeProject.github.repo === selectedRepo.name &&
        activeProject.github.branch === selectedBranch;

      const result = await pushGitHubFiles(
        selectedRepo.owner,
        selectedRepo.name,
        selectedBranch,
        commitMessage.trim(),
        activeProject.files.map((f) => ({ path: f.path, content: f.content })),
        {
          expectedParentSha: sameTarget ? activeProject.github?.lastCommitSha : undefined,
          forceOverwrite: forceConfirmed,
        }
      );
      const now = Date.now();
      await saveProject({
        ...activeProject,
        github: {
          owner: selectedRepo.owner,
          repo: selectedRepo.name,
          branch: selectedBranch,
          lastCommitSha: result.commitSha,
          lastSyncedAt: now,
        },
        activities: [
          {
            id: createId('act'),
            action: 'Pushed to GitHub',
            detail: `${selectedRepo.fullName}@${selectedBranch} — "${commitMessage.trim()}"`,
            timestamp: now,
          },
          ...activeProject.activities.slice(0, 29),
        ],
        updatedAt: now,
      });
      setCommitMessage('');
      setSyncDiff(null);
      await loadRepoDetails(selectedRepo, selectedBranch);
      pushToast({
        type: 'success',
        title: 'Committed & Pushed to GitHub',
        description: `Pushed ${result.filesPushed} files to ${selectedRepo.fullName}@${selectedBranch}.`,
      });
    } catch (err) {
      const ghErr = err as { conflict?: boolean; reauthRequired?: boolean };
      if (ghErr?.conflict) {
        setConfirmForcePush(true);
        await loadRepoDetails(selectedRepo, selectedBranch);
      } else if (ghErr?.reauthRequired) {
        await refreshGitHubStatus();
      }
      pushToast({
        type: 'error',
        title: ghErr?.conflict ? 'Remote branch diverged (409 Conflict)' : 'Push failed',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const filteredRepos = repos.filter((r) =>
    r.fullName.toLowerCase().includes(repoFilter.toLowerCase())
  );

  const handleRunLocalGit = async (gitCommand: string, createBackupBeforeSync = false) => {
    if (!desktopBridge?.runGitCommand || !activeProject?.localFolderPath) return;
    setLocalGitBusy(true);
    try {
      const res = await desktopBridge.runGitCommand(activeProject.localFolderPath, gitCommand, {
        createBackupBeforeSync,
      });
      setLocalGitResult(res);
      pushToast({
        type: res.ok ? 'success' : 'error',
        title: res.ok ? `Ran "${gitCommand}"` : `Git command failed`,
        description: res.backupPath ? `Pre-sync backup created at ${res.backupPath}` : undefined,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Local Git execution error',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLocalGitBusy(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {t('githubTitle')}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {t('githubSubtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {activeProject && (
            <button
              type="button"
              onClick={() => setShowPublishWizard((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-blue-500/40 bg-blue-600/10 text-blue-600 dark:text-blue-400 hover:bg-blue-600/20"
            >
              <Compass className="h-3.5 w-3.5" />
              <span>{showPublishWizard ? 'Hide Publish Wizard' : 'Guided Publish Wizard'}</span>
            </button>
          )}

          {githubStatus.connected && githubStatus.user ? (
            <div className="flex items-center gap-3 shrink-0">
              <div className="flex items-center gap-2.5 text-sm">
                <img
                  src={githubStatus.user.avatarUrl}
                  alt={githubStatus.user.login}
                  referrerPolicy="no-referrer"
                  className="h-8 w-8 rounded-full border border-slate-200 dark:border-slate-700"
                />
                <div className="text-start">
                  <p className="font-medium text-slate-900 dark:text-slate-100 leading-tight">
                    {githubStatus.user.name}
                  </p>
                  <p className="text-xs font-mono text-slate-500">@{githubStatus.user.login}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleDisconnect}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>{t('disconnectGitHub')}</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleConnectGitHub}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90 shrink-0"
            >
              <FolderGit2 className="h-4 w-4" />
              <span>{t('connectGitHub')}</span>
            </button>
          )}
        </div>
      </div>

      {showPublishWizard && activeProject && (
        <GitHubPublishWizard
          project={activeProject}
          repos={repos}
          onConnectOAuth={handleConnectGitHub}
          onRepoCreated={(created) => {
            setRepos((prev) => [created, ...prev]);
            setSelectedRepo(created);
          }}
          onPublished={async (repo, branch, sha) => {
            const now = Date.now();
            await saveProject({
              ...activeProject,
              github: {
                owner: repo.owner,
                repo: repo.name,
                branch,
                lastCommitSha: sha,
                lastSyncedAt: now,
              },
              updatedAt: now,
            });
            setSelectedRepo(repo);
            await loadRepoDetails(repo, branch);
          }}
          onClose={() => setShowPublishWizard(false)}
        />
      )}

      {/* Setup Guidance when OAuth env vars are not yet configured */}
      {!githubStatus.configured && (
        <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 p-5 space-y-2 text-xs text-amber-900 dark:text-amber-200">
          <p className="font-semibold text-sm">GitHub OAuth App Configuration Required</p>
          <p className="leading-relaxed">
            To enable GitHub authentication, register a GitHub OAuth App and set <code className="font-mono">GITHUB_CLIENT_ID</code> and <code className="font-mono">GITHUB_CLIENT_SECRET</code> in your server environment secrets. Tokens are encrypted server-side in HTTP-only <code className="font-mono">SameSite=None</code> cookies and never stored in browser <code className="font-mono">localStorage</code>.
          </p>
          {githubStatus.callbackUrl && (
            <p className="font-mono">
              Authorization Callback URL: <strong>{githubStatus.callbackUrl}</strong>
            </p>
          )}
        </div>
      )}

      {githubStatus.connected && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left: Repository Browser */}
          <section className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col overflow-hidden">
            <div className="p-4 border-b border-slate-200 dark:border-slate-800 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Repositories
                </h2>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={loadRepos}
                    className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                    title={t('refresh')}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${loadingRepos ? 'animate-spin' : ''}`} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowCreateRepo((v) => !v)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>{t('createRepository')}</span>
                  </button>
                </div>
              </div>

              <input
                type="text"
                value={repoFilter}
                onChange={(e) => setRepoFilter(e.target.value)}
                placeholder="Filter repositories..."
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-1.5 text-xs"
              />

              {showCreateRepo && (
                <form
                  onSubmit={handleCreateRepo}
                  className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 space-y-2.5"
                >
                  <input
                    type="text"
                    required
                    value={newRepoName}
                    onChange={(e) => setNewRepoName(e.target.value)}
                    placeholder="Repository name (e.g. omniai-app)"
                    className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                  />
                  <input
                    type="text"
                    value={newRepoDesc}
                    onChange={(e) => setNewRepoDesc(e.target.value)}
                    placeholder="Description (optional)"
                    className="w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs"
                  />
                  <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
                    <input
                      type="checkbox"
                      checked={newRepoPrivate}
                      onChange={(e) => setNewRepoPrivate(e.target.checked)}
                    />
                    <span>Private repository</span>
                  </label>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowCreateRepo(false)}
                      className="px-2.5 py-1 text-xs text-slate-500"
                    >
                      {t('cancel')}
                    </button>
                    <button
                      type="submit"
                      disabled={busyAction === 'create-repo'}
                      className="px-3 py-1 text-xs font-medium rounded bg-blue-600 text-white"
                    >
                      Create
                    </button>
                  </div>
                </form>
              )}
            </div>

            <div className="flex-1 max-h-[520px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80">
              {filteredRepos.map((repo) => {
                const active = selectedRepo?.id === repo.id;
                return (
                  <button
                    key={repo.id}
                    type="button"
                    onClick={() => {
                      setSelectedRepo(repo);
                      loadRepoDetails(repo);
                    }}
                    className={`w-full px-4 py-3 text-start transition-colors ${
                      active
                        ? 'bg-blue-600/10'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {repo.fullName}
                      </span>
                      <span className="text-[11px] text-slate-500 shrink-0">
                        {repo.private ? 'Private' : 'Public'}
                      </span>
                    </div>
                    {repo.description && (
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 line-clamp-1">
                        {repo.description}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Right: Sync Controls, Branches & Commit History */}
          <section className="lg:col-span-7 space-y-6">
            {!selectedRepo ? (
              <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-12 text-center text-sm text-slate-500">
                Select a GitHub repository on the left to inspect branches, import code, pull updates, or push commits.
              </div>
            ) : (
              <>
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100 dark:border-slate-800">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        {selectedRepo.fullName}
                      </h2>
                      <p className="text-xs text-slate-500">
                        Default branch: <span className="font-mono">{selectedRepo.defaultBranch}</span>
                      </p>
                    </div>
                    <a
                      href={selectedRepo.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      <span>Open on GitHub</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>

                  {/* Branch Selector + Create Branch */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        Target Branch
                      </label>
                      <div className="flex items-center gap-2">
                        <GitBranch className="h-4 w-4 text-slate-400 shrink-0" />
                        <select
                          value={selectedBranch}
                          onChange={(e) => {
                            setSelectedBranch(e.target.value);
                            loadRepoDetails(selectedRepo, e.target.value);
                          }}
                          className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs font-mono"
                        >
                          {branches.map((b) => (
                            <option key={b.name} value={b.name}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <form onSubmit={handleCreateBranch}>
                      <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1.5">
                        Create Branch from {selectedBranch}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={newBranchName}
                          onChange={(e) => setNewBranchName(e.target.value)}
                          placeholder="feature/new-ui"
                          className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 px-2.5 py-1.5 text-xs font-mono"
                        />
                        <button
                          type="submit"
                          disabled={!newBranchName.trim() || busyAction === 'create-branch'}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
                        >
                          Create
                        </button>
                      </div>
                    </form>
                  </div>

                  {/* Target Studio Project + Import / Pull / Push */}
                  <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Link2 className="h-4 w-4 text-slate-400" />
                        <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                          Studio Project:
                        </span>
                        <select
                          value={activeProject?.id || ''}
                          onChange={(e) => setActiveProjectId(e.target.value)}
                          className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-xs font-medium"
                        >
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.files.length} files)
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {activeProject && (
                          <button
                            type="button"
                            onClick={handleCheckSyncStatus}
                            disabled={busyAction === 'diff'}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <GitCompare className="h-3.5 w-3.5" />
                            <span>{busyAction === 'diff' ? 'Comparing...' : 'Check Sync'}</span>
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={handleImportAsProject}
                          disabled={busyAction === 'import'}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          <DownloadCloud className="h-3.5 w-3.5" />
                          <span>{t('importRepository')}</span>
                        </button>

                        {activeProject && (
                          <button
                            type="button"
                            onClick={handlePullIntoActive}
                            disabled={busyAction === 'pull'}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                          >
                            <DownloadCloud className="h-3.5 w-3.5" />
                            <span>{t('pullChanges')}</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {hasRemoteDivergence && activeProject && (
                      <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3.5 space-y-2 text-xs text-amber-900 dark:text-amber-200">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                          <div className="space-y-1 flex-1">
                            <p className="font-semibold">
                              Remote branch has newer commits ({latestRemoteSha?.slice(0, 7)}) than your last sync (
                              {activeProject.github?.lastCommitSha?.slice(0, 7)})
                            </p>
                            <p className="text-[11px] opacity-90">
                              Pull remote changes first to avoid overwriting teammate commits. A local snapshot will be saved automatically before pulling.
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <button
                            type="button"
                            onClick={handlePullIntoActive}
                            disabled={busyAction === 'pull'}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-600 text-white font-medium hover:bg-amber-700"
                          >
                            <DownloadCloud className="h-3.5 w-3.5" />
                            <span>Pull Remote (Snapshot Backup First)</span>
                          </button>
                          {confirmForcePush && (
                            <button
                              type="button"
                              onClick={(e) => handlePushActiveProject(e, true)}
                              disabled={!commitMessage.trim() || busyAction === 'push'}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-red-400 text-red-700 dark:text-red-300 bg-white dark:bg-slate-900 font-medium hover:bg-red-50 dark:hover:bg-red-950/40"
                            >
                              <UploadCloud className="h-3.5 w-3.5" />
                              <span>Confirm Push Anyway</span>
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {syncDiff && (
                      <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-3.5 space-y-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-slate-800 dark:text-slate-200">
                            Sync Comparison ({formatRelativeTime(syncDiff.checkedAt)})
                          </span>
                          <span className="text-[11px] text-slate-500">
                            {syncDiff.modified.length} modified · {syncDiff.localOnly.length} local only · {syncDiff.remoteOnly.length} remote only
                          </span>
                        </div>
                        {syncDiff.modified.length === 0 &&
                        syncDiff.localOnly.length === 0 &&
                        syncDiff.remoteOnly.length === 0 ? (
                          <p className="text-emerald-600 dark:text-emerald-400 font-medium">
                            Local project and remote branch match identically.
                          </p>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] font-mono">
                            <div className="rounded border border-amber-200 dark:border-amber-900/50 bg-white dark:bg-slate-900 p-2">
                              <p className="font-sans font-semibold text-amber-700 dark:text-amber-400 mb-1">
                                Modified ({syncDiff.modified.length})
                              </p>
                              <div className="max-h-24 overflow-y-auto space-y-0.5 text-slate-600 dark:text-slate-300">
                                {syncDiff.modified.length === 0 ? '—' : syncDiff.modified.map((f) => <div key={f} className="truncate">{f}</div>)}
                              </div>
                            </div>
                            <div className="rounded border border-blue-200 dark:border-blue-900/50 bg-white dark:bg-slate-900 p-2">
                              <p className="font-sans font-semibold text-blue-700 dark:text-blue-400 mb-1">
                                Local Only ({syncDiff.localOnly.length})
                              </p>
                              <div className="max-h-24 overflow-y-auto space-y-0.5 text-slate-600 dark:text-slate-300">
                                {syncDiff.localOnly.length === 0 ? '—' : syncDiff.localOnly.map((f) => <div key={f} className="truncate">{f}</div>)}
                              </div>
                            </div>
                            <div className="rounded border border-purple-200 dark:border-purple-900/50 bg-white dark:bg-slate-900 p-2">
                              <p className="font-sans font-semibold text-purple-700 dark:text-purple-400 mb-1">
                                Remote Only ({syncDiff.remoteOnly.length})
                              </p>
                              <div className="max-h-24 overflow-y-auto space-y-0.5 text-slate-600 dark:text-slate-300">
                                {syncDiff.remoteOnly.length === 0 ? '—' : syncDiff.remoteOnly.map((f) => <div key={f} className="truncate">{f}</div>)}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {activeProject && (
                      <form onSubmit={(e) => handlePushActiveProject(e, false)} className="space-y-2.5">
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            type="text"
                            required
                            value={commitMessage}
                            onChange={(e) => setCommitMessage(e.target.value)}
                            placeholder={t('commitMessagePlaceholder')}
                            className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs"
                          />
                          <button
                            type="submit"
                            disabled={!commitMessage.trim() || busyAction === 'push'}
                            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white whitespace-nowrap"
                          >
                            <UploadCloud className="h-3.5 w-3.5" />
                            <span>
                              {busyAction === 'push'
                                ? 'Pushing...'
                                : hasRemoteDivergence && !confirmForcePush
                                  ? 'Review & Push'
                                  : t('pushChanges')}
                            </span>
                          </button>
                        </div>
                        {activeProject.github?.lastSyncedAt && (
                          <p className="inline-flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>
                              Last synced {formatRelativeTime(activeProject.github.lastSyncedAt)} (
                              {activeProject.github.lastCommitSha?.slice(0, 7)})
                            </span>
                          </p>
                        )}
                      </form>
                    )}
                  </div>
                </div>

                {/* Commit History */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
                    <GitCommitHorizontal className="h-4 w-4 text-slate-400" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Commit History ({selectedBranch})
                    </h3>
                  </div>
                  <div className="divide-y divide-slate-100 dark:divide-slate-800/80 max-h-64 overflow-y-auto">
                    {commits.length === 0 ? (
                      <p className="p-4 text-xs text-slate-400">No commits found on this branch.</p>
                    ) : (
                      commits.map((c) => (
                        <div
                          key={c.sha}
                          className="px-5 py-2.5 flex items-center justify-between gap-4 text-xs"
                        >
                          <div className="min-w-0">
                            <p className="font-medium text-slate-900 dark:text-slate-100 truncate">
                              {c.message}
                            </p>
                            <p className="text-[11px] text-slate-500">
                              {c.authorName} · {new Date(c.date).toLocaleString()}
                            </p>
                          </div>
                          <a
                            href={c.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-blue-600 dark:text-blue-400 hover:underline shrink-0"
                          >
                            {c.shortSha}
                          </a>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {/* Desktop Local Git Console (Electron Only when a local folder is linked) */}
      {desktopBridge?.runGitCommand && activeProject?.localFolderPath && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Desktop Local Git Console
                </h3>
                <p className="text-[11px] font-mono text-slate-500">
                  {activeProject.localFolderPath}
                </p>
              </div>
            </div>
            <span className="text-[11px] text-slate-500">
              Allowlisted local Git commands · Pre-sync backup before pull
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {[
              { label: 'git status', cmd: 'git status', backup: false },
              { label: 'git branch', cmd: 'git branch', backup: false },
              { label: 'git log -n 5', cmd: 'git log -n 5', backup: false },
              { label: 'git diff', cmd: 'git diff', backup: false },
              { label: 'git add .', cmd: 'git add .', backup: false },
              { label: 'git pull (backup first)', cmd: 'git pull', backup: true },
              { label: 'git push', cmd: 'git push', backup: false },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                disabled={localGitBusy}
                onClick={() => handleRunLocalGit(item.cmd, item.backup)}
                className="px-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-40"
              >
                {item.label}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!localCommitMsg.trim()) return;
              const safeMsg = localCommitMsg.trim().replace(/"/g, "'");
              handleRunLocalGit(`git commit -m "${safeMsg}"`, false);
            }}
            className="flex flex-col sm:flex-row gap-2"
          >
            <input
              type="text"
              value={localCommitMsg}
              onChange={(e) => setLocalCommitMsg(e.target.value)}
              placeholder='Local commit message (runs git commit -m "...")'
              className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs"
            />
            <button
              type="submit"
              disabled={localGitBusy || !localCommitMsg.trim()}
              className="px-4 py-2 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white"
            >
              Commit Locally
            </button>
          </form>

          {localGitResult && (
            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-950 text-slate-100 p-3 text-[11px] font-mono space-y-1.5">
              <div className="flex items-center justify-between text-slate-400">
                <span>$ {localGitResult.command}</span>
                <span className={localGitResult.ok ? 'text-emerald-400' : 'text-red-400'}>
                  {localGitResult.ok ? 'OK' : 'FAILED'}
                </span>
              </div>
              {localGitResult.backupPath && (
                <div className="text-amber-300">Backup snapshot: {localGitResult.backupPath}</div>
              )}
              {localGitResult.stdout && (
                <pre className="whitespace-pre-wrap break-words text-slate-200">
                  {localGitResult.stdout}
                </pre>
              )}
              {localGitResult.stderr && (
                <pre className="whitespace-pre-wrap break-words text-amber-300">
                  {localGitResult.stderr}
                </pre>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
