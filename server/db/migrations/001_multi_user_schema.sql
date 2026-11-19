-- OmniAI Studio Multi-User Production PostgreSQL Schema (Migration 001)
-- Enforces strict per-user isolation across credentials, workspaces, projects, conversations, usage, and backups.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS encrypted_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_name TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  masked_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_encrypted_credentials_user_id ON encrypted_credentials(user_id);

CREATE TABLE IF NOT EXISTS user_models (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config_json JSONB NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_models_user_id ON user_models(user_id);

CREATE TABLE IF NOT EXISTS conversation_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES conversation_folders(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  framework TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  files_json JSONB NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_snapshots_user_project ON project_snapshots(user_id, project_id);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_config_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  context TEXT NOT NULL,
  project_id TEXT,
  conversation_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  token_source TEXT NOT NULL,
  estimated_cost_usd NUMERIC(12, 6),
  cost_status TEXT NOT NULL,
  timestamp BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_records_user_ts ON usage_records(user_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS workspace_backups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_backups_user_id ON workspace_backups(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  outcome TEXT NOT NULL,
  metadata_json JSONB,
  timestamp BIGINT NOT NULL
);
