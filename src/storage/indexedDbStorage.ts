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
import { computeSimpleChecksum, validateBackupPayload } from './backupValidator.ts';
import type {
  StorageAdapter,
  StorageUsageStats,
  WorkspaceBackupPayload,
} from './storageAdapter.ts';

const DB_NAME = 'omniai_studio_db';
const DB_VERSION = 3;
const STORE_PROJECTS = 'projects';
const STORE_CONVERSATIONS = 'conversations';
const STORE_FOLDERS = 'folders';
const STORE_SNAPSHOTS = 'snapshots';
const STORE_FALLBACK_HISTORY = 'fallback_history';
const STORE_USAGE_RECORDS = 'usage_records';
const STORE_META = 'meta';

const LS_MODELS_KEY = 'omniai_models_v1';
const LS_SETTINGS_KEY = 'omniai_settings_v1';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
        db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        const snapStore = db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id' });
        snapStore.createIndex('by_project', 'projectId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_FALLBACK_HISTORY)) {
        db.createObjectStore(STORE_FALLBACK_HISTORY, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_USAGE_RECORDS)) {
        const usageStore = db.createObjectStore(STORE_USAGE_RECORDS, { keyPath: 'id' });
        usageStore.createIndex('by_timestamp', 'timestamp', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll<T>(storeName: string): Promise<T[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result as T[]) || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

async function idbPut<T>(storeName: string, item: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(item);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(storeName: string, id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbClear(storeName: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDBStorageAdapter implements StorageAdapter {
  async getModels(): Promise<AIModelConfig[]> {
    try {
      const raw = localStorage.getItem(LS_MODELS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as AIModelConfig[]) : [];
    } catch {
      return [];
    }
  }

  async saveModels(models: AIModelConfig[]): Promise<void> {
    localStorage.setItem(LS_MODELS_KEY, JSON.stringify(models));
  }

  async getConversations(): Promise<Conversation[]> {
    const items = await idbGetAll<Conversation>(STORE_CONVERSATIONS);
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    await idbPut(STORE_CONVERSATIONS, conversation);
  }

  async deleteConversation(id: string): Promise<void> {
    await idbDelete(STORE_CONVERSATIONS, id);
  }

  async getFolders(): Promise<ConversationFolder[]> {
    const items = await idbGetAll<ConversationFolder>(STORE_FOLDERS);
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }

  async saveFolder(folder: ConversationFolder): Promise<void> {
    await idbPut(STORE_FOLDERS, folder);
  }

  async deleteFolder(id: string): Promise<void> {
    await idbDelete(STORE_FOLDERS, id);
  }

  async getProjects(): Promise<Project[]> {
    const items = await idbGetAll<Project>(STORE_PROJECTS);
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveProject(project: Project): Promise<void> {
    await idbPut(STORE_PROJECTS, project);
  }

  async deleteProject(id: string): Promise<void> {
    await idbDelete(STORE_PROJECTS, id);
  }

  async getSnapshots(projectId: string): Promise<ProjectSnapshot[]> {
    const all = await idbGetAll<ProjectSnapshot>(STORE_SNAPSHOTS);
    return all
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async saveSnapshot(snapshot: ProjectSnapshot): Promise<void> {
    await idbPut(STORE_SNAPSHOTS, snapshot);
  }

  async deleteSnapshot(id: string): Promise<void> {
    await idbDelete(STORE_SNAPSHOTS, id);
  }

  async getFallbackHistory(): Promise<FallbackHistoryEntry[]> {
    const all = await idbGetAll<FallbackHistoryEntry>(STORE_FALLBACK_HISTORY);
    return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
  }

  async addFallbackHistory(entry: FallbackHistoryEntry): Promise<void> {
    await idbPut(STORE_FALLBACK_HISTORY, entry);
  }

  async clearFallbackHistory(): Promise<void> {
    await idbClear(STORE_FALLBACK_HISTORY);
  }

  async getUsageRecords(): Promise<UsageRecord[]> {
    const all = await idbGetAll<UsageRecord>(STORE_USAGE_RECORDS);
    return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, 500);
  }

  async addUsageRecord(record: UsageRecord): Promise<void> {
    await idbPut(STORE_USAGE_RECORDS, record);
  }

  async clearUsageRecords(): Promise<void> {
    await idbClear(STORE_USAGE_RECORDS);
  }

  async getSettings(): Promise<UserSettings | null> {
    try {
      const raw = localStorage.getItem(LS_SETTINGS_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as UserSettings;
    } catch {
      return null;
    }
  }

  async saveSettings(settings: UserSettings): Promise<void> {
    localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(settings));
  }

  async getStorageStats(): Promise<StorageUsageStats> {
    const [projects, convs, snaps, usage] = await Promise.all([
      this.getProjects(),
      this.getConversations(),
      idbGetAll<ProjectSnapshot>(STORE_SNAPSHOTS),
      this.getUsageRecords(),
    ]);

    let usedBytes: number | null = null;
    let quotaBytes: number | null = null;
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      try {
        const est = await navigator.storage.estimate();
        usedBytes = est.usage ?? null;
        quotaBytes = est.quota ?? null;
      } catch {
        // ignore if unsupported in sandboxed env
      }
    }

    return {
      usedBytes,
      quotaBytes,
      projectCount: projects.length,
      conversationCount: convs.length,
      snapshotCount: snaps.length,
      usageRecordCount: usage.length,
      schemaVersion: DB_VERSION,
    };
  }

  async exportBackup(): Promise<WorkspaceBackupPayload> {
    const [models, conversations, folders, projects, snapshots, usageRecords, settings] =
      await Promise.all([
        this.getModels(),
        this.getConversations(),
        this.getFolders(),
        this.getProjects(),
        idbGetAll<ProjectSnapshot>(STORE_SNAPSHOTS),
        this.getUsageRecords(),
        this.getSettings(),
      ]);

    const sanitizedModels = models.map(({ apiKey: _removed, ...rest }) => rest);

    const basePayload: WorkspaceBackupPayload = {
      schemaVersion: DB_VERSION,
      exportedAt: Date.now(),
      models: sanitizedModels,
      conversations,
      folders,
      projects,
      snapshots,
      usageRecords,
      settings,
    };

    return {
      ...basePayload,
      checksum: computeSimpleChecksum(basePayload),
    };
  }

  async importBackup(
    payload: WorkspaceBackupPayload
  ): Promise<{ importedProjects: number; importedConversations: number; importedModels: number }> {
    const validation = validateBackupPayload(payload);
    if (!validation.valid) {
      throw new Error(`Invalid backup archive: ${validation.errors.join(' ')}`);
    }

    let importedProjects = 0;
    let importedConversations = 0;
    let importedModels = 0;

    if (Array.isArray(payload.projects)) {
      for (const proj of payload.projects) {
        if (proj?.id && proj?.name && Array.isArray(proj.files)) {
          await this.saveProject(proj);
          importedProjects += 1;
        }
      }
    }

    if (Array.isArray(payload.conversations)) {
      for (const conv of payload.conversations) {
        if (conv?.id && Array.isArray(conv.messages)) {
          await this.saveConversation(conv);
          importedConversations += 1;
        }
      }
    }

    if (Array.isArray(payload.folders)) {
      for (const folder of payload.folders) {
        if (folder?.id && folder?.name) {
          await this.saveFolder(folder);
        }
      }
    }

    if (Array.isArray(payload.snapshots)) {
      for (const snap of payload.snapshots) {
        if (snap?.id && snap?.projectId && Array.isArray(snap.files)) {
          await this.saveSnapshot(snap);
        }
      }
    }

    if (Array.isArray(payload.usageRecords)) {
      for (const rec of payload.usageRecords) {
        if (rec?.id && rec?.modelId) {
          await this.addUsageRecord(rec);
        }
      }
    }

    if (Array.isArray(payload.models)) {
      const existing = await this.getModels();
      const existingIds = new Set(existing.map((m) => m.id));
      const merged = [...existing];
      for (const m of payload.models) {
        if (m?.id && m?.modelId && !existingIds.has(m.id)) {
          merged.push({ ...m, status: 'untested' });
          importedModels += 1;
        }
      }
      await this.saveModels(merged);
    }

    if (payload.settings) {
      await this.saveSettings(payload.settings);
    }

    return { importedProjects, importedConversations, importedModels };
  }

  async clearAll(): Promise<void> {
    localStorage.removeItem(LS_MODELS_KEY);
    localStorage.removeItem(LS_SETTINGS_KEY);
    await Promise.all([
      idbClear(STORE_PROJECTS),
      idbClear(STORE_CONVERSATIONS),
      idbClear(STORE_FOLDERS),
      idbClear(STORE_SNAPSHOTS),
      idbClear(STORE_FALLBACK_HISTORY),
      idbClear(STORE_USAGE_RECORDS),
      idbClear(STORE_META),
    ]);
  }
}

export const storageAdapter: StorageAdapter = new IndexedDBStorageAdapter();
