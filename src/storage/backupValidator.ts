import type { Project } from '../types/index.ts';
import type { WorkspaceBackupPayload } from './storageAdapter.ts';

export interface BackupValidationResult {
  valid: boolean;
  errors: string[];
}

export function isSafeProjectRelativePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  if (filePath.includes('\0') || filePath.startsWith('/')) return false;
  const parts = filePath.replace(/\\/g, '/').split('/');
  if (parts.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return true;
}

export function computeSimpleChecksum(data: unknown): string {
  const str = JSON.stringify(data);
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function validateBackupPayload(raw: unknown): BackupValidationResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Backup payload must be a JSON object.'] };
  }

  const obj = raw as Record<string, unknown>;
  if (typeof obj.schemaVersion !== 'number' || obj.schemaVersion < 1) {
    errors.push('Missing or invalid numeric schemaVersion.');
  }
  if (typeof obj.exportedAt !== 'number' || obj.exportedAt <= 0) {
    errors.push('Missing or invalid exportedAt timestamp.');
  }

  if (obj.projects !== undefined && !Array.isArray(obj.projects)) {
    errors.push('projects must be an array.');
  } else if (Array.isArray(obj.projects)) {
    obj.projects.forEach((p, idx) => {
      if (!p || typeof p !== 'object') {
        errors.push(`projects[${idx}] is malformed.`);
        return;
      }
      const proj = p as Partial<Project>;
      if (!proj.id || !proj.name || !Array.isArray(proj.files)) {
        errors.push(`projects[${idx}] is missing id, name, or files.`);
        return;
      }
      for (const f of proj.files) {
        if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
          errors.push(`projects[${idx}] contains a malformed file entry.`);
          break;
        }
        if (!isSafeProjectRelativePath(f.path)) {
          errors.push(`projects[${idx}] contains unsafe file path "${f.path}".`);
          break;
        }
      }
    });
  }

  if (obj.conversations !== undefined && !Array.isArray(obj.conversations)) {
    errors.push('conversations must be an array.');
  }
  if (obj.folders !== undefined && !Array.isArray(obj.folders)) {
    errors.push('folders must be an array.');
  }
  if (obj.snapshots !== undefined && !Array.isArray(obj.snapshots)) {
    errors.push('snapshots must be an array.');
  }
  if (obj.models !== undefined && !Array.isArray(obj.models)) {
    errors.push('models must be an array.');
  }
  if (obj.usageRecords !== undefined && !Array.isArray(obj.usageRecords)) {
    errors.push('usageRecords must be an array.');
  }

  if (typeof obj.checksum === 'string' && obj.checksum.startsWith('fnv1a_')) {
    const { checksum, ...withoutChecksum } = obj;
    const expected = computeSimpleChecksum(withoutChecksum);
    if (checksum !== expected) {
      errors.push('Backup checksum mismatch — file may be corrupted or modified.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function createSingleProjectBackupPayload(project: Project): WorkspaceBackupPayload {
  const base: WorkspaceBackupPayload = {
    schemaVersion: 3,
    exportedAt: Date.now(),
    models: [],
    conversations: [],
    folders: [],
    projects: [project],
    snapshots: [],
    usageRecords: [],
    settings: null,
  };
  return {
    ...base,
    checksum: computeSimpleChecksum(base),
  };
}
