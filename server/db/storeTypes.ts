export type MaybePromise<T> = T | Promise<T>;

export interface PublicUserRecord {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  createdAt: number;
}

export interface StoredUserRecord extends PublicUserRecord {
  passwordHash: string;
  updatedAt: number;
}

export interface UserSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  createdAt: number;
  revokedAt?: number | null;
}

export interface UserWorkspaceData {
  models: Array<Record<string, unknown>>;
  conversations: Array<Record<string, unknown>>;
  folders: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  snapshots: Array<Record<string, unknown>>;
  usageRecords: Array<Record<string, unknown>>;
  settings: Record<string, unknown> | null;
  vaultSecrets: Record<string, string>;
  githubEncryptedToken?: string;
}

export interface WorkspaceBackupSummary {
  id: string;
  userId: string;
  schemaVersion: number;
  checksum: string;
  createdAt: number;
}

export interface DatabaseHealthStatus {
  ok: boolean;
  productionReady: boolean;
  backend: 'postgres' | 'file' | 'memory' | 'unavailable';
  latencyMs: number;
  detail: string;
  migrations?: {
    appliedCount: number;
    pending: string[];
    upToDate: boolean;
  };
}

export type WorkspaceSavePayload = Partial<
  Pick<
    UserWorkspaceData,
    'models' | 'conversations' | 'folders' | 'projects' | 'snapshots' | 'usageRecords' | 'settings'
  >
>;

export interface UserWorkspaceStore {
  readonly backendType: 'postgres' | 'file' | 'memory';
  healthCheck(): Promise<DatabaseHealthStatus>;
  registerUser(params: {
    email: string;
    password: string;
    displayName: string;
  }): MaybePromise<PublicUserRecord>;
  authenticateUser(email: string, password: string): MaybePromise<PublicUserRecord | null>;
  getUserById(userId: string): MaybePromise<PublicUserRecord | null>;
  createSession(
    userId: string,
    ttlMs?: number
  ): MaybePromise<{ sessionId: string; expiresAt: number }>;
  validateSession(sessionId: string, userId: string): MaybePromise<PublicUserRecord | null>;
  revokeSession(sessionId: string): MaybePromise<void>;
  getUserWorkspace(userId: string): MaybePromise<UserWorkspaceData>;
  saveUserWorkspace(userId: string, payload: WorkspaceSavePayload): MaybePromise<void>;
  setUserSecret(
    userId: string,
    refId: string,
    plaintextSecret: string,
    providerName?: string
  ): MaybePromise<void>;
  getUserSecret(userId: string, refId: string): MaybePromise<string | undefined>;
  listUserSecretRefs(userId: string): MaybePromise<Array<{ refId: string; maskedKey: string }>>;
  deleteUserSecret(userId: string, refId: string): MaybePromise<void>;
  setUserGitHubToken(userId: string, accessToken: string | null): MaybePromise<void>;
  getUserGitHubToken(userId: string): MaybePromise<string | null>;
  saveUserBackup(
    userId: string,
    backup: { schemaVersion: number; checksum: string; payload: Record<string, unknown> }
  ): MaybePromise<WorkspaceBackupSummary>;
  listUserBackups(userId: string): MaybePromise<WorkspaceBackupSummary[]>;
  getUserBackupById(
    userId: string,
    backupId: string
  ): MaybePromise<(WorkspaceBackupSummary & { payload: Record<string, unknown> }) | null>;
  appendAuditLog(entry: {
    userId?: string | null;
    action: string;
    target: string;
    outcome: 'success' | 'denied' | 'error';
    metadata?: Record<string, unknown>;
  }): MaybePromise<void>;
}
