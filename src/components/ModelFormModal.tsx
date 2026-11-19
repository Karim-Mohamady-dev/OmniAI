import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye, EyeOff, ShieldCheck, Sparkles, Sliders, X } from 'lucide-react';
import { useApp } from '../contexts/AppContext.tsx';
import type { AIModelConfig, ModelCapabilities, ModelProtocol, ModelRoleTag } from '../types/index.ts';

interface ModelFormModalProps {
  open: boolean;
  editingModel: AIModelConfig | null;
  nextPriority: number;
  onClose: () => void;
  onSave: (data: Omit<AIModelConfig, 'id' | 'createdAt' | 'status'>) => Promise<void>;
}

const ROLE_TAG_OPTIONS: Array<{ key: ModelRoleTag; label: string }> = [
  { key: 'preferred', label: 'Preferred Primary' },
  { key: 'coding', label: 'Coding & Builder' },
  { key: 'vision', label: 'Vision / Multimodal' },
  { key: 'long-context', label: 'Long Context' },
  { key: 'backup', label: 'Backup Fallback' },
];

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  text: true,
  streaming: true,
  vision: false,
  imageUnderstanding: false,
  toolCalling: true,
  jsonOutput: true,
  longContext: false,
};

const CAPABILITY_LABELS: Array<{ key: keyof ModelCapabilities; label: string }> = [
  { key: 'text', label: 'Text generation' },
  { key: 'streaming', label: 'Streaming (SSE)' },
  { key: 'vision', label: 'Vision' },
  { key: 'imageUnderstanding', label: 'Image understanding' },
  { key: 'toolCalling', label: 'Tool calling' },
  { key: 'jsonOutput', label: 'JSON output' },
  { key: 'longContext', label: 'Long context (100k+)' },
];

const PROTOCOL_DEFAULTS: Record<ModelProtocol, { baseUrl: string; placeholderModel: string }> = {
  'openai-compatible': {
    baseUrl: 'https://api.openai.com/v1',
    placeholderModel: 'gpt-4o-mini',
  },
  'google-gemini': {
    baseUrl: '',
    placeholderModel: 'gemini-3.8-flash',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    placeholderModel: 'claude-3-7-sonnet-latest',
  },
  'custom-http': {
    baseUrl: 'https://your-endpoint.example.com/v1/generate',
    placeholderModel: 'custom-model-v1',
  },
};

const WIZARD_PRESETS: Array<{
  id: string;
  label: string;
  providerName: string;
  protocol: ModelProtocol;
  baseUrl: string;
  modelId: string;
  displayName: string;
  capabilities: ModelCapabilities;
}> = [
  {
    id: 'openai',
    label: 'OpenAI',
    providerName: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-4o-mini',
    displayName: 'OpenAI GPT-4o Mini',
    capabilities: { ...DEFAULT_CAPABILITIES, vision: true, imageUnderstanding: true, longContext: true },
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    providerName: 'Google Gemini',
    protocol: 'google-gemini',
    baseUrl: '',
    modelId: 'gemini-3.8-flash',
    displayName: 'Gemini 3.8 Flash',
    capabilities: { ...DEFAULT_CAPABILITIES, vision: true, imageUnderstanding: true, longContext: true },
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    providerName: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    modelId: 'claude-3-7-sonnet-latest',
    displayName: 'Claude 3.7 Sonnet',
    capabilities: { ...DEFAULT_CAPABILITIES, vision: true, imageUnderstanding: true, longContext: true },
  },
  {
    id: 'groq',
    label: 'Groq (OpenAI-Compatible)',
    providerName: 'Groq',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    modelId: 'llama-3.3-70b-versatile',
    displayName: 'Groq Llama 3.3 70B',
    capabilities: { ...DEFAULT_CAPABILITIES, longContext: true },
  },
  {
    id: 'ollama',
    label: 'Ollama (Local)',
    providerName: 'Ollama',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    modelId: 'llama3.2',
    displayName: 'Local Ollama Llama 3.2',
    capabilities: { ...DEFAULT_CAPABILITIES },
  },
  {
    id: 'custom',
    label: 'Custom HTTP API',
    providerName: 'Custom Provider',
    protocol: 'custom-http',
    baseUrl: 'https://your-endpoint.example.com/v1/generate',
    modelId: 'custom-model-v1',
    displayName: 'Custom Model',
    capabilities: { ...DEFAULT_CAPABILITIES, streaming: false },
  },
];

export function ModelFormModal({
  open,
  editingModel,
  nextPriority,
  onClose,
  onSave,
}: ModelFormModalProps) {
  const { serverGeminiConfigured, t } = useApp();

  const [mode, setMode] = useState<'wizard' | 'advanced'>('advanced');
  const [wizardStep, setWizardStep] = useState(1);

  const [displayName, setDisplayName] = useState('');
  const [providerName, setProviderName] = useState('');
  const [modelId, setModelId] = useState('');
  const [protocol, setProtocol] = useState<ModelProtocol>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [useServerEnvKey, setUseServerEnvKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [priority, setPriority] = useState(nextPriority);
  const [enabled, setEnabled] = useState(true);
  const [maxContextWindow, setMaxContextWindow] = useState('');
  const [maxOutputTokens, setMaxOutputTokens] = useState('');
  const [capabilities, setCapabilities] = useState<ModelCapabilities>(DEFAULT_CAPABILITIES);
  const [roleTags, setRoleTags] = useState<ModelRoleTag[]>([]);
  const [inputPer1MUsd, setInputPer1MUsd] = useState('');
  const [outputPer1MUsd, setOutputPer1MUsd] = useState('');
  const [customHeadersJson, setCustomHeadersJson] = useState('');
  const [pricingTier, setPricingTier] = useState<'unspecified' | 'paid' | 'free-tier-explicit'>('unspecified');
  const [customConfigJson, setCustomConfigJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editingModel) {
      setMode('advanced');
      setWizardStep(1);
      setDisplayName(editingModel.displayName);
      setProviderName(editingModel.providerName);
      setModelId(editingModel.modelId);
      setProtocol(editingModel.protocol);
      setBaseUrl(editingModel.baseUrl || '');
      setApiKey(editingModel.apiKey || '');
      setUseServerEnvKey(Boolean(editingModel.useServerEnvKey));
      setPriority(editingModel.priority);
      setEnabled(editingModel.enabled);
      setMaxContextWindow(
        editingModel.maxContextWindow ? String(editingModel.maxContextWindow) : ''
      );
      setMaxOutputTokens(
        editingModel.maxOutputTokens ? String(editingModel.maxOutputTokens) : ''
      );
      setCapabilities({
        ...DEFAULT_CAPABILITIES,
        ...(editingModel.capabilities || {}),
      });
      setRoleTags(editingModel.roleTags || []);
      setInputPer1MUsd(
        editingModel.pricing?.inputPer1MUsd !== undefined
          ? String(editingModel.pricing.inputPer1MUsd)
          : ''
      );
      setOutputPer1MUsd(
        editingModel.pricing?.outputPer1MUsd !== undefined
          ? String(editingModel.pricing.outputPer1MUsd)
          : ''
      );
      setCustomHeadersJson(
        editingModel.customHeaders ? JSON.stringify(editingModel.customHeaders, null, 2) : ''
      );
      setPricingTier(editingModel.pricingTier || 'unspecified');
      setCustomConfigJson(
        editingModel.customConfig ? JSON.stringify(editingModel.customConfig, null, 2) : ''
      );
    } else {
      setMode('wizard');
      setWizardStep(1);
      setDisplayName('');
      setProviderName('');
      setModelId('');
      setProtocol('openai-compatible');
      setBaseUrl(PROTOCOL_DEFAULTS['openai-compatible'].baseUrl);
      setApiKey('');
      setUseServerEnvKey(false);
      setPriority(nextPriority);
      setEnabled(true);
      setMaxContextWindow('');
      setMaxOutputTokens('');
      setCapabilities(DEFAULT_CAPABILITIES);
      setRoleTags([]);
      setInputPer1MUsd('');
      setOutputPer1MUsd('');
      setCustomHeadersJson('');
      setPricingTier('unspecified');
      setCustomConfigJson('');
    }
    setShowKey(false);
    setError(null);
  }, [open, editingModel, nextPriority]);

  if (!open) return null;

  const handleProtocolChange = (nextProto: ModelProtocol) => {
    setProtocol(nextProto);
    if (!editingModel) {
      setBaseUrl(PROTOCOL_DEFAULTS[nextProto].baseUrl);
      if (nextProto !== 'google-gemini') {
        setUseServerEnvKey(false);
      }
    }
  };

  const applyPreset = (preset: (typeof WIZARD_PRESETS)[number]) => {
    setProviderName(preset.providerName);
    setProtocol(preset.protocol);
    setBaseUrl(preset.baseUrl);
    setModelId(preset.modelId);
    setDisplayName(preset.displayName);
    setCapabilities(preset.capabilities);
    setUseServerEnvKey(preset.protocol === 'google-gemini' && serverGeminiConfigured);
    setWizardStep(2);
  };

  const toggleCapability = (key: keyof ModelCapabilities) => {
    setCapabilities((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleRoleTag = (role: ModelRoleTag) => {
    setRoleTags((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!displayName.trim() || !providerName.trim() || !modelId.trim()) {
      setError('Display Name, Provider Name, and Model ID are required.');
      return;
    }

    if (protocol !== 'google-gemini' && !baseUrl.trim()) {
      setError('API Base URL is required for this protocol.');
      return;
    }

    const hasExistingVaultKey = Boolean(editingModel?.credentialRefId);
    if (
      !useServerEnvKey &&
      !apiKey.trim() &&
      !hasExistingVaultKey &&
      protocol !== 'custom-http' &&
      protocol !== 'openai-compatible'
    ) {
      setError('Please enter an API Key for this model.');
      return;
    }

    let parsedCustomHeaders: Record<string, string> | undefined;
    if (customHeadersJson.trim()) {
      try {
        const parsed = JSON.parse(customHeadersJson);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setError('Custom Headers must be a JSON object of header key/value pairs.');
          return;
        }
        parsedCustomHeaders = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, String(v)])
        );
      } catch {
        setError('Custom Headers contains invalid JSON.');
        return;
      }
    }

    let parsedCustomConfig: Record<string, unknown> | undefined;
    if (customConfigJson.trim()) {
      try {
        const parsed = JSON.parse(customConfigJson);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setError('Custom Configuration must be a valid JSON object.');
          return;
        }
        parsedCustomConfig = parsed;
      } catch {
        setError('Custom Configuration contains invalid JSON.');
        return;
      }
    }

    const parsedCtx = maxContextWindow.trim() ? Number(maxContextWindow.trim()) : undefined;
    if (parsedCtx !== undefined && (Number.isNaN(parsedCtx) || parsedCtx <= 0)) {
      setError('Maximum Context Window must be a positive number.');
      return;
    }

    const parsedOut = maxOutputTokens.trim() ? Number(maxOutputTokens.trim()) : undefined;
    if (parsedOut !== undefined && (Number.isNaN(parsedOut) || parsedOut <= 0)) {
      setError('Maximum Output Tokens must be a positive number.');
      return;
    }

    const parsedInputPrice = inputPer1MUsd.trim() ? Number(inputPer1MUsd.trim()) : undefined;
    const parsedOutputPrice = outputPer1MUsd.trim() ? Number(outputPer1MUsd.trim()) : undefined;

    setSaving(true);
    try {
      await onSave({
        displayName: displayName.trim(),
        providerName: providerName.trim(),
        modelId: modelId.trim(),
        protocol,
        baseUrl: baseUrl.trim() || undefined,
        apiKey: useServerEnvKey ? undefined : apiKey.trim() || undefined,
        credentialRefId:
          useServerEnvKey || apiKey.trim() ? undefined : editingModel?.credentialRefId,
        maskedApiKey:
          useServerEnvKey || apiKey.trim() ? undefined : editingModel?.maskedApiKey,
        useServerEnvKey: protocol === 'google-gemini' ? useServerEnvKey : false,
        priority: Math.max(1, Number(priority) || 1),
        enabled,
        maxContextWindow: parsedCtx,
        maxOutputTokens: parsedOut,
        capabilities,
        roleTags,
        customHeaders: parsedCustomHeaders,
        pricingTier,
        pricing:
          parsedInputPrice !== undefined || parsedOutputPrice !== undefined
            ? {
                inputPer1MUsd: parsedInputPrice,
                outputPer1MUsd: parsedOutputPrice,
                source: 'custom',
              }
            : undefined,
        customConfig: parsedCustomConfig,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 backdrop-blur-xs p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-2xl max-h-[92vh] flex flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {editingModel ? `Edit Model: ${editingModel.displayName}` : t('addNewModel')}
            </h2>
            {!editingModel && (
              <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 bg-slate-50 dark:bg-slate-950 text-xs">
                <button
                  type="button"
                  onClick={() => setMode('wizard')}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors ${
                    mode === 'wizard'
                      ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 font-medium shadow-xs'
                      : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  <Sparkles className="h-3 w-3" />
                  <span>{t('wizardMode')}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMode('advanced')}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors ${
                    mode === 'advanced'
                      ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 font-medium shadow-xs'
                      : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
                  }`}
                >
                  <Sliders className="h-3 w-3" />
                  <span>{t('advancedMode')}</span>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            aria-label={t('close')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {mode === 'wizard' && !editingModel ? (
          <div className="flex-1 overflow-y-auto p-6 space-y-5">
            {error && (
              <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>Step {wizardStep} of 3</span>
              <span className="font-mono">Guided Setup</span>
            </div>

            {wizardStep === 1 && (
              <div className="space-y-3">
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Choose a provider template to prefill protocol and endpoint defaults, or configure manually.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {WIZARD_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applyPreset(preset)}
                      className="text-start p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-blue-500 dark:hover:border-blue-500 bg-slate-50/50 dark:bg-slate-950/50 transition-colors space-y-1"
                    >
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {preset.label}
                      </div>
                      <div className="text-xs font-mono text-slate-500 truncate">
                        {preset.modelId} · {preset.protocol}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {wizardStep === 2 && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Display Name
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Model ID
                    </label>
                    <input
                      type="text"
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                      className="w-full font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      API Base URL
                    </label>
                    <input
                      type="text"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="https://..."
                      className="w-full font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                    />
                  </div>
                </div>
                {protocol === 'google-gemini' && serverGeminiConfigured && (
                  <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useServerEnvKey}
                      onChange={(e) => setUseServerEnvKey(e.target.checked)}
                    />
                    <span>Use server-managed Gemini environment key</span>
                  </label>
                )}
                {!useServerEnvKey && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      API Key (stored encrypted in server vault)
                    </label>
                    <div className="relative">
                      <input
                        type={showKey ? 'text' : 'password'}
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="Paste API key..."
                        className="w-full font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 ps-3 pe-10 py-2 text-sm text-slate-900 dark:text-slate-100"
                      />
                      <button
                        type="button"
                        onClick={() => setShowKey((s) => !s)}
                        className="absolute inset-y-0 end-0 px-3 text-slate-400"
                      >
                        {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => setWizardStep(1)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => setWizardStep(3)}
                    className="inline-flex items-center gap-1 px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    Next: Capabilities
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}

            {wizardStep === 3 && (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
                    {t('capabilitiesLabel')}
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {CAPABILITY_LABELS.map((cap) => (
                      <label
                        key={cap.key}
                        className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 p-2 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={capabilities[cap.key]}
                          onChange={() => toggleCapability(cap.key)}
                        />
                        <span>{cap.label}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Priority
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={priority}
                      onChange={(e) => setPriority(Number(e.target.value))}
                      className="w-full font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                      Billing Disclosure
                    </label>
                    <select
                      value={pricingTier}
                      onChange={(e) =>
                        setPricingTier(e.target.value as 'unspecified' | 'paid' | 'free-tier-explicit')
                      }
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100"
                    >
                      <option value="unspecified">Usage-based / Unspecified</option>
                      <option value="paid">Paid API Access</option>
                      <option value="free-tier-explicit">Explicitly Free Tier</option>
                    </select>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => setWizardStep(2)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-5 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white"
                  >
                    {saving ? t('loading') : t('save')}
                  </button>
                </div>
              </form>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
            {error && (
              <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Model Display Name
                </label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Primary GPT-4o or Local Llama 3"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Provider Name
                </label>
                <input
                  type="text"
                  value={providerName}
                  onChange={(e) => setProviderName(e.target.value)}
                  placeholder="e.g. OpenAI, Anthropic, Groq, Ollama"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  API Protocol / Compatibility Type
                </label>
                <select
                  value={protocol}
                  onChange={(e) => handleProtocolChange(e.target.value as ModelProtocol)}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="openai-compatible">OpenAI-Compatible API</option>
                  <option value="google-gemini">Google Gemini API</option>
                  <option value="anthropic">Anthropic Messages API</option>
                  <option value="custom-http">Custom HTTP JSON API</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Model ID
                </label>
                <input
                  type="text"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder={PROTOCOL_DEFAULTS[protocol].placeholderModel}
                  className="w-full font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                API Base URL {protocol === 'google-gemini' ? '(Optional override)' : ''}
              </label>
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={PROTOCOL_DEFAULTS[protocol].baseUrl || 'https://generativelanguage.googleapis.com'}
                className="w-full font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div className="space-y-2">
              {protocol === 'google-gemini' && serverGeminiConfigured && (
                <label className="flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useServerEnvKey}
                    onChange={(e) => setUseServerEnvKey(e.target.checked)}
                    className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600"
                  />
                  <span>Use server-managed environment credential (recommended for Gemini)</span>
                </label>
              )}

              {!useServerEnvKey && (
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                      API Key
                    </label>
                    {editingModel?.credentialRefId && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        Vaulted ({editingModel.maskedApiKey || 'encrypted'}) — leave blank to keep
                      </span>
                    )}
                  </div>
                  <div className="relative">
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={
                        editingModel?.credentialRefId
                          ? 'Enter new API key only if replacing existing vaulted key'
                          : 'Enter provider API key (leave blank only for unauthenticated local endpoints)'
                      }
                      autoComplete="off"
                      className="w-full font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 ps-3 pe-10 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((s) => !s)}
                      className="absolute inset-y-0 end-0 px-3 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                      aria-label={showKey ? 'Hide API key' : 'Show API key'}
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Priority
                </label>
                <input
                  type="number"
                  min={1}
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                  className="w-full font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Context Window
                </label>
                <input
                  type="number"
                  min={512}
                  value={maxContextWindow}
                  onChange={(e) => setMaxContextWindow(e.target.value)}
                  placeholder="128000"
                  className="w-full font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Max Output Tokens
                </label>
                <input
                  type="number"
                  min={64}
                  value={maxOutputTokens}
                  onChange={(e) => setMaxOutputTokens(e.target.value)}
                  placeholder="8192"
                  className="w-full font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Billing Disclosure
                </label>
                <select
                  value={pricingTier}
                  onChange={(e) =>
                    setPricingTier(e.target.value as 'unspecified' | 'paid' | 'free-tier-explicit')
                  }
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="unspecified">Usage-based</option>
                  <option value="paid">Paid API</option>
                  <option value="free-tier-explicit">Free Tier</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
                {t('capabilitiesLabel')}
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {CAPABILITY_LABELS.map((cap) => (
                  <label
                    key={cap.key}
                    className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 p-2 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={capabilities[cap.key]}
                      onChange={() => toggleCapability(cap.key)}
                    />
                    <span>{cap.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
                Orchestration Role Tags
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {ROLE_TAG_OPTIONS.map((role) => (
                  <label
                    key={role.key}
                    className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 p-2 rounded-lg border border-slate-200 dark:border-slate-800 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={roleTags.includes(role.key)}
                      onChange={() => toggleRoleTag(role.key)}
                    />
                    <span>{role.label}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Input Cost ($ / 1M tokens, optional)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={inputPer1MUsd}
                  onChange={(e) => setInputPer1MUsd(e.target.value)}
                  placeholder="Unavailable if blank"
                  className="w-full font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Output Cost ($ / 1M tokens, optional)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={outputPer1MUsd}
                  onChange={(e) => setOutputPer1MUsd(e.target.value)}
                  placeholder="Unavailable if blank"
                  className="w-full font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Custom Headers JSON (Optional)
                </label>
                <textarea
                  rows={2}
                  value={customHeadersJson}
                  onChange={(e) => setCustomHeadersJson(e.target.value)}
                  placeholder='{"HTTP-Referer": "https://omniai.local"}'
                  className="w-full font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Custom Configuration JSON (Optional)
                </label>
                <textarea
                  rows={2}
                  value={customConfigJson}
                  onChange={(e) => setCustomConfigJson(e.target.value)}
                  placeholder='{"parameters": {"temperature": 0.4}}'
                  className="w-full font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>

            <label className="flex items-center gap-2.5 text-sm text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="rounded border-slate-300 dark:border-slate-700 text-blue-600 focus:ring-blue-600"
              />
              <span>Enable model in automatic fallback pool</span>
            </label>

            <div className="pt-2 flex items-center justify-end gap-3 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                {t('cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-5 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors"
              >
                {saving ? t('loading') : t('save')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
