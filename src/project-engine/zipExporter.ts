import JSZip from 'jszip';
import type { Project } from '../types/index.ts';

const EXCLUDED_PATTERNS = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /secrets?\.(json|ya?ml|txt)$/i,
];

function isExcludedFromExport(filePath: string): boolean {
  const normalized = filePath.replace(/^\/+/, '');
  if (normalized.toLowerCase() === '.env.example') return false;
  const baseName = normalized.split('/').pop() || normalized;
  return EXCLUDED_PATTERNS.some((re) => re.test(baseName) || re.test(normalized));
}

export async function buildProjectZipArchive(project: Project): Promise<{
  blob: Blob;
  fileCount: number;
  excludedCount: number;
  filename: string;
}> {
  const zip = new JSZip();
  const folderName =
    project.name
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-|-$/g, '') || 'omniai-project';

  const root = zip.folder(folderName)!;
  let fileCount = 0;
  let excludedCount = 0;

  for (const file of project.files) {
    const cleanPath = file.path.replace(/^\/+/, '');
    if (!cleanPath || isExcludedFromExport(cleanPath)) {
      excludedCount += 1;
      continue;
    }
    root.file(cleanPath, file.content);
    fileCount += 1;
  }

  // Ensure README.md exists
  if (!project.files.some((f) => f.path.toLowerCase() === 'readme.md')) {
    root.file(
      'README.md',
      `# ${project.name}\n\n${project.description || 'Exported from OmniAI Studio'}\n`
    );
    fileCount += 1;
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const filename = `${folderName}.zip`;
  return { blob, fileCount, excludedCount, filename };
}

export async function downloadProjectAsZip(project: Project): Promise<{
  fileCount: number;
  excludedCount: number;
  filename: string;
}> {
  const { blob, fileCount, excludedCount, filename } = await buildProjectZipArchive(project);
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  return { fileCount, excludedCount, filename };
}
