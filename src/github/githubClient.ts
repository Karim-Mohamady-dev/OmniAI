import type { GitHubRepoSummary, GitHubUser } from '../types/index.ts';

export interface GitHubStatusResponse {
  configured: boolean;
  connected: boolean;
  callbackUrl: string;
  user: GitHubUser | null;
}

export interface GitHubBranch {
  name: string;
  sha: string;
}

export interface GitHubCommit {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  date: string;
  url: string;
}

export class GitHubClientError extends Error {
  status: number;
  conflict?: boolean;
  remoteHeadSha?: string;
  reauthRequired?: boolean;

  constructor(
    message: string,
    status: number,
    extra?: { conflict?: boolean; remoteHeadSha?: string; reauthRequired?: boolean }
  ) {
    super(message);
    this.name = 'GitHubClientError';
    this.status = status;
    this.conflict = extra?.conflict;
    this.remoteHeadSha = extra?.remoteHeadSha;
    this.reauthRequired = extra?.reauthRequired;
  }
}

export async function getGitHubStatus(): Promise<GitHubStatusResponse> {
  const res = await fetch('/api/github/status');
  if (!res.ok) {
    return { configured: false, connected: false, callbackUrl: '', user: null };
  }
  return res.json();
}

export async function getGitHubAuthUrl(): Promise<{
  configured: boolean;
  url?: string;
  callbackUrl: string;
  error?: string;
}> {
  const res = await fetch('/api/github/auth/url');
  return res.json();
}

export async function disconnectGitHub(): Promise<void> {
  await fetch('/api/github/disconnect', { method: 'POST' });
}

export async function listGitHubRepos(): Promise<GitHubRepoSummary[]> {
  const res = await fetch('/api/github/repos');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new GitHubClientError(err.error || 'Failed to load repositories', res.status, {
      reauthRequired: Boolean(err.reauthRequired),
    });
  }
  const data = await res.json();
  return data.repos || [];
}

export async function createGitHubRepo(params: {
  name: string;
  description: string;
  isPrivate: boolean;
}): Promise<GitHubRepoSummary> {
  const res = await fetch('/api/github/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new GitHubClientError(data.error || 'Failed to create repository', res.status, {
      reauthRequired: Boolean(data.reauthRequired),
    });
  }
  return data.repo;
}

export async function listGitHubBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
  const res = await fetch(
    `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`
  );
  const data = await res.json();
  if (!res.ok) {
    throw new GitHubClientError(data.error || 'Failed to list branches', res.status, {
      reauthRequired: Boolean(data.reauthRequired),
    });
  }
  return data.branches || [];
}

export async function createGitHubBranch(
  owner: string,
  repo: string,
  branchName: string,
  sourceSha: string
): Promise<GitHubBranch> {
  const res = await fetch(
    `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branchName, sourceSha }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new GitHubClientError(data.error || 'Failed to create branch', res.status, {
      reauthRequired: Boolean(data.reauthRequired),
    });
  }
  return { name: data.name, sha: data.sha };
}

export async function listGitHubCommits(
  owner: string,
  repo: string,
  branch: string
): Promise<GitHubCommit[]> {
  const res = await fetch(
    `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?branch=${encodeURIComponent(branch)}`
  );
  const data = await res.json();
  if (!res.ok) {
    throw new GitHubClientError(data.error || 'Failed to load commits', res.status, {
      reauthRequired: Boolean(data.reauthRequired),
    });
  }
  return data.commits || [];
}

export async function pullGitHubFiles(
  owner: string,
  repo: string,
  branch: string
): Promise<{ commitSha: string; branch: string; files: Array<{ path: string; content: string }> }> {
  const res = await fetch(
    `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new GitHubClientError(data.error || 'Failed to pull files', res.status, {
      reauthRequired: Boolean(data.reauthRequired),
    });
  }
  return data;
}

export async function pushGitHubFiles(
  owner: string,
  repo: string,
  branch: string,
  message: string,
  files: Array<{ path: string; content: string }>,
  options?: { expectedParentSha?: string; forceOverwrite?: boolean }
): Promise<{ commitSha: string; commitUrl: string; filesPushed: number }> {
  const res = await fetch(
    `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/push`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch,
        message,
        files,
        ...(options?.expectedParentSha ? { expectedParentSha: options.expectedParentSha } : {}),
        ...(options?.forceOverwrite ? { forceOverwrite: true } : {}),
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new GitHubClientError(data.error || 'Failed to push commit', res.status, {
      conflict: Boolean(data.conflict),
      remoteHeadSha: data.remoteHeadSha,
      reauthRequired: Boolean(data.reauthRequired),
    });
  }
  return data;
}
