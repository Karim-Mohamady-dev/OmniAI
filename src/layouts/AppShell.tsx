import React, { useEffect, useState } from 'react';
import {
  BarChart3,
  Code2,
  Compass,
  Cpu,
  FolderGit2,
  FolderKanban,
  LayoutDashboard,
  Menu,
  MessageSquare,
  Plus,
  Search,
  Settings,
  Stethoscope,
  UserCheck,
  X,
} from 'lucide-react';
import { AccountModal } from '../components/AccountModal.tsx';
import { CommandPalette } from '../components/CommandPalette.tsx';
import { OnboardingWizard } from '../components/OnboardingWizard.tsx';
import { useApp } from '../contexts/AppContext.tsx';
import type { NavRoute } from '../types/index.ts';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const {
    route,
    setRoute,
    t,
    createNewConversation,
    setActiveConversationId,
    models,
    githubStatus,
    authUser,
    settings,
  } = useApp();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  // Global Ctrl+K / Cmd+K shortcut for Command Palette + custom modal events
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((prev) => !prev);
      }
    };
    const onOpenOnboarding = () => setOnboardingOpen(true);
    const onOpenAccount = () => setAccountOpen(true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('omniai:open-onboarding', onOpenOnboarding);
    window.addEventListener('omniai:open-account', onOpenAccount);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('omniai:open-onboarding', onOpenOnboarding);
      window.removeEventListener('omniai:open-account', onOpenAccount);
    };
  }, []);

  const navItems: Array<{ id: NavRoute; label: string; icon: React.ReactNode }> = [
    { id: 'dashboard', label: t('navDashboard'), icon: <LayoutDashboard className="h-4 w-4" /> },
    { id: 'chat', label: t('navChat'), icon: <MessageSquare className="h-4 w-4" /> },
    { id: 'studio', label: t('navStudio'), icon: <Code2 className="h-4 w-4" /> },
    { id: 'projects', label: t('navProjects'), icon: <FolderKanban className="h-4 w-4" /> },
    { id: 'models', label: t('navModels'), icon: <Cpu className="h-4 w-4" /> },
    { id: 'diagnostics', label: t('navDiagnostics'), icon: <Stethoscope className="h-4 w-4" /> },
    { id: 'analytics', label: t('navAnalytics'), icon: <BarChart3 className="h-4 w-4" /> },
    { id: 'github', label: t('navGitHub'), icon: <FolderGit2 className="h-4 w-4" /> },
    { id: 'settings', label: t('navSettings'), icon: <Settings className="h-4 w-4" /> },
  ];

  const activeNavLabel = navItems.find((item) => item.id === route)?.label || t('appName');
  const primaryModel = [...models]
    .filter((m) => m.enabled)
    .sort((a, b) => a.priority - b.priority)[0];

  const handlePrimaryTopAction = async () => {
    if (route === 'models') {
      setRoute('models');
      window.dispatchEvent(new CustomEvent('omniai:open-add-model'));
      return;
    }
    if (route === 'projects') {
      window.dispatchEvent(new CustomEvent('omniai:open-new-project'));
      return;
    }
    const conv = await createNewConversation();
    setActiveConversationId(conv.id);
    setRoute('chat');
  };

  const primaryActionLabel =
    route === 'models'
      ? t('addNewModel')
      : route === 'projects'
        ? t('newProject')
        : t('newChat');

  const navigate = (target: NavRoute) => {
    setRoute(target);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:shrink-0 border-e border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="h-14 flex items-center justify-between px-5 border-b border-slate-200 dark:border-slate-800">
          <button
            type="button"
            onClick={() => navigate('dashboard')}
            className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0 font-display"
          >
            {t('appName')}
          </button>
          <button
            type="button"
            onClick={() => setOnboardingOpen(true)}
            title={t('guidedTour')}
            aria-label={t('guidedTour')}
            className="p-1.5 rounded-lg text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Compass className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto" aria-label="Primary Navigation">
          {navItems.map((item) => {
            const active = route === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/70 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                <span className="shrink-0">{item.icon}</span>
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-2 text-xs text-slate-500 dark:text-slate-400">
          <div className="flex items-center justify-between gap-2">
            <span>{t('activeModel')}</span>
            <span className="font-mono tabular-nums text-slate-700 dark:text-slate-300 truncate max-w-[120px]">
              {primaryModel ? primaryModel.displayName : 'None'}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>GitHub</span>
            <span className="text-slate-700 dark:text-slate-300 truncate">
              {githubStatus.connected && githubStatus.user
                ? `@${githubStatus.user.login}`
                : 'Not connected'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setAccountOpen(true)}
            className="w-full pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 text-start hover:text-slate-900 dark:hover:text-slate-100"
          >
            <span className="inline-flex items-center gap-1.5">
              <UserCheck className="h-3.5 w-3.5" />
              <span>{authUser ? authUser.displayName : 'Local Personal'}</span>
            </span>
            <span className="font-mono text-[10px] text-blue-600 dark:text-blue-400">
              {settings.runtimeMode === 'hosted' ? 'hosted' : 'local'}
            </span>
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-50 w-64 max-w-[80vw] flex flex-col bg-white dark:bg-slate-900 border-e border-slate-200 dark:border-slate-800">
            <div className="h-14 flex items-center justify-between px-4 border-b border-slate-200 dark:border-slate-800">
              <span className="text-base font-bold font-display">{t('appName')}</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-2 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
              {navItems.map((item) => {
                const active = route === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract: Breadcrumb/Title — Concise Info — Single Primary CTA */}
        <header className="h-14 shrink-0 flex items-center justify-between gap-4 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ms-2 rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="lg:hidden font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                {t('appName')}
              </span>
              <span className="lg:hidden text-slate-400" aria-hidden="true">
                /
              </span>
              <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
                {activeNavLabel}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <Search className="h-3.5 w-3.5" />
              <span>{t('commandPalette')}</span>
            </button>

            <button
              type="button"
              onClick={() => setAccountOpen(true)}
              className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <UserCheck className="h-3.5 w-3.5" />
              <span>{authUser ? authUser.displayName : 'Local'}</span>
            </button>

            <button
              type="button"
              onClick={handlePrimaryTopAction}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{primaryActionLabel}</span>
            </button>
          </div>
        </header>

        <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>
      </div>

      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        onOpenOnboarding={() => setOnboardingOpen(true)}
      />
      <OnboardingWizard open={onboardingOpen} onClose={() => setOnboardingOpen(false)} />
      <AccountModal open={accountOpen} onClose={() => setAccountOpen(false)} />
    </div>
  );
}
