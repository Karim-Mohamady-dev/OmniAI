import type { ProjectFile } from '../types/index.ts';

export interface PreviewBundleError {
  text: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface PreviewBundleResult {
  ok: boolean;
  html: string;
  errors: PreviewBundleError[];
  warnings: PreviewBundleError[];
  buildTimeMs: number;
}

export async function bundleProjectForPreview(
  files: ProjectFile[],
  framework: 'react-vite' | 'html-js'
): Promise<PreviewBundleResult> {
  const res = await fetch('/api/preview/bundle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: files.map((f) => ({ path: f.path, content: f.content })),
      framework,
    }),
  });

  if (!res.ok) {
    return {
      ok: false,
      html: '',
      errors: [{ text: `Preview bundler request failed (HTTP ${res.status})` }],
      warnings: [],
      buildTimeMs: 0,
    };
  }
  return res.json();
}
