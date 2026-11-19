import type {
  AIModelConfig,
  Conversation,
  ConversationFolder,
  FallbackHistoryEntry,
  Project,
  ProjectSnapshot,
  UsageRecord,
  UserSettings,
} from '../types/index.ts';

export interface WorkspaceBackupPayload {
  schemaVersion: number;
  exportedAt: number;
  checksum?: string;
  models: Array<Omit<AIModelConfig, 'apiKey'>>;
  conversations: Conversation[];
  folders: ConversationFolder[];
  projects: Project[];
  snapshots: ProjectSnapshot[];
  usageRecords?: UsageRecord[];
  settings: UserSettings | null;
}

export interface StorageUsageStats {
  usedBytes: number | null;
  quotaBytes: number | null;
  projectCount: number;
  conversationCount: number;
  snapshotCount: number;
  usageRecordCount?: number;
  schemaVersion: number;
}

export interface StorageAdapter {
  getModels(): Promise<AIModelConfig[]>;
  saveModels(models: AIModelConfig[]): Promise<void>;

  getConversations(): Promise<Conversation[]>;
  saveConversation(conversation: Conversation): Promise<void>;
  deleteConversation(id: string): Promise<void>;

  getFolders(): Promise<ConversationFolder[]>;
  saveFolder(folder: ConversationFolder): Promise<void>;
  deleteFolder(id: string): Promise<void>;

  getProjects(): Promise<Project[]>;
  saveProject(project: Project): Promise<void>;
  deleteProject(id: string): Promise<void>;

  getSnapshots(projectId: string): Promise<ProjectSnapshot[]>;
  saveSnapshot(snapshot: ProjectSnapshot): Promise<void>;
  deleteSnapshot(id: string): Promise<void>;

  getFallbackHistory(): Promise<FallbackHistoryEntry[]>;
  addFallbackHistory(entry: FallbackHistoryEntry): Promise<void>;
  clearFallbackHistory(): Promise<void>;

  getUsageRecords(): Promise<UsageRecord[]>;
  addUsageRecord(record: UsageRecord): Promise<void>;
  clearUsageRecords(): Promise<void>;

  getSettings(): Promise<UserSettings | null>;
  saveSettings(settings: UserSettings): Promise<void>;

  getStorageStats(): Promise<StorageUsageStats>;
  exportBackup(): Promise<WorkspaceBackupPayload>;
  importBackup(
    payload: WorkspaceBackupPayload
  ): Promise<{ importedProjects: number; importedConversations: number; importedModels: number }>;

  clearAll(): Promise<void>;
}
