import crypto from 'crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { getActiveStore, getDatabaseUnavailableReason } from '../db/index.ts';
import type { UserWorkspaceStore } from '../db/storeTypes.ts';
import { requireAuthMiddleware } from './auth.ts';

function isSafeRelativePath(filePath: string): boolean {
  if (!filePath || typeof filePath !== 'string') return false;
  if (filePath.includes('\0') || filePath.startsWith('/')) return false;
  const parts = filePath.replace(/\\/g, '/').split('/');
  return !parts.some((seg) => seg === '' || seg === '.' || seg === '..');
}

function computeFnv1aChecksum(data: unknown): string {
  const str = JSON.stringify(data);
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function validateBackupInput(raw: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Backup payload must be a JSON object.'] };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.schemaVersion !== 'number' || obj.schemaVersion < 1) {
    errors.push('Missing or invalid numeric schemaVersion.');
  }
  if (Array.isArray(obj.projects)) {
    obj.projects.forEach((p, idx) => {
      if (!p || typeof p !== 'object') {
        errors.push(`projects[${idx}] is malformed.`);
        return;
      }
      const proj = p as { files?: Array<{ path?: string; content?: string }> };
      if (!Array.isArray(proj.files)) {
        errors.push(`projects[${idx}] is missing files array.`);
        return;
      }
      for (const f of proj.files) {
        if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
          errors.push(`projects[${idx}] contains malformed file entry.`);
          break;
        }
        if (!isSafeRelativePath(f.path)) {
          errors.push(`projects[${idx}] contains unsafe file path "${f.path}".`);
          break;
        }
      }
    });
  }
  if (typeof obj.checksum === 'string' && obj.checksum.startsWith('fnv1a_')) {
    const { checksum, ...withoutChecksum } = obj;
    if (checksum !== computeFnv1aChecksum(withoutChecksum)) {
      errors.push('Backup checksum mismatch — payload may be corrupted or tampered.');
    }
  }
  return { valid: errors.length === 0, errors };
}

export function createWorkspaceRouter(customStore?: UserWorkspaceStore) {
  const router = express.Router();
  const resolveStore = () => customStore ?? getActiveStore();

  router.use((_req: Request, res: Response, next: NextFunction) => {
    if (!customStore) {
      const unavailable = getDatabaseUnavailableReason();
      if (unavailable) {
        res.status(503).json({ error: unavailable });
        return;
      }
    }
    next();
  });

  router.use(requireAuthMiddleware);

  router.get('/state', async (req, res) => {
    try {
      const userId = req.authUser!.id;
      const ws = await resolveStore().getUserWorkspace(userId);
      res.json({
        ownerUserId: userId,
        ...ws,
      });
    } catch (err) {
      res.status(404).json({
        error: err instanceof Error ? err.message : 'Workspace not found.',
      });
    }
  });

  router.put('/state', async (req, res) => {
    try {
      const store = resolveStore();
      const userId = req.authUser!.id;
      const body = req.body as Record<string, unknown>;

      if (body.ownerUserId && body.ownerUserId !== userId) {
        await store.appendAuditLog({
          userId,
          action: 'workspace_write_spoof_attempt',
          target: String(body.ownerUserId),
          outcome: 'denied',
        });
        res.status(403).json({ error: 'Forbidden: cannot modify another user workspace.' });
        return;
      }

      await store.saveUserWorkspace(userId, {
        models: Array.isArray(body.models) ? (body.models as Array<Record<string, unknown>>) : undefined,
        conversations: Array.isArray(body.conversations)
          ? (body.conversations as Array<Record<string, unknown>>)
          : undefined,
        folders: Array.isArray(body.folders) ? (body.folders as Array<Record<string, unknown>>) : undefined,
        projects: Array.isArray(body.projects) ? (body.projects as Array<Record<string, unknown>>) : undefined,
        snapshots: Array.isArray(body.snapshots)
          ? (body.snapshots as Array<Record<string, unknown>>)
          : undefined,
        usageRecords: Array.isArray(body.usageRecords)
          ? (body.usageRecords as Array<Record<string, unknown>>)
          : undefined,
        settings:
          body.settings !== undefined && typeof body.settings === 'object'
            ? (body.settings as Record<string, unknown> | null)
            : undefined,
      });

      res.json({ ok: true, ownerUserId: userId, savedAt: Date.now() });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to save workspace.',
      });
    }
  });

  router.get('/export', async (req, res) => {
    try {
      const userId = req.authUser!.id;
      const ws = await resolveStore().getUserWorkspace(userId);
      const base = {
        schemaVersion: 3,
        exportedAt: Date.now(),
        models: ws.models.map((m) => {
          const copy = { ...m };
          delete copy.apiKey;
          return copy;
        }),
        conversations: ws.conversations,
        folders: ws.folders,
        projects: ws.projects,
        snapshots: ws.snapshots,
        usageRecords: ws.usageRecords,
        settings: ws.settings,
      };
      res.json({
        ...base,
        checksum: computeFnv1aChecksum(base),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to export workspace backup.',
      });
    }
  });

  router.get('/backups', async (req, res) => {
    try {
      const backups = await resolveStore().listUserBackups(req.authUser!.id);
      res.json({ backups });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to list backups.',
      });
    }
  });

  router.post('/backups', async (req, res) => {
    try {
      const store = resolveStore();
      const userId = req.authUser!.id;
      const ws = await store.getUserWorkspace(userId);
      const base = {
        schemaVersion: 3,
        exportedAt: Date.now(),
        models: ws.models,
        conversations: ws.conversations,
        folders: ws.folders,
        projects: ws.projects,
        snapshots: ws.snapshots,
        usageRecords: ws.usageRecords,
        settings: ws.settings,
      };
      const checksum = computeFnv1aChecksum(base);
      const saved = await store.saveUserBackup(userId, {
        schemaVersion: 3,
        checksum,
        payload: base,
      });
      await store.appendAuditLog({
        userId,
        action: 'workspace_backup_created',
        target: saved.id,
        outcome: 'success',
      });
      res.status(201).json({ backup: saved });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to create workspace backup.',
      });
    }
  });

  router.post('/restore', async (req, res) => {
    try {
      const store = resolveStore();
      const userId = req.authUser!.id;
      const body = req.body as Record<string, unknown>;

      let payload: Record<string, unknown> = body;
      if (typeof body.backupId === 'string' && body.backupId.trim()) {
        const stored = await store.getUserBackupById(userId, body.backupId.trim());
        if (!stored) {
          res.status(404).json({ error: 'Backup record not found for this user.' });
          return;
        }
        payload = stored.payload;
      }

      if (payload.ownerUserId && payload.ownerUserId !== userId) {
        res.status(403).json({ error: 'Forbidden: cannot restore another user backup.' });
        return;
      }

      const validation = validateBackupInput(payload);
      if (!validation.valid) {
        res.status(400).json({ error: validation.errors.join(' ') });
        return;
      }

      await store.saveUserWorkspace(userId, {
        models: Array.isArray(payload.models)
          ? (payload.models as Array<Record<string, unknown>>)
          : [],
        conversations: Array.isArray(payload.conversations)
          ? (payload.conversations as Array<Record<string, unknown>>)
          : [],
        folders: Array.isArray(payload.folders)
          ? (payload.folders as Array<Record<string, unknown>>)
          : [],
        projects: Array.isArray(payload.projects)
          ? (payload.projects as Array<Record<string, unknown>>)
          : [],
        snapshots: Array.isArray(payload.snapshots)
          ? (payload.snapshots as Array<Record<string, unknown>>)
          : [],
        usageRecords: Array.isArray(payload.usageRecords)
          ? (payload.usageRecords as Array<Record<string, unknown>>)
          : [],
        settings:
          payload.settings !== undefined && typeof payload.settings === 'object'
            ? (payload.settings as Record<string, unknown> | null)
            : null,
      });

      await store.appendAuditLog({
        userId,
        action: 'workspace_backup_restored',
        target: userId,
        outcome: 'success',
      });

      res.json({
        ok: true,
        restoredAt: Date.now(),
        counts: {
          models: Array.isArray(payload.models) ? payload.models.length : 0,
          projects: Array.isArray(payload.projects) ? payload.projects.length : 0,
          conversations: Array.isArray(payload.conversations) ? payload.conversations.length : 0,
        },
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to restore workspace backup.',
      });
    }
  });

  router.post('/backup/validate', (req, res) => {
    const payload = req.body as Record<string, unknown>;
    const validation = validateBackupInput(payload);
    if (!validation.valid) {
      res.status(400).json({ valid: false, error: validation.errors.join(' ') });
      return;
    }
    const serialized = JSON.stringify({
      models: payload.models || [],
      conversations: payload.conversations || [],
      projects: payload.projects || [],
    });
    const checksum = crypto.createHash('sha256').update(serialized).digest('hex');
    res.json({
      valid: true,
      checksum,
      counts: {
        projects: Array.isArray(payload.projects) ? payload.projects.length : 0,
        conversations: Array.isArray(payload.conversations) ? payload.conversations.length : 0,
        models: Array.isArray(payload.models) ? payload.models.length : 0,
      },
    });
  });

  return router;
}

export default createWorkspaceRouter();
