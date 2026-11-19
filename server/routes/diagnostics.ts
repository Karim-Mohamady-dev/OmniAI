import express from 'express';
import { isPlaceholderOrWeakSecret } from '../config/envValidator.ts';
import { inferCapabilitiesForModel } from '../adapters/capabilities.ts';
import { getAdapterForProtocol } from '../adapters/registry.ts';
import { validateExternalModelUrl } from '../middleware/security.ts';
import type {
  DiagnosticCategory,
  DiagnosticTestResult,
  ServerModelConfig,
} from '../types.ts';
import { sanitizeSecretFromText } from '../vault/secretVault.ts';
import { hydrateModelSecrets } from './ai.ts';

const router = express.Router();

// Tiny 1x1 transparent PNG (base64) for multimodal image-understanding diagnostics
const TINY_TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function hasValidCredential(model: ServerModelConfig): boolean {
  if (model.useServerEnvKey) {
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    return Boolean(geminiKey && !isPlaceholderOrWeakSecret(geminiKey));
  }
  if (model.apiKey && model.apiKey.trim().length > 0 && !isPlaceholderOrWeakSecret(model.apiKey)) {
    return true;
  }
  // Unauthenticated local endpoints (e.g. Ollama) or custom endpoints explicitly on localhost may omit keys
  if (model.baseUrl) {
    try {
      const u = new URL(model.baseUrl);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

export async function runDiagnosticSuiteForModels(params: {
  models: ServerModelConfig[];
  tests: DiagnosticCategory[];
  timeoutMs?: number;
}): Promise<DiagnosticTestResult[]> {
  const { models, tests, timeoutMs = 15000 } = params;
  const results: DiagnosticTestResult[] = [];
  const safeTimeout = Math.min(Math.max(timeoutMs, 3000), 45000);

  for (const model of models) {
    const caps = inferCapabilitiesForModel(model);
    const urlCheck = validateExternalModelUrl(model.baseUrl);

    if (!urlCheck.valid) {
      for (const test of tests) {
        if (test === 'fallback') continue;
        results.push({
          test,
          modelConfigId: model.id,
          modelDisplayName: model.displayName,
          providerName: model.providerName,
          status: 'FAILED',
          latencyMs: 0,
          detail: urlCheck.reason || 'Endpoint blocked by SSRF policy.',
          checkedAt: Date.now(),
        });
      }
      continue;
    }

    if (!hasValidCredential(model)) {
      for (const test of tests) {
        if (test === 'fallback') continue;
        results.push({
          test,
          modelConfigId: model.id,
          modelDisplayName: model.displayName,
          providerName: model.providerName,
          status: 'NOT CONFIGURED',
          latencyMs: 0,
          detail: model.useServerEnvKey
            ? 'Server GEMINI_API_KEY environment variable is not set.'
            : 'No API key configured for this provider.',
          checkedAt: Date.now(),
        });
      }
      continue;
    }

    const adapter = getAdapterForProtocol(model.protocol);

    for (const test of tests) {
      if (test === 'fallback') continue;
      const started = Date.now();
      const controller = new AbortController();

      try {
        if (test === 'text') {
          const res = await adapter.testConnection(model, safeTimeout);
          results.push({
            test,
            modelConfigId: model.id,
            modelDisplayName: model.displayName,
            providerName: model.providerName,
            status: res.ok ? 'PASSED' : 'FAILED',
            latencyMs: res.latencyMs,
            detail: sanitizeSecretFromText(res.message, [model.apiKey]),
            checkedAt: Date.now(),
          });
          continue;
        }

        if (test === 'streaming') {
          if (!caps.streaming) {
            results.push({
              test,
              modelConfigId: model.id,
              modelDisplayName: model.displayName,
              providerName: model.providerName,
              status: 'UNSUPPORTED',
              latencyMs: 0,
              detail: `${model.protocol} does not advertise SSE streaming.`,
              checkedAt: Date.now(),
            });
            continue;
          }
          let chunks = 0;
          let text = '';
          for await (const c of adapter.streamChat({
            model,
            messages: [{ role: 'user', content: 'Say "stream-ok" briefly.' }],
            signal: controller.signal,
            timeoutMs: safeTimeout,
          })) {
            if (c.delta) {
              chunks += 1;
              text += c.delta;
            }
          }
          results.push({
            test,
            modelConfigId: model.id,
            modelDisplayName: model.displayName,
            providerName: model.providerName,
            status: text.trim().length > 0 ? 'PASSED' : 'FAILED',
            latencyMs: Date.now() - started,
            detail:
              text.trim().length > 0
                ? `Received ${chunks} chunk(s), ${text.length} chars.`
                : 'Provider returned an empty stream.',
            checkedAt: Date.now(),
          });
          continue;
        }

        if (test === 'long-context') {
          if (!caps.longContext) {
            results.push({
              test,
              modelConfigId: model.id,
              modelDisplayName: model.displayName,
              providerName: model.providerName,
              status: 'UNSUPPORTED',
              latencyMs: 0,
              detail: 'Model does not advertise long-context (100k+) capability.',
              checkedAt: Date.now(),
            });
            continue;
          }
          const longFiller = Array.from({ length: 400 }, (_, i) => `seg-${i}: alpha`).join(' ');
          let out = '';
          for await (const c of adapter.streamChat({
            model,
            messages: [
              {
                role: 'user',
                content: `Read this sequence and reply ONLY with the final token index number:\n${longFiller}\nFINAL_TOKEN=400`,
              },
            ],
            signal: controller.signal,
            timeoutMs: safeTimeout,
          })) {
            if (c.delta) out += c.delta;
          }
          results.push({
            test,
            modelConfigId: model.id,
            modelDisplayName: model.displayName,
            providerName: model.providerName,
            status: out.trim().length > 0 ? 'PASSED' : 'FAILED',
            latencyMs: Date.now() - started,
            detail: out.trim() ? `Response: ${out.trim().slice(0, 60)}` : 'Empty long-context response.',
            checkedAt: Date.now(),
          });
          continue;
        }

        if (test === 'image') {
          if (!caps.vision && !caps.imageUnderstanding) {
            results.push({
              test,
              modelConfigId: model.id,
              modelDisplayName: model.displayName,
              providerName: model.providerName,
              status: 'UNSUPPORTED',
              latencyMs: 0,
              detail: 'Model does not advertise vision / image understanding.',
              checkedAt: Date.now(),
            });
            continue;
          }
          let out = '';
          for await (const c of adapter.streamChat({
            model,
            messages: [
              {
                role: 'user',
                content: 'Confirm you received this 1x1 test image by replying with "IMAGE_OK".',
                attachments: [
                  {
                    id: 'diag-img',
                    name: 'probe.png',
                    mimeType: 'image/png',
                    size: 68,
                    dataBase64: TINY_TEST_PNG_BASE64,
                  },
                ],
              },
            ],
            signal: controller.signal,
            timeoutMs: safeTimeout,
          })) {
            if (c.delta) out += c.delta;
          }
          results.push({
            test,
            modelConfigId: model.id,
            modelDisplayName: model.displayName,
            providerName: model.providerName,
            status: out.trim().length > 0 ? 'PASSED' : 'FAILED',
            latencyMs: Date.now() - started,
            detail: out.trim() ? `Multimodal reply (${out.trim().slice(0, 50)})` : 'Empty vision response.',
            checkedAt: Date.now(),
          });
          continue;
        }

        if (test === 'json') {
          if (!caps.jsonOutput) {
            results.push({
              test,
              modelConfigId: model.id,
              modelDisplayName: model.displayName,
              providerName: model.providerName,
              status: 'UNSUPPORTED',
              latencyMs: 0,
              detail: 'Model does not advertise structured JSON output.',
              checkedAt: Date.now(),
            });
            continue;
          }
          let out = '';
          for await (const c of adapter.streamChat({
            model,
            messages: [
              {
                role: 'user',
                content: 'Return ONLY valid raw JSON with keys {"status":"ok","count":1}. No markdown fences.',
              },
            ],
            signal: controller.signal,
            timeoutMs: safeTimeout,
          })) {
            if (c.delta) out += c.delta;
          }
          const cleaned = out.replace(/^```json\s*/i, '').replace(/^```|```$/g, '').trim();
          let validJson = false;
          try {
            const parsed = JSON.parse(cleaned);
            validJson = typeof parsed === 'object' && parsed !== null;
          } catch {
            validJson = false;
          }
          results.push({
            test,
            modelConfigId: model.id,
            modelDisplayName: model.displayName,
            providerName: model.providerName,
            status: validJson ? 'PASSED' : 'FAILED',
            latencyMs: Date.now() - started,
            detail: validJson ? 'Valid JSON object parsed.' : `Response was not valid JSON (${out.slice(0, 50)})`,
            checkedAt: Date.now(),
          });
          continue;
        }

        if (test === 'tool-calling') {
          if (!caps.toolCalling) {
            results.push({
              test,
              modelConfigId: model.id,
              modelDisplayName: model.displayName,
              providerName: model.providerName,
              status: 'UNSUPPORTED',
              latencyMs: 0,
              detail: 'Model does not advertise function/tool calling.',
              checkedAt: Date.now(),
            });
            continue;
          }
          // Probe structured tool invocation intent via deterministic schema response
          let out = '';
          for await (const c of adapter.streamChat({
            model,
            messages: [
              {
                role: 'user',
                content:
                  'You have tool get_weather(city: string). Respond ONLY with JSON {"tool":"get_weather","arguments":{"city":"London"}}.',
              },
            ],
            signal: controller.signal,
            timeoutMs: safeTimeout,
          })) {
            if (c.delta) out += c.delta;
          }
          const cleaned = out.replace(/^```json\s*/i, '').replace(/^```|```$/g, '').trim();
          let validTool = false;
          try {
            const parsed = JSON.parse(cleaned) as { tool?: string };
            validTool = parsed?.tool === 'get_weather';
          } catch {
            validTool = false;
          }
          results.push({
            test,
            modelConfigId: model.id,
            modelDisplayName: model.displayName,
            providerName: model.providerName,
            status: validTool ? 'PASSED' : 'FAILED',
            latencyMs: Date.now() - started,
            detail: validTool ? 'Tool-call structure verified.' : 'Did not emit expected tool call JSON.',
            checkedAt: Date.now(),
          });
        }
      } catch (err) {
        const msg = sanitizeSecretFromText(
          err instanceof Error ? err.message : String(err),
          [model.apiKey]
        );
        results.push({
          test,
          modelConfigId: model.id,
          modelDisplayName: model.displayName,
          providerName: model.providerName,
          status: 'FAILED',
          latencyMs: Date.now() - started,
          detail: msg,
          checkedAt: Date.now(),
        });
      }
    }
  }

  // Fallback readiness diagnostic: verify at least 2 enabled models have credentials & valid URLs
  if (tests.includes('fallback')) {
    const enabled = models.filter((m) => m.enabled);
    const configured = enabled.filter((m) => hasValidCredential(m) && validateExternalModelUrl(m.baseUrl).valid);
    results.push({
      test: 'fallback',
      modelConfigId: 'orchestrator',
      modelDisplayName: 'Multi-Model Orchestrator',
      providerName: 'OmniAI Router',
      status:
        configured.length >= 2
          ? 'PASSED'
          : configured.length === 1
            ? 'NOT CONFIGURED'
            : 'NOT CONFIGURED',
      latencyMs: 0,
      detail:
        configured.length >= 2
          ? `Automatic failover ready across ${configured.length} configured enabled model(s).`
          : `At least 2 enabled models with valid credentials are required for live failover (${configured.length} currently ready).`,
      checkedAt: Date.now(),
    });
  }

  return results;
}

router.post('/run', async (req, res) => {
  try {
    const { models, tests, timeoutMs } = req.body as {
      models?: ServerModelConfig[];
      tests?: DiagnosticCategory[];
      timeoutMs?: number;
    };

    if (!Array.isArray(models) || models.length === 0) {
      res.status(400).json({ error: 'Provide at least one model configuration to test.' });
      return;
    }

    const hydrated = await hydrateModelSecrets(req, models);
    const activeTests: DiagnosticCategory[] =
      Array.isArray(tests) && tests.length > 0
        ? tests
        : ['text', 'streaming', 'json', 'fallback'];

    const results = await runDiagnosticSuiteForModels({
      models: hydrated,
      tests: activeTests,
      timeoutMs,
    });

    res.json({
      ranAt: Date.now(),
      results,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Diagnostics run failed.',
    });
  }
});

export default router;
