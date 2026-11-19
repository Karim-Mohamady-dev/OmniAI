import type { ProjectFile } from '../types/index.ts';

const BLOCKED_SECRET_FILES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'id_rsa',
  'id_ed25519',
]);

export function validateProjectPath(rawPath: string): { valid: boolean; normalized: string; error?: string } {
  const trimmed = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!trimmed) {
    return { valid: false, normalized: '', error: 'File path cannot be empty.' };
  }
  if (trimmed.includes('\0')) {
    return { valid: false, normalized: '', error: 'Invalid null character in path.' };
  }
  const segments = trimmed.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return { valid: false, normalized: '', error: 'Path traversal or empty segments are not allowed.' };
  }
  const baseName = segments[segments.length - 1].toLowerCase();
  if (BLOCKED_SECRET_FILES.has(baseName)) {
    return {
      valid: false,
      normalized: '',
      error: `Writing secret file "${baseName}" is restricted for security.`,
    };
  }
  return { valid: true, normalized: segments.join('/') };
}

export function upsertProjectFile(
  files: ProjectFile[],
  path: string,
  content: string
): { files: ProjectFile[]; error?: string } {
  const check = validateProjectPath(path);
  if (!check.valid) {
    return { files, error: check.error };
  }
  const now = Date.now();
  const existingIdx = files.findIndex((f) => f.path === check.normalized);
  if (existingIdx >= 0) {
    const next = [...files];
    next[existingIdx] = { path: check.normalized, content, updatedAt: now };
    return { files: next };
  }
  return {
    files: [...files, { path: check.normalized, content, updatedAt: now }].sort((a, b) =>
      a.path.localeCompare(b.path)
    ),
  };
}

export function deleteProjectPath(files: ProjectFile[], targetPath: string): ProjectFile[] {
  const clean = targetPath.trim().replace(/^\/+/, '');
  return files.filter((f) => f.path !== clean && !f.path.startsWith(`${clean}/`));
}

export function renameProjectPath(
  files: ProjectFile[],
  oldPath: string,
  newPath: string
): { files: ProjectFile[]; error?: string } {
  const check = validateProjectPath(newPath);
  if (!check.valid) return { files, error: check.error };

  const cleanOld = oldPath.trim().replace(/^\/+/, '');
  const now = Date.now();

  // Check collision
  if (files.some((f) => f.path === check.normalized && f.path !== cleanOld)) {
    return { files, error: `A file already exists at "${check.normalized}".` };
  }

  const next = files.map((f) => {
    if (f.path === cleanOld) {
      return { ...f, path: check.normalized, updatedAt: now };
    }
    if (f.path.startsWith(`${cleanOld}/`)) {
      return {
        ...f,
        path: `${check.normalized}/${f.path.slice(cleanOld.length + 1)}`,
        updatedAt: now,
      };
    }
    return f;
  });

  return { files: next.sort((a, b) => a.path.localeCompare(b.path)) };
}
