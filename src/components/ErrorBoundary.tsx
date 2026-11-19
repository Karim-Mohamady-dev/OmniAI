import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallbackTitle?: string },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode; fallbackTitle?: string }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'An unexpected rendering error occurred.',
    };
  }

  handleReset = () => {
    this.setState({ hasError: false, errorMessage: '' });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[320px] flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-xl border border-rose-200 dark:border-rose-500/30 bg-white dark:bg-slate-900 p-6 shadow-sm space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-rose-500/10 text-rose-500 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                  {this.props.fallbackTitle || 'Something went wrong'}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  The workspace component encountered an unexpected runtime error.
                </p>
              </div>
            </div>

            <div className="rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3 text-xs font-mono text-rose-600 dark:text-rose-400 break-words">
              {this.state.errorMessage}
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={this.handleReset}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Recover View
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
