import crypto from 'crypto';
import { Pool } from 'pg';
import { decryptString, encryptString } from '../crypto.ts';
import { sanitizeSecretFromText } from '../vault/secretVault.ts';
import {
  getPostgresMigrationStatus,
  runPostgresMigrations,
  type MigrationStatusReport,
  type SqlPoolLike,
} from './migrate.ts';
import { hashPasswordScrypt, verifyPasswordScrypt } from './multiUserStore.ts';
import type {
  DatabaseHealthStatus,
  PublicUserRecord,
  UserWorkspaceData,
  UserWorkspaceStore,
  WorkspaceBackupSummary,
  WorkspaceSavePayload,
} from './storeTypes.ts';

function maskKeyPreview(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return 'Not set';
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
}

export function resolvePostgresSslOption(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env
): false | { rejectUnauthorized: boolean } {
  const dbSsl = (env.DATABASE_SSL || '').trim().toLowerCase();
  const pgSslMode = (env.PGSSLMODE || '').trim().toLowerCase();
  const lowerUrl = connectionString.toLowerCase();
  const strictVerify =
    env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' ||
    dbSsl === 'verify-full' ||
    dbSsl === 'verify-ca' ||
    pgSslMode === 'verify-full' ||
    pgSslMode === 'verify-ca' ||
    lowerUrl.includes('sslmode=verify-full') ||
    lowerUrl.includes('sslmode=verify-ca');

  const sslRequested =
    dbSsl === 'true' ||
    dbSsl === 'require' ||
    dbSsl === 'verify-full' ||
    dbSsl === 'verify-ca' ||
    pgSslMode === 'require' ||
    pgSslMode === 'verify-full' ||
    pgSslMode === 'verify-ca' ||
    lowerUrl.includes('sslmode=require') ||
    lowerUrl.includes('sslmode=verify-full') ||
    lowerUrl.includes('sslmode=verify-ca');

  if (!sslRequested) return false;
  return { rejectUnauthorized: strictVerify };
}

export function createPostgresPool(
  connectionString: string,
  options?: { max?: number; connectionTimeoutMillis?: number }
): Pool {
  const sslOpt = resolvePostgresSslOption(connectionString);
  const pool = new Pool({
    connectionString,
    max: options?.max ?? 15,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: options?.connectionTimeoutMillis ?? 8_000,
    ...(sslOpt ? { ssl: sslOpt } : {}),
  });
  pool.on('error', (err) => {
    console.error('[OmniAI PG Pool Error]', sanitizeSecretFromText(err.message, [connectionString]));
  });
  return pool;
}

export class PostgresMultiUserStore implements UserWorkspaceStore {
  readonly backendType = 'postgres' as const;
  private pool: SqlPoolLike;
  private ownsPool: boolean;
  private lastMigrationStatus: MigrationStatusReport | null = null;

  constructor(poolOrConnectionString: string | SqlPoolLike) {
    if (typeof poolOrConnectionString === 'string') {
      this.pool = createPostgresPool(poolOrConnectionString, {
        max: 15,
        connectionTimeoutMillis: 8_000,
      });
      this.ownsPool = true;
    } else {
      this.pool = poolOrConnectionString;
      this.ownsPool = false;
    }
  }

  async initialize(): Promise<MigrationStatusReport> {
    this.lastMigrationStatus = await runPostgresMigrations(this.pool);
    return this.lastMigrationStatus;
  }

  async close(): Promise<void> {
    if (this.ownsPool && 'end' in this.pool && typeof (this.pool as Pool).end === 'function') {
      await (this.pool as Pool).end();
    }
  }

  async healthCheck(): Promise<DatabaseHealthStatus> {
    const started = Date.now();
    try {
      await this.pool.query('SELECT 1 AS ok');
      const migStatus = await getPostgresMigrationStatus(this.pool);
      this.lastMigrationStatus = migStatus;
      return {
        ok: migStatus.upToDate,
        productionReady: migStatus.upToDate,
        backend: 'postgres',
        latencyMs: Date.now() - started,
        detail: migStatus.upToDate
          ? 'PostgreSQL connected and all schema migrations applied.'
          : `PostgreSQL connected with ${migStatus.pending.length} pending migration(s).`,
        migrations: {
          appliedCount: migStatus.applied.length,
          pending: migStatus.pending,
          upToDate: migStatus.upToDate,
        },
      };
    } catch (err) {
      return {
        ok: false,
        productionReady: false,
        backend: 'postgres',
        latencyMs: Date.now() - started,
        detail: sanitizeSecretFromText(
          err instanceof Error ? err.message : 'PostgreSQL health check failed.'
        ),
      };
    }
  }

  async registerUser(params: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<PublicUserRecord> {
    const normalizedEmail = params.email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new Error('A valid email address is required.');
    }
    if (!params.password || params.password.length < 8) {
      throw new Error('Password must be at least 8 characters long.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1 LIMIT 1',
        [normalizedEmail]
      );
      if (existing.rows.length > 0) {
        throw new Error('An account with this email already exists.');
      }

      const now = Date.now();
      const id = `usr_${crypto.randomBytes(8).toString('hex')}`;
      const displayName = params.displayName.trim() || normalizedEmail.split('@')[0];
      const passwordHash = hashPasswordScrypt(params.password);

      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'user', $5, $5)`,
        [id, normalizedEmail, displayName, passwordHash, now]
      );

      await client.query(
        `INSERT INTO user_workspace_settings (user_id, settings_json, updated_at)
         VALUES ($1, NULL, $2) ON CONFLICT (user_id) DO NOTHING`,
        [id, now]
      );

      await client.query('COMMIT');
      return {
        id,
        email: normalizedEmail,
        displayName,
        role: 'user',
        createdAt: now,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async authenticateUser(email: string, password: string): Promise<PublicUserRecord | null> {
    const normalizedEmail = email.trim().toLowerCase();
    const res = await this.pool.query<{
      id: string;
      email: string;
      display_name: string;
      password_hash: string;
      role: 'user' | 'admin';
      created_at: string | number;
    }>(
      'SELECT id, email, display_name, password_hash, role, created_at FROM users WHERE email = $1 LIMIT 1',
      [normalizedEmail]
    );
    const user = res.rows[0];
    if (!user) return null;
    if (!verifyPasswordScrypt(password, user.password_hash)) return null;
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      createdAt: Number(user.created_at),
    };
  }

  async getUserById(userId: string): Promise<PublicUserRecord | null> {
    const res = await this.pool.query<{
      id: string;
      email: string;
      display_name: string;
      role: 'user' | 'admin';
      created_at: string | number;
    }>('SELECT id, email, display_name, role, created_at FROM users WHERE id = $1 LIMIT 1', [
      userId,
    ]);
    const user = res.rows[0];
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      createdAt: Number(user.created_at),
    };
  }

  async createSession(
    userId: string,
    ttlMs: number = 7 * 24 * 60 * 60 * 1000
  ): Promise<{ sessionId: string; expiresAt: number }> {
    const now = Date.now();
    const sessionId = `ses_${crypto.randomBytes(16).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(sessionId).digest('hex');
    const expiresAt = now + ttlMs;

    await this.pool.query(
      `INSERT INTO user_sessions (id, user_id, token_hash, expires_at, created_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [sessionId, userId, tokenHash, expiresAt, now]
    );

    return { sessionId, expiresAt };
  }

  async validateSession(sessionId: string, userId: string): Promise<PublicUserRecord | null> {
    const tokenHash = crypto.createHash('sha256').update(sessionId).digest('hex');
    const now = Date.now();
    const res = await this.pool.query<{
      id: string;
      email: string;
      display_name: string;
      role: 'user' | 'admin';
      created_at: string | number;
    }>(
      `SELECT u.id, u.email, u.display_name, u.role, u.created_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1
         AND s.user_id = $2
         AND s.token_hash = $3
         AND s.revoked_at IS NULL
         AND s.expires_at > $4
       LIMIT 1`,
      [sessionId, userId, tokenHash, now]
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      createdAt: Number(row.created_at),
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.pool.query(
      'UPDATE user_sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL',
      [Date.now(), sessionId]
    );
  }

  async getUserWorkspace(userId: string): Promise<UserWorkspaceData> {
    const user = await this.getUserById(userId);
    if (!user) {
      throw new Error('Unauthorized user workspace lookup.');
    }

    const [modelsRes, foldersRes, convRes, projRes, snapRes, usageRes, settingsRes] =
      await Promise.all([
        this.pool.query<{ config_json: Record<string, unknown> }>(
          'SELECT config_json FROM user_models WHERE user_id = $1 ORDER BY priority ASC, created_at ASC',
          [userId]
        ),
        this.pool.query<{ id: string; name: string; created_at: string | number }>(
          'SELECT id, name, created_at FROM conversation_folders WHERE user_id = $1 ORDER BY created_at ASC',
          [userId]
        ),
        this.pool.query<{ payload_json: Record<string, unknown> }>(
          'SELECT payload_json FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC',
          [userId]
        ),
        this.pool.query<{ payload_json: Record<string, unknown> }>(
          'SELECT payload_json FROM projects WHERE user_id = $1 ORDER BY updated_at DESC',
          [userId]
        ),
        this.pool.query<{
          id: string;
          project_id: string;
          label: string;
          files_json: unknown;
          created_by: string;
          created_at: string | number;
        }>(
          'SELECT id, project_id, label, files_json, created_by, created_at FROM project_snapshots WHERE user_id = $1 ORDER BY created_at DESC',
          [userId]
        ),
        this.pool.query<{
          id: string;
          model_config_id: string;
          provider_name: string;
          context: string;
          project_id: string | null;
          conversation_id: string | null;
          input_tokens: number | null;
          output_tokens: number | null;
          total_tokens: number | null;
          token_source: string;
          estimated_cost_usd: string | number | null;
          cost_status: string;
          timestamp: string | number;
        }>('SELECT * FROM usage_records WHERE user_id = $1 ORDER BY timestamp DESC', [userId]),
        this.pool.query<{ settings_json: Record<string, unknown> | null }>(
          'SELECT settings_json FROM user_workspace_settings WHERE user_id = $1 LIMIT 1',
          [userId]
        ),
      ]);

    return {
      models: modelsRes.rows.map((r) => ({ ...r.config_json, ownerUserId: userId })),
      folders: foldersRes.rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: Number(r.created_at),
      })),
      conversations: convRes.rows.map((r) => r.payload_json),
      projects: projRes.rows.map((r) => r.payload_json),
      snapshots: snapRes.rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        label: r.label,
        files: r.files_json,
        createdBy: r.created_by,
        createdAt: Number(r.created_at),
      })),
      usageRecords: usageRes.rows.map((r) => ({
        id: r.id,
        modelConfigId: r.model_config_id,
        providerName: r.provider_name,
        context: r.context,
        projectId: r.project_id ?? undefined,
        conversationId: r.conversation_id ?? undefined,
        inputTokens: r.input_tokens ?? undefined,
        outputTokens: r.output_tokens ?? undefined,
        totalTokens: r.total_tokens ?? undefined,
        tokenSource: r.token_source,
        estimatedCostUsd: r.estimated_cost_usd !== null ? Number(r.estimated_cost_usd) : undefined,
        costStatus: r.cost_status,
        timestamp: Number(r.timestamp),
      })),
      settings: settingsRes.rows[0]?.settings_json ?? null,
      vaultSecrets: {},
    };
  }

  async saveUserWorkspace(userId: string, payload: WorkspaceSavePayload): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const userRes = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE id = $1 LIMIT 1',
        [userId]
      );
      if (userRes.rows.length === 0) {
        throw new Error('Unauthorized workspace write.');
      }

      const now = Date.now();

      if (Array.isArray(payload.models)) {
        await client.query('DELETE FROM user_models WHERE user_id = $1', [userId]);
        for (const m of payload.models) {
          const copy = { ...m };
          delete copy.apiKey;
          copy.ownerUserId = userId;
          const id = String(copy.id || `mdl_${crypto.randomBytes(6).toString('hex')}`);
          const priority = Number(copy.priority ?? 1) || 1;
          const enabled = copy.enabled !== false;
          const createdAt = Number(copy.createdAt ?? now) || now;
          const updatedAt = Number(copy.updatedAt ?? now) || now;
          await client.query(
            `INSERT INTO user_models (id, user_id, config_json, priority, enabled, created_at, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
            [id, userId, JSON.stringify(copy), priority, enabled, createdAt, updatedAt]
          );
        }
      }

      if (Array.isArray(payload.folders)) {
        await client.query('DELETE FROM conversation_folders WHERE user_id = $1', [userId]);
        for (const f of payload.folders) {
          const id = String(f.id || `fld_${crypto.randomBytes(6).toString('hex')}`);
          const name = String(f.name || 'Folder');
          const createdAt = Number(f.createdAt ?? now) || now;
          await client.query(
            `INSERT INTO conversation_folders (id, user_id, name, created_at)
             VALUES ($1, $2, $3, $4)`,
            [id, userId, name, createdAt]
          );
        }
      }

      if (Array.isArray(payload.conversations)) {
        const folderRows = await client.query<{ id: string }>(
          'SELECT id FROM conversation_folders WHERE user_id = $1',
          [userId]
        );
        const validFolderIds = new Set(folderRows.rows.map((r) => r.id));

        await client.query('DELETE FROM conversations WHERE user_id = $1', [userId]);
        for (const c of payload.conversations) {
          const id = String(c.id || `conv_${crypto.randomBytes(6).toString('hex')}`);
          const rawFolderId = typeof c.folderId === 'string' ? c.folderId : null;
          const folderId = rawFolderId && validFolderIds.has(rawFolderId) ? rawFolderId : null;
          const title = String(c.title || 'Untitled Conversation');
          const createdAt = Number(c.createdAt ?? now) || now;
          const updatedAt = Number(c.updatedAt ?? now) || now;
          await client.query(
            `INSERT INTO conversations (id, user_id, folder_id, title, payload_json, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
            [id, userId, folderId, title, JSON.stringify(c), createdAt, updatedAt]
          );
        }
      }

      if (Array.isArray(payload.projects)) {
        await client.query('DELETE FROM projects WHERE user_id = $1', [userId]);
        for (const p of payload.projects) {
          const id = String(p.id || `proj_${crypto.randomBytes(6).toString('hex')}`);
          const name = String(p.name || 'Untitled Project');
          const framework = String(p.framework || 'react-vite');
          const createdAt = Number(p.createdAt ?? now) || now;
          const updatedAt = Number(p.updatedAt ?? now) || now;
          await client.query(
            `INSERT INTO projects (id, user_id, name, framework, payload_json, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
            [id, userId, name, framework, JSON.stringify(p), createdAt, updatedAt]
          );
        }
      }

      if (Array.isArray(payload.snapshots)) {
        const projRows = await client.query<{ id: string }>(
          'SELECT id FROM projects WHERE user_id = $1',
          [userId]
        );
        const validProjectIds = new Set(projRows.rows.map((r) => r.id));

        await client.query('DELETE FROM project_snapshots WHERE user_id = $1', [userId]);
        for (const s of payload.snapshots) {
          const projectId = String(s.projectId || '');
          if (!validProjectIds.has(projectId)) continue;
          const id = String(s.id || `snap_${crypto.randomBytes(6).toString('hex')}`);
          const label = String(s.label || 'Snapshot');
          const filesJson = JSON.stringify(Array.isArray(s.files) ? s.files : []);
          const createdBy = String(s.createdBy || 'user');
          const createdAt = Number(s.createdAt ?? now) || now;
          await client.query(
            `INSERT INTO project_snapshots (id, user_id, project_id, label, files_json, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
            [id, userId, projectId, label, filesJson, createdBy, createdAt]
          );
        }
      }

      if (Array.isArray(payload.usageRecords)) {
        await client.query('DELETE FROM usage_records WHERE user_id = $1', [userId]);
        for (const u of payload.usageRecords) {
          const id = String(u.id || `usg_${crypto.randomBytes(6).toString('hex')}`);
          await client.query(
            `INSERT INTO usage_records (
               id, user_id, model_config_id, provider_name, context, project_id, conversation_id,
               input_tokens, output_tokens, total_tokens, token_source, estimated_cost_usd, cost_status, timestamp
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
              id,
              userId,
              String(u.modelConfigId || ''),
              String(u.providerName || ''),
              String(u.context || 'chat'),
              u.projectId ? String(u.projectId) : null,
              u.conversationId ? String(u.conversationId) : null,
              typeof u.inputTokens === 'number' ? u.inputTokens : null,
              typeof u.outputTokens === 'number' ? u.outputTokens : null,
              typeof u.totalTokens === 'number' ? u.totalTokens : null,
              String(u.tokenSource || 'unavailable'),
              typeof u.estimatedCostUsd === 'number' ? u.estimatedCostUsd : null,
              String(u.costStatus || 'unavailable'),
              Number(u.timestamp ?? now) || now,
            ]
          );
        }
      }

      if (payload.settings !== undefined) {
        await client.query(
          `INSERT INTO user_workspace_settings (user_id, settings_json, updated_at)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (user_id)
           DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = EXCLUDED.updated_at`,
          [userId, payload.settings ? JSON.stringify(payload.settings) : null, now]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async setUserSecret(
    userId: string,
    refId: string,
    plaintextSecret: string,
    providerName: string = 'custom'
  ): Promise<void> {
    const encrypted = encryptString(plaintextSecret);
    const masked = maskKeyPreview(plaintextSecret);
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO encrypted_credentials (id, user_id, provider_name, encrypted_payload, masked_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (id)
       DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload,
                     masked_key = EXCLUDED.masked_key,
                     updated_at = EXCLUDED.updated_at
       WHERE encrypted_credentials.user_id = $2`,
      [refId, userId, providerName, encrypted, masked, now]
    );
  }

  async getUserSecret(userId: string, refId: string): Promise<string | undefined> {
    const res = await this.pool.query<{ encrypted_payload: string }>(
      'SELECT encrypted_payload FROM encrypted_credentials WHERE id = $1 AND user_id = $2 LIMIT 1',
      [refId, userId]
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return decryptString(row.encrypted_payload) || undefined;
  }

  async listUserSecretRefs(userId: string): Promise<Array<{ refId: string; maskedKey: string }>> {
    const res = await this.pool.query<{ id: string; masked_key: string }>(
      'SELECT id, masked_key FROM encrypted_credentials WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return res.rows.map((r) => ({ refId: r.id, maskedKey: r.masked_key }));
  }

  async deleteUserSecret(userId: string, refId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM encrypted_credentials WHERE id = $1 AND user_id = $2',
      [refId, userId]
    );
  }

  async setUserGitHubToken(userId: string, accessToken: string | null): Promise<void> {
    const encrypted = accessToken ? encryptString(accessToken) : null;
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO user_workspace_settings (user_id, github_encrypted_token, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id)
       DO UPDATE SET github_encrypted_token = EXCLUDED.github_encrypted_token, updated_at = EXCLUDED.updated_at`,
      [userId, encrypted, now]
    );
  }

  async getUserGitHubToken(userId: string): Promise<string | null> {
    const res = await this.pool.query<{ github_encrypted_token: string | null }>(
      'SELECT github_encrypted_token FROM user_workspace_settings WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    const enc = res.rows[0]?.github_encrypted_token;
    if (!enc) return null;
    return decryptString(enc);
  }

  async saveUserBackup(
    userId: string,
    backup: { schemaVersion: number; checksum: string; payload: Record<string, unknown> }
  ): Promise<WorkspaceBackupSummary> {
    const id = `bak_${crypto.randomBytes(8).toString('hex')}`;
    const createdAt = Date.now();
    await this.pool.query(
      `INSERT INTO workspace_backups (id, user_id, schema_version, checksum, payload_json, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [id, userId, backup.schemaVersion, backup.checksum, JSON.stringify(backup.payload), createdAt]
    );
    return {
      id,
      userId,
      schemaVersion: backup.schemaVersion,
      checksum: backup.checksum,
      createdAt,
    };
  }

  async listUserBackups(userId: string): Promise<WorkspaceBackupSummary[]> {
    const res = await this.pool.query<{
      id: string;
      user_id: string;
      schema_version: number;
      checksum: string;
      created_at: string | number;
    }>(
      'SELECT id, user_id, schema_version, checksum, created_at FROM workspace_backups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25',
      [userId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      schemaVersion: Number(r.schema_version),
      checksum: r.checksum,
      createdAt: Number(r.created_at),
    }));
  }

  async getUserBackupById(
    userId: string,
    backupId: string
  ): Promise<(WorkspaceBackupSummary & { payload: Record<string, unknown> }) | null> {
    const res = await this.pool.query<{
      id: string;
      user_id: string;
      schema_version: number;
      checksum: string;
      payload_json: Record<string, unknown>;
      created_at: string | number;
    }>(
      'SELECT id, user_id, schema_version, checksum, payload_json, created_at FROM workspace_backups WHERE id = $1 AND user_id = $2 LIMIT 1',
      [backupId, userId]
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      userId: r.user_id,
      schemaVersion: Number(r.schema_version),
      checksum: r.checksum,
      payload: r.payload_json,
      createdAt: Number(r.created_at),
    };
  }

  async appendAuditLog(entry: {
    userId?: string | null;
    action: string;
    target: string;
    outcome: 'success' | 'denied' | 'error';
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool
      .query(
        `INSERT INTO audit_logs (id, user_id, action, target, outcome, metadata_json, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          `aud_${crypto.randomBytes(6).toString('hex')}`,
          entry.userId ?? null,
          entry.action,
          entry.target,
          entry.outcome,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          Date.now(),
        ]
      )
      .catch(() => {
        // Non-fatal if audit log write fails
      });
  }
}
