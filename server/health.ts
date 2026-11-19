import { isIsolatedTestHarness, validateEnvironmentConfig } from './config/envValidator.ts';
import { getCryptoStatus } from './crypto.ts';
import { getDatabaseHealthStatus } from './db/index.ts';

export async function buildHealthSnapshot(requestId?: string) {
  const db = await getDatabaseHealthStatus();
  const cryptoStatus = getCryptoStatus();
  const currentEnvReport = validateEnvironmentConfig();
  const isolatedHarness = isIsolatedTestHarness();
  const mode = process.env.NODE_ENV || 'development';
  const isProd = mode === 'production';

  const isProdPostgresHealthy =
    db.ok &&
    db.backend === 'postgres' &&
    db.productionReady &&
    cryptoStatus.productionSafe &&
    currentEnvReport.valid;

  let httpStatus = 503;
  let status: 'ok' | 'test-harness' | 'degraded' = 'degraded';

  if (isProd) {
    if (isolatedHarness) {
      if (db.ok && cryptoStatus.productionSafe && currentEnvReport.valid) {
        httpStatus = 200;
        status = 'test-harness';
      }
    } else if (isProdPostgresHealthy) {
      httpStatus = 200;
      status = 'ok';
    }
  } else {
    if (db.ok && cryptoStatus.productionSafe) {
      httpStatus = 200;
      status = 'ok';
    }
  }

  const mem = process.memoryUsage();
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  const githubOAuthConfigured = Boolean(
    clientId &&
      clientSecret &&
      clientId !== 'YOUR_GITHUB_CLIENT_ID' &&
      clientSecret !== 'YOUR_GITHUB_CLIENT_SECRET'
  );
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const serverGeminiConfigured = Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY');

  return {
    httpStatus,
    body: {
      status,
      service: 'OmniAI Studio',
      requestId,
      mode,
      activeBackend: db.backend,
      productionReady: isProdPostgresHealthy,
      isolatedTestHarness: isolatedHarness,
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      database: db,
      crypto: cryptoStatus,
      config: {
        valid: currentEnvReport.valid,
        errorCount: currentEnvReport.errors.length,
        warningCount: currentEnvReport.warnings.length,
      },
      providers: {
        serverGeminiConfigured,
        githubOAuthConfigured,
      },
      process: {
        rssMb: Number((mem.rss / (1024 * 1024)).toFixed(1)),
        heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
      },
    },
  };
}
