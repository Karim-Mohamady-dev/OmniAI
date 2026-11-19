// @vitest-environment node
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runOrchestratedChatStream,
  trimRepeatedContinuationPrefix,
} from '../server/orchestrator/aiOrchestrator.ts';
import {
  clearModelCooldown,
  getAllModelHealthMetrics,
} from '../server/orchestrator/healthTracker.ts';
import type { ServerModelConfig } from '../server/types.ts';

interface CapturedEvent {
  event: string;
  data: Record<string, unknown>;
}

function createSseCapture() {
  const chunks: string[] = [];
  const res = {
    writableEnded: false,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    flushHeaders() {},
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };

  function getEvents(): CapturedEvent[] {
    const raw = chunks.join('');
    const out: CapturedEvent[] = [];
    for (const frame of raw.split('\n\n')) {
      if (!frame.trim()) continue;
      let event = 'message';
      let dataStr = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (dataStr) {
        out.push({ event, data: JSON.parse(dataStr) });
      }
    }
    return out;
  }

  return { res: res as unknown as Response, getEvents };
}

function sseFromChunks(texts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream({
    pull(controller) {
      if (idx < texts.length) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: texts[idx++] } }] })}\n\n`)
        );
        return;
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

describe('Multi-Model 3-Stage Fallback & Continuation Deduplication', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearModelCooldown('chain-m1');
    clearModelCooldown('chain-m2');
    clearModelCooldown('chain-m3');
  });

  it('executes 3-model chain (429 insufficient_quota -> timeout -> HTTP 200), records cooldowns & metrics, and never leaks API keys', async () => {
    const models: ServerModelConfig[] = [
      {
        id: 'chain-m1',
        displayName: 'Chain Model 1',
        providerName: 'Provider 1',
        modelId: 'm1-quota',
        baseUrl: 'https://m1.example.test/v1',
        apiKey: 'sk-chain-secret-111',
        protocol: 'openai-compatible',
        priority: 1,
        enabled: true,
      },
      {
        id: 'chain-m2',
        displayName: 'Chain Model 2',
        providerName: 'Provider 2',
        modelId: 'm2-timeout',
        baseUrl: 'https://m2.example.test/v1',
        apiKey: 'sk-chain-secret-222',
        protocol: 'openai-compatible',
        priority: 2,
        enabled: true,
      },
      {
        id: 'chain-m3',
        displayName: 'Chain Model 3',
        providerName: 'Provider 3',
        modelId: 'm3-healthy',
        baseUrl: 'https://m3.example.test/v1',
        apiKey: 'sk-chain-secret-333',
        protocol: 'openai-compatible',
        priority: 3,
        enabled: true,
      },
    ];

    const fetchMock = vi
      .fn()
      // Model 1: 429 insufficient_quota containing secret key that must be sanitized
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'insufficient_quota for key sk-chain-secret-111' } }),
          { status: 429, headers: { 'content-type': 'application/json' } }
        )
      )
      // Model 2: simulated upstream timeout
      .mockRejectedValueOnce(new Error('Request timed out after 5000ms (AbortError)'))
      // Model 3: clean 200 SSE success
      .mockResolvedValueOnce(
        new Response(sseFromChunks(['Chain ', 'recovered cleanly!']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      );

    vi.stubGlobal('fetch', fetchMock);

    const { res, getEvents } = createSseCapture();
    await runOrchestratedChatStream({
      res,
      models,
      messages: [{ role: 'user', content: 'Verify 3-model failover chain' }],
      policy: { maxRetriesPerModel: 0, initialBackoffMs: 100, maxBackoffMs: 100, timeoutMs: 5000 },
      signal: new AbortController().signal,
    });

    const events = getEvents();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('sk-chain-secret-111');
    expect(serialized).not.toContain('sk-chain-secret-222');
    expect(serialized).not.toContain('sk-chain-secret-333');

    const switchedEvents = events.filter((e) => e.event === 'switched');
    expect(switchedEvents).toHaveLength(2);
    expect(switchedEvents[0].data.fromModel).toBe('Chain Model 1');
    expect(switchedEvents[0].data.toModel).toBe('Chain Model 2');
    expect(switchedEvents[1].data.fromModel).toBe('Chain Model 2');
    expect(switchedEvents[1].data.toModel).toBe('Chain Model 3');

    const deltas = events
      .filter((e) => e.event === 'delta')
      .map((e) => e.data.text)
      .join('');
    expect(deltas).toBe('Chain recovered cleanly!');

    const doneEvent = events.find((e) => e.event === 'done');
    expect(doneEvent?.data.switchedCount).toBe(2);
    expect((doneEvent?.data.attempts as unknown[]).length).toBe(2);

    const metrics = getAllModelHealthMetrics();
    const m1 = metrics.models.find((m) => m.configId === 'chain-m1');
    const m2 = metrics.models.find((m) => m.configId === 'chain-m2');
    const m3 = metrics.models.find((m) => m.configId === 'chain-m3');
    expect(m1?.failureCount).toBeGreaterThanOrEqual(1);
    expect(m1?.cooldownUntil).toBeGreaterThan(Date.now());
    expect(m2?.failureCount).toBeGreaterThanOrEqual(1);
    expect(m3?.successCount).toBeGreaterThanOrEqual(1);
    expect((m3?.recentSamples?.length ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates repeated continuation prefixes cleanly when continuing a partial stream', () => {
    const accumulated = 'const server = express();\napp.listen(3000, () => {';
    const overlappingIncoming = 'listen(3000, () => { console.log("ready"); });';
    const trimmed = trimRepeatedContinuationPrefix(accumulated, overlappingIncoming);
    expect(trimmed).toBe(' console.log("ready"); });');
    expect(accumulated + trimmed).toBe(
      'const server = express();\napp.listen(3000, () => { console.log("ready"); });'
    );
  });
});
