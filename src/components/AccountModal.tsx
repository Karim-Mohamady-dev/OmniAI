import React, { useState } from 'react';
import { CloudDownload, CloudUpload, LogOut, ShieldCheck, UserCheck, X } from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';

export function AccountModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {
    authUser,
    databaseConfigured,
    settings,
    updateSettings,
    loginUser,
    registerUser,
    logoutUser,
    syncWorkspaceToCloud,
    pullWorkspaceFromCloud,
    pushToast,
  } = useApp();

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        await loginUser(email, password);
        await updateSettings({ runtimeMode: 'hosted' });
        pushToast({ type: 'success', title: 'Signed in to Hosted Account' });
      } else {
        await registerUser(email, password, displayName);
        await updateSettings({ runtimeMode: 'hosted' });
        pushToast({ type: 'success', title: 'Hosted Account Created' });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Account & Runtime Mode"
    >
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xl">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Account &amp; Workspace Isolation
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Runtime Mode Switcher */}
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2 text-xs">
            <div className="font-semibold text-slate-800 dark:text-slate-200">Runtime Mode</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => updateSettings({ runtimeMode: 'local' })}
                className={`py-2 px-3 rounded-lg border text-xs font-medium ${
                  (settings.runtimeMode || 'local') === 'local'
                    ? 'border-blue-500 bg-blue-600/10 text-blue-600 dark:text-blue-400'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                }`}
              >
                Local Personal
              </button>
              <button
                type="button"
                onClick={() => updateSettings({ runtimeMode: 'hosted' })}
                className={`py-2 px-3 rounded-lg border text-xs font-medium ${
                  settings.runtimeMode === 'hosted'
                    ? 'border-blue-500 bg-blue-600/10 text-blue-600 dark:text-blue-400'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
                }`}
              >
                Hosted Multi-User
              </button>
            </div>
            <p className="text-[11px] text-slate-500">
              {databaseConfigured
                ? 'PostgreSQL DATABASE_URL detected on server.'
                : 'Server multi-user store active (.omniai-data/multiuser-store.json + schema in server/db/migrations/001_multi_user_schema.sql).'}
            </p>
          </div>

          {authUser ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/30 p-3.5 text-xs space-y-1">
                <div className="flex items-center gap-2 font-semibold text-emerald-700 dark:text-emerald-300">
                  <UserCheck className="h-4 w-4" />
                  <span>{authUser.displayName}</span>
                </div>
                <div className="font-mono text-slate-600 dark:text-slate-400">
                  {authUser.email} · {authUser.role}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await syncWorkspaceToCloud();
                    pushToast({ type: 'success', title: 'Workspace synced to user vault' });
                  }}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
                >
                  <CloudUpload className="h-3.5 w-3.5" />
                  <span>Push to Cloud</span>
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    await pullWorkspaceFromCloud();
                    pushToast({ type: 'success', title: 'Loaded cloud workspace state' });
                  }}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <CloudDownload className="h-3.5 w-3.5" />
                  <span>Pull from Cloud</span>
                </button>
              </div>

              <button
                type="button"
                onClick={async () => {
                  await logoutUser();
                  pushToast({ type: 'info', title: 'Signed out' });
                }}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3 text-xs">
              <div className="flex gap-1 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className={`flex-1 py-1.5 rounded-md font-medium ${
                    mode === 'login' ? 'bg-white dark:bg-slate-950 shadow-xs' : 'text-slate-500'
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => setMode('register')}
                  className={`flex-1 py-1.5 rounded-md font-medium ${
                    mode === 'register' ? 'bg-white dark:bg-slate-950 shadow-xs' : 'text-slate-500'
                  }`}
                >
                  Create Account
                </button>
              </div>

              {error && (
                <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-red-700 dark:text-red-300">
                  {error}
                </div>
              )}

              {mode === 'register' && (
                <div>
                  <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                    Display Name
                  </label>
                  <input
                    type="text"
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Ada Lovelace"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2"
                  />
                </div>
              )}

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="developer@example.com"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Password (min 8 chars)
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
              >
                {busy
                  ? 'Working...'
                  : mode === 'login'
                    ? 'Sign In & Isolate Workspace'
                    : 'Register & Isolate Workspace'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
