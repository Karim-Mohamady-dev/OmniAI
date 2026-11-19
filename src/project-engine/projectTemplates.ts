import type { Project, ProjectFile } from '../types/index.ts';
import { createId } from '../utils/helpers.ts';

export function createReactViteStarterFiles(projectName: string, description: string): ProjectFile[] {
  const now = Date.now();
  const slug = projectName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'omni-app';

  return [
    {
      path: 'package.json',
      updatedAt: now,
      content: JSON.stringify(
        {
          name: slug,
          private: true,
          version: '0.1.0',
          type: 'module',
          scripts: {
            dev: 'vite',
            build: 'tsc && vite build',
            preview: 'vite preview',
          },
          dependencies: {
            react: '^19.0.0',
            'react-dom': '^19.0.0',
            'lucide-react': '^0.460.0',
          },
          devDependencies: {
            '@types/react': '^19.0.0',
            '@types/react-dom': '^19.0.0',
            '@vitejs/plugin-react': '^4.3.0',
            tailwindcss: '^4.0.0',
            typescript: '^5.6.0',
            vite: '^6.0.0',
          },
        },
        null,
        2
      ),
    },
    {
      path: 'tsconfig.json',
      updatedAt: now,
      content: JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            useDefineForClassFields: true,
            lib: ['ES2020', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            skipLibCheck: true,
            moduleResolution: 'bundler',
            allowImportingTsExtensions: true,
            isolatedModules: true,
            moduleDetection: 'force',
            noEmit: true,
            jsx: 'react-jsx',
            strict: true,
          },
          include: ['src'],
        },
        null,
        2
      ),
    },
    {
      path: 'vite.config.ts',
      updatedAt: now,
      content: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`,
    },
    {
      path: 'index.html',
      updatedAt: now,
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    {
      path: 'src/styles/index.css',
      updatedAt: now,
      content: `:root {
  color-scheme: light;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f8fafc;
  color: #0f172a;
  line-height: 1.5;
}
`,
    },
    {
      path: 'src/components/Header.tsx',
      updatedAt: now,
      content: `import React from 'react';
import { Layers } from 'lucide-react';

interface HeaderProps {
  title: string;
}

export function Header({ title }: HeaderProps) {
  return (
    <header style={{ borderBottom: '1px solid #e2e8f0', background: '#ffffff', padding: '16px 24px' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 700, fontSize: 18 }}>
          <Layers size={20} color="#2563eb" />
          <span>{title}</span>
        </div>
        <span style={{ fontSize: 13, color: '#64748b' }}>React + TypeScript Workspace</span>
      </div>
    </header>
  );
}
`,
    },
    {
      path: 'src/pages/Home.tsx',
      updatedAt: now,
      content: `import React, { useState } from 'react';
import { ArrowRight, CheckCircle2 } from 'lucide-react';

export function Home() {
  const [count, setCount] = useState(0);

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: '48px 24px' }}>
      <section style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 32 }}>
        <h1 style={{ margin: '0 0 12px', fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em' }}>
          ${projectName}
        </h1>
        <p style={{ margin: '0 0 24px', color: '#475569', fontSize: 16, maxWidth: 640 }}>
          ${description || 'Ready for AI-driven development. Describe the features, pages, and design you want in the AI Builder panel.'}
        </p>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            onClick={() => setCount((c) => c + 1)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              background: '#0f172a',
              color: '#ffffff',
              border: 'none',
              borderRadius: 8,
              padding: '10px 18px',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <span>Interactive Counter: {count}</span>
            <ArrowRight size={16} />
          </button>

          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#16a34a' }}>
            <CheckCircle2 size={16} />
            Live sandbox active
          </span>
        </div>
      </section>
    </main>
  );
}
`,
    },
    {
      path: 'src/App.tsx',
      updatedAt: now,
      content: `import React from 'react';
import { Header } from './components/Header';
import { Home } from './pages/Home';

export default function App() {
  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc' }}>
      <Header title="${projectName}" />
      <Home />
    </div>
  );
}
`,
    },
    {
      path: 'src/main.tsx',
      updatedAt: now,
      content: `import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`,
    },
    {
      path: 'README.md',
      updatedAt: now,
      content: `# ${projectName}\n\n${description || 'Generated with OmniAI Studio.'}\n\n## Run Locally\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`,
    },
    {
      path: '.gitignore',
      updatedAt: now,
      content: `node_modules\ndist\n.env\n.env.local\n*.log\n`,
    },
  ];
}

export function createHtmlStarterFiles(projectName: string, description: string): ProjectFile[] {
  const now = Date.now();
  return [
    {
      path: 'index.html',
      updatedAt: now,
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="container">
      <h1>${projectName}</h1>
      <p>${description || 'Static web starter project generated in OmniAI Studio.'}</p>
      <button id="actionBtn">Click to test script</button>
      <p id="status"></p>
    </main>
    <script src="app.js"></script>
  </body>
</html>
`,
    },
    {
      path: 'styles.css',
      updatedAt: now,
      content: `body {
  font-family: system-ui, sans-serif;
  background: #f8fafc;
  color: #0f172a;
  margin: 0;
  padding: 48px 24px;
}
.container {
  max-width: 720px;
  margin: 0 auto;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 32px;
}
button {
  background: #2563eb;
  color: #fff;
  border: none;
  padding: 10px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
}
`,
    },
    {
      path: 'app.js',
      updatedAt: now,
      content: `document.getElementById('actionBtn')?.addEventListener('click', () => {
  const el = document.getElementById('status');
  if (el) el.textContent = 'Interactive JavaScript is working at ' + new Date().toLocaleTimeString();
});
`,
    },
    {
      path: 'README.md',
      updatedAt: now,
      content: `# ${projectName}\n\n${description}\n`,
    },
  ];
}

export function createStarterProject(
  name: string,
  description: string,
  framework: 'react-vite' | 'html-js' = 'react-vite'
): Project {
  const now = Date.now();
  const files =
    framework === 'react-vite'
      ? createReactViteStarterFiles(name, description)
      : createHtmlStarterFiles(name, description);

  return {
    id: createId('proj'),
    name,
    description,
    framework,
    files,
    activities: [
      {
        id: createId('act'),
        action: 'Project created',
        detail: `Initialized ${framework} template with ${files.length} files`,
        timestamp: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}
