import React, { useEffect, useRef, useState } from 'react';
import {
  Code2,
  Copy,
  Download,
  Edit3,
  Eye,
  FolderGit2,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { LivePreviewPanel } from '../components/LivePreviewPanel.tsx';
import { useApp } from '../contexts/AppContext.tsx';
import { bundleProjectForPreview, type PreviewBundleResult } from '../preview/previewBundler.ts';
import { downloadProjectAsZip } from '../project-engine/zipExporter.ts';
import type { Project } from '../types/index.ts';
import { createId, formatRelativeTime } from '../utils/helpers.ts';

export function ProjectsPage() {
  const {
    projects,
    createProject,
    saveProject,
    duplicateProject,
    deleteProject,
    setActiveProjectId,
    setRoute,
    pushToast,
    t,
  } = useApp();

  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'name' | 'files'>('updated');
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [framework, setFramework] = useState<'react-vite' | 'html-js'>('react-vite');
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [previewProj, setPreviewProj] = useState<Project | null>(null);
  const [previewBundle, setPreviewBundle] = useState<PreviewBundleResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const importRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handler = () => setNewOpen(true);
    window.addEventListener('omniai:open-new-project', handler);
    return () => window.removeEventListener('omniai:open-new-project', handler);
  }, []);

  const filtered = projects
    .filter(
      (p) =>
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.description.toLowerCase().includes(search.toLowerCase())
    )
    .sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'files') return b.files.length - a.files.length;
      return b.updatedAt - a.updatedAt;
    });

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const created = await createProject(name.trim(), description.trim(), framework);
    setNewOpen(false);
    setName('');
    setDescription('');
    setActiveProjectId(created.id);
    setRoute('studio');
    pushToast({
      type: 'success',
      title: 'Project created',
      description: `${created.name} opened in AI Studio.`,
    });
  };

  const handleDownload = async (proj: Project) => {
    const res = await downloadProjectAsZip(proj);
    pushToast({
      type: 'success',
      title: 'Project ZIP downloaded',
      description: `Exported ${res.fileCount} files to ${res.filename} (${res.excludedCount} secret files excluded).`,
    });
  };

  const handleQuickPreview = async (proj: Project) => {
    setPreviewProj(proj);
    setPreviewLoading(true);
    try {
      const res = await bundleProjectForPreview(proj.files, proj.framework);
      setPreviewBundle(res);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleImportProjectJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<Project>;
      if (!parsed.name || !Array.isArray(parsed.files)) {
        throw new Error('JSON must contain "name" and "files" array.');
      }
      const now = Date.now();
      const imported: Project = {
        id: createId('proj'),
        name: parsed.name,
        description: parsed.description || 'Imported project',
        framework: parsed.framework === 'html-js' ? 'html-js' : 'react-vite',
        status: 'active',
        files: parsed.files.map((f) => ({
          path: f.path,
          content: f.content,
          updatedAt: f.updatedAt || now,
        })),
        activities: [
          {
            id: createId('act'),
            action: 'Imported JSON project',
            detail: `${parsed.files.length} files`,
            timestamp: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      await saveProject(imported);
      pushToast({ type: 'success', title: `Imported "${imported.name}"` });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Project import failed',
        description: err instanceof Error ? err.message : 'Invalid project JSON file.',
      });
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {t('navProjects')}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Manage generated software projects, open in Monaco Studio, quick-preview, duplicate, export ZIP archives, or sync with GitHub.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => importRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <Upload className="h-3.5 w-3.5" />
            <span>Import JSON</span>
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".json,application/json"
            onChange={handleImportProjectJson}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => setNewOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
          >
            <Plus className="h-4 w-4" />
            <span>{t('newProject')}</span>
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="h-4 w-4 text-slate-400 absolute start-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects..."
            className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 ps-9 pe-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
        </div>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as 'updated' | 'name' | 'files')}
          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200"
        >
          <option value="updated">Sort: Last Updated</option>
          <option value="name">Sort: Name (A–Z)</option>
          <option value="files">Sort: Most Files</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 p-12 text-center">
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('noProjectsYet')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map((proj) => (
            <div
              key={proj.id}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col justify-between gap-4"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  {renamingId === proj.id ? (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (renameValue.trim()) {
                          await saveProject({
                            ...proj,
                            name: renameValue.trim(),
                            updatedAt: Date.now(),
                          });
                        }
                        setRenamingId(null);
                      }}
                      className="flex-1 flex items-center gap-1.5"
                    >
                      <input
                        type="text"
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => setRenamingId(null)}
                        className="flex-1 rounded border border-blue-500 bg-white dark:bg-slate-950 px-2 py-1 text-sm"
                      />
                    </form>
                  ) : (
                    <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
                      {proj.name}
                    </h2>
                  )}

                  <div className="flex items-center gap-2 shrink-0">
                    <select
                      value={proj.status || 'active'}
                      onChange={(e) =>
                        saveProject({
                          ...proj,
                          status: e.target.value as Project['status'],
                          updatedAt: Date.now(),
                        })
                      }
                      className="rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-1.5 py-0.5 text-[11px] font-medium"
                    >
                      <option value="active">Active</option>
                      <option value="draft">Draft</option>
                      <option value="archived">Archived</option>
                    </select>
                    <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                      {proj.framework}
                    </span>
                  </div>
                </div>

                <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-400 line-clamp-2">
                  {proj.description || 'No description provided.'}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  <span>{proj.files.length} files</span>
                  <span aria-hidden="true">·</span>
                  <span>Updated {formatRelativeTime(proj.updatedAt)}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono text-[11px]">
                    {proj.localFolderPath ? `Disk: ${proj.localFolderPath}` : 'IndexedDB'}
                  </span>
                  {proj.github && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-blue-600 dark:text-blue-400">
                        {proj.github.owner}/{proj.github.repo} ({proj.github.branch})
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 dark:border-slate-800/80 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveProjectId(proj.id);
                      setRoute('studio');
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    <span>{t('openStudio')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleQuickPreview(proj)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span>Preview</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleDownload(proj)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>ZIP</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setActiveProjectId(proj.id);
                      setRoute('github');
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <FolderGit2 className="h-3.5 w-3.5" />
                    <span>GitHub</span>
                  </button>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingId(proj.id);
                      setRenameValue(proj.name);
                    }}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    title={t('rename')}
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const copy = await duplicateProject(proj.id);
                      if (copy) {
                        pushToast({ type: 'success', title: `Duplicated as "${copy.name}"` });
                      }
                    }}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    title={t('duplicate')}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(proj)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
                    aria-label={`Delete ${proj.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Quick Preview Modal */}
      {previewProj && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-5xl h-[82vh] rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Preview: {previewProj.name}
              </span>
              <button
                type="button"
                onClick={() => setPreviewProj(null)}
                className="p-1 text-slate-400 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <LivePreviewPanel
                bundle={previewBundle}
                bundling={previewLoading}
                runtimeErrors={[]}
                onRefresh={() => handleQuickPreview(previewProj)}
                onAskAiFix={() => {
                  setActiveProjectId(previewProj.id);
                  setPreviewProj(null);
                  setRoute('studio');
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* New Project Modal */}
      {newOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800">
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {t('newProject')}
              </h2>
              <button
                type="button"
                onClick={() => setNewOpen(false)}
                className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Project Name
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Modern Commerce Storefront"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Framework Template
                </label>
                <select
                  value={framework}
                  onChange={(e) => setFramework(e.target.value as 'react-vite' | 'html-js')}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="react-vite">React + TypeScript + Vite</option>
                  <option value="html-js">HTML5 + CSS + Vanilla JavaScript</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Description
                </label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe the application goals..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setNewOpen(false)}
                  className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  {t('cancel')}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
                >
                  Create &amp; Open Studio
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Delete ${deleteTarget?.name || 'project'}?`}
        description="All project files stored locally in IndexedDB will be permanently removed."
        confirmLabel={t('delete')}
        onConfirm={async () => {
          if (deleteTarget) {
            await deleteProject(deleteTarget.id);
            pushToast({ type: 'info', title: 'Project deleted' });
          }
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
