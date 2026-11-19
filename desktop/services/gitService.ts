import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { validateDesktopCommand } from '../security/validators';

const execFileAsync = promisify(execFile);

export interface LocalGitResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
}

export async function runValidatedLocalGit(
  workspaceRoot: string,
  gitCommand: string
): Promise<LocalGitResult> {
  const trimmed = gitCommand.trim().startsWith('git ')
    ? gitCommand.trim()
    : `git ${gitCommand.trim()}`;

  const validation = validateDesktopCommand(trimmed);
  if (!validation.allowed || validation.executable !== 'git') {
    throw new Error(validation.reason || 'Git command blocked by desktop security policy.');
  }

  try {
    const { stdout, stderr } = await execFileAsync('git', validation.args, {
      cwd: workspaceRoot,
      timeout: 30_000,
    });
    return {
      ok: true,
      command: trimmed,
      stdout: stdout || '',
      stderr: stderr || '',
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      command: trimmed,
      stdout: e.stdout || '',
      stderr: e.stderr || e.message || 'Git execution failed',
    };
  }
}

export async function createLocalBackupSnapshot(workspaceRoot: string): Promise<string> {
  const realRoot = await fs.realpath(workspaceRoot);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(realRoot, '.omniai-backups', `snapshot-${stamp}`);
  await fs.mkdir(backupDir, { recursive: true });

  const entries = await fs.readdir(realRoot, { withFileTypes: true });
  const SKIP = new Set(['node_modules', '.git', '.omniai-backups', 'dist', 'release']);

  async function copyDir(src: string, dest: string) {
    await fs.mkdir(dest, { recursive: true });
    const items = await fs.readdir(src, { withFileTypes: true });
    for (const item of items) {
      if (SKIP.has(item.name) || item.isSymbolicLink()) continue;
      const s = path.join(src, item.name);
      const stat = await fs.lstat(s);
      if (stat.isSymbolicLink()) continue;
      const d = path.join(dest, item.name);
      if (stat.isDirectory()) {
        await copyDir(s, d);
      } else if (stat.isFile()) {
        await fs.copyFile(s, d);
      }
    }
  }

  for (const entry of entries) {
    if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
    const s = path.join(realRoot, entry.name);
    const stat = await fs.lstat(s);
    if (stat.isSymbolicLink()) continue;
    const d = path.join(backupDir, entry.name);
    if (stat.isDirectory()) {
      await copyDir(s, d);
    } else if (stat.isFile()) {
      await fs.copyFile(s, d);
    }
  }

  return backupDir;
}
