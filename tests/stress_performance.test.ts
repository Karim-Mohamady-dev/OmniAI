// @vitest-environment node
import express from 'express';
import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import previewRouter from '../server/routes/preview.ts';
import { computeSimpleChecksum, validateBackupPayload } from '../src/storage/backupValidator.ts';
import type { Project, ProjectFile } from '../src/types/index.ts';

describe('Stress & Performance Benchmarks', () => {
  let server: http.Server;
  let baseUrl = '';

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/preview', previewRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('bundles a 50-file React project under 3000ms cleanly', async () => {
    const files: ProjectFile[] = [];
    const imports: string[] = [];
    const renders: string[] = [];

    for (let i = 0; i < 48; i++) {
      files.push({
        path: `src/components/Widget${i}.tsx`,
        content: `import React from 'react';\nexport function Widget${i}() { return <div>Widget ${i}</div>; }\n`,
        updatedAt: Date.now(),
      });
      imports.push(`import { Widget${i} } from './components/Widget${i}.tsx';`);
      renders.push(`<Widget${i} key="${i}" />`);
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

    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/preview/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ framework: 'react-vite', files }),
    });
    const data = (await res.json()) as { ok: boolean; html: string; errors: unknown[] };
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(true);
    expect(data.ok).toBe(true);
    expect(data.errors).toEqual([]);
    expect(elapsed).toBeLessThan(3000);
    expect(data.html.length).toBeGreaterThan(200);
  });

  it('validates a large 150-message, 50-file workspace backup with checksum under 500ms', () => {
    const project: Project = {
      id: 'proj-stress',
      name: 'Large Workspace',
      description: 'Stress test project',
      framework: 'react-vite',
      files: Array.from({ length: 50 }, (_, idx) => ({
        path: `src/modules/mod_${idx}.ts`,
        content: `export const val_${idx} = ${idx};\n`.repeat(20),
        updatedAt: 1700000000000,
      })),
      activities: [],
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };

    const conv = {
      id: 'conv-stress',
      title: 'Long Thread',
      pinned: false,
      selectedModelId: 'auto',
      messages: Array.from({ length: 150 }, (_, idx) => ({
        id: `m-${idx}`,
        role: idx % 2 === 0 ? 'user' : 'assistant',
        content: `Message content iteration #${idx}: deterministic verification payload.`,
        createdAt: 1700000000000 + idx,
      })),
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };

    const base = {
      schemaVersion: 3,
      exportedAt: 1700000000000,
      models: [],
      conversations: [conv],
      folders: [],
      projects: [project],
      snapshots: [],
      usageRecords: [],
      settings: null,
    };
    const payload = { ...base, checksum: computeSimpleChecksum(base) };

    const started = Date.now();
    const res = validateBackupPayload(payload);
    const elapsed = Date.now() - started;

    expect(res.valid).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });
});
