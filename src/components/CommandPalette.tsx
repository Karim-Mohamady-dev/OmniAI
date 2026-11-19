import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Code2,
  Compass,
  Cpu,
  FolderGit2,
  FolderKanban,
  LayoutDashboard,
  MessageSquare,
  Search,
  Settings,
  Stethoscope,
  SunMoon,
  X,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';
import type { NavRoute } from '../types/index.ts';

interface CommandAction {
  id: string;
  label: string;
  category: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onOpenOnboarding,
}: {
  open: boolean;
  onClose: () => void;
  onOpenOnboarding: () => void;
}) {
  const {
    projects,
    settings,
    setRoute,
    setActiveProjectId,
    updateSettings,
    createNewConversation,
  } = useApp();
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const actions = useMemo<CommandAction[]>(() => {
    const go = (r: NavRoute) => () => {
      setRoute(r);
      onClose();
    };
    const base: CommandAction[] = [
      { id: 'nav-dashboard', label: 'Go to Dashboard & Model Health', category: 'Navigation', icon: <LayoutDashboard className="h-4 w-4" />, run: go('dashboard') },
      { id: 'nav-chat', label: 'Go to AI Chat', category: 'Navigation', icon: <MessageSquare className="h-4 w-4" />, run: go('chat') },
      { id: 'nav-studio', label: 'Go to AI Development Studio', category: 'Navigation', icon: <Code2 className="h-4 w-4" />, run: go('studio') },
      { id: 'nav-projects', label: 'Go to Projects', category: 'Navigation', icon: <FolderKanban className="h-4 w-4" />, run: go('projects') },
      { id: 'nav-models', label: 'Go to Multi-Model Manager', category: 'Navigation', icon: <Cpu className="h-4 w-4" />, run: go('models') },
      { id: 'nav-diagnostics', label: 'Go to Provider Diagnostics', category: 'Navigation', icon: <Stethoscope className="h-4 w-4" />, run: go('diagnostics') },
      { id: 'nav-analytics', label: 'Go to Usage & Cost Analytics', category: 'Navigation', icon: <BarChart3 className="h-4 w-4" />, run: go('analytics') },
      { id: 'nav-github', label: 'Go to GitHub Integration', category: 'Navigation', icon: <FolderGit2 className="h-4 w-4" />, run: go('github') },
      { id: 'nav-settings', label: 'Go to Settings & Accounts', category: 'Navigation', icon: <Settings className="h-4 w-4" />, run: go('settings') },
      {
        id: 'act-new-chat',
        label: 'Start New Conversation',
        category: 'Actions',
        icon: <MessageSquare className="h-4 w-4" />,
        run: () => {
          createNewConversation();
          setRoute('chat');
          onClose();
        },
      },
      {
        id: 'act-theme',
        label: `Toggle Theme (current: ${settings.theme})`,
        category: 'Actions',
        icon: <SunMoon className="h-4 w-4" />,
        run: () => {
          updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' });
          onClose();
        },
      },
      {
        id: 'act-tour',
        label: 'Open Guided Onboarding Wizard',
        category: 'Help',
        icon: <Compass className="h-4 w-4" />,
        run: () => {
          onClose();
          onOpenOnboarding();
        },
      },
    ];

    const projActions: CommandAction[] = projects.map((p) => ({
      id: `proj-${p.id}`,
      label: `Open Studio Project: ${p.name}`,
      category: 'Projects',
      icon: <Code2 className="h-4 w-4" />,
      run: () => {
        setActiveProjectId(p.id);
        setRoute('studio');
        onClose();
      },
    }));

    return [...base, ...projActions];
  }, [createNewConversation, onClose, onOpenOnboarding, projects, setActiveProjectId, setRoute, settings.theme, updateSettings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter(
      (a) => a.label.toLowerCase().includes(q) || a.category.toLowerCase().includes(q)
    );
  }, [actions, query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] bg-slate-950/60 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
    >
      <div className="w-full max-w-lg rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xl">
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <Search className="h-4 w-4 text-slate-400 shrink-0" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && filtered.length > 0) {
                filtered[0].run();
              }
            }}
            placeholder="Jump to page, switch project, or run action..."
            className="flex-1 bg-transparent text-sm text-slate-900 dark:text-slate-100 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            aria-label="Close command palette"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80">
          {filtered.length === 0 ? (
            <p className="p-6 text-center text-xs text-slate-500">No matching commands found.</p>
          ) : (
            filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={item.run}
                className="w-full px-4 py-2.5 flex items-center justify-between gap-3 text-start hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
              >
                <span className="flex items-center gap-2.5 text-sm text-slate-800 dark:text-slate-200">
                  <span className="text-slate-400">{item.icon}</span>
                  <span>{item.label}</span>
                </span>
                <span className="text-[11px] font-mono text-slate-400">{item.category}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
