// @vitest-environment node
import type { Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOrchestratedChatStream } from '../server/orchestrator/aiOrchestrator.ts';
import type { ServerModelConfig } from '../server/types.ts';

interface CapturedSseEvent {
  event: string;
  data: Record<string, unknown>;
}

function createMockSseResponse() {
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

  function getEvents(): CapturedSseEvent[] {
    const raw = chunks.join('');
    const events: CapturedSseEvent[] = [];
    for (const frame of raw.split('\n\n')) {
      if (!frame.trim()) continue;
      let event = 'message';
      let dataStr = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (dataStr) {
        events.push({ event, data: JSON.parse(dataStr) });
      }
    }
    return events;
  }

  return { res: res as unknown as Response, getEvents };
}

function makeOpenAiSseStream(deltas: string[], failAfterSecond = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let idx = 0;
  return new ReadableStream({
    pull(controller) {
      if (failAfterSecond && idx === 2) {
        controller.error(new Error('503 upstream stream interrupted'));
        return;
      }
      if (idx < deltas.length) {
        const d = deltas[idx++];
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
        );
        return;
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

const modelA: ServerModelConfig = {
  id: 'cfg-a',
  displayName: 'Primary Model A',
  providerName: 'Provider A',
  modelId: 'gpt-4o',
  baseUrl: 'https://api.example-a.test/v1',
  apiKey: 'sk-primary-secret-key-999',
  protocol: 'openai-compatible',
  priority: 1,
  enabled: true,
};

const modelB: ServerModelConfig = {
  id: 'cfg-b',
  displayName: 'Fallback Model B',
  providerName: 'Provider B',
  modelId: 'llama-3-70b',
  baseUrl: 'https://api.example-b.test/v1',
  apiKey: 'sk-fallback-secret-key-888',
  protocol: 'openai-compatible',
  priority: 2,
  enabled: true,
};

describe('AI Orchestrator & Automatic Fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('streams directly from primary model when healthy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(makeOpenAiSseStream(['Hello ', 'world!']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
    );

    const { res, getEvents } = createMockSseResponse();
    await runOrchestratedChatStream({
      res,
      models: [modelA, modelB],
      messages: [{ role: 'user', content: 'Hi' }],
      policy: { maxRetriesPerModel: 0, initialBackoffMs: 100, maxBackoffMs: 100, timeoutMs: 5000 },
      signal: new AbortController().signal,
    });

    const events = getEvents();
    const text = events
      .filter((e) => e.event === 'delta')
      .map((e) => e.data.text)
      .join('');
    expect(text).toBe('Hello world!');
    expect(events.some((e) => e.event === 'switched')).toBe(false);
    expect(events.some((e) => e.event === 'done')).toBe(true);
  });

  it('automatically falls back on HTTP 429 rate limit and preserves full prompt', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Rate limit exceeded (429)' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(makeOpenAiSseStream(['Recovered from Model B']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const { res, getEvents } = createMockSseResponse();
    await runOrchestratedChatStream({
      res,
      models: [modelA, modelB],
      messages: [{ role: 'user', content: 'Explain fallback' }],
      policy: { maxRetriesPerModel: 0, initialBackoffMs: 100, maxBackoffMs: 100, timeoutMs: 5000 },
      signal: new AbortController().signal,
    });

    const events = getEvents();
    const switched = events.find((e) => e.event === 'switched');
    expect(switched).toBeDefined();
    expect(switched?.data.fromModel).toBe('Primary Model A');
    expect(switched?.data.toModel).toBe('Fallback Model B');
    expect(switched?.data.errorKind).toBe('RATE_LIMIT');

    const deltas = events
      .filter((e) => e.event === 'delta')
      .map((e) => e.data.text)
      .join('');
    expect(deltas).toBe('Recovered from Model B');
  });

  it('does not retry 401 auth errors in a loop and sanitizes leaked keys', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: `Invalid key ${modelA.apiKey}` } }),
          { status: 401, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(makeOpenAiSseStream(['Auth OK on Model B']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const { res, getEvents } = createMockSseResponse();
    await runOrchestratedChatStream({
      res,
      models: [modelA, modelB],
      messages: [{ role: 'user', content: 'Test auth switch' }],
      policy: { maxRetriesPerModel: 2, initialBackoffMs: 100, maxBackoffMs: 100, timeoutMs: 5000 },
      signal: new AbortController().signal,
    });

    // Only 2 total calls: 1 on modelA (no retries for 401) + 1 on modelB
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const events = getEvents();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(modelA.apiKey);
    expect(serialized).not.toContain(modelB.apiKey);
    expect(events.find((e) => e.event === 'switched')?.data.errorKind).toBe('AUTH_ERROR');
  });

  it('preserves partial output on mid-stream failure and passes continuation context', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(makeOpenAiSseStream(['Part 1 ', 'Part 2 ', 'ignored'], true), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
      .mockResolvedValueOnce(
        new Response(makeOpenAiSseStream(['Part 3!']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const { res, getEvents } = createMockSseResponse();
    await runOrchestratedChatStream({
      res,
      models: [modelA, modelB],
      messages: [{ role: 'user', content: 'Write a 3-part answer' }],
      policy: { maxRetriesPerModel: 1, initialBackoffMs: 100, maxBackoffMs: 100, timeoutMs: 5000 },
      signal: new AbortController().signal,
    });

    const events = getEvents();
    const switched = events.find((e) => e.event === 'switched');
    expect(switched?.data.preservingPartialOutput).toBe(true);

    const secondCallBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    const serializedPrompt = JSON.stringify(secondCallBody.messages);
    expect(serializedPrompt).toContain('Part 1 Part 2 ');
    expect(serializedPrompt).toContain('Continue seamlessly');

    const totalText = events
      .filter((e) => e.event === 'delta')
      .map((e) => e.data.text)
      .join('');
    expect(totalText).toBe('Part 1 Part 2 Part 3!');
  });

  it('emits capability_adapted notice when routing image prompts to a non-vision model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(makeOpenAiSseStream(['Processed text fallback']), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      )
    );

    const { res, getEvents } = createMockSseResponse();
    await runOrchestratedChatStream({
      res,
      models: [modelB], // llama-3-70b without vision
      messages: [
        {
          role: 'user',
          content: 'Describe this screenshot',
          attachments: [
            {
              id: 'att-1',
              name: 'ui.png',
              mimeType: 'image/png',
              size: 12,
              dataBase64: 'iVBORw0KGgo=',
            },
          ],
        },
      ],
      policy: { maxRetriesPerModel: 0, initialBackoffMs: 100, maxBackoffMs: 100, timeoutMs: 5000 },
      signal: new AbortController().signal,
    });

    const events = getEvents();
    const adaptedEvt = events.find((e) => e.event === 'capability_adapted');
    expect(adaptedEvt).toBeDefined();
    expect(adaptedEvt?.data.omittedImages).toEqual(['ui.png']);
  });

  it('emits fatal when all enabled models are exhausted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Quota exceeded' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      )
    );

    const { res, getEvents } = createMockSseResponse();
    await runOrchestratedChatStream({
      res,
      models: [modelA, modelB],
      messages: [{ role: 'user', content: 'Fail all' }],
      policy: { maxRetriesPerModel: 0, initialBackoffMs: 100, maxBackoffMs: 100, timeoutMs: 5000 },
      signal: new AbortController().signal,
    });

    const events = getEvents();
    const fatal = events.find((e) => e.event === 'fatal');
    expect(fatal).toBeDefined();
    expect((fatal?.data.attempts as unknown[]).length).toBe(2);
  });
});
