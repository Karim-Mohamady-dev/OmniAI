import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isIsolatedTestHarness, validateEnvironmentConfig } from './server/config/envValidator.ts';
import { getCryptoStatus } from './server/crypto.ts';
import { initializeActiveStore } from './server/db/index.ts';
import { buildHealthSnapshot } from './server/health.ts';
import {
  corsMiddleware,
  createRateLimiter,
  securityHeadersMiddleware,
  structuredRequestLogger,
} from './server/middleware/security.ts';
import aiRouter from './server/routes/ai.ts';
import authRouter, { attachAuthUserMiddleware } from './server/routes/auth.ts';
import diagnosticsRouter from './server/routes/diagnostics.ts';
import githubRouter from './server/routes/github.ts';
import previewRouter from './server/routes/preview.ts';
import vaultRouter from './server/routes/vault.ts';
import workspaceRouter from './server/routes/workspace.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function createServer() {
  const envReport = validateEnvironmentConfig();
  const initialDbStatus = await initializeActiveStore();
  const initialCryptoStatus = getCryptoStatus();
  const isolatedHarness = isIsolatedTestHarness();
  const isStrictProduction = process.env.NODE_ENV === 'production' && !isolatedHarness;

  if (
    isStrictProduction &&
    (!envReport.valid ||
      !initialDbStatus.ok ||
      (initialDbStatus.backend !== 'postgres' && process.env.ALLOW_LOCAL_FILE_DB !== 'true') ||
      !initialCryptoStatus.productionSafe)
  ) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'fatal_startup_config_error',
        envValid: envReport.valid,
        envErrors: envReport.errors,
        databaseOk: initialDbStatus.ok,
        databaseBackend: initialDbStatus.backend,
        databaseDetail: initialDbStatus.detail,
        cryptoProductionSafe: initialCryptoStatus.productionSafe,
        cryptoSource: initialCryptoStatus.source,
      })
    );
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production' && isolatedHarness && !initialCryptoStatus.productionSafe) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'fatal_startup_crypto_error',
        cryptoProductionSafe: initialCryptoStatus.productionSafe,
        cryptoSource: initialCryptoStatus.source,
      })
    );
    process.exit(1);
  }

  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.set('trust proxy', 1);
  app.use(securityHeadersMiddleware);
  app.use(corsMiddleware);
  app.use(structuredRequestLogger);
  app.use(cookieParser());
  app.use(express.json({ limit: '15mb' }));
  app.use(attachAuthUserMiddleware());

  const aiRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });
  const previewRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 120 });

  // Health & readiness endpoint with storage backend, migration, encryption, and provider readiness reporting
  app.get('/api/health', async (req, res) => {
    const snapshot = await buildHealthSnapshot(req.requestId);
    res.status(snapshot.httpStatus).json(snapshot.body);
  });

  // Backend Auth, Workspace, Vault, AI Orchestration, Diagnostics, Preview & GitHub OAuth routes
  app.use('/api/auth', authRouter);
  app.use('/api/workspace', workspaceRouter);
  app.use('/api/vault', vaultRouter);
  app.use('/api/ai', aiRateLimiter, aiRouter);
  app.use('/api/diagnostics', aiRateLimiter, diagnosticsRouter);
  app.use('/api/preview', previewRateLimiter, previewRouter);
  app.use(githubRouter);

  const distDir = path.resolve(__dirname, 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(distDir);

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : undefined,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'server_started',
        port: PORT,
        mode: isProd ? 'production' : 'development',
        databaseBackend: initialDbStatus.backend,
        databaseOk: initialDbStatus.ok,
      })
    );
  });

  const shutdown = (signal: string) => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'shutdown_initiated', signal }));
    server.close(() => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'server_closed' }));
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

createServer().catch((err) => {
  console.error('Failed to start OmniAI Studio server:', err);
  process.exit(1);
});
