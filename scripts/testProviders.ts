import dotenv from 'dotenv';
import http from 'http';
import type { Response } from 'express';
import { isPlaceholderOrWeakSecret } from '../server/config/envValidator.ts';
import { getAdapterForProtocol } from '../server/adapters/registry.ts';
import { clearModelCooldown } from '../server/orchestrator/healthTracker.ts';
import { runOrchestratedChatStream } from '../server/orchestrator/aiOrchestrator.ts';
import type { ServerModelConfig } from '../server/types.ts';
import { sanitizeSecretFromText } from '../server/vault/secretVault.ts';

dotenv.config();

type ProviderFlag = 'gemini' | 'openai' | 'anthropic' | 'custom-http';
type CheckStatus = 'REAL PASS' | 'REAL FAIL' | 'MOCK VERIFIED' | 'NOT CONFIGURED' | 'SKIPPED';

interface CheckRow {
  provider: ProviderFlag | 'orchestrator';
  check: string;
  status: CheckStatus;
  latencyMs: number;
  detail: string;
}

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function parseArgs() {
  const args = process.argv.slice(2);
  let providerFilter: ProviderFlag | 'all' = 'all';
  let mockMode = false;
  let timeoutMs = 20_000;

  for (const a of args) {
    if (a.startsWith('--provider=')) {
      const val = a.slice('--provider='.length).trim().toLowerCase();
      if (val === 'gemini' || val === 'openai' || val === 'anthropic' || val === 'custom-http') {
        providerFilter = val;
      } else {
        console.error(`Unknown provider "${val}". Supported: gemini, openai, anthropic, custom-http`);
        process.exit(2);
      }
    } else if (a === '--mock') {
      mockMode = true;
    } else if (a.startsWith('--timeout=')) {
      const n = Number(a.slice('--timeout='.length));
      if (Number.isFinite(n) && n >= 3000) timeoutMs = n;
    }
  }
  return { providerFilter, mockMode, timeoutMs };
}

function makeMemorySseRes() {
  const chunks: string[] = [];
  let firstDeltaAt: number | null = null;
  const startedAt = Date.now();
  const res = {
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) {
      if (firstDeltaAt === null && chunk.includes('event: delta')) {
        firstDeltaAt = Date.now();
      }
      chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  return {
    res: res as unknown as Response,
    read: () => ({
      raw: chunks.join(''),
      ttftMs: firstDeltaAt !== null ? firstDeltaAt - startedAt : -1,
      totalMs: Date.now() - startedAt,
    }),
  };
}

async function runProviderMatrix(
  provider: ProviderFlag,
  model: ServerModelConfig,
  timeoutMs: number,
  isMock: boolean
): Promise<{ rows: CheckRow[]; configured: boolean }> {
  const okStatus: CheckStatus = isMock ? 'MOCK VERIFIED' : 'REAL PASS';
  const failStatus: CheckStatus = isMock ? 'MOCK VERIFIED' : 'REAL FAIL';
  const effectiveFailStatus: CheckStatus = 'REAL FAIL';
  const rows: CheckRow[] = [];
  const adapter = getAdapterForProtocol(model.protocol);

  const rawGeminiEnv = process.env.GEMINI_API_KEY?.trim();
  const hasRealGeminiEnv = Boolean(rawGeminiEnv && !isPlaceholderOrWeakSecret(rawGeminiEnv));
  const rawModelKey = model.apiKey?.trim();
  const hasRealModelKey = Boolean(rawModelKey && !isPlaceholderOrWeakSecret(rawModelKey));

  const hasCreds =
    provider === 'gemini'
      ? Boolean(model.useServerEnvKey ? hasRealGeminiEnv : hasRealModelKey)
      : provider === 'custom-http'
        ? Boolean(model.baseUrl?.trim())
        : hasRealModelKey;

  if (!hasCreds) {
    rows.push({
      provider,
      check: 'credentials',
      status: 'NOT CONFIGURED',
      latencyMs: 0,
      detail:
        provider === 'gemini'
          ? 'GEMINI_API_KEY is not set (or uses placeholder) in environment.'
          : provider === 'openai'
            ? 'OPENAI_API_KEY is not set (or uses placeholder) in environment.'
            : provider === 'anthropic'
              ? 'ANTHROPIC_API_KEY is not set (or uses placeholder) in environment.'
              : 'CUSTOM_HTTP_URL is not set in environment.',
    });
    return { rows, configured: false };
  }

  // 1. Model connection test
  const tConn = await adapter.testConnection(model, timeoutMs);
  rows.push({
    provider,
    check: 'connection_test',
    status: tConn.ok ? okStatus : effectiveFailStatus,
    latencyMs: tConn.latencyMs,
    detail: sanitizeSecretFromText(tConn.message, [model.apiKey]),
  });

  // 2. Streaming chat + TTFT + usage metadata
  try {
    const started = Date.now();
    let ttft = -1;
    let output = '';
    let chunkCount = 0;
    let usageTokens: number | undefined;

    for await (const c of adapter.streamChat({
      model,
      messages: [{ role: 'user', content: 'Reply with two words: stream verified' }],
      signal: new AbortController().signal,
      timeoutMs,
    })) {
      if (c.delta) {
        if (ttft === -1) ttft = Date.now() - started;
        chunkCount += 1;
        output += c.delta;
      }
      if (c.usage?.totalTokens || c.usage?.outputTokens) {
        usageTokens = c.usage.totalTokens ?? c.usage.outputTokens;
      }
    }
    rows.push({
      provider,
      check: 'streaming_chat',
      status: output.trim().length > 0 ? okStatus : effectiveFailStatus,
      latencyMs: Date.now() - started,
      detail: `chunks=${chunkCount}, ttft=${ttft}ms, chars=${output.length}`,
    });
    rows.push({
      provider,
      check: 'usage_metadata',
      status: usageTokens !== undefined ? okStatus : 'SKIPPED',
      latencyMs: 0,
      detail:
        usageTokens !== undefined
          ? `Reported usage tokens=${usageTokens}`
          : 'Provider omitted usage metadata in this stream response',
    });
  } catch (err) {
    rows.push({
      provider,
      check: 'streaming_chat',
      status: effectiveFailStatus,
      latencyMs: 0,
      detail: sanitizeSecretFromText(err instanceof Error ? err.message : String(err), [model.apiKey]),
    });
  }

  // 3. Invalid key handling, error normalization & zero secret leak
  if (provider !== 'custom-http') {
    const fakeSecret = `${provider}-invalid-key-9876543210abcdef`;
    const badModel: ServerModelConfig = {
      ...model,
      id: `${model.id}-badkey`,
      useServerEnvKey: false,
      apiKey: fakeSecret,
    };
    const badRes = await adapter.testConnection(badModel, Math.min(timeoutMs, 10_000));
    const leaked = badRes.message.includes(fakeSecret);
    const normalized = Boolean(badRes.errorKind && badRes.message.length > 0);
    rows.push({
      provider,
      check: 'error_norm_&_key_redact',
      status: !badRes.ok && !leaked && normalized ? okStatus : effectiveFailStatus,
      latencyMs: badRes.latencyMs,
      detail: leaked
        ? 'CRITICAL: Raw invalid API key leaked in error message!'
        : `Normalized (${badRes.errorKind || 'NONE'}) with secret redacted`,
    });
  }

  // 4. Mid-stream cancellation
  try {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 50);
    for await (const _c of adapter.streamChat({
      model,
      messages: [{ role: 'user', content: 'Write a 200-word explanation of TypeScript.' }],
      signal: ac.signal,
      timeoutMs,
    })) {
      // consume until abort
    }
    rows.push({
      provider,
      check: 'cancellation',
      status: okStatus,
      latencyMs: Date.now() - started,
      detail: 'AbortController stopped stream cleanly without unhandled rejection.',
    });
  } catch (err) {
    rows.push({
      provider,
      check: 'cancellation',
      status: effectiveFailStatus,
      latencyMs: 0,
      detail: sanitizeSecretFromText(err instanceof Error ? err.message : String(err), [model.apiKey]),
    });
  }

  // 5. Structured JSON output
  try {
    const started = Date.now();
    let out = '';
    for await (const c of adapter.streamChat({
      model,
      messages: [
        { role: 'user', content: 'Return ONLY valid raw JSON {"ok":true,"mode":"verify"}. No markdown.' },
      ],
      signal: new AbortController().signal,
      timeoutMs,
    })) {
      if (c.delta) out += c.delta;
    }
    const cleaned = out.replace(/^```json\s*/i, '').replace(/^```|```$/g, '').trim();
    const parsed = JSON.parse(cleaned) as { ok?: boolean };
    rows.push({
      provider,
      check: 'structured_json',
      status: typeof parsed === 'object' && parsed !== null ? okStatus : effectiveFailStatus,
      latencyMs: Date.now() - started,
      detail: `Parsed JSON response (${cleaned.slice(0, 60)})`,
    });
  } catch (err) {
    rows.push({
      provider,
      check: 'structured_json',
      status: effectiveFailStatus,
      latencyMs: 0,
      detail: sanitizeSecretFromText(err instanceof Error ? err.message : String(err), [model.apiKey]),
    });
  }

  // 6. Multimodal image input (for multimodal providers)
  if (provider === 'gemini' || provider === 'openai' || provider === 'anthropic') {
    try {
      const started = Date.now();
      let out = '';
      for await (const c of adapter.streamChat({
        model,
        messages: [
          {
            role: 'user',
            content: 'Reply "IMAGE_VERIFIED" if you can inspect the attached 1x1 PNG.',
            attachments: [
              {
                id: 'img-verify',
                name: 'pixel.png',
                mimeType: 'image/png',
                size: 68,
                dataBase64: TINY_PNG_BASE64,
              },
            ],
          },
        ],
        signal: new AbortController().signal,
        timeoutMs,
      })) {
        if (c.delta) out += c.delta;
      }
      rows.push({
        provider,
        check: 'multimodal_image',
        status: out.trim().length > 0 ? okStatus : effectiveFailStatus,
        latencyMs: Date.now() - started,
        detail: `Reply (${out.trim().slice(0, 50)})`,
      });
    } catch (err) {
      rows.push({
        provider,
        check: 'multimodal_image',
        status: effectiveFailStatus,
        latencyMs: 0,
        detail: sanitizeSecretFromText(err instanceof Error ? err.message : String(err), [model.apiKey]),
      });
    }
  }

  // 7. Failover from unreachable/bad primary to this working provider
  try {
    const cap = makeMemorySseRes();
    const failingPrimary: ServerModelConfig = {
      id: `primary-fail-${provider}`,
      displayName: 'Failing Primary',
      providerName: 'Primary',
      modelId: 'nonexistent-model',
      protocol: provider === 'gemini' ? 'openai-compatible' : model.protocol,
      baseUrl: 'https://invalid.example.invalid/v1',
      apiKey: 'sk-invalid-primary',
      priority: 1,
      enabled: true,
    };
    const backup: ServerModelConfig = { ...model, id: `backup-${provider}`, priority: 2 };
    clearModelCooldown(failingPrimary.id);
    clearModelCooldown(backup.id);

    await runOrchestratedChatStream({
      res: cap.res,
      models: [failingPrimary, backup],
      messages: [{ role: 'user', content: 'Say "fallback ok".' }],
      policy: { maxRetriesPerModel: 0, initialBackoffMs: 100, maxBackoffMs: 100, timeoutMs },
      signal: new AbortController().signal,
    });
    const out = cap.read();
    const switched = out.raw.includes('event: switched') && out.raw.includes('event: done');
    rows.push({
      provider,
      check: 'failover_recovery',
      status: switched ? okStatus : effectiveFailStatus,
      latencyMs: out.totalMs,
      detail: switched
        ? `Switched from failing primary to ${model.displayName} (TTFT=${out.ttftMs}ms)`
        : 'Fallback did not emit expected switched + done events.',
    });
  } catch (err) {
    rows.push({
      provider,
      check: 'failover_recovery',
      status: effectiveFailStatus,
      latencyMs: 0,
      detail: sanitizeSecretFromText(err instanceof Error ? err.message : String(err), [model.apiKey]),
    });
  }

  return { rows, configured: true };
}

async function startLocalMockProviderServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const auth = req.headers.authorization || req.headers['x-api-key'] || '';
      if (String(auth).includes('invalid-key')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid authentication credential' } }));
        return;
      }

      if (req.url?.includes('/chat/completions')) {
        const parsed = JSON.parse(body || '{}') as { stream?: boolean };
        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":true,' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '"mode":"verify"}' } }] })}\n\n`);
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } })}\n\n`
          );
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
        }
        return;
      }

      if (req.url?.includes('/v1/messages')) {
        const parsed = JSON.parse(body || '{}') as { stream?: boolean };
        if (parsed.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { text: '{"ok":true,"mode":"verify"}' } })}\n\n`);
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } })}\n\n`);
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ content: [{ text: 'OK' }] }));
        }
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: '{"ok":true,"mode":"verify"}' }));
    });
  });

  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => srv.close(() => resolve())),
  };
}

async function main() {
  const { providerFilter, mockMode, timeoutMs } = parseArgs();
  let mockServer: { url: string; close: () => Promise<void> } | null = null;

  if (mockMode) {
    process.env.ALLOW_LOCAL_MODEL_URLS = 'true';
    mockServer = await startLocalMockProviderServer();
  }

  try {
    const configs: Record<ProviderFlag, ServerModelConfig> = {
      gemini: {
        id: 'verify-gemini',
        displayName: 'Gemini Live Verify',
        providerName: 'Google Gemini',
        modelId: process.env.GEMINI_MODEL_ID?.trim() || 'gemini-3.8-flash',
        protocol: 'google-gemini',
        useServerEnvKey: true,
        priority: 1,
        enabled: true,
      },
      openai: {
        id: 'verify-openai',
        displayName: 'OpenAI Live Verify',
        providerName: 'OpenAI',
        modelId: process.env.OPENAI_MODEL_ID?.trim() || 'gpt-4o-mini',
        baseUrl: mockServer ? `${mockServer.url}/v1` : process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
        apiKey: mockServer ? 'sk-mock-openai-valid-123456' : process.env.OPENAI_API_KEY?.trim(),
        protocol: 'openai-compatible',
        priority: 2,
        enabled: true,
      },
      anthropic: {
        id: 'verify-anthropic',
        displayName: 'Anthropic Live Verify',
        providerName: 'Anthropic',
        modelId: process.env.ANTHROPIC_MODEL_ID?.trim() || 'claude-3-5-haiku-latest',
        baseUrl: mockServer ? mockServer.url : process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com',
        apiKey: mockServer ? 'sk-ant-mock-valid-123456' : process.env.ANTHROPIC_API_KEY?.trim(),
        protocol: 'anthropic',
        priority: 3,
        enabled: true,
      },
      'custom-http': {
        id: 'verify-custom',
        displayName: 'Custom HTTP Verify',
        providerName: 'Custom HTTP',
        modelId: process.env.CUSTOM_HTTP_MODEL_ID?.trim() || 'custom-model',
        baseUrl: mockServer ? `${mockServer.url}/custom` : process.env.CUSTOM_HTTP_URL?.trim(),
        apiKey: mockServer ? 'sk-mock-custom-123456' : process.env.CUSTOM_HTTP_API_KEY?.trim(),
        protocol: 'custom-http',
        priority: 4,
        enabled: true,
      },
    };

    const targetProviders: ProviderFlag[] =
      providerFilter === 'all'
        ? mockMode
          ? ['openai', 'anthropic', 'custom-http']
          : ['gemini', 'openai', 'anthropic', 'custom-http']
        : [providerFilter];

    const allRows: CheckRow[] = [];
    const configuredProviders: ServerModelConfig[] = [];

    for (const p of targetProviders) {
      const result = await runProviderMatrix(p, configs[p], timeoutMs, mockMode);
      allRows.push(...result.rows);
      if (result.configured) {
        configuredProviders.push(configs[p]);
      }
    }

    // Cross-provider failover when >= 2 providers are configured
    if (configuredProviders.length >= 2) {
      const cap = makeMemorySseRes();
      const firstBroken: ServerModelConfig = {
        ...configuredProviders[0],
        id: 'cross-fail-primary',
        useServerEnvKey: false,
        apiKey: 'sk-invalid-key-cross-primary',
      };
      const secondWorking: ServerModelConfig = {
        ...configuredProviders[1],
        id: 'cross-backup-secondary',
        priority: 2,
      };
      clearModelCooldown(firstBroken.id);
      clearModelCooldown(secondWorking.id);

      await runOrchestratedChatStream({
        res: cap.res,
        models: [firstBroken, secondWorking],
        messages: [{ role: 'user', content: 'Say "cross failover ok".' }],
        policy: { maxRetriesPerModel: 0, initialBackoffMs: 100, maxBackoffMs: 100, timeoutMs },
        signal: new AbortController().signal,
      });
      const out = cap.read();
      const switched = out.raw.includes('event: switched') && out.raw.includes('event: done');
      allRows.push({
        provider: 'orchestrator',
        check: 'cross_provider_failover',
        status: switched ? (mockMode ? 'MOCK VERIFIED' : 'REAL PASS') : 'REAL FAIL',
        latencyMs: out.totalMs,
        detail: `${firstBroken.providerName} -> ${secondWorking.providerName} (TTFT=${out.ttftMs}ms)`,
      });
    } else {
      allRows.push({
        provider: 'orchestrator',
        check: 'cross_provider_failover',
        status: 'SKIPPED',
        latencyMs: 0,
        detail: `Requires >= 2 configured providers (${configuredProviders.length} configured in current environment).`,
      });
    }

    console.log('\n=== OmniAI Provider Verification Matrix ===');
    console.log(`Mode: ${mockMode ? 'LOCAL MOCK SERVER (MOCK VERIFIED ONLY)' : 'LIVE PROVIDER ENVIRONMENT'}`);
    for (const r of allRows) {
      console.log(
        `[${r.status.padEnd(14)}] ${r.provider.padEnd(12)} | ${r.check.padEnd(23)} | ${String(r.latencyMs).padStart(5)}ms | ${r.detail}`
      );
    }

    const counts = allRows.reduce<Record<CheckStatus, number>>(
      (acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      },
      { 'REAL PASS': 0, 'REAL FAIL': 0, 'MOCK VERIFIED': 0, 'NOT CONFIGURED': 0, SKIPPED: 0 }
    );
    console.log(
      `\nSummary: REAL PASS=${counts['REAL PASS']}, MOCK VERIFIED=${counts['MOCK VERIFIED']}, REAL FAIL=${counts['REAL FAIL']}, NOT CONFIGURED=${counts['NOT CONFIGURED']}, SKIPPED=${counts.SKIPPED}`
    );

    if (counts['REAL FAIL'] > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (mockServer) await mockServer.close();
  }
}

main().catch((err) => {
  console.error('Provider verification runner crashed:', sanitizeSecretFromText(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
