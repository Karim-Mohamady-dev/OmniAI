import React, { useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { FileCode2, Search, X } from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';
import type { ProjectFile } from '../types/index.ts';
import { getLanguageFromPath } from '../utils/helpers.ts';

interface CodeEditorPanelProps {
  files: ProjectFile[];
  openTabs: string[];
  activeFilePath: string | null;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onChangeContent: (path: string, content: string) => void;
}

export function CodeEditorPanel({
  files,
  openTabs,
  activeFilePath,
  onSelectTab,
  onCloseTab,
  onChangeContent,
}: CodeEditorPanelProps) {
  const { settings } = useApp();
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const activeFile = files.find((f) => f.path === activeFilePath) || null;

  const isDarkTheme =
    settings.theme === 'dark' ||
    (settings.theme === 'system' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ES2020,
      allowNonTsExtensions: true,
      moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      noEmit: true,
      esModuleInterop: true,
      jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
      allowJs: true,
    });
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: false,
    });
  };

  const triggerFind = () => {
    editorRef.current?.getAction('actions.find')?.run();
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-slate-950 min-w-0">
      {/* Tabs Header */}
      <div className="h-10 shrink-0 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
        <div className="flex items-center overflow-x-auto no-scrollbar h-full">
          {openTabs.map((tabPath) => {
            const fileName = tabPath.split('/').pop() || tabPath;
            const active = tabPath === activeFilePath;
            return (
              <div
                key={tabPath}
                className={`group flex items-center gap-2 h-full px-3 border-e border-slate-200 dark:border-slate-800 text-xs cursor-pointer whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-medium'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                }`}
                onClick={() => onSelectTab(tabPath)}
              >
                <FileCode2 className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                <span className="font-mono">{fileName}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tabPath);
                  }}
                  className="p-0.5 rounded opacity-60 group-hover:opacity-100 hover:bg-slate-200 dark:hover:bg-slate-700"
                  aria-label={`Close ${fileName}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>

        {activeFile && (
          <button
            type="button"
            onClick={triggerFind}
            className="px-3 h-full flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 border-s border-slate-200 dark:border-slate-800 shrink-0"
            title="Search & Replace (Ctrl/Cmd+F)"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Find</span>
          </button>
        )}
      </div>

      {/* Monaco Editor Canvas */}
      <div className="flex-1 min-h-0" dir="ltr">
        {activeFile ? (
          <Editor
            height="100%"
            path={activeFile.path}
            language={getLanguageFromPath(activeFile.path)}
            value={activeFile.content}
            theme={isDarkTheme ? 'vs-dark' : 'light'}
            onMount={handleMount}
            onChange={(val) => onChangeContent(activeFile.path, val ?? '')}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "'JetBrains Mono', monospace",
              lineNumbers: 'on',
              wordWrap: 'on',
              tabSize: 2,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              padding: { top: 12 },
            }}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-slate-400 p-8 text-center">
            <FileCode2 className="h-8 w-8 mb-2 opacity-50" />
            <p className="text-sm">Select a file from the explorer to view or edit code.</p>
          </div>
        )}
      </div>
    </div>
  );
}
