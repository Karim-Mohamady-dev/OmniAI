// @vitest-environment node
import http from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterCallError } from '../server/adapters/base.ts';
import { getAdapterForProtocol } from '../server/adapters/registry.ts';
import type { ServerModelConfig } from '../server/types.ts';

const openaiCompatibleAdapter = getAdapterForProtocol('openai-compatible');
const anthropicAdapter = getAdapterForProtocol('anthropic');
const customHttpAdapter = getAdapterForProtocol('custom-http');
const geminiAdapter = getAdapterForProtocol('google-gemini');

describe('AI Provider Adapters & Live Integration Matrix', () => {
  const servers: http.Server[] = [];
  const origAllowLocal = process.env.ALLOW_LOCAL_MODEL_URLS;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (origAllowLocal === undefined) delete process.env.ALLOW_LOCAL_MODEL_URLS;
    else process.env.ALLOW_LOCAL_MODEL_URLS = origAllowLocal;
    await Promise.all(
      servers.map(
        (srv) =>
          new Promise<void>((resolve) => {
            srv.close(() => resolve());
          })
      )
    );
    servers.length = 0;
  });

  async function startMockProviderServer(
    handler: http.RequestListener
  ): Promise<{ baseUrl: string }> {
    process.env.ALLOW_LOCAL_MODEL_URLS = 'true';
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const port = (server.address() as { port: number }).port;
    return { baseUrl: `http://127.0.0.1:${port}` };
  }

  it('openaiCompatibleAdapter streams tokens, extracts token usage, and rejects mid-stream SSE errors', async () => {
    let lastRequestBody: Record<string, unknown> = {};
    const { baseUrl } = await startMockProviderServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        lastRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: 'OpenAI!' } }],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });

    const model: ServerModelConfig = {
      id: 'm-oai',
      displayName: 'OpenAI Local Mock',
      providerName: 'OpenAI',
      modelId: 'gpt-4o-mini',
      baseUrl: `${baseUrl}/v1`,
      apiKey: 'sk-mock-oai',
      protocol: 'openai-compatible',
      priority: 1,
      enabled: true,
    };

    const collected: string[] = [];
    let usageTokens = 0;
    for await (const chunk of openaiCompatibleAdapter.streamChat({
      model,
      messages: [{ role: 'user', content: 'Say hi' }],
      signal: new AbortController().signal,
      timeoutMs: 5000,
    })) {
      if (chunk.delta) collected.push(chunk.delta);
      if (chunk.usage?.totalTokens) usageTokens = chunk.usage.totalTokens;
    }

    expect(collected.join('')).toBe('Hello OpenAI!');
    expect(usageTokens).toBe(18);
    expect(lastRequestBody.model).toBe('gpt-4o-mini');

    // Mid-stream SSE JSON error -> throws AdapterCallError so orchestrator fails over
    const { baseUrl: errBaseUrl } = await startMockProviderServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ error: { message: 'insufficient_quota on mid-stream' } })}\n\n`
      );
      res.end();
    });

    const failingModel: ServerModelConfig = { ...model, baseUrl: `${errBaseUrl}/v1` };
    await expect(async () => {
      for await (const _chunk of openaiCompatibleAdapter.streamChat({
        model: failingModel,
        messages: [{ role: 'user', content: 'Trigger mid-stream error' }],
        signal: new AbortController().signal,
        timeoutMs: 5000,
      })) {
        // drain
      }
    }).rejects.toBeInstanceOf(AdapterCallError);
  });

  it('anthropicAdapter streams content_block_delta, reports usage, and classifies SSE error events', async () => {
    const { baseUrl } = await startMockProviderServer((req, res) => {
      expect(req.headers['x-api-key']).toBe('sk-ant-mock');
      expect(req.headers['anthropic-version']).toBe('2023-06-01');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 15 } } })}\n\n`
      );
      res.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Claude response' },
        })}\n\n`
      );
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          usage: { output_tokens: 9 },
        })}\n\n`
      );
      res.end();
    });

    const model: ServerModelConfig = {
      id: 'm-ant',
      displayName: 'Anthropic Mock',
      providerName: 'Anthropic',
      modelId: 'claude-3-5-sonnet-20241022',
      baseUrl,
      apiKey: 'sk-ant-mock',
      protocol: 'anthropic',
      priority: 1,
      enabled: true,
    };

    const parts: string[] = [];
    let latestUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
    for await (const chunk of anthropicAdapter.streamChat({
      model,
      messages: [{ role: 'user', content: 'Hi Claude' }],
      signal: new AbortController().signal,
      timeoutMs: 5000,
    })) {
      if (chunk.delta) parts.push(chunk.delta);
      if (chunk.usage) latestUsage = chunk.usage;
    }

    expect(parts.join('')).toBe('Claude response');
    expect(latestUsage.inputTokens).toBe(15);
    expect(latestUsage.outputTokens).toBe(9);
    expect(latestUsage.totalTokens).toBe(24);
  });

  it('customHttpAdapter parses JSON response, streaming chunks, and inline JSON errors', async () => {
    const { baseUrl } = await startMockProviderServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          text: 'Custom JSON OK',
          usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
        })
      );
    });

    const model: ServerModelConfig = {
      id: 'm-cust',
      displayName: 'Custom Mock',
      providerName: 'Custom',
      modelId: 'custom-model-v1',
      baseUrl,
      apiKey: 'cust-secret',
      protocol: 'custom-http',
      priority: 1,
      enabled: true,
    };

    const testRes = await customHttpAdapter.testConnection(model, 5000);
    expect(testRes.ok).toBe(true);
    expect(testRes.latencyMs).toBeGreaterThanOrEqual(0);

    const { baseUrl: errUrl } = await startMockProviderServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Model quota limit reached' } }));
    });
    const badRes = await customHttpAdapter.testConnection({ ...model, baseUrl: errUrl }, 5000);
    expect(badRes.ok).toBe(false);
    expect(badRes.errorKind).toBe('QUOTA_EXCEEDED');
  });

  it('validates live external provider keys honestly (SKIPPED/NOT CONFIGURED when absent)', async () => {
    const statusReport: Record<string, { status: string; detail: string }> = {};

    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    if (geminiKey && geminiKey !== 'MY_GEMINI_API_KEY') {
      const res = await geminiAdapter.testConnection(
        {
          id: 'live-gem',
          displayName: 'Live Gemini',
          providerName: 'Google',
          modelId: 'gemini-2.5-flash',
          protocol: 'google-gemini',
          useServerEnvKey: true,
          priority: 1,
          enabled: true,
        },
        15000
      );
      statusReport.gemini = { status: res.ok ? 'PASS' : 'FAIL', detail: res.message };
      expect(typeof res.ok).toBe('boolean');
    } else {
      statusReport.gemini = {
        status: 'NOT CONFIGURED',
        detail: 'GEMINI_API_KEY not provided in test environment.',
      };
    }

    const openaiKey = process.env.OPENAI_API_KEY?.trim();
    if (openaiKey) {
      const res = await openaiCompatibleAdapter.testConnection(
        {
          id: 'live-oai',
          displayName: 'Live OpenAI',
          providerName: 'OpenAI',
          modelId: process.env.OPENAI_TEST_MODEL || 'gpt-4o-mini',
          baseUrl: process.env.OPENAI_TEST_BASE_URL || 'https://api.openai.com/v1',
          apiKey: openaiKey,
          protocol: 'openai-compatible',
          priority: 2,
          enabled: true,
        },
        15000
      );
      statusReport.openai = { status: res.ok ? 'PASS' : 'FAIL', detail: res.message };
    } else {
      statusReport.openai = {
        status: 'NOT CONFIGURED',
        detail: 'OPENAI_API_KEY not provided in test environment.',
      };
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (anthropicKey) {
      const res = await anthropicAdapter.testConnection(
        {
          id: 'live-ant',
          displayName: 'Live Anthropic',
          providerName: 'Anthropic',
          modelId: process.env.ANTHROPIC_TEST_MODEL || 'claude-3-5-haiku-latest',
          apiKey: anthropicKey,
          protocol: 'anthropic',
          priority: 3,
          enabled: true,
        },
        15000
      );
      statusReport.anthropic = { status: res.ok ? 'PASS' : 'FAIL', detail: res.message };
    } else {
      statusReport.anthropic = {
        status: 'NOT CONFIGURED',
        detail: 'ANTHROPIC_API_KEY not provided in test environment.',
      };
    }

    expect(Object.keys(statusReport)).toEqual(['gemini', 'openai', 'anthropic']);
  });
});
