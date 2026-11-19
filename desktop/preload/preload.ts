import { contextBridge, ipcRenderer } from 'electron';

const desktopBridge = {
  platform: 'electron' as const,
  checkEnvironment: () => ipcRenderer.invoke('desktop:check-environment'),
  getAppInfo: () => ipcRenderer.invoke('desktop:get-app-info'),
  getLogs: (limitLines?: number): Promise<string[]> =>
    ipcRenderer.invoke('desktop:get-logs', limitLines),
  checkPortAvailability: (port: number) => ipcRenderer.invoke('desktop:check-port', port),
  openExternalUrl: (url: string): Promise<boolean> =>
    ipcRenderer.invoke('desktop:open-external', url),
  getRecentProjects: () => ipcRenderer.invoke('desktop:get-recent-projects'),
  openRecentFolder: (folderPath: string): Promise<string> =>
    ipcRenderer.invoke('desktop:open-recent-folder', folderPath),
  openFolderDialog: (): Promise<string | null> => ipcRenderer.invoke('desktop:open-folder'),
  createLocalProjectFolder: (parentDir?: string): Promise<string | null> =>
    ipcRenderer.invoke('desktop:create-project-folder', parentDir),
  inspectFolder: (folderPath: string) => ipcRenderer.invoke('desktop:inspect-folder', folderPath),
  backupFolder: (folderPath: string): Promise<string> =>
    ipcRenderer.invoke('desktop:backup-folder', folderPath),
  readDirectoryFiles: (folderPath: string) =>
    ipcRenderer.invoke('desktop:read-files', folderPath),
  writeFile: (folderPath: string, relativePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('desktop:write-file', folderPath, relativePath, content),
  createFolder: (folderPath: string, relativePath: string): Promise<void> =>
    ipcRenderer.invoke('desktop:create-folder', folderPath, relativePath),
  renamePath: (folderPath: string, oldPath: string, newPath: string): Promise<void> =>
    ipcRenderer.invoke('desktop:rename-path', folderPath, oldPath, newPath),
  deletePath: (folderPath: string, relativePath: string): Promise<boolean> =>
    ipcRenderer.invoke('desktop:delete-path', folderPath, relativePath),
  runGitCommand: (
    folderPath: string,
    gitCommand: string,
    options?: { createBackupBeforeSync?: boolean }
  ) => ipcRenderer.invoke('desktop:git-exec', folderPath, gitCommand, options),
  runShellCommand: (
    folderPath: string,
    command: string
  ): Promise<{ started: boolean; processId: string; error?: string }> =>
    ipcRenderer.invoke('desktop:run-command', folderPath, command),
  stopProcess: (processId: string): Promise<boolean> =>
    ipcRenderer.invoke('desktop:stop-process', processId),
  onProcessOutput: (
    callback: (evt: { processId: string; stream: string; text: string; detectedUrl?: string }) => void
  ) => {
    const handler = (
      _event: unknown,
      payload: { processId: string; stream: string; text: string; detectedUrl?: string }
    ) => callback(payload);
    ipcRenderer.on('desktop:process-output', handler);
    return () => ipcRenderer.removeListener('desktop:process-output', handler);
  },
  onProcessExit: (
    callback: (evt: { processId: string; code: number | null; timedOut?: boolean }) => void
  ) => {
    const handler = (
      _event: unknown,
      payload: { processId: string; code: number | null; timedOut?: boolean }
    ) => callback(payload);
    ipcRenderer.on('desktop:process-exit', handler);
    return () => ipcRenderer.removeListener('desktop:process-exit', handler);
  },
};

contextBridge.exposeInMainWorld('omniDesktopBridge', desktopBridge);
