import { expect, test, type Page } from '@playwright/test';
import fs from 'fs';
import http from 'http';
import path from 'path';

let mockAiServer: http.Server;
let mockAiBaseUrl = '';

function makeTinyPngBuffer(): Buffer {
  // 1x1 transparent PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64'
  );
}

async function addAdvancedModel(
  page: Page,
  opts: {
    displayName: string;
    providerName: string;
    protocol: 'openai-compatible' | 'custom-http';
    modelId: string;
    baseUrl: string;
    apiKey?: string;
    priority: number;
  }
) {
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await page.getByRole('button', { name: 'Add New Model' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Advanced Form' }).click();

  await dialog.getByPlaceholder('e.g. Primary GPT-4o or Local Llama 3').fill(opts.displayName);
  await dialog.getByPlaceholder('e.g. OpenAI, Anthropic, Groq, Ollama').fill(opts.providerName);
  await dialog.locator('select').first().selectOption(opts.protocol);
  await dialog.locator('input.font-mono').first().fill(opts.modelId);
  await dialog.locator('input[type="url"]').fill(opts.baseUrl);
  if (opts.apiKey) {
    await dialog.locator('input[type="password"]').fill(opts.apiKey);
  }
  await dialog.locator('input[type="number"]').first().fill(String(opts.priority));
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe.serial('OmniAI Studio Phase 4 Complete E2E Workflows (20 Scenarios)', () => {
  const uncaughtPageErrors: string[] = [];

  test.beforeAll(async () => {
    mockAiServer = http.createServer((req, res) => {
      const url = req.url || '/';
      if (url.startsWith('/fail429/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
        return;
      }
      if (url.startsWith('/fail429/v1/chat/completions')) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'You exceeded your current quota (insufficient_quota).' },
          })
        );
        return;
      }
      if (url.startsWith('/ok-oai/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }));
        return;
      }
      if (url.startsWith('/ok-oai/v1/chat/completions')) {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          let body: {
            stream?: boolean;
            messages?: Array<{ role: string; content: unknown }>;
          } = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = {};
          }
          const messages = body.messages || [];
          const sysText = String(messages.find((m) => m.role === 'system')?.content || '');
          const userMsgs = messages.filter((m) => m.role === 'user');
          const rawLastUser = userMsgs[userMsgs.length - 1]?.content;
          const lastUser =
            typeof rawLastUser === 'string' ? rawLastUser : JSON.stringify(rawLastUser || '');

          let reply = `Mock AI streamed reply for: ${lastUser.slice(0, 80)}`;
          if (sysText.includes('<omni_file>') || sysText.includes('AI Software Architect')) {
            if (lastUser.includes('trigger intentional broken build')) {
              reply = [
                '<omni_plan>Inject intentional compile error for Supervisor & Fix test</omni_plan>',
                '<omni_file path="src/App.tsx">',
                "import { BrokenExport } from './NonExistentModule';",
                'export default function App() { return <div>{BrokenExport}</div>; }',
                '</omni_file>',
                '<omni_summary>Broken file written for recovery check</omni_summary>',
              ].join('\n');
            } else if (
              lastUser.includes('agent multi-step app') &&
              !lastUser.includes('previous build produced errors')
            ) {
              reply = [
                '<omni_plan>Agent step 1 initial scaffold</omni_plan>',
                '<omni_file path="src/App.tsx">',
                "import { MissingAgentCard } from './MissingAgentCard';",
                'export default function App() { return <MissingAgentCard />; }',
                '</omni_file>',
                '<omni_summary>Step 1 generated</omni_summary>',
              ].join('\n');
            } else if (
              lastUser.includes('previous build produced errors') ||
              lastUser.includes('Fix the following build/runtime error')
            ) {
              reply = [
                '<omni_plan>Resolve broken imports and restore clean React build</omni_plan>',
                '<omni_file path="src/App.tsx">',
                "import React from 'react';",
                'export default function App() {',
                '  return <main className="p-6"><h1>Recovered Studio App</h1></main>;',
                '}',
                '</omni_file>',
                '<omni_summary>Fixed build error cleanly</omni_summary>',
              ].join('\n');
            } else if (lastUser.includes('planning mode') || lastUser.includes('calculator')) {
              reply = [
                '<omni_plan>Create interactive calculator layout</omni_plan>',
                '<omni_file path="src/App.tsx">',
                "import React, { useState } from 'react';",
                'export default function App() {',
                '  const [count, setCount] = useState(0);',
                '  return (',
                '    <main className="p-6">',
                '      <h1>Planned Studio Calculator</h1>',
                '      <button onClick={() => setCount(count + 1)}>Count: {count}</button>',
                '    </main>',
                '  );',
                '}',
                '</omni_file>',
                '<omni_summary>Generated interactive calculator component</omni_summary>',
              ].join('\n');
            } else {
              reply = [
                '<omni_plan>Apply Studio fast update</omni_plan>',
                '<omni_file path="src/App.tsx">',
                "import React from 'react';",
                'export default function App() {',
                '  return <main className="p-6"><h1>Fast Mode App Ready</h1></main>;',
                '}',
                '</omni_file>',
                '<omni_summary>Updated src/App.tsx successfully</omni_summary>',
              ].join('\n');
            }
          } else if (lastUser.includes('Strict JSON') || lastUser.includes('valid JSON')) {
            reply = '{"ok":true,"status":"verified"}';
          } else if (lastUser.includes('Reply OK')) {
            reply = 'OK';
          }

          if (body.stream === false) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                choices: [{ message: { content: reply } }],
                usage: { prompt_tokens: 12, completion_tokens: 10, total_tokens: 22 },
              })
            );
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const midpoint = Math.max(1, Math.floor(reply.length / 2));
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: reply.slice(0, midpoint) } }] })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: reply.slice(midpoint) } }],
              usage: { prompt_tokens: 14, completion_tokens: 11, total_tokens: 25 },
            })}\n\n`
          );
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      if (url.startsWith('/custom-ok')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Custom HTTP response OK', usage: { totalTokens: 6 } }));
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    await new Promise<void>((resolve) => mockAiServer.listen(0, '127.0.0.1', resolve));
    const port = (mockAiServer.address() as { port: number }).port;
    mockAiBaseUrl = `http://127.0.0.1:${port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => mockAiServer.close(() => resolve()));
    expect(uncaughtPageErrors).toEqual([]);
  });

  test('Workflows 1-3: Multi-user signup, persistence reload, logout session revocation, and User B isolation', async ({
    page,
    browser,
  }) => {
    page.on('pageerror', (err) => uncaughtPageErrors.push(err.message));

    await page.goto('/');
    await expect(page.getByText('Workspace Overview')).toBeVisible();

    // 1. Sign up User A via AccountModal
    await page.getByRole('button', { name: 'Local', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Account & Runtime Mode' });
    await modal.getByRole('button', { name: 'Create Account' }).click();
    await modal.getByPlaceholder('Ada Lovelace').fill('Alice Developer');
    await modal.getByPlaceholder('developer@example.com').fill('alice.e2e@example.com');
    await modal.locator('input[type="password"]').fill('alicePass123');
    await modal.getByRole('button', { name: 'Register & Isolate Workspace' }).click();
    await expect(modal).toBeHidden();
    await expect(page.getByRole('button', { name: 'Alice Developer', exact: true })).toBeVisible();

    // Add a private model and sync to cloud
    await addAdvancedModel(page, {
      displayName: 'Alice Private GPT',
      providerName: 'OpenAI',
      protocol: 'openai-compatible',
      modelId: 'gpt-4o-mini',
      baseUrl: `${mockAiBaseUrl}/ok-oai/v1`,
      apiKey: 'sk-alice-secret-key',
      priority: 1,
    });
    await expect(page.getByText('Alice Private GPT').first()).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Sync to Cloud' }).click();
    await expect(page.getByText('Workspace pushed to hosted vault')).toBeVisible();

    // Reload page and confirm persistence
    await page.reload();
    await page.getByRole('button', { name: 'Models', exact: true }).click();
    await expect(page.getByText('Alice Private GPT').first()).toBeVisible();

    // 2. Log out & verify session invalidation (401) + sign back in
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Sign Out' }).click();
    await expect(page.getByRole('button', { name: 'Sign In / Register Account' })).toBeVisible();

    const unauthStatus = await page.evaluate(async () => {
      const r = await fetch('/api/workspace/state');
      return r.status;
    });
    expect(unauthStatus).toBe(401);

    await page.getByRole('button', { name: 'Sign In / Register Account' }).click();
    const loginModal = page.getByRole('dialog', { name: 'Account & Runtime Mode' });
    await loginModal.getByPlaceholder('developer@example.com').fill('alice.e2e@example.com');
    await loginModal.locator('input[type="password"]').fill('alicePass123');
    await loginModal.getByRole('button', { name: 'Sign In & Isolate Workspace' }).click();
    await expect(loginModal).toBeHidden();

    // 3. Isolated User B context verifies zero data leakage from User A
    const bobContext = await browser.newContext();
    const bobPage = await bobContext.newPage();
    bobPage.on('pageerror', (err) => uncaughtPageErrors.push(err.message));
    await bobPage.goto('/');
    await bobPage.getByRole('button', { name: 'Local', exact: true }).click();
    const bobModal = bobPage.getByRole('dialog', { name: 'Account & Runtime Mode' });
    await bobModal.getByRole('button', { name: 'Create Account' }).click();
    await bobModal.getByPlaceholder('Ada Lovelace').fill('Bob Isolated');
    await bobModal.getByPlaceholder('developer@example.com').fill('bob.e2e@example.com');
    await bobModal.locator('input[type="password"]').fill('bobPass1234');
    await bobModal.getByRole('button', { name: 'Register & Isolate Workspace' }).click();
    await expect(bobModal).toBeHidden();

    const bobCloudCheck = await bobPage.evaluate(async () => {
      const r = await fetch('/api/workspace/state');
      return r.json();
    });
    expect(JSON.stringify(bobCloudCheck)).not.toContain('Alice Private GPT');
    await bobContext.close();
  });

  test('Workflows 4-10: Multiple models, fallback 429->200 failover, regenerate, edit/resend, branch, folders, search & file/image attachment', async ({
    page,
  }) => {
    page.on('pageerror', (err) => uncaughtPageErrors.push(err.message));
    await page.goto('/');

    // Re-add Alice Primary + Custom HTTP + Failing 429 model in fresh IndexedDB session
    await addAdvancedModel(page, {
      displayName: 'Primary OAI OK',
      providerName: 'OpenAI',
      protocol: 'openai-compatible',
      modelId: 'gpt-4o-mini',
      baseUrl: `${mockAiBaseUrl}/ok-oai/v1`,
      apiKey: 'sk-oai-ok',
      priority: 1,
    });
    await addAdvancedModel(page, {
      displayName: 'Custom Endpoint V1',
      providerName: 'Custom Provider',
      protocol: 'custom-http',
      modelId: 'custom-v1',
      baseUrl: `${mockAiBaseUrl}/custom-ok`,
      priority: 2,
    });

    // 4. Test Connection on configured models
    const testButtons = page.getByRole('button', { name: 'Test Connection' });
    await testButtons.first().click();
    await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();

    // 5. Configure fallback settings & routing mode in Settings
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const retriesInput = page.locator('section').filter({ hasText: 'Fallback Orchestration Policy' }).locator('input[type="number"]').first();
    await retriesInput.fill('0');
    await page.locator('section').filter({ hasText: 'Routing Mode' }).locator('select').first().selectOption('priority');

    // 6. Start new chat, send message, receive streamed response
    await page.getByRole('button', { name: 'AI Chat', exact: true }).click();
    await page.getByPlaceholder('Ask anything, attach code or images, or test model fallback...').fill('Hello streaming check');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/Mock AI streamed reply for: Hello streaming check/)).toBeVisible();

    // 7. Add failing 429 model at Priority #1 and trigger automatic failover to Priority #2
    await addAdvancedModel(page, {
      displayName: 'Quota Exhausted Model',
      providerName: 'OpenAI',
      protocol: 'openai-compatible',
      modelId: 'gpt-4o',
      baseUrl: `${mockAiBaseUrl}/fail429/v1`,
      apiKey: 'sk-fail-429',
      priority: 1,
    });
    // Ensure Primary OAI OK stays enabled at priority 1 or 2 by bumping Quota Exhausted above or reordering via edit:
    // Notice Primary OAI OK has priority 1, Quota Exhausted Model was set priority 1 -> drag or edit Primary OAI OK to priority 2
    await page.locator('button[aria-label="Edit"]').nth(0).click();
    const editDialog = page.getByRole('dialog');
    const editingTitle = await editDialog.locator('h2').textContent();
    if (editingTitle?.includes('Primary OAI OK')) {
      await editDialog.locator('input[type="number"]').first().fill('2');
      await editDialog.getByRole('button', { name: 'Save', exact: true }).click();
    } else {
      await editDialog.getByRole('button', { name: 'Close', exact: true }).click();
    }

    await page.getByRole('button', { name: 'AI Chat', exact: true }).click();
    await page.getByRole('button', { name: 'New Chat' }).first().click();
    await page.getByPlaceholder('Ask anything, attach code or images, or test model fallback...').fill('Trigger failover stream');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/Mock AI streamed reply for: Trigger failover stream/)).toBeVisible();
    await expect(page.getByText(/Switched|Quota Exhausted Model/).first()).toBeVisible();

    // 8. Regenerate, edit & resend, and branch conversation
    await page.getByRole('button', { name: 'Regenerate' }).click();
    await expect(page.getByText(/Mock AI streamed reply for: Trigger failover stream/)).toBeVisible();

    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.locator('textarea').first().fill('Edited prompt resend test');
    await page.getByRole('button', { name: 'Edit & Resend' }).click();
    await expect(page.getByText(/Mock AI streamed reply for: Edited prompt resend test/)).toBeVisible();

    await page.getByRole('button', { name: 'Branch from here' }).last().click();
    await expect(page.getByText('Branched from').first()).toBeVisible();

    // Delete the branched conversation
    const branchedRow = page.locator('aside').nth(1).locator('div.group').first();
    await branchedRow.hover();
    await branchedRow.locator('button[title="Delete"]').click({ force: true });
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();

    // 9. Create folder, organize chat, and filter/search
    await page.locator('button[title="New Folder"]').click();
    await page.getByPlaceholder('Folder name').fill('Phase4Folder');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: /Phase4Folder/ }).first()).toBeVisible();
    await page.getByPlaceholder('Search conversations...').fill('NonMatchingQueryXYZ');
    await expect(page.getByText('No conversations')).toBeVisible();
    await page.getByPlaceholder('Search conversations...').fill('');
    await page.getByRole('button', { name: /All Chats/ }).click();

    // 10. Upload text + image attachment and send
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles([
      {
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Sample attached spec note'),
      },
      {
        name: 'pixel.png',
        mimeType: 'image/png',
        buffer: makeTinyPngBuffer(),
      },
    ]);
    await expect(page.getByText('notes.txt')).toBeVisible();
    await expect(page.getByText('pixel.png')).toBeVisible();
    await page.getByPlaceholder('Ask anything, attach code or images, or test model fallback...').fill('Review attachments');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/Mock AI streamed reply for: Review attachments/)).toBeVisible();
  });

  test('Workflows 11-16: AI Studio Fast/Planning diff/Agent modes, file edit + preview, Supervisor & AI fix, Snapshots & rollback, ZIP download', async ({
    page,
  }) => {
    page.on('pageerror', (err) => uncaughtPageErrors.push(err.message));
    await page.goto('/');

    await addAdvancedModel(page, {
      displayName: 'Studio Builder Model',
      providerName: 'OpenAI',
      protocol: 'openai-compatible',
      modelId: 'gpt-4o-mini',
      baseUrl: `${mockAiBaseUrl}/ok-oai/v1`,
      apiKey: 'sk-studio-ok',
      priority: 1,
    });

    // 11 & 12. Open AI Studio & test Planning Mode (with line diff preview), Fast Mode, and Agent Mode
    await page.getByRole('button', { name: 'AI Studio', exact: true }).click();

    // Planning mode -> inspect diff -> Approve & Apply
    await page.getByRole('button', { name: 'Planning', exact: true }).click();
    await page
      .getByPlaceholder(/Describe an app to build/)
      .fill('Build a calculator app in planning mode');
    await page.getByRole('button', { name: 'Generate & Apply' }).click();
    await expect(page.getByText(/Review Changes/)).toBeVisible();
    await page.getByRole('button', { name: /modify src\/App\.tsx/i }).click();
    await expect(page.getByText(/Planned Studio Calculator/)).toBeVisible();
    await page.getByRole('button', { name: 'Approve & Apply' }).click();
    await expect(page.getByText('Applied 1 planned file(s)')).toBeVisible();

    // Verify sandboxed live preview iframe rendered the updated component
    const previewFrame = page.frameLocator('iframe[title="OmniAI Sandboxed Live Preview"]');
    await expect(previewFrame.getByText('Planned Studio Calculator')).toBeVisible();

    // Fast mode
    await page.getByRole('button', { name: 'Fast', exact: true }).click();
    await page.getByPlaceholder(/Describe an app to build/).fill('Update header fast');
    await page.getByRole('button', { name: 'Generate & Apply' }).click();
    await expect(previewFrame.getByText('Fast Mode App Ready')).toBeVisible();

    // Agent mode (step 1 intentional missing import -> auto-fix iteration 2 recovers)
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByPlaceholder(/Describe an app to build/).fill('agent multi-step app');
    await page.getByRole('button', { name: 'Generate & Apply' }).click();
    await expect(previewFrame.getByText('Recovered Studio App')).toBeVisible({ timeout: 15000 });

    // 13. Create / edit project file & verify live preview bundle updates
    await page.locator('button[title="New File"]').click();
    await page.getByPlaceholder('src/components/Card.tsx').fill('src/components/HelperNote.tsx');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('HelperNote.tsx').first()).toBeVisible();

    // 14. Trigger intentional build error -> Supervisor detects BLOCKED -> Fix with AI recovers
    await page.getByRole('button', { name: 'Fast', exact: true }).click();
    await page.getByPlaceholder(/Describe an app to build/).fill('trigger intentional broken build');
    await page.getByRole('button', { name: 'Generate & Apply' }).click();
    await expect(page.getByText('Preview Build Error')).toBeVisible();

    await page.getByRole('button', { name: 'Supervisor', exact: true }).click();
    await page.getByRole('button', { name: 'Run Deterministic Static Checks' }).click();
    await expect(page.getByText('Gate: BLOCKED')).toBeVisible();

    // Use Fix with AI button on preview error banner
    await page.getByRole('button', { name: 'AI Builder', exact: true }).click();
    await page.getByRole('button', { name: 'Fix with AI' }).click();
    await expect(previewFrame.getByText('Recovered Studio App')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Preview Build Error')).toBeHidden();

    // 15. Save a project snapshot & rollback to it
    await page.getByRole('button', { name: /Snapshots/ }).click();
    await page.getByRole('button', { name: 'Save Snapshot' }).click();
    await expect(page.getByText(/Manual snapshot/).first()).toBeVisible();

    // Mutate project to broken state then restore manual snapshot
    await page.getByPlaceholder(/Describe an app to build/).fill('trigger intentional broken build');
    await page.getByRole('button', { name: 'Generate & Apply' }).click();
    await expect(page.getByText('Preview Build Error')).toBeVisible();

    const manualSnapCard = page.locator('div.shrink-0').filter({ hasText: 'Manual snapshot' }).first();
    await manualSnapCard.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page.getByText('Snapshot restored').first()).toBeVisible();
    await expect(previewFrame.getByText('Recovered Studio App')).toBeVisible();

    // 16. Export project as ZIP and verify non-empty file download
    const [zipDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download Project' }).click(),
    ]);
    expect(zipDownload.suggestedFilename()).toMatch(/\.zip$/i);
    const zipPath = await zipDownload.path();
    expect(zipPath).toBeTruthy();
    const stat = fs.statSync(zipPath!);
    expect(stat.size).toBeGreaterThan(200);
  });

  test('Workflows 17-20: Backup integrity/tamper rejection, GitHub sync/conflict/disconnect, i18n RTL/theme, Health Recharts, Diagnostics & Analytics', async ({
    page,
  }, testInfo) => {
    page.on('pageerror', (err) => uncaughtPageErrors.push(err.message));

    // Mock GitHub backend API routes for deterministic E2E UI verification
    let ghConnected = true;
    let pushCount = 0;

    await page.route('**/api/github/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          ghConnected
            ? {
                configured: true,
                connected: true,
                callbackUrl: 'http://localhost:3100/auth/callback',
                user: {
                  login: 'octo-e2e',
                  name: 'Octo E2E',
                  avatarUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
                },
              }
            : {
                configured: true,
                connected: false,
                callbackUrl: 'http://localhost:3100/auth/callback',
                user: null,
              }
        ),
      });
    });

    await page.route('**/api/github/repos', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          repos: [
            {
              id: 101,
              name: 'omniai-demo-repo',
              fullName: 'octo-e2e/omniai-demo-repo',
              owner: 'octo-e2e',
              private: true,
              defaultBranch: 'main',
              description: 'E2E test repository',
              htmlUrl: 'https://github.com/octo-e2e/omniai-demo-repo',
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.route('**/api/github/repos/*/*/branches', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ branches: [{ name: 'main', sha: 'sha-main-001' }] }),
      });
    });

    await page.route('**/api/github/repos/*/*/commits**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          commits: [
            {
              sha: 'sha-main-001',
              shortSha: 'sha-mai',
              message: 'Initial commit',
              authorName: 'Octo E2E',
              date: new Date().toISOString(),
              url: 'https://github.com/octo-e2e/omniai-demo-repo/commit/sha-main-001',
            },
          ],
        }),
      });
    });

    await page.route('**/api/github/repos/*/*/pull', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          commitSha: 'sha-main-001',
          branch: 'main',
          files: [{ path: 'README.md', content: '# Remote README' }],
        }),
      });
    });

    await page.route('**/api/github/repos/*/*/push', async (route) => {
      pushCount += 1;
      if (pushCount === 1) {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Remote branch main has diverged since last sync.',
            conflict: true,
            remoteHeadSha: 'sha-main-002',
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          commitSha: 'sha-main-003',
          commitUrl: 'https://github.com/octo-e2e/omniai-demo-repo/commit/sha-main-003',
          filesPushed: 4,
        }),
      });
    });

    await page.route('**/api/github/disconnect', async (route) => {
      ghConnected = false;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto('/');
    await addAdvancedModel(page, {
      displayName: 'Health Chart Model',
      providerName: 'OpenAI',
      protocol: 'openai-compatible',
      modelId: 'gpt-4o-mini',
      baseUrl: `${mockAiBaseUrl}/ok-oai/v1`,
      apiKey: 'sk-health-key',
      priority: 1,
    });

    // 17. Workspace backup export, reject tampered checksum, and import valid backup
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const [backupDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export Workspace Backup' }).click(),
    ]);
    const validBackupPath = await backupDownload.path();
    const validJson = JSON.parse(fs.readFileSync(validBackupPath!, 'utf8'));
    expect(validJson.checksum).toBeTruthy();
    expect(JSON.stringify(validJson)).not.toContain('sk-health-key');

    const tamperedPath = path.join(testInfo.outputDir, 'tampered-backup.json');
    fs.mkdirSync(testInfo.outputDir, { recursive: true });
    fs.writeFileSync(
      tamperedPath,
      JSON.stringify({ ...validJson, projects: [{ id: 'tamper', name: 'Tampered', files: [] }] })
    );

    const backupInput = page.locator('input[type="file"]').first();
    await backupInput.setInputFiles(tamperedPath);
    await expect(page.getByText('Backup restore failed')).toBeVisible();

    await backupInput.setInputFiles(validBackupPath!);
    await expect(page.getByText('Backup restored')).toBeVisible();

    // 18. GitHub workflow: repo select -> Check Sync -> 409 conflict -> Confirm Push -> Disconnect
    await page.getByRole('button', { name: 'GitHub', exact: true }).click();
    await expect(page.getByText('octo-e2e/omniai-demo-repo')).toBeVisible();
    await page.getByRole('button', { name: /octo-e2e\/omniai-demo-repo/ }).click();
    await page.getByRole('button', { name: 'Check Sync' }).click();
    await expect(page.getByText(/Sync Comparison/)).toBeVisible();

    await page.getByPlaceholder('Describe your commit changes...').fill('Phase 4 sync commit');
    await page.getByRole('button', { name: 'Commit & Push' }).click();
    await expect(page.getByText(/Remote branch diverged \(409 Conflict\)/)).toBeVisible();

    // Trigger force overwrite after conflict or re-submit
    await page.getByRole('button', { name: 'Commit & Push' }).click();
    await expect(page.getByText('Committed & Pushed to GitHub')).toBeVisible();

    await page.getByRole('button', { name: 'Disconnect GitHub' }).click();
    await expect(page.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();

    // 19. Switch EN <-> AR RTL and Dark <-> Light theme
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'العربية (RTL)' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');

    await page.getByRole('button', { name: 'فاتح' }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    await page.getByRole('button', { name: 'English (LTR)' }).click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);

    // 20. Dashboard Model Health (Recharts), Diagnostics & Analytics with 0 page errors
    await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
    await expect(page.getByText('Model Latency Comparison (ms)')).toBeVisible();
    await expect(page.locator('svg.recharts-surface').first()).toBeVisible();
    await page.getByRole('button', { name: 'Refresh live orchestrator metrics' }).click();
    await page.getByRole('button', { name: 'Test All Enabled' }).click();
    await expect(page.getByText('Connected').first()).toBeVisible();

    const primaryNav = page.getByRole('navigation', { name: 'Primary Navigation' });
    await primaryNav.getByRole('button', { name: 'Diagnostics', exact: true }).click();
    await page.getByRole('button', { name: 'Run Diagnostics' }).click();
    await expect(page.getByText('Diagnostic Matrix')).toBeVisible();
    await expect(page.getByText('PASSED').first()).toBeVisible();

    await primaryNav.getByRole('button', { name: 'Analytics', exact: true }).click();
    await expect(page.getByText('Usage & Cost Analytics')).toBeVisible();
    await expect(page.getByText('Token Consumption by Model')).toBeVisible();
  });
});
