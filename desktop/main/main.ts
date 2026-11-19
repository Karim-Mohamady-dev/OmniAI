import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import crypto from 'crypto';
import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import {
  validateDesktopCommand,
  validateDesktopExternalUrl,
} from '../security/validators';
import {
  createLocalProjectFolder,
  deleteLocalProjectPath,
  readLocalProjectFiles,
  renameLocalProjectPath,
  writeLocalProjectFile,
} from '../services/filesystemService';
import {
  assertWorkspaceIsAuthorized,
  checkLocalPortAvailability,
  detectDesktopEnvironment,
  inspectFolderOverview,
  loadRecentProjects,
  openAuthorizedRecentProject,
  saveRecentProject,
} from '../services/envService';
import {
  createLocalBackupSnapshot,
  runValidatedLocalGit,
} from '../services/gitService';
import { DesktopProcessRunner } from '../services/processRunner';

let mainWindow: BrowserWindow | null = null;
const authorizedWorkspaces = new Set<string>();
const processRunner = new DesktopProcessRunner();

function getRecentProjectsStorePath(): string {
  return path.join(app.getPath('userData'), 'recent-projects.json');
}

function getDesktopLogPath(): string {
  return path.join(app.getPath('userData'), 'omniai-desktop.log');
}

async function appendDesktopLog(
  level: 'info' | 'warn' | 'error',
  event: string,
  detail?: Record<string, unknown>
): Promise<void> {
  try {
    const logPath = getDesktopLogPath();
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...(detail ? { detail } : {}),
    });
    await fs.appendFile(logPath, `${line}\n`, 'utf8');
  } catch {
    // Do not crash on log write errors
  }
}

async function readDesktopLogTail(limitLines = 100): Promise<string[]> {
  try {
    const raw = await fs.readFile(getDesktopLogPath(), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines.slice(-limitLines);
  } catch {
    return [];
  }
}

function assertAuthorizedWorkspace(folderPath: string): string {
  return assertWorkspaceIsAuthorized(authorizedWorkspaces, folderPath);
}

process.on('uncaughtException', (err) => {
  void appendDesktopLog('error', 'uncaught_exception', { message: err.message });
});

process.on('unhandledRejection', (reason) => {
  void appendDesktopLog('error', 'unhandled_rejection', {
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'OmniAI Studio Desktop',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (validateDesktopExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const allowedLocalDev =
      targetUrl.startsWith('http://localhost:') ||
      targetUrl.startsWith('http://127.0.0.1:') ||
      targetUrl.startsWith('file://');
    if (!allowedLocalDev) {
      event.preventDefault();
      void appendDesktopLog('warn', 'blocked_navigation', { targetUrl });
    }
  });

  const devUrl = process.env.OMNIAI_DESKTOP_URL?.trim();
  if (devUrl && validateDesktopExternalUrl(devUrl)) {
    void mainWindow.loadURL(devUrl);
  } else {
    const packagedIndex = path.join(process.resourcesPath, 'web-dist', 'index.html');
    const devDistIndex = path.resolve(__dirname, '../../../dist/index.html');
    const targetIndex = app.isPackaged && fsSync.existsSync(packagedIndex) ? packagedIndex : devDistIndex;
    if (!fsSync.existsSync(targetIndex)) {
      void appendDesktopLog('error', 'missing_renderer_bundle', { targetIndex });
    }
    void mainWindow.loadFile(targetIndex);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  void appendDesktopLog('info', 'desktop_app_ready', {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });
  createWindow();

  ipcMain.handle('desktop:check-environment', async () => {
    return detectDesktopEnvironment();
  });

  ipcMain.handle('desktop:get-app-info', async () => {
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      packaged: app.isPackaged,
      logPath: getDesktopLogPath(),
    };
  });

  ipcMain.handle('desktop:get-logs', async (_event, limitLines?: number) => {
    return readDesktopLogTail(typeof limitLines === 'number' ? limitLines : 100);
  });

  ipcMain.handle('desktop:check-port', async (_event, port: number) => {
    const safePort = Number(port);
    if (!Number.isInteger(safePort) || safePort < 1024 || safePort > 65535) {
      throw new Error('Port must be between 1024 and 65535.');
    }
    return checkLocalPortAvailability(safePort);
  });

  ipcMain.handle('desktop:open-external', async (_event, url: string) => {
    if (!validateDesktopExternalUrl(url)) {
      throw new Error('External URL blocked: only http://localhost, http://127.0.0.1, or https://github.com are permitted.');
    }
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('desktop:get-recent-projects', async () => {
    return loadRecentProjects(getRecentProjectsStorePath());
  });

  ipcMain.handle('desktop:open-recent-folder', async (_event, folderPath: string) => {
    const abs = await openAuthorizedRecentProject(
      getRecentProjectsStorePath(),
      folderPath,
      authorizedWorkspaces
    );
    void appendDesktopLog('info', 'open_recent_folder', { folder: path.basename(abs) });
    return abs;
  });

  ipcMain.handle('desktop:open-folder', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Local Project Folder',
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const abs = await fs.realpath(path.resolve(res.filePaths[0]));
    authorizedWorkspaces.add(abs);
    await saveRecentProject(getRecentProjectsStorePath(), abs);
    void appendDesktopLog('info', 'authorize_folder', { folder: path.basename(abs) });
    return abs;
  });

  ipcMain.handle('desktop:create-project-folder', async (_event, projectName?: string) => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Parent Directory for New Local Project',
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const safeName = (projectName || 'omniai-local-project').replace(/[^a-zA-Z0-9-_]/g, '-');
    const parentReal = await fs.realpath(res.filePaths[0]);
    const projectDir = path.resolve(parentReal, safeName);
    await fs.mkdir(projectDir, { recursive: true });
    const realProjectDir = await fs.realpath(projectDir);
    authorizedWorkspaces.add(realProjectDir);
    await saveRecentProject(getRecentProjectsStorePath(), realProjectDir);
    void appendDesktopLog('info', 'create_project_folder', { folder: path.basename(realProjectDir) });
    return realProjectDir;
  });

  ipcMain.handle('desktop:inspect-folder', async (_event, folderPath: string) => {
    const abs = assertAuthorizedWorkspace(folderPath);
    return inspectFolderOverview(abs);
  });

  ipcMain.handle('desktop:backup-folder', async (_event, folderPath: string) => {
    const abs = assertAuthorizedWorkspace(folderPath);
    return createLocalBackupSnapshot(abs);
  });

  ipcMain.handle('desktop:read-files', async (_event, folderPath: string) => {
    const abs = assertAuthorizedWorkspace(folderPath);
    return readLocalProjectFiles(abs);
  });

  ipcMain.handle(
    'desktop:write-file',
    async (_event, folderPath: string, relativePath: string, content: string) => {
      const abs = assertAuthorizedWorkspace(folderPath);
      await writeLocalProjectFile(abs, relativePath, content);
    }
  );

  ipcMain.handle(
    'desktop:create-folder',
    async (_event, folderPath: string, relativePath: string) => {
      const abs = assertAuthorizedWorkspace(folderPath);
      await createLocalProjectFolder(abs, relativePath);
    }
  );

  ipcMain.handle(
    'desktop:rename-path',
    async (_event, folderPath: string, oldPath: string, newPath: string) => {
      const abs = assertAuthorizedWorkspace(folderPath);
      await renameLocalProjectPath(abs, oldPath, newPath);
    }
  );

  ipcMain.handle(
    'desktop:delete-path',
    async (_event, folderPath: string, relativePath: string) => {
      const abs = assertAuthorizedWorkspace(folderPath);
      if (!mainWindow) return false;
      const confirm = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Delete'],
        defaultId: 0,
        title: 'Confirm Local File Deletion',
        message: `Permanently delete "${relativePath}" from disk?`,
        detail: abs,
      });
      if (confirm.response !== 1) return false;
      await deleteLocalProjectPath(abs, relativePath);
      void appendDesktopLog('info', 'delete_path', { relativePath });
      return true;
    }
  );

  ipcMain.handle(
    'desktop:git-exec',
    async (
      _event,
      folderPath: string,
      gitCommand: string,
      options?: { createBackupBeforeSync?: boolean }
    ) => {
      const abs = assertAuthorizedWorkspace(folderPath);
      const trimmed = (gitCommand || '').trim();
      const normalized = trimmed.startsWith('git ') ? trimmed : `git ${trimmed}`;
      const validation = validateDesktopCommand(normalized);
      if (!validation.allowed || validation.executable !== 'git') {
        throw new Error(validation.reason || 'Git command rejected by security policy.');
      }
      const sub = (validation.args[0] || '').toLowerCase();
      const mutatingSubs = new Set(['commit', 'pull', 'push', 'checkout']);
      if (mainWindow && mutatingSubs.has(sub)) {
        const confirm = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['Cancel', 'Approve Git Action'],
          defaultId: 0,
          title: 'Confirm Local Git Operation',
          message: `Run "${normalized}" in ${path.basename(abs)}?`,
          detail: abs,
        });
        if (confirm.response !== 1) {
          return {
            ok: false,
            command: normalized,
            stdout: '',
            stderr: 'Git action declined by user.',
          };
        }
      }
      let backupPath: string | undefined;
      if ((sub === 'pull' || sub === 'checkout') && options?.createBackupBeforeSync !== false) {
        backupPath = await createLocalBackupSnapshot(abs);
      }
      const result = await runValidatedLocalGit(abs, normalized);
      void appendDesktopLog('info', 'git_exec', { command: normalized, ok: result.ok });
      return { ...result, backupPath };
    }
  );

  ipcMain.handle(
    'desktop:run-command',
    async (_event, folderPath: string, command: string) => {
      const abs = assertAuthorizedWorkspace(folderPath);
      const validation = validateDesktopCommand(command);
      if (!validation.allowed) {
        return { started: false, processId: '', error: validation.reason };
      }

      if (mainWindow && validation.requiresConfirmation) {
        const confirm = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['Reject', 'Allow Execution'],
          defaultId: 0,
          title: 'Approve Local Terminal Command',
          message: `Allow running "${command}" in ${path.basename(abs)}?`,
          detail: `Directory: ${abs}`,
        });
        if (confirm.response !== 1) {
          return { started: false, processId: '', error: 'Command execution declined by user.' };
        }
      }

      const processId = `proc_${crypto.randomBytes(6).toString('hex')}`;
      void appendDesktopLog('info', 'run_command', { command, processId });
      processRunner.runCommand({
        processId,
        workspaceRoot: abs,
        command,
        timeoutMs: command.includes('dev') ? undefined : 120_000,
        onOutput: (evt) => {
          mainWindow?.webContents.send('desktop:process-output', evt);
        },
        onExit: (evt) => {
          mainWindow?.webContents.send('desktop:process-exit', evt);
        },
      });
      return { started: true, processId };
    }
  );

  ipcMain.handle('desktop:stop-process', async (_event, processId: string) => {
    return processRunner.stopProcess(processId);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  processRunner.stopAll();
});

app.on('window-all-closed', () => {
  processRunner.stopAll();
  if (process.platform !== 'darwin') app.quit();
});
