import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isIsolatedTestHarness } from '../config/envValidator.ts';
import { decryptString, encryptString } from '../crypto.ts';
import type {
  DatabaseHealthStatus,
  PublicUserRecord,
  StoredUserRecord,
  UserSessionRecord,
  UserWorkspaceData,
  UserWorkspaceStore,
  WorkspaceBackupSummary,
  WorkspaceSavePayload,
} from './storeTypes.ts';

export type { StoredUserRecord, UserWorkspaceData } from './storeTypes.ts';

interface StoredBackupRow extends WorkspaceBackupSummary {
  payload: Record<string, unknown>;
}

interface AuditLogRow {
  id: string;
  userId?: string | null;
  action: string;
  target: string;
  outcome: 'success' | 'denied' | 'error';
  metadata?: Record<string, unknown>;
  timestamp: number;
}

interface StoreDatabaseShape {
  users: Record<string, StoredUserRecord>;
  sessions: Record<string, UserSessionRecord>;
  workspaces: Record<string, UserWorkspaceData>;
  backups: Record<string, StoredBackupRow[]>;
  auditLogs: AuditLogRow[];
}

function emptyWorkspace(): UserWorkspaceData {
  return {
    models: [],
    conversations: [],
    folders: [],
    projects: [],
    snapshots: [],
    usageRecords: [],
    settings: null,
    vaultSecrets: {},
  };
}

function maskKeyPreview(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return 'Not set';
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
}

export function hashPasswordScrypt(password: string, existingSalt?: string): string {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPasswordScrypt(password: string, storedHash: string): boolean {
  const [salt, expectedHex] = storedHash.split(':');
  if (!salt || !expectedHex) return false;
  const actualBuf = crypto.scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

export class MultiUserStore implements UserWorkspaceStore {
  readonly backendType: 'file' | 'memory';
  private dataFilePath: string | null;
  private db: StoreDatabaseShape = {
    users: {},
    sessions: {},
    workspaces: {},
    backups: {},
    auditLogs: [],
  };

  constructor(dataFilePath?: string | null) {
    if (dataFilePath === null) {
      this.dataFilePath = null;
      this.backendType = 'memory';
    } else {
      const configuredDir =
        dataFilePath || path.resolve(process.cwd(), '.omniai-data', 'multiuser-store.json');
      this.dataFilePath = configuredDir;
      this.backendType = 'file';
      this.loadFromDisk();
    }
  }

  async healthCheck(): Promise<DatabaseHealthStatus> {
    return {
      ok: true,
      productionReady: false,
      backend: this.backendType,
      latencyMs: 0,
      detail:
        this.backendType === 'memory'
          ? 'In-memory local store active (non-production test/dev harness).'
          : `Local JSON file store active (${this.dataFilePath}); not hosted PostgreSQL.`,
    };
  }

  private loadFromDisk() {
    if (!this.dataFilePath) return;
    try {
      if (fs.existsSync(this.dataFilePath)) {
        const raw = fs.readFileSync(this.dataFilePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<StoreDatabaseShape>;
        if (parsed && typeof parsed === 'object') {
          this.db = {
            users: parsed.users || {},
            sessions: parsed.sessions || {},
            workspaces: parsed.workspaces || {},
            backups: parsed.backups || {},
            auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
          };
        }
      }
    } catch {
      this.db = { users: {}, sessions: {}, workspaces: {}, backups: {}, auditLogs: [] };
    }
  }

  private persistToDisk() {
    if (!this.dataFilePath) return;
    try {
      const dir = path.dirname(this.dataFilePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.dataFilePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2), 'utf8');
      fs.renameSync(tmp, this.dataFilePath);
    } catch {
      // Ignore write failures in read-only test harnesses
    }
  }

  registerUser(params: {
    email: string;
    password: string;
    displayName: string;
  }): PublicUserRecord {
    const normalizedEmail = params.email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new Error('A valid email address is required.');
    }
    if (!params.password || params.password.length < 8) {
      throw new Error('Password must be at least 8 characters long.');
    }

    const exists = Object.values(this.db.users).some((u) => u.email === normalizedEmail);
    if (exists) {
      throw new Error('An account with this email already exists.');
    }

    const now = Date.now();
    const id = `usr_${crypto.randomBytes(8).toString('hex')}`;
    const record: StoredUserRecord = {
      id,
      email: normalizedEmail,
      displayName: params.displayName.trim() || normalizedEmail.split('@')[0],
      passwordHash: hashPasswordScrypt(params.password),
      role: 'user',
      createdAt: now,
      updatedAt: now,
    };

    this.db.users[id] = record;
    this.db.workspaces[id] = emptyWorkspace();
    this.persistToDisk();

    return {
      id: record.id,
      email: record.email,
      displayName: record.displayName,
      role: record.role,
      createdAt: record.createdAt,
    };
  }

  authenticateUser(email: string, password: string): PublicUserRecord | null {
    const normalizedEmail = email.trim().toLowerCase();
    const user = Object.values(this.db.users).find((u) => u.email === normalizedEmail);
    if (!user) return null;
    if (!verifyPasswordScrypt(password, user.passwordHash)) return null;
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  getUserById(userId: string): PublicUserRecord | null {
    const user = this.db.users[userId];
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  createSession(
    userId: string,
    ttlMs: number = 7 * 24 * 60 * 60 * 1000
  ): { sessionId: string; expiresAt: number } {
    if (!this.db.users[userId]) {
      throw new Error('Cannot create session for unknown user.');
    }
    const now = Date.now();
    const sessionId = `ses_${crypto.randomBytes(16).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(sessionId).digest('hex');
    const expiresAt = now + ttlMs;
    this.db.sessions[sessionId] = {
      id: sessionId,
      userId,
      tokenHash,
      expiresAt,
      createdAt: now,
      revokedAt: null,
    };
    this.persistToDisk();
    return { sessionId, expiresAt };
  }

  validateSession(sessionId: string, userId: string): PublicUserRecord | null {
    const session = this.db.sessions[sessionId];
    if (!session) return null;
    if (session.userId !== userId) return null;
    if (session.revokedAt !== null && session.revokedAt !== undefined) return null;
    if (session.expiresAt <= Date.now()) return null;
    return this.getUserById(userId);
  }

  revokeSession(sessionId: string): void {
    const session = this.db.sessions[sessionId];
    if (!session) return;
    session.revokedAt = Date.now();
    this.persistToDisk();
  }

  getUserWorkspace(userId: string): UserWorkspaceData {
    if (!this.db.users[userId]) {
      throw new Error('Unauthorized user workspace lookup.');
    }
    if (!this.db.workspaces[userId]) {
      this.db.workspaces[userId] = emptyWorkspace();
    }
    const ws = this.db.workspaces[userId];
    return {
      models: ws.models.map((m) => ({ ...m, ownerUserId: userId })),
      conversations: ws.conversations,
      folders: ws.folders,
      projects: ws.projects,
      snapshots: ws.snapshots,
      usageRecords: ws.usageRecords,
      settings: ws.settings,
      vaultSecrets: {},
    };
  }

  saveUserWorkspace(userId: string, payload: WorkspaceSavePayload) {
    if (!this.db.users[userId]) {
      throw new Error('Unauthorized workspace write.');
    }
    const current = this.db.workspaces[userId] || emptyWorkspace();

    const sanitizedModels = Array.isArray(payload.models)
      ? payload.models.map((m) => {
          const copy = { ...m };
          delete copy.apiKey;
          copy.ownerUserId = userId;
          return copy;
        })
      : current.models;

    this.db.workspaces[userId] = {
      ...current,
      models: sanitizedModels,
      conversations: Array.isArray(payload.conversations) ? payload.conversations : current.conversations,
      folders: Array.isArray(payload.folders) ? payload.folders : current.folders,
      projects: Array.isArray(payload.projects) ? payload.projects : current.projects,
      snapshots: Array.isArray(payload.snapshots) ? payload.snapshots : current.snapshots,
      usageRecords: Array.isArray(payload.usageRecords) ? payload.usageRecords : current.usageRecords,
      settings: payload.settings !== undefined ? payload.settings : current.settings,
    };
    this.persistToDisk();
  }

  setUserSecret(userId: string, refId: string, plaintextSecret: string, _providerName?: string) {
    if (!this.db.users[userId]) throw new Error('Unauthorized vault access.');
    const ws = this.db.workspaces[userId] || (this.db.workspaces[userId] = emptyWorkspace());
    ws.vaultSecrets[refId] = encryptString(plaintextSecret);
    this.persistToDisk();
  }

  getUserSecret(userId: string, refId: string): string | undefined {
    const ws = this.db.workspaces[userId];
    if (!ws) return undefined;
    const enc = ws.vaultSecrets[refId];
    if (!enc) return undefined;
    return decryptString(enc) || undefined;
  }

  listUserSecretRefs(userId: string): Array<{ refId: string; maskedKey: string }> {
    const ws = this.db.workspaces[userId];
    if (!ws) return [];
    return Object.entries(ws.vaultSecrets).map(([refId, enc]) => {
      const plain = decryptString(enc);
      return {
        refId,
        maskedKey: plain ? maskKeyPreview(plain) : '••••••••',
      };
    });
  }

  deleteUserSecret(userId: string, refId: string) {
    const ws = this.db.workspaces[userId];
    if (!ws) return;
    if (refId in ws.vaultSecrets) {
      delete ws.vaultSecrets[refId];
      this.persistToDisk();
    }
  }

  setUserGitHubToken(userId: string, accessToken: string | null) {
    const ws = this.db.workspaces[userId];
    if (!ws) return;
    ws.githubEncryptedToken = accessToken ? encryptString(accessToken) : undefined;
    this.persistToDisk();
  }

  getUserGitHubToken(userId: string): string | null {
    const ws = this.db.workspaces[userId];
    if (!ws?.githubEncryptedToken) return null;
    return decryptString(ws.githubEncryptedToken);
  }

  saveUserBackup(
    userId: string,
    backup: { schemaVersion: number; checksum: string; payload: Record<string, unknown> }
  ): WorkspaceBackupSummary {
    if (!this.db.users[userId]) {
      throw new Error('Unauthorized backup write.');
    }
    const id = `bak_${crypto.randomBytes(8).toString('hex')}`;
    const createdAt = Date.now();
    const record: StoredBackupRow = {
      id,
      userId,
      schemaVersion: backup.schemaVersion,
      checksum: backup.checksum,
      payload: backup.payload,
      createdAt,
    };
    const existing = this.db.backups[userId] || [];
    this.db.backups[userId] = [record, ...existing].slice(0, 25);
    this.persistToDisk();
    return {
      id: record.id,
      userId: record.userId,
      schemaVersion: record.schemaVersion,
      checksum: record.checksum,
      createdAt: record.createdAt,
    };
  }

  listUserBackups(userId: string): WorkspaceBackupSummary[] {
    const items = this.db.backups[userId] || [];
    return items.map(({ id, userId: uId, schemaVersion, checksum, createdAt }) => ({
      id,
      userId: uId,
      schemaVersion,
      checksum,
      createdAt,
    }));
  }

  getUserBackupById(
    userId: string,
    backupId: string
  ): (WorkspaceBackupSummary & { payload: Record<string, unknown> }) | null {
    const items = this.db.backups[userId] || [];
    return items.find((b) => b.id === backupId && b.userId === userId) || null;
  }

  appendAuditLog(entry: {
    userId?: string | null;
    action: string;
    target: string;
    outcome: 'success' | 'denied' | 'error';
    metadata?: Record<string, unknown>;
  }) {
    this.db.auditLogs.push({
      id: `aud_${crypto.randomBytes(6).toString('hex')}`,
      userId: entry.userId ?? null,
      action: entry.action,
      target: entry.target,
      outcome: entry.outcome,
      metadata: entry.metadata,
      timestamp: Date.now(),
    });
    if (this.db.auditLogs.length > 500) {
      this.db.auditLogs = this.db.auditLogs.slice(-500);
    }
    this.persistToDisk();
  }
}

const allowDefaultMemoryStore =
  isIsolatedTestHarness() ||
  (process.env.NODE_ENV !== 'production' && process.env.OMNIAI_TEST_MEMORY_DB === 'true');

export const defaultMultiUserStore = new MultiUserStore(
  allowDefaultMemoryStore ? null : undefined
);
