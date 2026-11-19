import React, { Suspense, lazy } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { ToastContainer } from './components/ToastContainer.tsx';
import { AppProvider, useApp } from './contexts/AppContext.tsx';
import { AppShell } from './layouts/AppShell.tsx';
import { AnalyticsPage } from './pages/AnalyticsPage.tsx';
import { ChatPage } from './pages/ChatPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { DiagnosticsPage } from './pages/DiagnosticsPage.tsx';
import { GitHubPage } from './pages/GitHubPage.tsx';
import { ModelsPage } from './pages/ModelsPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

const StudioPage = lazy(() =>
  import('./pages/StudioPage.tsx').then((m) => ({ default: m.StudioPage }))
);

function OmniAIRouter() {
  const { ready, route, t } = useApp();

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-slate-500 text-sm">
        {t('loading')}
      </div>
    );
  }

  return (
    <AppShell>
      <ErrorBoundary>
        {route === 'dashboard' && <DashboardPage />}
        {route === 'chat' && <ChatPage />}
        {route === 'studio' && (
          <Suspense
            fallback={
              <div className="min-h-[320px] flex items-center justify-center text-sm text-slate-500">
                {t('loading')}
              </div>
            }
          >
            <StudioPage />
          </Suspense>
        )}
        {route === 'projects' && <ProjectsPage />}
        {route === 'models' && <ModelsPage />}
        {route === 'diagnostics' && <DiagnosticsPage />}
        {route === 'analytics' && <AnalyticsPage />}
        {route === 'github' && <GitHubPage />}
        {route === 'settings' && <SettingsPage />}
      </ErrorBoundary>
    </AppShell>
  );
}

export default function App() {
  return (
    <ErrorBoundary fallbackTitle="OmniAI Studio Encountered an Error">
      <AppProvider>
        <OmniAIRouter />
        <ToastContainer />
      </AppProvider>
    </ErrorBoundary>
  );
}
