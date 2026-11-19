import React, { useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FolderGit2,
  ShieldAlert,
  UploadCloud,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';
import { createGitHubRepo, pushGitHubFiles } from '../github/githubClient.ts';
import type { GitHubRepoSummary, Project } from '../types/index.ts';

interface GitHubPublishWizardProps {
  project: Project;
  repos: GitHubRepoSummary[];
  onConnectOAuth: () => void;
  onRepoCreated: (repo: GitHubRepoSummary) => void;
  onPublished: (repo: GitHubRepoSummary, branch: string, sha: string) => void;
  onClose: () => void;
}

const STEP_TITLES = [
  '1. Pre-flight Security & Quality Check',
  '2. Verify GitHub OAuth Authorization',
  '3. Choose Target Project',
  '4. Select or Create Repository',
  '5. Target Branch',
  '6. Save Recovery Snapshot',
  '7. Review Files to Publish',
  '8. Commit Message & Push',
  '9. Published Confirmation',
];

export function GitHubPublishWizard({
  project,
  repos,
  onConnectOAuth,
  onRepoCreated,
  onPublished,
  onClose,
}: GitHubPublishWizardProps) {
  const { githubStatus, createProjectSnapshot, pushToast } = useApp();
  const [step, setStep] = useState(0);
  const [selectedRepoFull, setSelectedRepoFull] = useState(repos[0]?.fullName || '');
  const [createNew, setCreateNew] = useState(repos.length === 0);
  const [newRepoName, setNewRepoName] = useState(
    project.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'omniai-app'
  );
  const [isPrivate, setIsPrivate] = useState(true);
  const [branch, setBranch] = useState(project.github?.branch || 'main');
  const [snapshotSaved, setSnapshotSaved] = useState(false);
  const [commitMessage, setCommitMessage] = useState(`Publish ${project.name} from OmniAI Studio`);
  const [publishing, setPublishing] = useState(false);
  const [publishedResult, setPublishedResult] = useState<{
    repoUrl: string;
    commitSha: string;
    filesPushed: number;
  } | null>(null);

  const secretFiles = project.files.filter((f) =>
    /(^\.env$|\.pem$|\.key$|id_rsa)/i.test(f.path.split('/').pop() || '')
  );
  const safeFiles = project.files.filter(
    (f) => !/(^\.env$|\.pem$|\.key$|id_rsa)/i.test(f.path.split('/').pop() || '')
  );

  const selectedRepo = repos.find((r) => r.fullName === selectedRepoFull) || null;

  const handlePublishNow = async () => {
    setPublishing(true);
    try {
      let targetRepo = selectedRepo;
      if (createNew || !targetRepo) {
        targetRepo = await createGitHubRepo({
          name: newRepoName.trim(),
          description: project.description,
          isPrivate,
        });
        onRepoCreated(targetRepo);
        setSelectedRepoFull(targetRepo.fullName);
        setCreateNew(false);
      }

      const res = await pushGitHubFiles(
        targetRepo.owner,
        targetRepo.name,
        branch.trim() || targetRepo.defaultBranch || 'main',
        commitMessage.trim() || `Publish ${project.name}`,
        safeFiles.map((f) => ({ path: f.path, content: f.content }))
      );

      setPublishedResult({
        repoUrl: targetRepo.htmlUrl,
        commitSha: res.commitSha,
        filesPushed: res.filesPushed,
      });
      onPublished(targetRepo, branch.trim() || 'main', res.commitSha);
      setStep(8);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Wizard publish failed',
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="rounded-xl border border-blue-200 dark:border-blue-900/60 bg-white dark:bg-slate-900 p-5 space-y-4">
      <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <FolderGit2 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Guided GitHub Publish Wizard — {STEP_TITLES[step]}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
        >
          Exit Wizard
        </button>
      </div>

      <div className="flex gap-1">
        {STEP_TITLES.map((_, i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full ${
              i <= step ? 'bg-blue-600' : 'bg-slate-200 dark:bg-slate-800'
            }`}
          />
        ))}
      </div>

      <div className="min-h-[150px] text-xs space-y-3">
        {step === 0 && (
          <div className="space-y-2">
            <p className="text-slate-600 dark:text-slate-300">
              Scanning <strong>{project.name}</strong> ({project.files.length} files) before publishing:
            </p>
            {secretFiles.length > 0 ? (
              <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 text-amber-800 dark:text-amber-300 flex items-start gap-2">
                <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <strong>Excluded {secretFiles.length} sensitive file(s):</strong>{' '}
                  {secretFiles.map((f) => f.path).join(', ')}. They will NOT be pushed to GitHub.
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 p-3 text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4" />
                <span>No `.env` or private key files detected. Ready for publishing.</span>
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            {githubStatus.connected && githubStatus.user ? (
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-medium">
                <CheckCircle2 className="h-4 w-4" />
                <span>Connected as @{githubStatus.user.login} via encrypted server OAuth cookie.</span>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-slate-600 dark:text-slate-300">
                  GitHub OAuth connection is required to push commits.
                </p>
                <button
                  type="button"
                  onClick={onConnectOAuth}
                  className="px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-medium"
                >
                  Authorize GitHub Account
                </button>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-1">
            <p className="text-slate-600 dark:text-slate-300">
              Publishing Studio Project: <strong>{project.name}</strong> ({project.framework})
            </p>
            <p className="font-mono text-slate-500">
              {safeFiles.length} publishable files prepared.
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <div className="flex gap-3">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="radio"
                  checked={!createNew}
                  onChange={() => setCreateNew(false)}
                  disabled={repos.length === 0}
                />
                <span>Existing Repository</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="radio" checked={createNew} onChange={() => setCreateNew(true)} />
                <span>Create New Repository</span>
              </label>
            </div>
            {!createNew ? (
              <select
                value={selectedRepoFull}
                onChange={(e) => setSelectedRepoFull(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2"
              >
                {repos.map((r) => (
                  <option key={r.id} value={r.fullName}>
                    {r.fullName} ({r.private ? 'Private' : 'Public'})
                  </option>
                ))}
              </select>
            ) : (
              <div className="space-y-2">
                <input
                  type="text"
                  value={newRepoName}
                  onChange={(e) => setNewRepoName(e.target.value)}
                  placeholder="my-omniai-project"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono"
                />
                <label className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
                  <input
                    type="checkbox"
                    checked={isPrivate}
                    onChange={(e) => setIsPrivate(e.target.checked)}
                  />
                  <span>Keep repository private</span>
                </label>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-2">
            <label className="block font-medium">Target Branch</label>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="w-full font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2"
            />
          </div>
        )}

        {step === 5 && (
          <div className="space-y-3">
            <p className="text-slate-600 dark:text-slate-300">
              Create a recovery snapshot in IndexedDB before pushing changes to GitHub.
            </p>
            <button
              type="button"
              onClick={async () => {
                await createProjectSnapshot(project.id, `Pre-GitHub Publish (${branch})`, 'auto-backup');
                setSnapshotSaved(true);
              }}
              className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 font-medium"
            >
              {snapshotSaved ? 'Snapshot Saved ✓' : 'Save Recovery Snapshot'}
            </button>
          </div>
        )}

        {step === 6 && (
          <div className="space-y-2">
            <p className="font-medium">Files staged for commit ({safeFiles.length}):</p>
            <div className="max-h-32 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-2 font-mono space-y-0.5">
              {safeFiles.map((f) => (
                <div key={f.path} className="truncate text-slate-700 dark:text-slate-300">
                  + {f.path} ({f.content.length} chars)
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 7 && (
          <div className="space-y-3">
            <label className="block font-medium">Commit Message</label>
            <input
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2"
            />
            <button
              type="button"
              onClick={handlePublishNow}
              disabled={publishing || !githubStatus.connected}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium"
            >
              <UploadCloud className="h-4 w-4" />
              <span>{publishing ? 'Publishing to GitHub...' : 'Publish Repository Now'}</span>
            </button>
          </div>
        )}

        {step === 8 && publishedResult && (
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 p-4 space-y-2">
            <div className="flex items-center gap-2 font-semibold text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4" />
              <span>Published {publishedResult.filesPushed} file(s) successfully!</span>
            </div>
            <p className="font-mono text-slate-600 dark:text-slate-400">
              Commit SHA: {publishedResult.commitSha}
            </p>
            <a
              href={publishedResult.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-blue-600 dark:text-blue-400 font-medium hover:underline"
            >
              <span>View Repository on GitHub</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-slate-800">
        <button
          type="button"
          disabled={step === 0 || step === 8}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          <span>Back</span>
        </button>

        {step < 7 && (
          <button
            type="button"
            disabled={step === 1 && !githubStatus.connected}
            onClick={() => setStep((s) => Math.min(7, s + 1))}
            className="inline-flex items-center gap-1 px-4 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white"
          >
            <span>Continue</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
