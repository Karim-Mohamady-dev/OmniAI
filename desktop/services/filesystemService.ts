import fs from 'fs/promises';
import path from 'path';
import { resolveRealSafeProjectPath } from '../security/validators';

export interface LocalProjectFile {
  path: string;
  content: string;
  updatedAt: number;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'release']);
const MAX_FILE_BYTES = 512 * 1024;

export async function readLocalProjectFiles(workspaceRoot: string): Promise<LocalProjectFile[]> {
  const results: LocalProjectFile[] = [];
  const rootReal = await fs.realpath(workspaceRoot);

  async function walk(dirAbs: string) {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dirAbs, entry.name);
      const rel = path.relative(rootReal, full).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const check = resolveRealSafeProjectPath(rootReal, rel);
        if (!check.valid) continue;
        const stat = await fs.stat(check.resolvedPath);
        if (stat.size > MAX_FILE_BYTES) continue;
        const buf = await fs.readFile(check.resolvedPath);
        if (buf.includes(0)) continue;
        results.push({
          path: check.normalizedRelative,
          content: buf.toString('utf8'),
          updatedAt: stat.mtimeMs,
        });
      }
    }
  }

  await walk(rootReal);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export async function writeLocalProjectFile(
  workspaceRoot: string,
  relativePath: string,
  content: string
): Promise<void> {
  const check = resolveRealSafeProjectPath(workspaceRoot, relativePath);
  if (!check.valid) throw new Error(check.error);
  await fs.mkdir(path.dirname(check.resolvedPath), { recursive: true });
  await fs.writeFile(check.resolvedPath, content, 'utf8');
}

export async function createLocalProjectFolder(
  workspaceRoot: string,
  relativePath: string
): Promise<void> {
  const check = resolveRealSafeProjectPath(workspaceRoot, relativePath);
  if (!check.valid) throw new Error(check.error);
  await fs.mkdir(check.resolvedPath, { recursive: true });
}

export async function renameLocalProjectPath(
  workspaceRoot: string,
  oldRelativePath: string,
  newRelativePath: string
): Promise<void> {
  const oldCheck = resolveRealSafeProjectPath(workspaceRoot, oldRelativePath);
  if (!oldCheck.valid) throw new Error(oldCheck.error);
  const newCheck = resolveRealSafeProjectPath(workspaceRoot, newRelativePath);
  if (!newCheck.valid) throw new Error(newCheck.error);
  await fs.mkdir(path.dirname(newCheck.resolvedPath), { recursive: true });
  await fs.rename(oldCheck.resolvedPath, newCheck.resolvedPath);
}

export async function deleteLocalProjectPath(
  workspaceRoot: string,
  relativePath: string
): Promise<void> {
  const check = resolveRealSafeProjectPath(workspaceRoot, relativePath);
  if (!check.valid) throw new Error(check.error);
  await fs.rm(check.resolvedPath, { recursive: true, force: false });
}
