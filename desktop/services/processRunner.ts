import { spawn, type ChildProcess } from 'child_process';
import { validateDesktopCommand } from '../security/validators';

export interface ProcessOutputEvent {
  processId: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  detectedUrl?: string;
}

export interface ProcessExitEvent {
  processId: string;
  code: number | null;
  timedOut?: boolean;
}

interface ActiveProcessEntry {
  child: ChildProcess;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  killFallbackTimer?: ReturnType<typeof setTimeout>;
}

export class DesktopProcessRunner {
  private activeProcesses = new Map<string, ActiveProcessEntry>();

  runCommand(params: {
    processId: string;
    workspaceRoot: string;
    command: string;
    timeoutMs?: number;
    onOutput: (evt: ProcessOutputEvent) => void;
    onExit: (evt: ProcessExitEvent) => void;
  }): void {
    const validation = validateDesktopCommand(params.command);
    if (!validation.allowed) {
      throw new Error(validation.reason || 'Command rejected by desktop security policy.');
    }

    const bin =
      process.platform === 'win32' &&
      (validation.executable === 'npm' || validation.executable === 'npx')
        ? `${validation.executable}.cmd`
        : validation.executable;

    const child = spawn(bin, validation.args, {
      cwd: params.workspaceRoot,
      shell: false,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
    });

    const entry: ActiveProcessEntry = { child };
    let timedOut = false;

    if (typeof params.timeoutMs === 'number' && params.timeoutMs > 0) {
      entry.timeoutTimer = setTimeout(() => {
        timedOut = true;
        params.onOutput({
          processId: params.processId,
          stream: 'stderr',
          text: `Command exceeded timeout of ${params.timeoutMs}ms and was terminated.`,
        });
        child.kill('SIGTERM');
        entry.killFallbackTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already exited
          }
        }, 1500);
        entry.killFallbackTimer.unref?.();
      }, params.timeoutMs);
      entry.timeoutTimer.unref?.();
    }

    this.activeProcesses.set(params.processId, entry);

    const handleChunk = (stream: 'stdout' | 'stderr', buf: Buffer) => {
      const text = buf.toString('utf8');
      const urlMatch = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}[^\s]*/i);
      params.onOutput({
        processId: params.processId,
        stream,
        text,
        detectedUrl: urlMatch?.[0],
      });
    };

    const cleanupEntry = () => {
      const existing = this.activeProcesses.get(params.processId);
      if (existing) {
        if (existing.timeoutTimer) clearTimeout(existing.timeoutTimer);
        if (existing.killFallbackTimer) clearTimeout(existing.killFallbackTimer);
        this.activeProcesses.delete(params.processId);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => handleChunk('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => handleChunk('stderr', chunk));

    child.on('close', (code) => {
      cleanupEntry();
      params.onExit({ processId: params.processId, code, ...(timedOut ? { timedOut: true } : {}) });
    });

    child.on('error', (err) => {
      cleanupEntry();
      params.onOutput({
        processId: params.processId,
        stream: 'stderr',
        text: err.message,
      });
      params.onExit({ processId: params.processId, code: 1 });
    });
  }

  stopProcess(processId: string): boolean {
    const entry = this.activeProcesses.get(processId);
    if (!entry) return false;
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    entry.child.kill('SIGTERM');
    entry.killFallbackTimer = setTimeout(() => {
      try {
        entry.child.kill('SIGKILL');
      } catch {
        // already exited
      }
    }, 1500);
    entry.killFallbackTimer.unref?.();
    this.activeProcesses.delete(processId);
    return true;
  }

  stopAll(): void {
    for (const id of Array.from(this.activeProcesses.keys())) {
      this.stopProcess(id);
    }
  }
}
