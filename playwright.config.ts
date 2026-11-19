import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: {
    timeout: 12000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      executablePath:
        '/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  },
  webServer: {
    command:
      'npm run build && NODE_ENV=production OMNIAI_ISOLATED_TEST_HARNESS=true OMNIAI_TEST_RUNNER=playwright OMNIAI_TEST_MEMORY_DB=true OMNIAI_MASTER_KEY=e2e-test-master-key-32bytes-minimum PORT=3100 APP_URL=http://localhost:3100 ALLOW_LOCAL_MODEL_URLS=true npx tsx server.ts',
    url: 'http://localhost:3100/api/health',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
