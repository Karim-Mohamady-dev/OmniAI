import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Edit2,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Search,
  Trash2,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';
import type { ProjectFile } from '../types/index.ts';

interface FileExplorerProps {
  files: ProjectFile[];
  activeFilePath: string | null;
  onSelectFile: (path: string) => void;
  onCreateFile: (path: string) => void;
  onRenamePath: (oldPath: string, newPath: string) => void;
  onDeletePath: (path: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  isFolder: boolean;
  children: TreeNode[];
}

function buildTree(files: ProjectFile[], query: string): TreeNode[] {
  const root: TreeNode[] = [];
  const lowerQ = query.trim().toLowerCase();
  const filtered = lowerQ
    ? files.filter((f) => f.path.toLowerCase().includes(lowerQ))
    : files;

  const folderMap = new Map<string, TreeNode>();

  const ensureFolder = (folderPath: string): TreeNode => {
    const existing = folderMap.get(folderPath);
    if (existing) return existing;

    const parts = folderPath.split('/');
    const name = parts[parts.length - 1];
    const node: TreeNode = {
      name,
      path: folderPath,
      isFolder: true,
      children: [],
    };
    folderMap.set(folderPath, node);

    if (parts.length === 1) {
      root.push(node);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = ensureFolder(parentPath);
      parent.children.push(node);
    }
    return node;
  };

  for (const file of filtered) {
    const parts = file.path.split('/');
    const fileName = parts[parts.length - 1];
    const fileNode: TreeNode = {
      name: fileName,
      path: file.path,
      isFolder: false,
      children: [],
    };

    if (parts.length === 1) {
      root.push(fileNode);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      const parent = ensureFolder(parentPath);
      parent.children.push(fileNode);
    }
  }

  const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => {
      if (n.children.length > 0) sortNodes(n.children);
    });
    return nodes;
  };

  return sortNodes(root);
}

export function FileExplorer({
  files,
  activeFilePath,
  onSelectFile,
  onCreateFile,
  onRenamePath,
  onDeletePath,
}: FileExplorerProps) {
  const { t } = useApp();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['src', 'src/components', 'src/pages', 'src/styles']));
  const [creatingMode, setCreatingMode] = useState<'file' | 'folder' | null>(null);
  const [newPathInput, setNewPathInput] = useState('');
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const tree = useMemo(() => buildTree(files, search), [files, search]);

  const toggleFolder = (folderPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = newPathInput.trim().replace(/^\/+/, '');
    if (!clean) return;
    if (creatingMode === 'folder') {
      onCreateFile(`${clean.replace(/\/+$/, '')}/.gitkeep`);
      setExpanded((prev) => new Set(prev).add(clean.replace(/\/+$/, '')));
    } else {
      onCreateFile(clean);
    }
    setNewPathInput('');
    setCreatingMode(null);
  };

  const handleRenameSubmit = (e: React.FormEvent, oldPath: string) => {
    e.preventDefault();
    if (renameValue.trim() && renameValue.trim() !== oldPath) {
      onRenamePath(oldPath, renameValue.trim());
    }
    setRenamingPath(null);
    setRenameValue('');
  };

  const renderNode = (node: TreeNode, depth: number) => {
    const isExpanded = search.trim().length > 0 || expanded.has(node.path);
    const isActive = !node.isFolder && activeFilePath === node.path;

    if (renamingPath === node.path) {
      return (
        <form
          key={node.path}
          onSubmit={(e) => handleRenameSubmit(e, node.path)}
          className="px-2 py-1"
          style={{ paddingInlineStart: `${depth * 14 + 8}px` }}
        >
          <input
            type="text"
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={() => setRenamingPath(null)}
            className="w-full rounded border border-blue-500 bg-white dark:bg-slate-950 px-2 py-1 text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none"
          />
        </form>
      );
    }

    return (
      <div key={node.path}>
        <div
          className={`group flex items-center justify-between gap-1 pe-2 py-1.5 text-xs cursor-pointer rounded-md mx-1 transition-colors ${
            isActive
              ? 'bg-blue-600/15 text-blue-600 dark:text-blue-400 font-medium'
              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
          }`}
          style={{ paddingInlineStart: `${depth * 14 + 8}px` }}
          onClick={() => (node.isFolder ? toggleFolder(node.path) : onSelectFile(node.path))}
        >
          <div className="flex items-center gap-1.5 min-w-0">
            {node.isFolder ? (
              <>
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                )}
                {isExpanded ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                )}
              </>
            ) : (
              <FileCode2 className="h-3.5 w-3.5 shrink-0 text-slate-400 ms-4" />
            )}
            <span className="truncate font-mono">{node.name}</span>
          </div>

          <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setRenamingPath(node.path);
                setRenameValue(node.path);
              }}
              className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-500"
              title={t('rename')}
            >
              <Edit2 className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDeletePath(node.path);
              }}
              className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950/60 text-slate-500 hover:text-red-600"
              title={t('delete')}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        </div>

        {node.isFolder && isExpanded && (
          <div>{node.children.map((child) => renderNode(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-slate-900 border-e border-slate-200 dark:border-slate-800">
      <div className="px-3 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
          {t('fileExplorer')}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setCreatingMode('file');
              setNewPathInput('src/components/NewComponent.tsx');
            }}
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
            title={t('newFile')}
          >
            <FilePlus2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setCreatingMode('folder');
              setNewPathInput('src/utils');
            }}
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
            title={t('newFolder')}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="p-2 border-b border-slate-100 dark:border-slate-800/80">
        <div className="relative">
          <Search className="h-3.5 w-3.5 text-slate-400 absolute start-2.5 top-2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchFiles')}
            className="w-full rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 ps-8 pe-2 py-1 text-xs text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-600"
          />
        </div>

        {creatingMode && (
          <form onSubmit={handleCreateSubmit} className="mt-2 space-y-1.5">
            <input
              type="text"
              autoFocus
              value={newPathInput}
              onChange={(e) => setNewPathInput(e.target.value)}
              placeholder={creatingMode === 'folder' ? 'src/hooks' : 'src/components/Card.tsx'}
              className="w-full rounded-md border border-blue-500 bg-white dark:bg-slate-950 px-2 py-1 text-xs font-mono text-slate-900 dark:text-slate-100 focus:outline-none"
            />
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setCreatingMode(null)}
                className="px-2 py-0.5 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              >
                {t('cancel')}
              </button>
              <button
                type="submit"
                className="px-2.5 py-0.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
              >
                Create
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="flex-1 overflow-y-auto py-1.5">
        {tree.length === 0 ? (
          <p className="px-4 py-6 text-xs text-slate-400 text-center">No matching files</p>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}
      </div>
    </div>
  );
}
