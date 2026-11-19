import { execFile } from 'child_process';
import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface DesktopEnvironmentInfo {
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string | null;
  npmVersion: string | null;
  gitVersion: string | null;
}

export interface RecentLocalProject {
  folderPath: string;
  name: string;
  lastOpenedAt: number;
}

export interface FolderInspectionSummary {
  folderPath: string;
  isEmpty: boolean;
  entryCount: number;
  hasPackageJson: boolean;
  hasGitRepo: boolean;
  scripts: string[];
}

async function readVersionSafe(cmd: string, args: string[]): Promise<string | null> {
  try {
    const bin =
      process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd;
    const { stdout } = await execFileAsync(bin, args, { timeout: 4000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function detectDesktopEnvironment(): Promise<DesktopEnvironmentInfo> {
  const [nodeVersion, npmVersion, gitVersion] = await Promise.all([
    readVersionSafe('node', ['-v']),
    readVersionSafe('npm', ['-v']),
    readVersionSafe('git', ['--version']),
  ]);
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion,
    npmVersion,
    gitVersion,
  };
}

export function checkLocalPortAvailability(port: number): Promise<{ port: number; inUse: boolean }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => {
      resolve({ port, inUse: true });
    });
    server.once('listening', () => {
      server.close(() => resolve({ port, inUse: false }));
    });
    server.listen(port, '127.0.0.1');
  });
}

export async function inspectFolderOverview(folderPath: string): Promise<FolderInspectionSummary> {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  const visibleEntries = entries.filter((e) => !e.name.startsWith('.omniai-backups'));
  const hasPackageJson = entries.some((e) => e.isFile() && e.name === 'package.json');
  const hasGitRepo = entries.some((e) => e.isDirectory() && e.name === '.git');
  let scripts: string[] = [];

  if (hasPackageJson) {
    try {
      const raw = await fs.readFile(path.join(folderPath, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
      if (parsed?.scripts && typeof parsed.scripts === 'object') {
        scripts = Object.keys(parsed.scripts);
      }
    } catch {
      // ignore invalid package.json
    }
  }

  return {
    folderPath,
    isEmpty: visibleEntries.length === 0,
    entryCount: visibleEntries.length,
    hasPackageJson,
    hasGitRepo,
    scripts,
  };
}

export async function loadRecentProjects(storeFilePath: string): Promise<RecentLocalProject[]> {
  try {
    const raw = await fs.readFile(storeFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentLocalProject[]) : [];
  } catch {
    return [];
  }
}

export async function saveRecentProject(
  storeFilePath: string,
  folderPath: string
): Promise<RecentLocalProject[]> {
  const list = await loadRecentProjects(storeFilePath);
  const filtered = list.filter((p) => p.folderPath !== folderPath);
  const updated: RecentLocalProject[] = [
    {
      folderPath,
      name: path.basename(folderPath) || folderPath,
      lastOpenedAt: Date.now(),
    },
    ...filtered,
  ].slice(0, 12);

  await fs.mkdir(path.dirname(storeFilePath), { recursive: true });
  await fs.writeFile(storeFilePath, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

export async function openAuthorizedRecentProject(
  storeFilePath: string,
  folderPath: string,
  authorizedSet: Set<string>
): Promise<string> {
  const abs = await fs.realpath(path.resolve(folderPath));
  const list = await loadRecentProjects(storeFilePath);
  const known = list.some(
    (entry) => path.resolve(entry.folderPath) === abs || path.resolve(entry.folderPath) === path.resolve(folderPath)
  );
  if (!known) {
    throw new Error('Folder is not in recent projects history; select it via folder picker.');
  }
  await fs.access(abs);
  authorizedSet.add(abs);
  await saveRecentProject(storeFilePath, abs);
  return abs;
}

export function assertWorkspaceIsAuthorized(authorizedSet: Set<string>, folderPath: string): string {
  const abs = path.resolve(folderPath);
  if (!authorizedSet.has(abs)) {
    throw new Error('Access denied: Folder was not explicitly authorized via the native folder picker.');
  }
  return abs;
}
