# OmniAI Studio — Production Deployment & Operations Guide

## 1. Runtime & System Requirements

- **Node.js**: v22 LTS or newer (verified on `v22.23.2` — supports native TypeScript stripping for `node server.ts`).
- **Database**: PostgreSQL 15 or 16+ for hosted multi-user deployments (`pg` connection pool + automatic transactional SQL migrations in `server/db/migrations/`).
- **Single-Instance Local Fallback (Optional)**: Set `ALLOW_LOCAL_FILE_DB=true` only for single-node local/personal server deployments persisting under `.omniai-data/`. Do not use `.omniai-data/` behind multi-instance load balancers.

## 2. Environment Variables & Key Stability

Create `.env` (or platform secret manager entries) based on `.env.example`. Validate configuration without exposing secrets before booting:

```bash
npm run validate:env -- --production
```

Required in Production (`NODE_ENV=production`):

| Variable | Requirement | Notes |
| :--- | :--- | :--- |
| `NODE_ENV` | `"production"` | Enables strict fail-fast startup checks, static `dist/` serving, and `Secure` cookies over HTTPS. |
| `APP_URL` | `https://your-domain.com` | Public HTTPS origin used for GitHub OAuth callbacks (`<APP_URL>/auth/callback`) and CORS validation. |
| `DATABASE_URL` | `postgresql://user:pass@host:5432/db` | Must point to a live PostgreSQL database (unless `ALLOW_LOCAL_FILE_DB=true`). |
| `DATABASE_SSL` | `"true"` / `"require"` (if TLS) | Required by most managed PostgreSQL providers (RDS, Cloud SQL, Neon, Supabase). |
| `OMNIAI_MASTER_KEY` | Random 32+ char string | Derives AES-256-GCM keys for HTTP-only encrypted cookies, DB credential vaults, and GitHub tokens. **Never** reuse `GEMINI_API_KEY` and **never** use placeholder values. |
| `SESSION_SECRET` | Random 32+ char string | Optional separate secret; defaults to `OMNIAI_MASTER_KEY`. |

Optional Provider & Integration Variables (leave unset if unused):

- `GEMINI_API_KEY`: Server-side Gemini fallback key (never exposed to frontend).
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`: Used by CLI verification (`npm run test:providers`) or optional server testing; users normally store keys per account in the encrypted vault.
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`: Required only for GitHub OAuth sign-in (`<APP_URL>/auth/callback`).
- `ALLOWED_ORIGINS`: Comma-separated list of additional trusted origins if serving frontend/desktop origins separately.
- `ALLOW_LOCAL_MODEL_URLS`: Keep `"false"` in production (only `"true"` on trusted local machines running Ollama/vLLM/LM Studio).

### Master Encryption Key Stability & Backup

All user API keys (`encrypted_credentials.encrypted_payload`) and GitHub OAuth tokens (`user_workspace_settings.github_encrypted_token`) are encrypted using `OMNIAI_MASTER_KEY`.

- **Restart persistence**: Keep `OMNIAI_MASTER_KEY` identical across deployments and container restarts. Changing or omitting it invalidates existing encrypted credentials in PostgreSQL.
- **Out-of-band backup**: Store `OMNIAI_MASTER_KEY` in a dedicated secret manager (e.g., GCP Secret Manager, AWS Secrets Manager, Vault) **separately** from database backups.

## 3. PostgreSQL Configuration, Setup & Disposable Test Database Guide

### Supported Versions & SSL Matrix

- **PostgreSQL Versions**: Tested SQL dialect (`BIGINT`, `JSONB`, partial `WHERE revoked_at IS NULL` indexes, `NUMERIC(12,6)`) is compatible with **PostgreSQL 14, 15, 16, and 17** (`postgres:16` in CI).
- **Driver**: `pg` `^8.23.1` with pooling (`max: 15`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 8000`) and automatic idle-error listener.
- **SSL Modes**:
  - Local Docker / localhost: `DATABASE_SSL="false"` (no SSL).
  - Managed Cloud PostgreSQL (RDS / Cloud SQL / Neon / Supabase): set `DATABASE_SSL="true"` (or `"require"`), or include `?sslmode=require` in the URL (`rejectUnauthorized: false`).
  - Strict CA Certificate Verification: set `DATABASE_SSL="verify-full"` or `DATABASE_SSL_REJECT_UNAUTHORIZED="true"` (or `?sslmode=verify-full` / `?sslmode=verify-ca`).

### Database URL Separation Safety Rule

- **`DATABASE_URL`**: Used by the running OmniAI Studio application (`npm run start`, `npm run db:migrate`).
- **`TEST_DATABASE_URL` / `SMOKE_DATABASE_URL`**: Dedicated **disposable** test database used by `npm run test:postgres`, `npm run test:postgres:release`, and `npm run test:smoke`.
- Destructive test suites explicitly refuse to run if `TEST_DATABASE_URL` or `SMOKE_DATABASE_URL` equals `DATABASE_URL`.

### Step-by-Step Disposable Test Database Provisioning

#### Option A — Docker Disposable PostgreSQL 16 (Recommended)

**Linux / macOS (Bash/Zsh):**
```bash
docker run -d --name omniai-pg-test \
  -e POSTGRES_USER=omniai_test \
  -e POSTGRES_PASSWORD=omniai_test_password \
  -e POSTGRES_DB=omniai_test \
  -p 5432:5432 \
  postgres:16

# Wait until healthy
until docker exec omniai-pg-test pg_isready -U omniai_test -d omniai_test; do sleep 1; done

export TEST_DATABASE_URL="postgresql://omniai_test:omniai_test_password@localhost:5432/omniai_test"
export SMOKE_DATABASE_URL="$TEST_DATABASE_URL"
export DATABASE_SSL="false"
```

**Windows PowerShell:**
```powershell
docker run -d --name omniai-pg-test `
  -e POSTGRES_USER=omniai_test `
  -e POSTGRES_PASSWORD=omniai_test_password `
  -e POSTGRES_DB=omniai_test `
  -p 5432:5432 `
  postgres:16

do { Start-Sleep -Seconds 1; docker exec omniai-pg-test pg_isready -U omniai_test -d omniai_test } while ($LASTEXITCODE -ne 0)

$env:TEST_DATABASE_URL = "postgresql://omniai_test:omniai_test_password@localhost:5432/omniai_test"
$env:SMOKE_DATABASE_URL = $env:TEST_DATABASE_URL
$env:DATABASE_SSL = "false"
```

#### Option B — Local Native PostgreSQL (15/16+)

Run once via `psql` as superuser (`postgres`):
```sql
CREATE USER omniai_test WITH PASSWORD 'omniai_test_password';
CREATE DATABASE omniai_test OWNER omniai_test;
```

Then set `TEST_DATABASE_URL` and `SMOKE_DATABASE_URL` as shown above.

### Executing Migrations & Live PostgreSQL Verification

Run the exact sequence against your disposable test database (`-- --test` targets `TEST_DATABASE_URL` cleanly without touching `DATABASE_URL`):

**Linux / macOS:**
```bash
npm run db:init -- --test
npm run db:migrate -- --test
npm run db:status -- --test
npm run db:health -- --test
npm run test:postgres
npm run test:postgres:release
npm run build && npm run test:smoke
```

**Windows PowerShell:**
```powershell
npm run db:init -- --test
npm run db:migrate -- --test
npm run db:status -- --test
npm run db:health -- --test
npm run test:postgres
npm run test:postgres:release
npm run build
if ($LASTEXITCODE -eq 0) { npm run test:smoke }
```

For production database migrations (`DATABASE_URL`):
```bash
npm run db:init
npm run db:migrate
npm run db:status
npm run db:health
```

## 4. HTTPS, Reverse Proxy & Cookie Security

Terminate TLS at your reverse proxy (Nginx, Caddy, Cloudflare, or Cloud Run) and forward `X-Forwarded-Proto: https` and `X-Forwarded-For` (`server.ts` enables `app.set('trust proxy', 1)`).

### Nginx Example (with SSE Streaming Support)

```nginx
server {
    listen 443 ssl http2;
    server_name omniai.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Required for SSE AI model streaming (/api/ai/chat)
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

- **Session Cookies**: `omniai_auth_session` is `HttpOnly`, `SameSite=Lax` (or `None; Secure` for cross-site iframe contexts), and automatically marks `Secure` when `req.secure` or `NODE_ENV=production`.
- **CORS**: `corsMiddleware` denies untrusted cross-origin credentialed requests and sets `Vary: Origin`, permitting only `APP_URL`, `ALLOWED_ORIGINS`, and local dev ports.

## 5. Build, Startup, Health Checks & Graceful Shutdown

```bash
npm ci --legacy-peer-deps
npm run validate:env -- --production
npm run db:migrate
npm run build
NODE_ENV=production npm run start
```

- **Readiness / Liveness Probe**: `GET /api/health`
  - Returns `200 OK` (`status: "ok"`, `productionReady: true`) **only** when PostgreSQL connectivity is live, all schema migrations are applied, production environment validation passes, and a valid non-ephemeral `OMNIAI_MASTER_KEY` is configured.
  - Returns `503 Service Unavailable` (`status: "degraded"`, `productionReady: false`) in production whenever PostgreSQL is unreachable/unconfigured, migrations are pending, encryption configuration is unsafe, or non-hosted local file/memory storage is active (`ALLOW_LOCAL_FILE_DB=true`).
  - `OMNIAI_TEST_MEMORY_DB=true` is rejected in `NODE_ENV=production` outside explicit isolated localhost test harnesses (`OMNIAI_ISOLATED_TEST_HARNESS=true` + recognized test runner). HTTP query parameters and headers cannot bypass this enforcement.
- **Graceful Shutdown**: Sending `SIGTERM` or `SIGINT` stops accepting new HTTP connections, waits up to 5 seconds for active requests/streams to close (`server_closed`), and exits cleanly.
- **Production Release Smoke Test & Full Release Gate**:
  ```bash
  export TEST_DATABASE_URL="postgresql://user:pass@host:5432/omniai_test"
  export SMOKE_DATABASE_URL="$TEST_DATABASE_URL"
  npm run build && npm run test:smoke
  npm run test:postgres:release
  npm run release:gate
  ```

## 6. Database Backup, Restore & Key Rotation Procedure

- **Backup**:
  ```bash
  pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" -f "omniai-backup-$(date +%Y%m%d-%H%M%S).dump"
  ```
- **Restore** (ensure `OMNIAI_MASTER_KEY` matches the environment where credentials were encrypted):
  ```bash
  pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" omniai-backup-YYYYMMDD-HHMMSS.dump
  npm run db:status
  npm run db:health
  ```
- **User-level JSON Backup**: Users can also export/restore FNV-1a checksummed workspace JSON archives from Settings (API secrets are stripped from JSON exports).

### Encryption Key Rotation & Loss Recovery Reality

1. Stored provider keys (`encrypted_credentials.encrypted_payload`) and GitHub tokens (`user_workspace_settings.github_encrypted_token`) are encrypted with AES-256-GCM using the SHA-256 digest of `OMNIAI_MASTER_KEY` (falling back to `SESSION_SECRET`).
2. **Rotating `OMNIAI_MASTER_KEY` without data loss**:
   - Currently there is no dual-key keyring; rotating `OMNIAI_MASTER_KEY` requires a maintenance window script that connects to PostgreSQL, decrypts each `encrypted_payload` and `github_encrypted_token` row using the **old** key, and re-encrypts/writes it with the **new** key before updating the deployment secret and restarting the server.
   - Wait to rotate `SESSION_SECRET` separately if you only wish to invalidate active HTTP session cookies (users simply sign in again).
3. **If `OMNIAI_MASTER_KEY` is lost without backup**:
   - Encrypted credentials and GitHub tokens cannot be decrypted (there is no recovery backdoor). Restore `OMNIAI_MASTER_KEY` from your out-of-band secret manager, or users must re-enter their provider API keys and reconnect GitHub OAuth.

