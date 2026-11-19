# OmniAI Studio

Unified Multi-Model AI Platform, AI Development Environment & Windows/Cross-Platform Electron Desktop App built with React, TypeScript, Vite, Tailwind CSS v4, Monaco Editor, Recharts, Express, `esbuild`, and `@google/genai`.

## Architecture & Production Capabilities

- **Multi-Model Manager & Encrypted Server Key Vault**:
  - Manually configure unlimited AI models across **OpenAI-compatible**, **Google Gemini**, **Anthropic Messages**, and **Custom HTTP** endpoints.
  - Supports capability metadata (`text`, `streaming`, `vision`, `imageUnderstanding`, `toolCalling`, `jsonOutput`, `longContext`), role tags (`preferred`, `backup`, `coding`, `vision`, `long-context`), context window & max output token budgets, custom HTTP headers, custom optional $/1M token pricing rates, beginner 3-step Wizard + Advanced Form, and secret-free JSON export/import.
  - Client-entered API keys are stored in an **AES-256-GCM encrypted HTTP-only server credential vault** (`omniai_key_vault` cookie + per-user isolated backend vault) and referenced by opaque `credentialRefId` tokens.
- **Model Health Dashboard (Recharts) & Circuit-Breaker Orchestration**:
  - Real-time **Model Health Dashboard** inside Dashboard with Recharts latency bar charts, reliability distribution charts, live `/api/ai/metrics` sync, cooldown circuit-breaker countdowns with manual **Reset**, consecutive failure alerts, and per-model or batch **Test All Enabled** checks.
  - Automatic cooldown recovery probes and non-duplicating partial stream continuation on fallback (`Auto`, `Manual`, `Priority`, `Capability-Based`, `User-Defined Routing Rules`).
- **Live Provider Diagnostics & Usage Analytics**:
  - **Diagnostics Page**: Real-time verification matrix across `text`, `streaming`, `json`, `tool-calling`, `image`, `long-context`, and `fallback` with strict `NOT CONFIGURED`, `UNSUPPORTED`, `PASSED`, and `FAILED` reporting (never faked) plus secret-free JSON report export.
  - **Analytics Page**: Tracks token usage strictly separating `Provider-Reported` vs `Estimated` (~4 chars/token) vs `Cost Unavailable`, with filters by time window, provider, and project, inline custom token pricing entry, and CSV export.
- **PostgreSQL Multi-User Isolation, Migrations & Local Personal Mode**:
  - Operate in **Local Personal** mode (browser IndexedDB v3) or switch to **Hosted Multi-User** mode with scrypt password hashing, expiring signed HTTP-only session cookies, logout revocation, strict user-scoped authorization (`401`/`403` cross-tenant guards), and per-user encrypted credential vaults.
  - Supports **PostgreSQL** (`DATABASE_URL` + optional `DATABASE_SSL`) with automatic transactional SQL migrations (`server/db/migrations/001_multi_user_schema.sql`, `002_user_settings_and_github.sql`) tracked in `schema_migrations`, plus `ALLOW_LOCAL_FILE_DB` fallback (`.omniai-data/`) for local development.
  - Workspace backups include an **FNV-1a integrity checksum**, schema validation, path-traversal (`../`) rejection, and stripped credentials.
- **AI Development Studio, Supervisor Quality Gate & Local AI Agent**:
  - Three workflows (**Fast**, **Planning** with line-level diffs, **Agent**) plus persistent per-project AI instructions, cross-file code search, adjustable right panel width (`S`/`M`/`L`), automatic **Project Snapshots**, single-project `.json` archive export, and ZIP export.
  - **Independent Project Supervisor**: Combines deterministic static analysis (committed `.env`/secrets, broken relative imports, empty files, active build errors) with AI review to compute a **0–100 Health Score**, strict **Publish Quality Gate** (`PASS`, `WARNING`, `BLOCKED`), and finding evidence.
  - **Local AI Agent Drawer**: Granular permissions (`read-only`, `edit-files`, `run-commands`, `install-deps`, `delete-files`, `publish-github`), **Revoke All Permissions**, confirmation before `npm install`, timestamped local agent audit log, and **Open in System Browser**.
- **GitHub Integration & 9-Step Publish Wizard**:
  - Popup OAuth with encrypted HTTP-only `SameSite=None` cookies, branch creation, **Check Sync** diff, `409 Conflict` remote divergence protection, **9-step Guided Publish Wizard** (automatically excluding `.env`/key files), and **Desktop Local Git Console** (with pre-pull backup snapshots).
- **Windows Electron Desktop App (`desktop/`)**:
  - Context-isolated Electron main/preload runtime with SSRF & URL allowlists, workspace path confinement, recent folder tracking, toolchain detection (`node`/`npm`/`git`), port availability checks, and Windows NSIS + portable packaging scripts (`desktop/README.md` and `.github/workflows/windows-desktop.yml`).

## Environment Variables & Security Separation

Configure via `.env` (see `.env.example`) or platform secrets:

- `OMNIAI_MASTER_KEY` / `SESSION_SECRET` — **Required in production** (min 16 chars; 32+ random bytes recommended). Derives AES-256-GCM encryption keys for cookies and backend vaults. Never reuse `GEMINI_API_KEY`.
- `DATABASE_URL` — PostgreSQL connection string for hosted multi-user deployments. Migrations run transactionally on server startup.
- `DATABASE_SSL` — Set `"true"` (or `"require"`) when connecting to TLS-enforced PostgreSQL providers.
- `ALLOW_LOCAL_FILE_DB` — Allows local `.omniai-data/` JSON store fallback when `DATABASE_URL` is unset (defaults to enabled in dev).
- `GEMINI_API_KEY` — Optional server-side Google Gemini API key (never exposed to browser).
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — GitHub OAuth App credentials.
- `APP_URL` — Public application origin URL used for GitHub OAuth callbacks (`<APP_URL>/auth/callback`).
- `ALLOW_LOCAL_MODEL_URLS` — Set `"true"` only for local Ollama/vLLM/LM Studio endpoints (otherwise private/loopback URLs are blocked by the SSRF guard).
- `ALLOWED_ORIGINS` — Optional comma-separated trusted CORS origins for production.
- `PORT` / `NODE_ENV` — Server listen port (default `3000`) and runtime environment.

### GitHub OAuth Callback URLs

Register `<APP_URL>/auth/callback` in your GitHub OAuth App settings:
- Local development: `http://localhost:3000/auth/callback`
- Hosted preview/production examples:
  - `https://ais-dev-6cpsed3xskh7i4fil3qrqt-882908475066.europe-west2.run.app/auth/callback`
  - `https://ais-pre-6cpsed3xskh7i4fil3qrqt-882908475066.europe-west2.run.app/auth/callback`

## Running, Testing & Health Checks

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for full production deployment, reverse proxy, TLS, PostgreSQL backup/restore, and encryption key management procedures.

```bash
npm install
npm run dev
```

Verify Configuration, Database, Lint, Tests, Smoke Test & Build:

```bash
npm run validate:env            # Safe non-secret env diagnostic (add -- --production for strict mode)
npm run db:init                 # Verify PostgreSQL connectivity (add -- --test to target TEST_DATABASE_URL)
npm run db:migrate              # Apply pending transactional SQL migrations (add -- --test for TEST_DATABASE_URL)
npm run db:status               # Check applied vs pending migrations (add -- --test for TEST_DATABASE_URL)
npm run db:health               # Run PostgreSQL health probe (add -- --test for TEST_DATABASE_URL)
npm run lint                    # TypeScript check
npm test                        # Vitest backend, security, orchestrator, PostgreSQL & desktop suites
npm run test:e2e                # Playwright headless Chromium end-to-end suite (20 workflows)
npm run build                   # Production Vite SPA build -> dist/
npm run test:smoke              # Production release smoke test against built dist/ + real PostgreSQL test DB
npm run test:postgres:release   # 11-step live PostgreSQL release verification (requires TEST_DATABASE_URL)
npm run test:providers -- --mock # Provider verification matrix (--provider=gemini|openai|anthropic|custom-http for live)
npm run test:github             # GitHub OAuth & live API diagnostic
npm run release:gate            # Execute full 10-step release verification matrix with honest PASS/BLOCKED statuses
npm run start
```

Readiness & Health Endpoint:
```bash
curl -s http://localhost:3000/api/health
```
Returns `200 OK` (`productionReady: true`) in production **only** when PostgreSQL connectivity, migrations, production config validation, and non-ephemeral `OMNIAI_MASTER_KEY` are valid (`503` degraded otherwise; memory/file storage never reports production readiness).

Optional Live Vendor Integration Environment Variables (only needed when testing against live external services):
- `TEST_DATABASE_URL` / `SMOKE_DATABASE_URL`: Live disposable PostgreSQL database for migration, isolation & smoke tests (`npm run test:postgres`, `npm run test:postgres:release`, `npm run test:smoke`).
- `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`: Real model provider checks.
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_TEST_TOKEN`: Live GitHub OAuth & API checks.

## Windows Desktop Build & CI (`desktop/`)

```powershell
# 1. Build production web assets at repo root
npm install
npm run build

# 2. Install & compile Electron desktop shell
cd desktop
npm install
npm run build

# 3. Start backend server (Terminal 1 at repo root)
npm run dev

# 4. Launch Desktop app (Terminal 2 in desktop/)
$env:OMNIAI_DESKTOP_URL="http://localhost:3000"
npm start
```

For Windows `.exe` NSIS installer & portable builds (`desktop/release/`), run on Windows or trigger `.github/workflows/windows-desktop.yml` (`windows-latest`):

```powershell
cd desktop
npm run dist:unpacked
npm run package:win
```

## Troubleshooting

- **`/api/health` returns `503 degraded` in production**: Ensure `OMNIAI_MASTER_KEY` (or `SESSION_SECRET`) is >= 16 characters and `DATABASE_URL` is reachable (or set `ALLOW_LOCAL_FILE_DB=true` for single-instance disk persistence).
- **Local Ollama/vLLM returns SSRF `400`**: Set `ALLOW_LOCAL_MODEL_URLS=true` in `.env` and restart the server.
- **GitHub push returns `409 Conflict`**: Remote branch head changed after your last pull/push. Use **Check Sync** / **Pull Changes** (auto-snapshots local files first) or confirm overwrite.
- **Desktop Agent rejects command or file path**: Desktop runtime enforces path confinement (`resolveSafeProjectPath`) and command allowlists (`validateDesktopCommand`, blocking shell metacharacters and `.env`/`.git`/`node_modules` writes). See `desktop/README.md`.
