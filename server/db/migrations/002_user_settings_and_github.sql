-- OmniAI Studio Multi-User Production PostgreSQL Schema (Migration 002)
-- Adds persistent per-user workspace settings, encrypted GitHub token storage, and session revocation tracking.

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS revoked_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_user_sessions_active
  ON user_sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS user_workspace_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json JSONB,
  github_encrypted_token TEXT,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_ts
  ON audit_logs(user_id, timestamp DESC);
