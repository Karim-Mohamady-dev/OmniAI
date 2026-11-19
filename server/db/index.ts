import { isIsolatedTestHarness } from '../config/envValidator.ts';
import { defaultMultiUserStore } from './multiUserStore.ts';
import { PostgresMultiUserStore } from './postgresStore.ts';
import type { DatabaseHealthStatus, UserWorkspaceStore } from './storeTypes.ts';

let activeStore: UserWorkspaceStore = defaultMultiUserStore;
let pgStoreInstance: PostgresMultiUserStore | null = null;
let databaseUnavailableError: string | null = null;
let initialized = false;

export function isProductionHostedDatabaseRequired(): boolean {
  return (
    process.env.NODE_ENV === 'production' &&
    process.env.ALLOW_LOCAL_FILE_DB !== 'true' &&
    !isIsolatedTestHarness()
  );
}

export async function initializeActiveStore(): Promise<DatabaseHealthStatus> {
  if (initialized && pgStoreInstance) {
    return getDatabaseHealthStatus();
  }

  const isProd = process.env.NODE_ENV === 'production';
  const isolatedHarness = isIsolatedTestHarness();

  if (isProd && process.env.OMNIAI_TEST_MEMORY_DB === 'true' && !isolatedHarness) {
    databaseUnavailableError =
      'OMNIAI_TEST_MEMORY_DB=true cannot be used in production outside an isolated localhost test harness.';
    pgStoreInstance = null;
    initialized = true;
    return {
      ok: false,
      productionReady: false,
      backend: 'unavailable',
      latencyMs: 0,
      detail: databaseUnavailableError,
    };
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  const requireProdDb = isProductionHostedDatabaseRequired();

  if (!isolatedHarness && databaseUrl && databaseUrl !== 'postgresql://user:password@localhost:5432/omniai') {
    try {
      const pgStore = new PostgresMultiUserStore(databaseUrl);
      const migStatus = await pgStore.initialize();
      pgStoreInstance = pgStore;
      activeStore = pgStore;
      databaseUnavailableError = null;
      initialized = true;
      return {
        ok: migStatus.upToDate,
        productionReady: migStatus.upToDate,
        backend: 'postgres',
        latencyMs: 0,
        detail: migStatus.upToDate
          ? 'PostgreSQL connected and migrations verified.'
          : `PostgreSQL connected with ${migStatus.pending.length} pending migration(s).`,
        migrations: {
          appliedCount: migStatus.applied.length,
          pending: migStatus.pending,
          upToDate: migStatus.upToDate,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'PostgreSQL initialization failed.';
      if (requireProdDb) {
        databaseUnavailableError = `Production database unavailable: ${message}`;
        pgStoreInstance = null;
        initialized = true;
        return {
          ok: false,
          productionReady: false,
          backend: 'unavailable',
          latencyMs: 0,
          detail: databaseUnavailableError,
        };
      }
      console.warn('[OmniAI DB] PostgreSQL unavailable in non-strict mode, falling back to local store:', message);
      activeStore = defaultMultiUserStore;
      databaseUnavailableError = null;
      initialized = true;
      return activeStore.healthCheck();
    }
  }

  if (requireProdDb) {
    databaseUnavailableError =
      'DATABASE_URL is required in production (or set ALLOW_LOCAL_FILE_DB=true for non-hosted single-node local persistence).';
    pgStoreInstance = null;
    initialized = true;
    return {
      ok: false,
      productionReady: false,
      backend: 'unavailable',
      latencyMs: 0,
      detail: databaseUnavailableError,
    };
  }

  activeStore = defaultMultiUserStore;
  databaseUnavailableError = null;
  initialized = true;
  return activeStore.healthCheck();
}

export function getActiveStore(): UserWorkspaceStore {
  return activeStore;
}

export function getDatabaseUnavailableReason(): string | null {
  return databaseUnavailableError;
}

export async function getDatabaseHealthStatus(): Promise<DatabaseHealthStatus> {
  if (databaseUnavailableError) {
    return {
      ok: false,
      productionReady: false,
      backend: 'unavailable',
      latencyMs: 0,
      detail: databaseUnavailableError,
    };
  }
  return activeStore.healthCheck();
}
