import React from 'react';
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  Code2,
  Cpu,
  FolderKanban,
  MessageSquare,
  Stethoscope,
} from 'lucide-react';
import { ModelHealthDashboard } from '../components/ModelHealthDashboard.tsx';
import { useApp } from '../contexts/AppContext.tsx';
import { formatRelativeTime } from '../utils/helpers.ts';

export function DashboardPage() {
  const {
    models,
    conversations,
    projects,
    fallbackHistory,
    settings,
    setRoute,
    setActiveConversationId,
    setActiveProjectId,
    createNewConversation,
    t,
  } = useApp();

  const sortedModels = [...models].sort((a, b) => a.priority - b.priority);
  const enabledModels = sortedModels.filter((m) => m.enabled);
  const readyModels = enabledModels.filter((m) => m.status === 'connected' || m.status === 'untested');
  const activeModel = enabledModels[0] || null;

  const recentActivities = projects
    .flatMap((p) =>
      p.activities.map((a) => ({
        ...a,
        projectId: p.id,
        projectName: p.name,
      }))
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 8);

  const handleQuickChat = async () => {
    if (conversations.length > 0) {
      setActiveConversationId(conversations[0].id);
    } else {
      const created = await createNewConversation();
      setActiveConversationId(created.id);
    }
    setRoute('chat');
  };

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            {t('dashboardTitle')}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {t('dashboardSubtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setRoute('diagnostics')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            <Stethoscope className="h-3.5 w-3.5" />
            <span>{t('navDiagnostics')}</span>
          </button>
          <button
            type="button"
            onClick={() => setRoute('analytics')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            <BarChart3 className="h-3.5 w-3.5" />
            <span>{t('navAnalytics')}</span>
          </button>
          <button
            type="button"
            onClick={handleQuickChat}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            <MessageSquare className="h-4 w-4" />
            <span>{t('startChat')}</span>
          </button>
          <button
            type="button"
            onClick={() => setRoute('studio')}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
          >
            <Code2 className="h-4 w-4" />
            <span>{t('openStudio')}</span>
          </button>
        </div>
      </div>

      {/* KPI Strip (Single-Elevation flat bordered surface) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            <span>{t('totalConnectedModels')}</span>
            <Cpu className="h-4 w-4 text-slate-400" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {models.length}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {enabledModels.length} enabled · mode: {settings.routingMode}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            <span>{t('availableModels')}</span>
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {readyModels.length}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {fallbackHistory.length} fallback switches logged
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            <span>{t('activeModel')}</span>
            <Activity className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          </div>
          <p className="mt-2 text-base font-semibold text-slate-900 dark:text-slate-100 truncate">
            {activeModel ? activeModel.displayName : 'None configured'}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 truncate">
            {activeModel ? `${activeModel.providerName} · ${activeModel.modelId}` : 'Add a model to begin'}
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
            <span>{t('totalProjects')}</span>
            <FolderKanban className="h-4 w-4 text-slate-400" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {projects.length}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {conversations.length} saved conversations
          </p>
        </div>
      </div>

      {/* Model Health & Orchestration Telemetry Dashboard */}
      <ModelHealthDashboard onNavigateModels={() => setRoute('models')} />

      {/* Two-Column Grid: Recent Conversations & Recent Projects + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Conversations */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {t('recentConversations')}
            </h2>
            <button
              type="button"
              onClick={() => setRoute('chat')}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
            >
              View All
            </button>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
            {conversations.length === 0 ? (
              <p className="p-6 text-sm text-slate-500 dark:text-slate-400">
                {t('noConversationsYet')}
              </p>
            ) : (
              conversations.slice(0, 5).map((conv) => (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => {
                    setActiveConversationId(conv.id);
                    setRoute('chat');
                  }}
                  className="w-full px-5 py-3.5 text-start flex items-center justify-between gap-4 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                      {conv.title}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      {conv.messages.length} messages · {formatRelativeTime(conv.updatedAt)}
                    </p>
                  </div>
                  <ArrowUpRight className="h-4 w-4 text-slate-400 shrink-0" />
                </button>
              ))
            )}
          </div>
        </section>

        {/* Recent Projects & Activity */}
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {t('recentProjects')}
            </h2>
            <button
              type="button"
              onClick={() => setRoute('projects')}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
            >
              View All
            </button>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
            {projects.length === 0 ? (
              <p className="p-6 text-sm text-slate-500 dark:text-slate-400">
                {t('noProjectsYet')}
              </p>
            ) : (
              projects.slice(0, 4).map((proj) => (
                <button
                  key={proj.id}
                  type="button"
                  onClick={() => {
                    setActiveProjectId(proj.id);
                    setRoute('studio');
                  }}
                  className="w-full px-5 py-3.5 text-start flex items-center justify-between gap-4 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                      {proj.name}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                      {proj.framework} · {proj.files.length} files · {formatRelativeTime(proj.updatedAt)}
                    </p>
                  </div>
                  <ArrowUpRight className="h-4 w-4 text-slate-400 shrink-0" />
                </button>
              ))
            )}
          </div>

          {recentActivities.length > 0 && (
            <div className="border-t border-slate-200 dark:border-slate-800 px-5 py-3.5 bg-slate-50/70 dark:bg-slate-950/50">
              <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-300 mb-2">
                {t('recentActivity')}
              </h3>
              <div className="space-y-1.5">
                {recentActivities.slice(0, 4).map((act) => (
                  <div
                    key={act.id}
                    className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400"
                  >
                    <span className="truncate">
                      <strong className="font-medium text-slate-700 dark:text-slate-300">
                        {act.projectName}
                      </strong>{' '}
                      · {act.action} — {act.detail}
                    </span>
                    <span className="shrink-0 tabular-nums">{formatRelativeTime(act.timestamp)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
