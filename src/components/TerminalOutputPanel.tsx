import React, { useState } from 'react';
import { Laptop, Terminal as TerminalIcon, Trash2 } from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';
import { getDesktopCapabilities } from '../desktop/desktopBridge.ts';

export interface TerminalLogEntry {
  id: string;
  level: 'info' | 'log' | 'warn' | 'error';
  source: 'bundler' | 'sandbox' | 'supervisor' | 'github';
  message: string;
  timestamp: number;
}

interface TerminalOutputPanelProps {
  logs: TerminalLogEntry[];
  onClear: () => void;
}

export function TerminalOutputPanel({ logs, onClear }: TerminalOutputPanelProps) {
  const { t } = useApp();
  const [filter, setFilter] = useState<'all' | 'error' | 'warn'>('all');
  const caps = getDesktopCapabilities();

  const visibleLogs = logs.filter((l) => {
    if (filter === 'error') return l.level === 'error';
    if (filter === 'warn') return l.level === 'warn' || l.level === 'error';
    return true;
  });

  return (
    <div className="h-full flex flex-col bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
      <div className="h-9 shrink-0 px-3 flex items-center justify-between border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
            <TerminalIcon className="h-3.5 w-3.5" />
            <span>{t('terminalOutput')}</span>
          </span>

          <div className="flex items-center gap-1 text-[11px]">
            {(['all', 'warn', 'error'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`px-2 py-0.5 rounded capitalize ${
                  filter === f
                    ? 'bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-medium'
                    : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
            <Laptop className="h-3.5 w-3.5" />
            <span>
              {caps.supportsLocalTerminalExec
                ? 'Local Native Shell Active'
                : 'Browser Sandbox (Download ZIP or Desktop App for npm/shell)'}
            </span>
          </span>

          <button
            type="button"
            onClick={onClear}
            className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            title="Clear logs"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 font-mono text-xs space-y-1 bg-slate-50 dark:bg-slate-950" dir="ltr">
        {visibleLogs.length === 0 ? (
          <p className="text-slate-400 dark:text-slate-500 px-1 py-2">
            No build or runtime log entries yet.
          </p>
        ) : (
          visibleLogs.map((entry) => {
            const color =
              entry.level === 'error'
                ? 'text-red-600 dark:text-red-400'
                : entry.level === 'warn'
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-slate-700 dark:text-slate-300';
            return (
              <div key={entry.id} className={`flex items-start gap-2 leading-relaxed ${color}`}>
                <span className="text-slate-400 shrink-0 tabular-nums">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                <span className="text-slate-500 shrink-0">[{entry.source}]</span>
                <span className="whitespace-pre-wrap break-words">{entry.message}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
