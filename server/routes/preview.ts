import { createRequire } from 'module';
import * as esbuild from 'esbuild';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { compile as compileTailwind } from 'tailwindcss';

const require = createRequire(import.meta.url);
const router = express.Router();

interface VirtualFile {
  path: string;
  content: string;
}

const RUNTIME_BRIDGE_SCRIPT = `
<script>
(function() {
  const send = (level, message) => {
    try {
      window.parent.postMessage({
        source: 'omniai-preview',
        level: level,
        message: String(message),
        timestamp: Date.now()
      }, '*');
    } catch (_) {}
  };
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const formatArgs = (args) => Array.from(args).map(a => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
  }).join(' ');
  console.log = function() { origLog.apply(console, arguments); send('log', formatArgs(arguments)); };
  console.warn = function() { origWarn.apply(console, arguments); send('warn', formatArgs(arguments)); };
  console.error = function() { origError.apply(console, arguments); send('error', formatArgs(arguments)); };
  window.addEventListener('error', function(e) {
    send('error', (e.message || 'Runtime error') + (e.lineno ? ' (line ' + e.lineno + ')' : ''));
  });
  window.addEventListener('unhandledrejection', function(e) {
    send('error', 'Unhandled Promise Rejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
  });
})();
</script>
`;

const ALLOWED_HOST_PACKAGES = new Set([
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'lucide-react',
]);

let cachedTailwindCompiler: Awaited<ReturnType<typeof compileTailwind>> | null = null;

async function compileProjectTailwind(files: VirtualFile[]): Promise<string> {
  try {
    if (!cachedTailwindCompiler) {
      const twIndexPath = path.resolve(process.cwd(), 'node_modules/tailwindcss/index.css');
      const twIndexCss = fs.readFileSync(twIndexPath, 'utf8');
      cachedTailwindCompiler = await compileTailwind('@import "tailwindcss";', {
        loadStylesheet: async (id) => {
          if (id === 'tailwindcss') {
            return { path: twIndexPath, base: process.cwd(), content: twIndexCss };
          }
          throw new Error(`Unsupported stylesheet import in preview: ${id}`);
        },
      });
    }

    const candidates = new Set<string>();
    const tokenRegex = /[a-zA-Z0-9_:/.\[\]-]+/g;
    for (const f of files) {
      if (/\.(tsx|jsx|ts|js|html)$/i.test(f.path)) {
        const matches = f.content.match(tokenRegex);
        if (matches) {
          for (const m of matches) {
            if (m.length <= 64) candidates.add(m);
          }
        }
      }
    }
    return cachedTailwindCompiler.build(Array.from(candidates));
  } catch {
    return '';
  }
}

function resolveVirtualPath(fileMap: Map<string, string>, importer: string, spec: string): string | null {
  let target = spec;
  if (spec.startsWith('@/')) {
    target = spec.slice(2);
  } else if (spec.startsWith('/')) {
    target = spec.slice(1);
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    const baseDir = importer.includes('/') ? importer.slice(0, importer.lastIndexOf('/')) : '';
    const joined = path.posix.normalize(baseDir ? `${baseDir}/${spec}` : spec);
    target = joined.replace(/^\/+/, '');
  } else {
    return null;
  }

  const candidates = [
    target,
    `${target}.tsx`,
    `${target}.ts`,
    `${target}.jsx`,
    `${target}.js`,
    `${target}.css`,
    `${target}.json`,
    `${target}.svg`,
    `public/${target}`,
    `${target}/index.tsx`,
    `${target}/index.ts`,
    `${target}/index.jsx`,
    `${target}/index.js`,
  ];

  for (const cand of candidates) {
    if (fileMap.has(cand)) return cand;
  }
  return null;
}

function getLoader(filePath: string): esbuild.Loader {
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.ts')) return 'ts';
  if (filePath.endsWith('.jsx')) return 'jsx';
  if (filePath.endsWith('.json')) return 'json';
  if (filePath.endsWith('.css')) return 'css';
  return 'js';
}

router.post('/bundle', async (req, res) => {
  const started = Date.now();
  try {
    const { files, framework } = req.body as {
      files?: VirtualFile[];
      framework?: 'react-vite' | 'html-js';
    };

    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({
        ok: false,
        errors: [{ text: 'Project has no files to preview.' }],
        warnings: [],
        buildTimeMs: 0,
      });
      return;
    }

    const fileMap = new Map<string, string>();
    for (const f of files) {
      if (f.path && typeof f.content === 'string') {
        fileMap.set(f.path.replace(/^\/+/, ''), f.content);
      }
    }

    const entryCandidates = [
      'src/main.tsx',
      'src/main.jsx',
      'src/index.tsx',
      'src/index.jsx',
      'src/App.tsx',
      'src/App.jsx',
    ];
    const entryPath = entryCandidates.find((p) => fileMap.has(p));

    // HTML/JS mode or no React entry point
    if (framework === 'html-js' || !entryPath) {
      let html = fileMap.get('index.html') || '<!doctype html><html><body><p>No index.html found.</p></body></html>';

      // Inline local CSS links
      html = html.replace(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi, (full, href: string) => {
        if (/^https?:\/\//i.test(href)) return full;
        const clean = href.replace(/^\.?\//, '');
        const css = fileMap.get(clean);
        return css !== undefined ? `<style>\n${css}\n</style>` : full;
      });

      // Inline local JS scripts
      html = html.replace(/<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/gi, (full, src: string) => {
        if (/^https?:\/\//i.test(src)) return full;
        const clean = src.replace(/^\.?\//, '');
        const js = fileMap.get(clean);
        return js !== undefined ? `<script>\n${js}\n</script>` : full;
      });

      if (html.includes('<head>')) {
        html = html.replace('<head>', `<head>${RUNTIME_BRIDGE_SCRIPT}`);
      } else {
        html = `${RUNTIME_BRIDGE_SCRIPT}${html}`;
      }

      res.json({
        ok: true,
        html,
        errors: [],
        warnings: [],
        buildTimeMs: Date.now() - started,
      });
      return;
    }

    const collectedCss: string[] = [];

    const virtualPlugin: esbuild.Plugin = {
      name: 'omniai-virtual-fs',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === 'entry-point') {
            return { path: args.path.replace(/^\.?\//, ''), namespace: 'vfs' };
          }
          // Let esbuild handle imports originating from inside real node_modules files
          if (args.namespace === 'file') {
            return undefined;
          }
          if (args.path.startsWith('.') || args.path.startsWith('/') || args.path.startsWith('@/')) {
            const resolved = resolveVirtualPath(fileMap, args.importer, args.path);
            if (!resolved) {
              return {
                errors: [
                  {
                    text: `Cannot resolve import "${args.path}" from "${args.importer}"`,
                  },
                ],
              };
            }
            return { path: resolved, namespace: 'vfs' };
          }

          if (ALLOWED_HOST_PACKAGES.has(args.path)) {
            try {
              const resolvedRealPath = require.resolve(args.path, { paths: [process.cwd()] });
              return { path: resolvedRealPath };
            } catch {
              // fallback error below
            }
          }

          return {
            errors: [
              {
                text: `External package "${args.path}" is not available in the browser preview sandbox. Download the project ZIP and run "npm install && npm run dev" locally to bundle custom npm dependencies.`,
              },
            ],
          };
        });

        build.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => {
          const content = fileMap.get(args.path);
          if (content === undefined) {
            return { errors: [{ text: `Missing virtual file: ${args.path}` }] };
          }
          if (args.path.endsWith('.css')) {
            const cleaned = content.replace(/@import\s+["']tailwindcss["']\s*;?/g, '');
            collectedCss.push(cleaned);
            return { contents: '/* css collected */', loader: 'js' };
          }
          if (args.path.endsWith('.svg')) {
            const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(content)}`;
            return { contents: `export default ${JSON.stringify(dataUri)};`, loader: 'js' };
          }
          if (args.path.endsWith('.txt') || args.path.endsWith('.md')) {
            return { contents: `export default ${JSON.stringify(content)};`, loader: 'js' };
          }
          return {
            contents: content,
            loader: getLoader(args.path),
          };
        });
      },
    };

    const effectiveEntry =
      entryPath === 'src/App.tsx' || entryPath === 'src/App.jsx'
        ? '__virtual_entry__.tsx'
        : entryPath;

    if (effectiveEntry === '__virtual_entry__.tsx') {
      fileMap.set(
        '__virtual_entry__.tsx',
        `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './${entryPath}';
const rootEl = document.getElementById('root');
if (rootEl) createRoot(rootEl).render(<App />);`
      );
    }

    const result = await esbuild.build({
      entryPoints: [effectiveEntry],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: ['es2020'],
      jsx: 'automatic',
      plugins: [virtualPlugin],
      define: {
        'process.env.NODE_ENV': '"production"',
      },
    });

    const jsOutput = result.outputFiles?.[0]?.text || '';
    const tailwindCss = await compileProjectTailwind(files);

    // Collect any standalone CSS files in case they weren't imported in JS
    const rawCssFiles = files
      .filter((f) => f.path.endsWith('.css'))
      .map((f) => f.content.replace(/@import\s+["']tailwindcss["']\s*;?/g, ''));

    const finalCss = [tailwindCss, ...rawCssFiles, ...collectedCss].filter(Boolean).join('\n');

    const titleMatch = (fileMap.get('index.html') || '').match(/<title>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : 'OmniAI Preview';

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    ${RUNTIME_BRIDGE_SCRIPT}
    <style>${finalCss}</style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      try {
        ${jsOutput.replace(/<\/script>/gi, '<\\/script>')}
      } catch (err) {
        console.error(err && err.message ? err.message : String(err));
        var root = document.getElementById('root');
        if (root) {
          root.innerHTML = '<div style="padding:24px;font-family:monospace;color:#dc2626;background:#fef2f2;border:1px solid #fecaca;margin:16px;border-radius:8px;"><strong>Runtime Error:</strong> ' + String(err) + '</div>';
        }
      }
    </script>
  </body>
</html>`;

    res.json({
      ok: true,
      html,
      errors: [],
      warnings: result.warnings.map((w) => ({
        text: w.text,
        file: w.location?.file,
        line: w.location?.line,
      })),
      buildTimeMs: Date.now() - started,
    });
  } catch (err) {
    const esErr = err as {
      errors?: Array<{ text: string; location?: { file?: string; line?: number; column?: number } }>;
      message?: string;
    };
    const errors =
      Array.isArray(esErr.errors) && esErr.errors.length > 0
        ? esErr.errors.map((e) => ({
            text: e.text,
            file: e.location?.file,
            line: e.location?.line,
            column: e.location?.column,
          }))
        : [{ text: esErr.message || String(err) }];

    res.json({
      ok: false,
      html: '',
      errors,
      warnings: [],
      buildTimeMs: Date.now() - started,
    });
  }
});

export default router;
