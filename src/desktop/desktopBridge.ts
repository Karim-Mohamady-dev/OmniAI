/**
 * Desktop Runtime Abstraction Layer
 * Clearly separates Web Sandbox capabilities from Electron Desktop capabilities.
 * Never simulates local filesystem access inside a normal web browser.
 */

export type RuntimeEnvironment = 'web-sandbox' | 'electron-desktop' | 'tauri-desktop';

export interface DesktopCapabilities {
  environment: RuntimeEnvironment;
  supportsLocalFolderOpen: boolean;
  supportsLocalTerminalExec: boolean;
  supportsLocalProcessPreview: boolean;
  supportsBrowserIndexedDbProjects: boolean;
  supportsZipDownload: boolean;
}

export interface DesktopEnvironmentInfo {
  platform: string;
  arch: string;
  nodeVersion: string | null;
  npmVersion: string | null;
  gitVersion: string | null;
}

export interface DesktopAppInfo {
  version: string;
  platform: string;
  arch: string;
  electronVersion: string;
  packaged: boolean;
  logPath: string;
}

export interface RecentLocalProject {
  folderPath: string;
  name: string;
  lastOpenedAt: number;
}

export interface FolderInspectionSummary {
  folderPath: string;
  isEmpty: boolean;
  entryCount: number;
  hasPackageJson: boolean;
  hasGitRepo: boolean;
  scripts: string[];
}

export interface LocalGitCommandResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  backupPath?: string;
}

export interface OmniDesktopBridgeAPI {
  platform: 'electron' | 'tauri';
  checkEnvironment?: () => Promise<DesktopEnvironmentInfo>;
  getAppInfo?: () => Promise<DesktopAppInfo>;
  getLogs?: (limitLines?: number) => Promise<string[]>;
  checkPortAvailability?: (port: number) => Promise<{ port: number; inUse: boolean }>;
  openExternalUrl?: (url: string) => Promise<boolean>;
  getRecentProjects?: () => Promise<RecentLocalProject[]>;
  openRecentFolder?: (folderPath: string) => Promise<string>;
  openFolderDialog: () => Promise<string | null>;
  createLocalProjectFolder: (projectName?: string) => Promise<string | null>;
  inspectFolder?: (folderPath: string) => Promise<FolderInspectionSummary>;
  backupFolder?: (folderPath: string) => Promise<string>;
  readDirectoryFiles: (folderPath: string) => Promise<Array<{ path: string; content: string; updatedAt?: number }>>;
  writeFile: (folderPath: string, relativePath: string, content: string) => Promise<void>;
  createFolder: (folderPath: string, relativePath: string) => Promise<void>;
  renamePath: (folderPath: string, oldPath: string, newPath: string) => Promise<void>;
  deletePath: (folderPath: string, relativePath: string) => Promise<boolean>;
  runGitCommand?: (
    folderPath: string,
    gitCommand: string,
    options?: { createBackupBeforeSync?: boolean }
  ) => Promise<LocalGitCommandResult>;
  runShellCommand: (
    folderPath: string,
    command: string
  ) => Promise<{ started: boolean; processId: string; error?: string }>;
  stopProcess: (processId: string) => Promise<boolean>;
  onProcessOutput: (
    cb: (evt: { processId: string; stream: string; text: string; detectedUrl?: string }) => void
  ) => () => void;
  onProcessExit: (
    cb: (evt: { processId: string; code: number | null; timedOut?: boolean }) => void
  ) => () => void;
}

interface ElectronBridgeWindow {
  omniDesktopBridge?: OmniDesktopBridgeAPI;
}

export function detectRuntimeEnvironment(): RuntimeEnvironment {
  if (typeof window === 'undefined') return 'web-sandbox';
  const bridge = (window as unknown as ElectronBridgeWindow).omniDesktopBridge;
  if (bridge?.platform === 'electron') return 'electron-desktop';
  if (bridge?.platform === 'tauri') return 'tauri-desktop';
  return 'web-sandbox';
}

export function getDesktopCapabilities(): DesktopCapabilities {
  const env = detectRuntimeEnvironment();
  const isNative = env !== 'web-sandbox';
  return {
    environment: env,
    supportsLocalFolderOpen: isNative,
    supportsLocalTerminalExec: isNative,
    supportsLocalProcessPreview: isNative,
    supportsBrowserIndexedDbProjects: true,
    supportsZipDownload: true,
  };
}

export function getDesktopBridge(): OmniDesktopBridgeAPI | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as ElectronBridgeWindow).omniDesktopBridge ?? null;
}
