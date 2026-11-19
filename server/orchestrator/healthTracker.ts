import { inferCapabilitiesForModel } from '../adapters/capabilities.ts';
import type {
  AdapterErrorKind,
  ModelCapabilities,
  RoutingMode,
  ServerModelConfig,
} from '../types.ts';

export interface TelemetrySample {
  ts: number;
  ok: boolean;
  latencyMs?: number;
  errorKind?: AdapterErrorKind;
}

export interface RuntimeHealthRecord {
  configId: string;
  consecutiveFailures: number;
  cooldownUntil: number;
  cooldownReason?: string;
  successCount: number;
  failureCount: number;
  lastLatencyMs?: number;
  averageLatencyMs?: number;
  lastUpdated: number;
  recentSamples: TelemetrySample[];
}

const MAX_SAMPLES_PER_MODEL = 30;
const runtimeHealth = new Map<string, RuntimeHealthRecord>();

export function computeCooldownDurationMs(
  errorKind: AdapterErrorKind,
  consecutiveFailures: number
): number {
  if (errorKind === 'AUTH_ERROR' || errorKind === 'INVALID_MODEL') {
    return 120_000;
  }
  if (errorKind === 'QUOTA_EXCEEDED') {
    return Math.min(300_000, 60_000 * Math.max(1, consecutiveFailures));
  }
  if (
    errorKind === 'RATE_LIMIT' ||
    errorKind === 'SERVER_ERROR' ||
    errorKind === 'TIMEOUT' ||
    errorKind === 'NETWORK'
  ) {
    if (consecutiveFailures < 2) return 15_000;
    return Math.min(300_000, 30_000 * Math.min(consecutiveFailures, 6));
  }
  return 0;
}

export function getEffectiveModelHealth(
  model: ServerModelConfig,
  now = Date.now()
): {
  inCooldown: boolean;
  cooldownUntil: number;
  consecutiveFailures: number;
  cooldownReason?: string;
} {
  const mem = runtimeHealth.get(model.id);
  const clientCooldown = model.cooldownUntil ?? 0;
  const memCooldown = mem?.cooldownUntil ?? 0;
  const cooldownUntil = Math.max(clientCooldown, memCooldown);
  const consecutiveFailures = Math.max(
    model.consecutiveFailures ?? 0,
    mem?.consecutiveFailures ?? 0
  );
  return {
    inCooldown: cooldownUntil > now,
    cooldownUntil: cooldownUntil > now ? cooldownUntil : 0,
    consecutiveFailures,
    cooldownReason: mem?.cooldownReason,
  };
}

export function recordModelAttemptSuccess(modelId: string, latencyMs: number, now = Date.now()) {
  const prev = runtimeHealth.get(modelId);
  const prevAvg = prev?.averageLatencyMs;
  const averageLatencyMs =
    typeof prevAvg === 'number' ? Math.round(prevAvg * 0.7 + latencyMs * 0.3) : Math.round(latencyMs);

  const recentSamples = [
    ...(prev?.recentSamples || []),
    { ts: now, ok: true, latencyMs: Math.round(latencyMs) },
  ].slice(-MAX_SAMPLES_PER_MODEL);

  const next: RuntimeHealthRecord = {
    configId: modelId,
    consecutiveFailures: 0,
    cooldownUntil: 0,
    cooldownReason: undefined,
    successCount: (prev?.successCount ?? 0) + 1,
    failureCount: prev?.failureCount ?? 0,
    lastLatencyMs: Math.round(latencyMs),
    averageLatencyMs,
    lastUpdated: now,
    recentSamples,
  };
  runtimeHealth.set(modelId, next);
  return next;
}

export function recordModelAttemptFailure(
  modelId: string,
  errorKind: AdapterErrorKind,
  reason: string,
  priorConsecutive = 0,
  now = Date.now(),
  latencyMs?: number
) {
  const prev = runtimeHealth.get(modelId);
  const consecutive = Math.max(prev?.consecutiveFailures ?? 0, priorConsecutive) + 1;
  const durationMs = computeCooldownDurationMs(errorKind, consecutive);
  const cooldownUntil = durationMs > 0 ? now + durationMs : 0;

  const recentSamples = [
    ...(prev?.recentSamples || []),
    {
      ts: now,
      ok: false,
      ...(typeof latencyMs === 'number' ? { latencyMs: Math.round(latencyMs) } : {}),
      errorKind,
    },
  ].slice(-MAX_SAMPLES_PER_MODEL);

  const next: RuntimeHealthRecord = {
    configId: modelId,
    consecutiveFailures: consecutive,
    cooldownUntil,
    cooldownReason: cooldownUntil > 0 ? `${errorKind}: ${reason}` : undefined,
    successCount: prev?.successCount ?? 0,
    failureCount: (prev?.failureCount ?? 0) + 1,
    lastLatencyMs: prev?.lastLatencyMs,
    averageLatencyMs: prev?.averageLatencyMs,
    lastUpdated: now,
    recentSamples,
  };
  runtimeHealth.set(modelId, next);
  return next;
}

export function clearModelCooldown(modelId: string) {
  const prev = runtimeHealth.get(modelId);
  if (prev) {
    prev.consecutiveFailures = 0;
    prev.cooldownUntil = 0;
    prev.cooldownReason = undefined;
  }
}

export function getAllModelHealthMetrics(): {
  generatedAt: number;
  totalSuccess: number;
  totalFailures: number;
  totalRequests: number;
  models: RuntimeHealthRecord[];
} {
  const records = Array.from(runtimeHealth.values()).map((r) => ({
    ...r,
    recentSamples: [...r.recentSamples],
  }));
  const totalSuccess = records.reduce((acc, r) => acc + r.successCount, 0);
  const totalFailures = records.reduce((acc, r) => acc + r.failureCount, 0);
  return {
    generatedAt: Date.now(),
    totalSuccess,
    totalFailures,
    totalRequests: totalSuccess + totalFailures,
    models: records,
  };
}

export function resetHealthTrackerForTests() {
  runtimeHealth.clear();
}

export function orderModelsWithHealthAndRoles(params: {
  models: ServerModelConfig[];
  routingMode: RoutingMode;
  requiredCapabilities?: Partial<ModelCapabilities>;
  hasImages?: boolean;
  preferredRole?: 'coding' | 'vision' | 'long-context';
  now?: number;
}): {
  ordered: ServerModelConfig[];
  skippedCooldownIds: string[];
  probingRecovery: boolean;
} {
  const {
    models,
    routingMode,
    requiredCapabilities,
    hasImages,
    preferredRole,
    now = Date.now(),
  } = params;

  const enabled = models.filter((m) => m.enabled);
  if (routingMode === 'manual') {
    return {
      ordered: enabled.slice(0, 1),
      skippedCooldownIds: [],
      probingRecovery: false,
    };
  }

  const needsVision = Boolean(
    hasImages || requiredCapabilities?.vision || requiredCapabilities?.imageUnderstanding
  );
  const needsJson = Boolean(requiredCapabilities?.jsonOutput);
  const needsTools = Boolean(requiredCapabilities?.toolCalling);
  const needsLongCtx = Boolean(requiredCapabilities?.longContext);

  const scoreModel = (m: ServerModelConfig) => {
    const caps = inferCapabilitiesForModel(m);
    const roles = new Set(m.roleTags || []);
    let s = 0;

    if (roles.has('preferred')) s += 25;
    if (preferredRole && roles.has(preferredRole)) s += 35;
    if (needsVision && roles.has('vision')) s += 30;
    if (needsLongCtx && roles.has('long-context')) s += 25;
    if (roles.has('backup')) s -= 10;

    if (routingMode === 'capability' || routingMode === 'auto' || hasImages || requiredCapabilities) {
      if (needsVision && (caps.vision || caps.imageUnderstanding)) s += 100;
      if (needsJson && caps.jsonOutput) s += 40;
      if (needsTools && caps.toolCalling) s += 40;
      if (needsLongCtx && caps.longContext) s += 30;
    }

    return s;
  };

  const healthy: ServerModelConfig[] = [];
  const cooling: Array<{ model: ServerModelConfig; until: number }> = [];

  for (const m of enabled) {
    const h = getEffectiveModelHealth(m, now);
    if (h.inCooldown) {
      cooling.push({ model: m, until: h.cooldownUntil });
    } else {
      healthy.push(m);
    }
  }

  const sortByScoreThenPriority = (list: ServerModelConfig[]) =>
    [...list].sort((a, b) => {
      if (routingMode === 'priority') {
        return a.priority - b.priority;
      }
      const diff = scoreModel(b) - scoreModel(a);
      return diff !== 0 ? diff : a.priority - b.priority;
    });

  if (healthy.length > 0) {
    const sortedHealthy = sortByScoreThenPriority(healthy);
    const sortedCooling = [...cooling]
      .sort((a, b) => a.until - b.until)
      .map((c) => c.model);
    return {
      ordered: [...sortedHealthy, ...sortedCooling],
      skippedCooldownIds: cooling.map((c) => c.model.id),
      probingRecovery: false,
    };
  }

  const recoveryOrdered = [...cooling]
    .sort((a, b) => a.until - b.until)
    .map((c) => c.model);

  return {
    ordered: recoveryOrdered,
    skippedCooldownIds: recoveryOrdered.map((m) => m.id),
    probingRecovery: recoveryOrdered.length > 0,
  };
}
