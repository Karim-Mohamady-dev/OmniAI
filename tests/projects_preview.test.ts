// @vitest-environment node
import express from 'express';
import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import previewRouter from '../server/routes/preview.ts';
import { parseAiProjectChanges, detectProjectDependencies } from '../src/project-engine/aiProjectParser.ts';
import {
  deleteProjectPath,
  renameProjectPath,
  upsertProjectFile,
  validateProjectPath,
} from '../src/project-engine/fileOperations.ts';

describe('Project File Operations & AI Change Parser', () => {
  it('blocks path traversal and sensitive .env files', () => {
    expect(validateProjectPath('../secret.txt').valid).toBe(false);
    expect(validateProjectPath('.env').valid).toBe(false);
    expect(validateProjectPath('.env.local').valid).toBe(false);
    expect(validateProjectPath('src/App.tsx')).toEqual({
      valid: true,
      normalized: 'src/App.tsx',
    });

    const initial = [{ path: 'src/App.tsx', content: 'export default function App(){}', updatedAt: 1 }];
    const blocked = upsertProjectFile(initial, '../outside.ts', 'bad');
    expect(blocked.error).toBeDefined();
    expect(blocked.files).toHaveLength(1);
  });

  it('renames and deletes project files cleanly without leaving orphans', () => {
    const files = [
      { path: 'src/Old.tsx', content: 'export const X = 1;', updatedAt: 1 },
      { path: 'src/keep.ts', content: 'export const Y = 2;', updatedAt: 1 },
    ];
    const renamed = renameProjectPath(files, 'src/Old.tsx', 'src/New.tsx');
    expect(renamed.error).toBeUndefined();
    expect(renamed.files.some((f) => f.path === 'src/New.tsx')).toBe(true);
    expect(renamed.files.some((f) => f.path === 'src/Old.tsx')).toBe(false);

    const deleted = deleteProjectPath(renamed.files, 'src/New.tsx');
    expect(deleted).toHaveLength(1);
    expect(deleted[0].path).toBe('src/keep.ts');
  });

  it('parses structured <omni_plan>, <omni_file>, <omni_rename>, <omni_delete>, <omni_summary>', () => {
    const raw = `
<omni_plan>1. Add Header\n2. Remove Legacy</omni_plan>
<omni_file path="src/Header.tsx">
export function Header() { return <header>OmniAI</header>; }
</omni_file>
<omni_rename from="src/Old.tsx" to="src/Modern.tsx" />
<omni_delete path="src/Legacy.tsx" />
<omni_summary>Updated header and cleaned up legacy module.</omni_summary>
`;
    const parsed = parseAiProjectChanges(raw);
    expect(parsed.plan).toContain('Add Header');
    expect(parsed.writes).toHaveLength(1);
    expect(parsed.writes[0].path).toBe('src/Header.tsx');
    expect(parsed.renames).toEqual([{ from: 'src/Old.tsx', to: 'src/Modern.tsx' }]);
    expect(parsed.deletes).toEqual(['src/Legacy.tsx']);
    expect(parsed.summary).toContain('Updated header');
  });

  it('detects external npm packages not included in sandbox preview', () => {
    const deps = detectProjectDependencies([
      {
        path: 'package.json',
        content: JSON.stringify({ dependencies: { react: '^19.0.0', axios: '^1.7.0' } }),
      },
      {
        path: 'src/App.tsx',
        content: `import React from 'react';\nimport axios from 'axios';\nimport { Home } from 'lucide-react';`,
      },
    ]);
    expect(deps.declared).toContain('axios');
    expect(deps.unsupportedInPreview).toEqual(['axios']);
  });
});

describe('Sandboxed Live Preview Bundler API', () => {
  let server: http.Server;
  let baseUrl = '';

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
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

  it('compiles a React TSX + Tailwind project into a self-contained HTML preview', async () => {
    const res = await fetch(`${baseUrl}/api/preview/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        framework: 'react-vite',
        files: [
          {
            path: 'src/App.tsx',
            content:
              'import React from "react"; export default function App(){ return <div className="p-4 text-blue-600">Preview OK</div>; }',
          },
        ],
      }),
    });

    const data = (await res.json()) as { ok: boolean; html: string; errors: unknown[] };
    expect(data.ok).toBe(true);
    expect(data.errors).toEqual([]);
    expect(data.html).toContain('omniai-preview');
    expect(data.html).toContain('Preview OK');
  });

  it('reports structured syntax and missing import errors cleanly', async () => {
    const res = await fetch(`${baseUrl}/api/preview/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        framework: 'react-vite',
        files: [
          {
            path: 'src/App.tsx',
            content: 'import Missing from "./DoesNotExist"; export default function App() { return <div',
          },
        ],
      }),
    });

    const data = (await res.json()) as { ok: boolean; errors: Array<{ text: string }> };
    expect(data.ok).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
  });
});
