import React, { useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Maximize2,
  Minimize2,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Tablet,
  Wrench,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';
import type { PreviewBundleResult } from '../preview/previewBundler.ts';

interface LivePreviewPanelProps {
  bundle: PreviewBundleResult | null;
  bundling: boolean;
  runtimeErrors: string[];
  onRefresh: () => void;
  onAskAiFix: (errorSummary: string) => void;
}

type ViewportMode = 'desktop' | 'tablet' | 'mobile';

export function LivePreviewPanel({
  bundle,
  bundling,
  runtimeErrors,
  onRefresh,
  onAskAiFix,
}: LivePreviewPanelProps) {
  const { t } = useApp();
  const [viewport, setViewport] = useState<ViewportMode>('desktop');
  const [fullscreen, setFullscreen] = useState(false);

  const widthStyle =
    viewport === 'mobile' ? '375px' : viewport === 'tablet' ? '768px' : '100%';

  const handleOpenNewTab = () => {
    if (!bundle?.html) return;
    const blob = new Blob([bundle.html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const buildErrors = bundle && !bundle.ok ? bundle.errors : [];
  const hasErrors = buildErrors.length > 0 || runtimeErrors.length > 0;
  const combinedErrorSummary = [
    ...buildErrors.map((e) => `${e.file ? `${e.file}:${e.line || 1} ` : ''}${e.text}`),
    ...runtimeErrors,
  ].join('\n');

  return (
    <div
      className={`flex flex-col bg-slate-100 dark:bg-slate-950 ${
        fullscreen ? 'fixed inset-0 z-50' : 'h-full'
      }`}
    >
      {/* Preview Toolbar */}
      <div className="h-10 shrink-0 px-3 flex items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800">
          <button
            type="button"
            onClick={() => setViewport('desktop')}
            className={`px-2 py-1 rounded-md text-xs flex items-center gap-1 transition-colors ${
              viewport === 'desktop'
                ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
            title={t('desktopView')}
          >
            <Monitor className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">{t('desktopView')}</span>
          </button>
          <button
            type="button"
            onClick={() => setViewport('tablet')}
            className={`px-2 py-1 rounded-md text-xs flex items-center gap-1 transition-colors ${
              viewport === 'tablet'
                ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
            title={t('tabletView')}
          >
            <Tablet className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">{t('tabletView')}</span>
          </button>
          <button
            type="button"
            onClick={() => setViewport('mobile')}
            className={`px-2 py-1 rounded-md text-xs flex items-center gap-1 transition-colors ${
              viewport === 'mobile'
                ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
            title={t('mobileView')}
          >
            <Smartphone className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">{t('mobileView')}</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="hidden md:inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 me-2">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>{t('sandboxNotice')}</span>
          </span>

          <button
            type="button"
            onClick={onRefresh}
            disabled={bundling}
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            title={t('refresh')}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${bundling ? 'animate-spin' : ''}`} />
          </button>

          <button
            type="button"
            onClick={handleOpenNewTab}
            disabled={!bundle?.html}
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            title={t('openInNewTab')}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={() => setFullscreen((f) => !f)}
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800"
            title={t('fullscreen')}
          >
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Error Banner when Build or Runtime Error occurs */}
      {hasErrors && (
        <div className="shrink-0 bg-red-50 dark:bg-red-950/60 border-b border-red-200 dark:border-red-900 px-4 py-2.5 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-red-800 dark:text-red-300">
                {buildErrors.length > 0 ? 'Preview Build Error' : 'Preview Runtime Error'}
              </p>
              <pre className="mt-1 text-[11px] font-mono text-red-700 dark:text-red-300 whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                {combinedErrorSummary}
              </pre>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onAskAiFix(combinedErrorSummary)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white shrink-0 whitespace-nowrap"
          >
            <Wrench className="h-3.5 w-3.5" />
            <span>Fix with AI</span>
          </button>
        </div>
      )}

      {/* Sandboxed Iframe Container */}
      <div className="flex-1 min-h-0 overflow-auto flex justify-center p-3">
        <div
          style={{ width: widthStyle, maxWidth: '100%' }}
          className="h-full bg-white rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden shadow-xs transition-[width] duration-200"
        >
          {bundle?.ok && bundle.html ? (
            <iframe
              title="OmniAI Sandboxed Live Preview"
              sandbox="allow-scripts"
              srcDoc={bundle.html}
              className="w-full h-full border-0 bg-white"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center p-6 text-center text-sm text-slate-500">
              {bundling
                ? 'Bundling project for sandboxed preview...'
                : buildErrors.length > 0
                  ? 'Fix the build error above to render live preview.'
                  : 'Preview not ready yet.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
