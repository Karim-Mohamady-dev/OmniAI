import fs from 'fs';
import path from 'path';

const BLOCKED_FILES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'id_rsa',
  'id_ed25519',
]);

const BLOCKED_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];

export interface SafePathResult {
  valid: boolean;
  resolvedPath: string;
  normalizedRelative: string;
  error?: string;
}

export function resolveSafeProjectPath(workspaceRoot: string, relativePath: string): SafePathResult {
  if (!workspaceRoot || !workspaceRoot.trim()) {
    return { valid: false, resolvedPath: '', normalizedRelative: '', error: 'No workspace folder is authorized.' };
  }

  const raw = (relativePath || '').trim();
  if (!raw || raw.includes('\0') || /^[a-zA-Z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    return { valid: false, resolvedPath: '', normalizedRelative: '', error: 'Invalid or absolute file path is not allowed.' };
  }

  const posixRel = raw.replace(/\\/g, '/');
  const segments = posixRel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return {
      valid: false,
      resolvedPath: '',
      normalizedRelative: '',
      error: 'Path traversal segments ("..") are strictly prohibited.',
    };
  }

  if (segments.includes('.git') || segments.includes('node_modules')) {
    return {
      valid: false,
      resolvedPath: '',
      normalizedRelative: '',
      error: 'Direct modification of .git or node_modules is blocked.',
    };
  }

  const fileName = segments[segments.length - 1].toLowerCase();
  if (BLOCKED_FILES.has(fileName) || BLOCKED_EXTENSIONS.some((ext) => fileName.endsWith(ext))) {
    return {
      valid: false,
      resolvedPath: '',
      normalizedRelative: '',
      error: `Access to sensitive credential file "${fileName}" is restricted.`,
    };
  }

  const rootAbs = path.resolve(workspaceRoot);
  const targetAbs = path.resolve(rootAbs, ...segments);
  const relCheck = path.relative(rootAbs, targetAbs);

  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return {
      valid: false,
      resolvedPath: '',
      normalizedRelative: '',
      error: 'Resolved path escapes the authorized workspace directory.',
    };
  }

  return {
    valid: true,
    resolvedPath: targetAbs,
    normalizedRelative: segments.join('/'),
  };
}

/**
 * Symlink-safe filesystem confinement validator.
 * Rejects any symbolic links along the path or realpath targets outside the canonical workspace root.
 */
export function resolveRealSafeProjectPath(workspaceRoot: string, relativePath: string): SafePathResult {
  const lexical = resolveSafeProjectPath(workspaceRoot, relativePath);
  if (!lexical.valid) return lexical;

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(workspaceRoot);
  } catch {
    return {
      valid: false,
      resolvedPath: '',
      normalizedRelative: '',
      error: 'Authorized workspace folder does not exist on disk.',
    };
  }

  const segments = lexical.normalizedRelative.split('/');
  let cursor = realRoot;

  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    if (!fs.existsSync(cursor)) {
      // Check lstat too in case it's a dangling symlink!
      try {
        const lstat = fs.lstatSync(cursor);
        if (lstat.isSymbolicLink()) {
          return {
            valid: false,
            resolvedPath: '',
            normalizedRelative: '',
            error: 'Symbolic links are blocked inside authorized workspaces.',
          };
        }
      } catch {
        // Non-existent path segment (will be created later under verified parent realRoot)
      }
      continue;
    }

    const lstat = fs.lstatSync(cursor);
    if (lstat.isSymbolicLink()) {
      return {
        valid: false,
        resolvedPath: '',
        normalizedRelative: '',
        error: 'Symbolic links are blocked inside authorized workspaces.',
      };
    }

    const realCursor = fs.realpathSync(cursor);
    const rel = path.relative(realRoot, realCursor);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return {
        valid: false,
        resolvedPath: '',
        normalizedRelative: '',
        error: 'Resolved real path escapes the authorized workspace directory.',
      };
    }
  }

  return {
    valid: true,
    resolvedPath: path.join(realRoot, ...segments),
    normalizedRelative: lexical.normalizedRelative,
  };
}

export interface CommandValidationResult {
  allowed: boolean;
  executable: string;
  args: string[];
  requiresConfirmation: boolean;
  reason?: string;
}

const ALLOWED_BINARIES = new Set(['npm', 'npx', 'node', 'git']);
const ALLOWED_NPM_SUBCOMMANDS = new Set(['install', 'ci', 'run', 'test', 'build']);
const ALLOWED_NPM_SCRIPTS = new Set(['dev', 'build', 'start', 'preview', 'lint', 'test']);
const ALLOWED_NPX_TOOLS = new Set(['tsc', 'vite', 'vitest', 'playwright', 'tailwindcss', 'esbuild']);
const BLOCKED_NODE_FLAGS = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-i',
  '--interactive',
]);
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'status',
  'branch',
  'log',
  'diff',
  'add',
  'commit',
  'pull',
  'push',
  'checkout',
]);
const BLOCKED_GIT_FLAGS = new Set(['-c', '--exec', '--upload-pack', '--receive-pack']);
const SHELL_METACHARS = /[;&|`$<>()\n\r]/;

export function tokenizeCommandArgs(rawCommand: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes: '"' | "'" | null = null;
  for (let i = 0; i < rawCommand.length; i++) {
    const ch = rawCommand[i];
    if (inQuotes) {
      if (ch === inQuotes) {
        inQuotes = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuotes = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export function validateDesktopCommand(rawCommand: string): CommandValidationResult {
  const trimmed = (rawCommand || '').trim();
  if (!trimmed) {
    return { allowed: false, executable: '', args: [], requiresConfirmation: false, reason: 'Command is empty.' };
  }

  if (SHELL_METACHARS.test(trimmed)) {
    return {
      allowed: false,
      executable: '',
      args: [],
      requiresConfirmation: false,
      reason: 'Shell metacharacters (;, &&, |, $, backticks, redirects) are blocked for security.',
    };
  }

  const parts = tokenizeCommandArgs(trimmed);
  const bin = (parts[0] || '').toLowerCase();
  const args = parts.slice(1);

  if (!ALLOWED_BINARIES.has(bin)) {
    return {
      allowed: false,
      executable: bin,
      args,
      requiresConfirmation: false,
      reason: `Executable "${bin}" is not in the approved local development allowlist (npm, npx, node, git).`,
    };
  }

  if (bin === 'npm') {
    const sub = (args[0] || '').toLowerCase();
    if (!ALLOWED_NPM_SUBCOMMANDS.has(sub)) {
      return {
        allowed: false,
        executable: bin,
        args,
        requiresConfirmation: false,
        reason: `npm subcommand "${sub}" is not permitted.`,
      };
    }
    if (sub === 'run') {
      const script = args[1] || '';
      if (!ALLOWED_NPM_SCRIPTS.has(script)) {
        return {
          allowed: false,
          executable: bin,
          args,
          requiresConfirmation: false,
          reason: `npm script "${script}" is not in the approved script list (dev, build, start, preview, lint, test).`,
        };
      }
    }
    for (const a of args.slice(1)) {
      const lowerArg = a.toLowerCase();
      if (
        lowerArg.startsWith('http://') ||
        lowerArg.startsWith('https://') ||
        lowerArg.startsWith('git+') ||
        lowerArg.startsWith('file:') ||
        lowerArg.includes('..')
      ) {
        return {
          allowed: false,
          executable: bin,
          args,
          requiresConfirmation: false,
          reason: `Unsafe npm argument "${a}" is blocked by desktop security policy.`,
        };
      }
    }
  }

  if (bin === 'node') {
    if (args.length === 0) {
      return {
        allowed: false,
        executable: bin,
        args,
        requiresConfirmation: false,
        reason: 'Interactive node REPL without a workspace script file is blocked.',
      };
    }
    let scriptTarget = '';
    for (const a of args) {
      const lower = a.toLowerCase();
      const flagName = lower.split('=')[0];
      if (BLOCKED_NODE_FLAGS.has(flagName)) {
        return {
          allowed: false,
          executable: bin,
          args,
          requiresConfirmation: false,
          reason: `Node flag "${flagName}" (inline eval/preload) is blocked by desktop security policy.`,
        };
      }
      if (!scriptTarget && !a.startsWith('-')) {
        scriptTarget = a;
      }
    }
    if (
      !scriptTarget ||
      scriptTarget.startsWith('/') ||
      scriptTarget.includes('..') ||
      !/\.(js|cjs|mjs|ts)$/i.test(scriptTarget)
    ) {
      return {
        allowed: false,
        executable: bin,
        args,
        requiresConfirmation: false,
        reason: 'node execution requires a relative workspace script file (.js, .cjs, .mjs, .ts).',
      };
    }
  }

  if (bin === 'npx') {
    const nonFlagArgs = args.filter((a) => !a.startsWith('-'));
    const tool = (nonFlagArgs[0] || '').toLowerCase();
    if (!tool || !ALLOWED_NPX_TOOLS.has(tool)) {
      return {
        allowed: false,
        executable: bin,
        args,
        requiresConfirmation: false,
        reason: `npx tool "${tool || '(none)'}" is not in the approved local toolchain allowlist (tsc, vite, vitest, playwright, tailwindcss, esbuild).`,
      };
    }
    for (const a of args) {
      if (a === '-y' || a === '--yes' || a.startsWith('--package=') || a === '-p' || a === '--package') {
        return {
          allowed: false,
          executable: bin,
          args,
          requiresConfirmation: false,
          reason: `npx remote package flag "${a}" is blocked by desktop security policy.`,
        };
      }
    }
  }

  if (bin === 'git') {
    const sub = (args[0] || '').toLowerCase();
    if (!ALLOWED_GIT_SUBCOMMANDS.has(sub)) {
      return {
        allowed: false,
        executable: bin,
        args,
        requiresConfirmation: false,
        reason: `git subcommand "${sub}" is not permitted.`,
      };
    }
    for (const a of args) {
      if (BLOCKED_GIT_FLAGS.has(a) || a.startsWith('--upload-pack=') || a.startsWith('--exec=')) {
        return {
          allowed: false,
          executable: bin,
          args,
          requiresConfirmation: false,
          reason: `Git flag "${a}" is blocked by desktop security policy.`,
        };
      }
    }
  }

  return {
    allowed: true,
    executable: bin,
    args,
    requiresConfirmation: true,
  };
}

export function validateDesktopExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.protocol === 'http:' &&
      (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
    ) {
      return true;
    }
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com') {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
