// @vitest-environment node
import cookieParser from 'cookie-parser';
import express, { type Response } from 'express';
import http from 'http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MultiUserStore } from '../server/db/multiUserStore.ts';
import { runOrchestratedChatStream } from '../server/orchestrator/aiOrchestrator.ts';
import {
  clearModelCooldown,
  orderModelsWithHealthAndRoles,
  recordModelAttemptFailure,
} from '../server/orchestrator/healthTracker.ts';
import aiRouter from '../server/routes/ai.ts';
import { attachAuthUserMiddleware, createAuthRouter } from '../server/routes/auth.ts';
import previewRouter from '../server/routes/preview.ts';
import { createWorkspaceRouter } from '../server/routes/workspace.ts';
import type { ServerModelConfig } from '../server/types.ts';
import type { ProjectFile } from '../src/types/index.ts';

function extractCookie(setCookie: string | null): string {
  return setCookie ? setCookie.split(';')[0] || '' : '';
}

function makeTimedSseCapture() {
  const chunks: string[] = [];
  let firstDeltaTs: number | null = null;
  const startedAt = Date.now();
  const res = {
    writableEnded: false,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    flushHeaders() {},
    write(chunk: string) {
      if (firstDeltaTs === null && chunk.includes('event: delta')) {
        firstDeltaTs = Date.now();
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
    getMetrics: () => ({
      ttftMs: firstDeltaTs !== null ? firstDeltaTs - startedAt : -1,
      totalMs: Date.now() - startedAt,
      raw: chunks.join(''),
    }),
  };
}

describe('Phase 4 Performance, Concurrency & Reliability Benchmarks', () => {
  let server: http.Server;
  let baseUrl = '';
  let store: MultiUserStore;

  beforeAll(async () => {
    store = new MultiUserStore(null);
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    app.use(cookieParser());
    app.use(attachAuthUserMiddleware(store));
    app.use('/api/auth', createAuthRouter(store));
    app.use('/api/workspace', createWorkspaceRouter(store));
    app.use('/api/ai', aiRouter);
    app.use('/api/preview', previewRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearModelCooldown('perf-m1');
    clearModelCooldown('perf-m2');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('benchmarks 200-file React preview bundling latency and memory delta', async () => {
    const files: ProjectFile[] = [];
    const imports: string[] = [];
    const renders: string[] = [];

    for (let i = 0; i < 198; i++) {
      files.push({
        path: `src/components/Module${i}.tsx`,
        content: `import React from 'react';\nexport function Module${i}() { return <span>Module ${i}</span>; }\n`,
        updatedAt: Date.now(),
      });
      imports.push(`import { Module${i} } from './components/Module${i}.tsx';`);
      renders.push(`<Module${i} key="${i}" />`);
    }

    files.push({
      path: 'src/App.tsx',
      content: `import React from 'react';\n${imports.join('\n')}\nexport default function App() { return <div>${renders.join('')}</div>; }\n`,
      updatedAt: Date.now(),
    });
    files.push({
      path: 'src/main.tsx',
      content: `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.tsx';\ncreateRoot(document.getElementById('root')!).render(<App />);\n`,
      updatedAt: Date.now(),
    });

    const memBefore = process.memoryUsage();
    const started = performance.now();
    const res = await fetch(`${baseUrl}/api/preview/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ framework: 'react-vite', files }),
    });
    const json = (await res.json()) as { ok: boolean; html: string; errors: unknown[] };
    const elapsedMs = Math.round(performance.now() - started);
    const memAfter = process.memoryUsage();
    const heapDeltaMb = Number(((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(2));

    console.info(
      `[PERF] 200-file preview bundle: ${elapsedMs}ms | HTML ${(json.html.length / 1024).toFixed(1)}KB | Heap delta ${heapDeltaMb}MB`
    );

    expect(res.ok).toBe(true);
    expect(json.ok).toBe(true);
    expect(json.errors).toEqual([]);
    expect(elapsedMs).toBeLessThan(6000);
  });

  it('benchmarks API endpoint latency (avg/P95), SSE TTFT, and 12 concurrent orchestrated AI streams', async () => {
    const os = await import('os');
    // 1. API latency across 40 calls (avg & P95)
    const apiLatencies: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      const res = await fetch(`${baseUrl}/api/ai/metrics`);
      expect(res.ok).toBe(true);
      apiLatencies.push(performance.now() - t0);
    }
    const sortedApi = [...apiLatencies].sort((a, b) => a - b);
    const avgApiMs = Number(
      (apiLatencies.reduce((a, b) => a + b, 0) / apiLatencies.length).toFixed(2)
    );
    const p95ApiMs = Number(
      sortedApi[Math.min(sortedApi.length - 1, Math.floor(sortedApi.length * 0.95))].toFixed(2)
    );
    expect(avgApiMs).toBeLessThan(100);
    expect(p95ApiMs).toBeLessThan(150);

    // 2. Concurrent SSE streams (12 parallel requests)
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Chunk A ' } }] })}\n\n`)
            );
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Chunk B' } }] })}\n\n`)
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      })
    );

    const model: ServerModelConfig = {
      id: 'perf-m1',
      displayName: 'Perf Model',
      providerName: 'Perf',
      modelId: 'perf-1',
      baseUrl: 'https://perf.example.test/v1',
      apiKey: 'sk-perf-test',
      protocol: 'openai-compatible',
      priority: 1,
      enabled: true,
    };

    const tStart = performance.now();
    const results = await Promise.all(
      Array.from({ length: 12 }, async (_, idx) => {
        const cap = makeTimedSseCapture();
        await runOrchestratedChatStream({
          res: cap.res,
          models: [model],
          messages: [{ role: 'user', content: `Parallel prompt #${idx}` }],
          policy: { maxRetriesPerModel: 0, initialBackoffMs: 100, maxBackoffMs: 100, timeoutMs: 5000 },
          signal: new AbortController().signal,
        });
        return cap.getMetrics();
      })
    );
    const totalWallMs = Math.round(performance.now() - tStart);
    const sortedTtft = results.map((r) => r.ttftMs).sort((a, b) => a - b);
    const avgTtft = Number((sortedTtft.reduce((a, b) => a + b, 0) / sortedTtft.length).toFixed(2));
    const p95Ttft = sortedTtft[Math.min(sortedTtft.length - 1, Math.floor(sortedTtft.length * 0.95))];
    const rssMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1));

    console.info(
      `[PERF] HW=${os.cpus().length}vCPU/${Math.round(os.totalmem() / (1024 * 1024))}MB | API avg=${avgApiMs}ms P95=${p95ApiMs}ms | 12 concurrent SSE total=${totalWallMs}ms avgTTFT=${avgTtft}ms P95TTFT=${p95Ttft}ms | RSS=${rssMb}MB`
    );

    results.forEach((r) => {
      expect(r.raw).toContain('Chunk A');
      expect(r.raw).toContain('event: done');
      expect(r.ttftMs).toBeGreaterThanOrEqual(0);
    });
  });

  it('handles 15 concurrent multi-user signups & isolated workspace writes without cross-contamination', async () => {
    const t0 = performance.now();
    const outcomes = await Promise.all(
      Array.from({ length: 15 }, async (_, idx) => {
        const reg = await fetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: `concurrent_${idx}@example.com`,
            password: 'password1234',
            displayName: `Concurrent ${idx}`,
          }),
        });
        expect(reg.status).toBe(201);
        const cookie = extractCookie(reg.headers.get('set-cookie'));

        const put = await fetch(`${baseUrl}/api/workspace/state`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            projects: [{ id: `proj-user-${idx}`, name: `User ${idx} App`, files: [] }],
          }),
        });
        expect(put.status).toBe(200);

        const getRes = await fetch(`${baseUrl}/api/workspace/state`, {
          headers: { Cookie: cookie },
        });
        const ws = (await getRes.json()) as { projects: Array<{ id: string }> };
        return ws.projects.map((p) => p.id);
      })
    );
    const elapsedMs = Math.round(performance.now() - t0);
    console.info(`[PERF] 15 concurrent users register+save+read completed in ${elapsedMs}ms`);

    outcomes.forEach((projIds, idx) => {
      expect(projIds).toEqual([`proj-user-${idx}`]);
    });
  });

  it('cleans up aborted SSE streams cleanly and probes expired cooldown recovery', async () => {
    // 1. Stream cancellation cleanup
    const abortController = new AbortController();
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'First token ' } }] })}\n\n`)
            );
            init?.signal?.addEventListener(
              'abort',
              () => {
                controller.error(new DOMException('The operation was aborted.', 'AbortError'));
              },
              { once: true }
            );
            setTimeout(() => abortController.abort(), 15);
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      })
    );

    const cap = makeTimedSseCapture();
    await runOrchestratedChatStream({
      res: cap.res,
      models: [
        {
          id: 'perf-m1',
          displayName: 'Abortable Model',
          providerName: 'Perf',
          modelId: 'abort-1',
          baseUrl: 'https://abort.example.test/v1',
          apiKey: 'sk-abort',
          protocol: 'openai-compatible',
          priority: 1,
          enabled: true,
        },
      ],
      messages: [{ role: 'user', content: 'Cancel mid stream' }],
      policy: { maxRetriesPerModel: 0, initialBackoffMs: 100, maxBackoffMs: 100, timeoutMs: 5000 },
      signal: abortController.signal,
    });
    const abortedRaw = cap.getMetrics().raw;
    expect(abortedRaw).toContain('"aborted":true');

    // 2. Cooldown circuit breaker & expiration probe
    const pastNow = Date.now() - 120_000;
    recordModelAttemptFailure('perf-m1', 'RATE_LIMIT', '429 rate limited', 2, pastNow, 50);

    const models: ServerModelConfig[] = [
      {
        id: 'perf-m1',
        displayName: 'Model 1',
        providerName: 'P1',
        modelId: 'm1',
        protocol: 'openai-compatible',
        priority: 1,
        enabled: true,
      },
      {
        id: 'perf-m2',
        displayName: 'Model 2',
        providerName: 'P2',
        modelId: 'm2',
        protocol: 'openai-compatible',
        priority: 2,
        enabled: true,
      },
    ];

    // Active cooldown skips Model 1
    const duringCooldown = orderModelsWithHealthAndRoles({
      models,
      routingMode: 'auto',
      now: pastNow + 5000,
    });
    expect(duringCooldown.skippedCooldownIds).toContain('perf-m1');
    expect(duringCooldown.ordered[0].id).toBe('perf-m2');

    // When all models are in active cooldown, probingRecovery becomes true
    recordModelAttemptFailure('perf-m2', 'RATE_LIMIT', '429 rate limited', 2, pastNow + 4000, 50);
    const allCooling = orderModelsWithHealthAndRoles({
      models,
      routingMode: 'auto',
      now: pastNow + 5000,
    });
    expect(allCooling.probingRecovery).toBe(true);

    // After cooldown expires, Model 1 recovers out of cooldown back to priority #1
    const afterCooldown = orderModelsWithHealthAndRoles({
      models,
      routingMode: 'auto',
      now: Date.now(),
    });
    expect(afterCooldown.skippedCooldownIds).not.toContain('perf-m1');
    expect(afterCooldown.probingRecovery).toBe(false);
    expect(afterCooldown.ordered[0].id).toBe('perf-m1');
  });
});
