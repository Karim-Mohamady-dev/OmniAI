import express from 'express';
import { isPlaceholderOrWeakSecret } from '../config/envValidator.ts';
import { inferCapabilitiesForModel } from '../adapters/capabilities.ts';
import { getAdapterForProtocol } from '../adapters/registry.ts';
import { validateExternalModelUrl } from '../middleware/security.ts';
import { runOrchestratedChatStream } from '../orchestrator/aiOrchestrator.ts';
import {
  clearModelCooldown,
  getAllModelHealthMetrics,
  recordModelAttemptFailure,
  recordModelAttemptSuccess,
} from '../orchestrator/healthTracker.ts';
import type {
  ChatMessageInput,
  FallbackPolicy,
  ModelCapabilities,
  RoutingMode,
  ServerModelConfig,
} from '../types.ts';
import { resolveSecretForModel, sanitizeSecretFromText } from '../vault/secretVault.ts';

const router = express.Router();

const DEFAULT_POLICY: FallbackPolicy = {
  maxRetriesPerModel: 1,
  initialBackoffMs: 600,
  maxBackoffMs: 4000,
  timeoutMs: 45000,
};

export async function hydrateModelSecrets(
  req: express.Request,
  models: ServerModelConfig[]
): Promise<ServerModelConfig[]> {
  return Promise.all(
    models.map(async (m) => ({
      ...m,
      apiKey: m.useServerEnvKey
        ? undefined
        : await resolveSecretForModel(req, m.credentialRefId, m.apiKey),
    }))
  );
}

router.get('/capabilities', (_req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  res.json({
    serverGeminiConfigured: Boolean(geminiKey && !isPlaceholderOrWeakSecret(geminiKey)),
    supportedProtocols: ['google-gemini', 'openai-compatible', 'anthropic', 'custom-http'],
    routingModes: ['auto', 'manual', 'priority', 'capability', 'rules'],
  });
});

router.get('/metrics', (_req, res) => {
  res.json(getAllModelHealthMetrics());
});

router.post('/cooldown/reset', (req, res) => {
  const { configId } = req.body as { configId?: string };
  if (!configId) {
    res.status(400).json({ error: 'configId is required.' });
    return;
  }
  clearModelCooldown(configId);
  res.json({ ok: true, configId });
});

router.post('/test', async (req, res) => {
  try {
    const { model, timeoutMs } = req.body as {
      model?: ServerModelConfig;
      timeoutMs?: number;
    };

    if (!model || !model.protocol || !model.modelId) {
      res.status(400).json({
        ok: false,
        latencyMs: 0,
        message: 'Invalid model configuration. Model ID and protocol are required.',
      });
      return;
    }

    const urlCheck = validateExternalModelUrl(model.baseUrl);
    if (!urlCheck.valid) {
      res.status(400).json({
        ok: false,
        latencyMs: 0,
        errorKind: 'BAD_REQUEST',
        message: urlCheck.reason || 'Endpoint URL blocked by SSRF security policy.',
      });
      return;
    }

    const [hydrated] = await hydrateModelSecrets(req, [model]);
    const adapter = getAdapterForProtocol(hydrated.protocol);
    const result = await adapter.testConnection(
      hydrated,
      Math.min(Math.max(timeoutMs || 15000, 3000), 45000)
    );

    const safeMessage = sanitizeSecretFromText(result.message, [hydrated.apiKey]);
    if (result.ok) {
      clearModelCooldown(hydrated.id);
      recordModelAttemptSuccess(hydrated.id, result.latencyMs);
    } else if (result.errorKind) {
      recordModelAttemptFailure(
        hydrated.id,
        result.errorKind,
        safeMessage,
        hydrated.consecutiveFailures ?? 0,
        Date.now(),
        result.latencyMs
      );
    }

    res.json({
      ...result,
      message: safeMessage,
      detectedCapabilities: inferCapabilitiesForModel(hydrated),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      latencyMs: 0,
      message: err instanceof Error ? err.message : 'Unexpected connection test failure.',
    });
  }
});

router.post('/chat', async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished && !res.writableEnded) {
      controller.abort();
    }
  });

  try {
    const { models, messages, systemInstruction, policy, routingMode, requiredCapabilities } =
      req.body as {
        models?: ServerModelConfig[];
        messages?: ChatMessageInput[];
        systemInstruction?: string;
        policy?: Partial<FallbackPolicy>;
        routingMode?: RoutingMode;
        requiredCapabilities?: Partial<ModelCapabilities>;
      };

    if (!Array.isArray(models) || models.length === 0) {
      res.status(400).json({ error: 'At least one model configuration is required.' });
      return;
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'Messages array is required.' });
      return;
    }

    const hydratedModels = await hydrateModelSecrets(req, models);

    await runOrchestratedChatStream({
      res,
      models: hydratedModels,
      messages,
      systemInstruction,
      policy: { ...DEFAULT_POLICY, ...policy },
      routingMode: routingMode || 'auto',
      requiredCapabilities,
      signal: controller.signal,
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Orchestrator error',
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

export default router;
