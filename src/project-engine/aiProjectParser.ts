export interface ParsedProjectChangeSet {
  plan?: string;
  summary?: string;
  writes: Array<{ path: string; content: string }>;
  renames: Array<{ from: string; to: string }>;
  deletes: string[];
}

/**
 * Parses structured file modification tags emitted by the AI Builder:
 * <omni_plan>...</omni_plan>
 * <omni_file path="src/App.tsx">...</omni_file>
 * <omni_rename from="src/Old.tsx" to="src/New.tsx" />
 * <omni_delete path="src/old.tsx" />
 * <omni_summary>...</omni_summary>
 */
export function parseAiProjectChanges(rawText: string): ParsedProjectChangeSet {
  const result: ParsedProjectChangeSet = {
    writes: [],
    renames: [],
    deletes: [],
  };

  const planMatch = rawText.match(/<omni_plan>([\s\S]*?)<\/omni_plan>/i);
  if (planMatch) {
    result.plan = planMatch[1].trim();
  }

  const summaryMatch = rawText.match(/<omni_summary>([\s\S]*?)<\/omni_summary>/i);
  if (summaryMatch) {
    result.summary = summaryMatch[1].trim();
  }

  const fileRegex = /<omni_file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/omni_file>/gi;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(rawText)) !== null) {
    const filePath = match[1].trim();
    let content = match[2];
    if (content.startsWith('\n')) content = content.slice(1);
    if (content.endsWith('\n')) content = content.slice(0, -1);
    const fenceMatch = content.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
    if (fenceMatch) {
      content = fenceMatch[1];
    }
    if (filePath) {
      result.writes.push({ path: filePath, content: content + '\n' });
    }
  }

  const renameRegex =
    /<omni_rename\s+from=["']([^"']+)["']\s+to=["']([^"']+)["']\s*\/?>/gi;
  while ((match = renameRegex.exec(rawText)) !== null) {
    const from = match[1].trim();
    const to = match[2].trim();
    if (from && to && from !== to) {
      result.renames.push({ from, to });
    }
  }

  const deleteRegex = /<omni_delete\s+path=["']([^"']+)["']\s*\/?>/gi;
  while ((match = deleteRegex.exec(rawText)) !== null) {
    const delPath = match[1].trim();
    if (delPath) result.deletes.push(delPath);
  }

  return result;
}

const BUILTIN_PREVIEW_PACKAGES = new Set([
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'lucide-react',
]);

export function detectProjectDependencies(
  files: Array<{ path: string; content: string }>
): { declared: string[]; externalImports: string[]; unsupportedInPreview: string[] } {
  const declared = new Set<string>();
  const externalImports = new Set<string>();

  const pkgFile = files.find((f) => f.path.toLowerCase() === 'package.json');
  if (pkgFile) {
    try {
      const parsed = JSON.parse(pkgFile.content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      Object.keys(parsed.dependencies || {}).forEach((d) => declared.add(d));
    } catch {
      // ignore invalid package.json
    }
  }

  const importRe = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|require\()\s*['"]([^'"]+)['"]/g;
  for (const file of files) {
    if (!/\.(tsx?|jsx?|mjs)$/i.test(file.path)) continue;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(file.content)) !== null) {
      const spec = m[1];
      if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue;
      externalImports.add(spec);
    }
  }

  const unsupportedInPreview = Array.from(externalImports).filter(
    (pkg) =>
      !BUILTIN_PREVIEW_PACKAGES.has(pkg) &&
      !pkg.startsWith('react/') &&
      !pkg.startsWith('react-dom/')
  );

  return {
    declared: Array.from(declared),
    externalImports: Array.from(externalImports),
    unsupportedInPreview,
  };
}
