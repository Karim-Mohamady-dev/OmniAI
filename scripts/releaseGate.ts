import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type GateStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT CONFIGURED' | 'MOCK VERIFIED';

interface GateStep {
  id: number;
  name: string;
  command: string;
  status: GateStatus;
  detail: string;
  durationMs: number;
}

async function runCmd(cmd: string, args: string[], cwd: string = process.cwd()): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}> {
  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: process.env,
    });
    return { code: 0, stdout, stderr, durationMs: Date.now() - started };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout || '',
      stderr: e.stderr || e.message || '',
      durationMs: Date.now() - started,
    };
  }
}

async function main() {
  const steps: GateStep[] = [];
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const hasTestPg = Boolean(
    process.env.TEST_DATABASE_URL?.trim() &&
      process.env.TEST_DATABASE_URL.trim() !== 'postgresql://user:password@localhost:5432/omniai'
  );
  const hasLiveProvider = Boolean(
    process.env.GEMINI_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.ANTHROPIC_API_KEY?.trim() ||
      process.env.CUSTOM_HTTP_URL?.trim()
  );
  const hasGitHub = Boolean(
    (process.env.GITHUB_CLIENT_ID?.trim() && process.env.GITHUB_CLIENT_SECRET?.trim()) ||
      process.env.GITHUB_TEST_TOKEN?.trim()
  );

  // 1. validate:env
  {
    const strictArgs = ['run', 'validate:env'];
    if (process.env.NODE_ENV === 'production') strictArgs.push('--', '--production');
    const r = await runCmd(npmBin, strictArgs);
    steps.push({
      id: 1,
      name: 'validate:env',
      command: `npm ${strictArgs.join(' ')}`,
      status: r.code === 0 ? 'PASS' : 'FAIL',
      detail: r.code === 0 ? 'Environment config valid for active mode' : (r.stdout + r.stderr).trim().split('\n').slice(-2).join(' | '),
      durationMs: r.durationMs,
    });
  }

  // 2. typecheck / lint
  {
    const r = await runCmd(npmBin, ['run', 'lint']);
    steps.push({
      id: 2,
      name: 'typecheck',
      command: 'npm run lint',
      status: r.code === 0 ? 'PASS' : 'FAIL',
      detail: r.code === 0 ? 'tsc --noEmit exited 0' : (r.stderr || r.stdout).slice(0, 200),
      durationMs: r.durationMs,
    });
  }

  // 3. vitest unit/security/agent tests
  {
    const r = await runCmd(npxBin, ['vitest', 'run', '--exclude', 'tests/postgres_live.test.ts']);
    const line = r.stdout.split('\n').find((l) => l.includes('Tests '))?.trim() || `exit=${r.code}`;
    steps.push({
      id: 3,
      name: 'vitest_core_suites',
      command: 'npx vitest run --exclude tests/postgres_live.test.ts',
      status: r.code === 0 ? 'PASS' : 'FAIL',
      detail: line,
      durationMs: r.durationMs,
    });
  }

  // 4. live PostgreSQL tests & 11-step release gate
  {
    if (!hasTestPg) {
      steps.push({
        id: 4,
        name: 'postgres_live_gate',
        command: 'npm run test:postgres && npm run test:postgres:release',
        status: 'BLOCKED',
        detail: 'TEST_DATABASE_URL is not configured in environment.',
        durationMs: 0,
      });
    } else {
      const r1 = await runCmd(npmBin, ['run', 'test:postgres']);
      const r2 = await runCmd(npmBin, ['run', 'test:postgres:release']);
      const ok = r1.code === 0 && r2.code === 0;
      steps.push({
        id: 4,
        name: 'postgres_live_gate',
        command: 'npm run test:postgres && npm run test:postgres:release',
        status: ok ? 'PASS' : 'FAIL',
        detail: ok ? 'Live PostgreSQL vitest + 11-step gate passed' : (r2.stderr || r1.stderr).slice(0, 200),
        durationMs: r1.durationMs + r2.durationMs,
      });
    }
  }

  // 5. production web build
  {
    const r = await runCmd(npmBin, ['run', 'build']);
    steps.push({
      id: 5,
      name: 'web_production_build',
      command: 'npm run build',
      status: r.code === 0 ? 'PASS' : 'FAIL',
      detail: r.code === 0 ? 'dist/ production Vite bundle created' : r.stderr.slice(0, 200),
      durationMs: r.durationMs,
    });
  }

  // 6. production smoke test (must use PostgreSQL)
  {
    const r = await runCmd(npmBin, ['run', 'test:smoke']);
    const status: GateStatus = r.code === 0 ? 'PASS' : r.code === 2 ? 'BLOCKED' : 'FAIL';
    steps.push({
      id: 6,
      name: 'production_smoke_test',
      command: 'npm run test:smoke',
      status,
      detail:
        status === 'PASS'
          ? 'All smoke checks passed against PostgreSQL'
          : (r.stderr || r.stdout).trim().split('\n')[0] || `exit=${r.code}`,
      durationMs: r.durationMs,
    });
  }

  // 7. Playwright E2E suite
  {
    const r = await runCmd(npmBin, ['run', 'test:e2e']);
    const summaryLine = r.stdout.split('\n').find((l) => l.includes('passed'))?.trim() || `exit=${r.code}`;
    steps.push({
      id: 7,
      name: 'playwright_e2e',
      command: 'npm run test:e2e',
      status: r.code === 0 ? 'PASS' : 'FAIL',
      detail: summaryLine,
      durationMs: r.durationMs,
    });
  }

  // 8. Provider checks (mock baseline + live check)
  {
    const mockRun = await runCmd(npmBin, ['run', 'test:providers', '--', '--mock']);
    if (!hasLiveProvider) {
      steps.push({
        id: 8,
        name: 'provider_verification',
        command: 'npm run test:providers',
        status: mockRun.code === 0 ? 'NOT CONFIGURED' : 'FAIL',
        detail:
          mockRun.code === 0
            ? 'Mock protocol checks passed; live API keys not configured in environment.'
            : 'Mock provider runner failed.',
        durationMs: mockRun.durationMs,
      });
    } else {
      const liveRun = await runCmd(npmBin, ['run', 'test:providers']);
      steps.push({
        id: 8,
        name: 'provider_verification',
        command: 'npm run test:providers',
        status: liveRun.code === 0 && mockRun.code === 0 ? 'PASS' : 'FAIL',
        detail:
          liveRun.stdout.split('\n').find((l) => l.startsWith('Summary:')) || `exit=${liveRun.code}`,
        durationMs: mockRun.durationMs + liveRun.durationMs,
      });
    }
  }

  // 9. GitHub check
  {
    const r = await runCmd(npmBin, ['run', 'test:github']);
    steps.push({
      id: 9,
      name: 'github_verification',
      command: 'npm run test:github',
      status: !hasGitHub ? 'NOT CONFIGURED' : r.code === 0 ? 'PASS' : 'FAIL',
      detail: !hasGitHub
        ? 'GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET/GITHUB_TEST_TOKEN not set.'
        : r.stdout.split('\n').find((l) => l.includes('[REAL PASS]') || l.includes('[PASS]')) || 'Checked',
      durationMs: r.durationMs,
    });
  }

  // 10. Desktop TypeScript build & Windows host gate
  {
    const r = await runCmd(npmBin, ['run', 'build', '--prefix', 'desktop']);
    const isWin = process.platform === 'win32';
    steps.push({
      id: 10,
      name: 'desktop_build_and_packaging',
      command: 'npm run build --prefix desktop',
      status: r.code !== 0 ? 'FAIL' : isWin ? 'PASS' : 'BLOCKED',
      detail:
        r.code !== 0
          ? r.stderr.slice(0, 200)
          : isWin
            ? 'Desktop main/preload compiled cleanly on win32.'
            : 'Desktop TypeScript compiled on linux; Windows .exe packaging requires windows-latest CI or Windows host.',
      durationMs: r.durationMs,
    });
  }

  console.log('\n================ OmniAI Studio Release Gate Summary ================');
  for (const s of steps) {
    console.log(
      `[${s.status.padEnd(14)}] #${String(s.id).padStart(2, '0')} ${s.name.padEnd(28)} (${String(s.durationMs).padStart(5)}ms) | ${s.detail}`
    );
  }

  const hardFailures = steps.filter((s) => s.status === 'FAIL');
  const blockedCount = steps.filter((s) => s.status === 'BLOCKED' || s.status === 'NOT CONFIGURED').length;

  console.log('\n--------------------------------------------------------------------');
  if (hardFailures.length > 0) {
    console.error(`RELEASE GATE STATUS: FAILED (${hardFailures.length} failing gate(s), ${blockedCount} blocked/unconfigured).`);
    process.exitCode = 1;
  } else if (blockedCount > 0) {
    console.error(
      `RELEASE GATE STATUS: INCOMPLETE / INTERNAL TEST RELEASE (${blockedCount} external/platform gate(s) BLOCKED or NOT CONFIGURED).`
    );
    process.exitCode = 2;
  } else {
    console.log('RELEASE GATE STATUS: ALL GATES PASSED (Ready for BETA RELEASE after interactive OAuth + Windows QA sign-off).');
  }
}

main().catch((err) => {
  console.error('Release gate crashed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
