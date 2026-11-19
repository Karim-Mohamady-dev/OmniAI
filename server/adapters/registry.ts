import type { ModelProtocol } from '../types.ts';
import { AnthropicAdapter } from './anthropicAdapter.ts';
import type { ProviderAdapter } from './base.ts';
import { CustomHttpAdapter } from './customHttpAdapter.ts';
import { GeminiAdapter } from './geminiAdapter.ts';
import { OpenAICompatibleAdapter } from './openaiCompatibleAdapter.ts';

const adapters: Record<ModelProtocol, ProviderAdapter> = {
  'google-gemini': new GeminiAdapter(),
  'openai-compatible': new OpenAICompatibleAdapter(),
  anthropic: new AnthropicAdapter(),
  'custom-http': new CustomHttpAdapter(),
};

export function getAdapterForProtocol(protocol: ModelProtocol): ProviderAdapter {
  return adapters[protocol] || adapters['openai-compatible'];
}
