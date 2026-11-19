import type { ModelCapabilities, ServerModelConfig } from '../types.ts';

export function inferCapabilitiesForModel(model: ServerModelConfig): ModelCapabilities {
  const id = (model.modelId || '').toLowerCase();
  const base: ModelCapabilities = {
    text: true,
    streaming: model.protocol !== 'custom-http',
    vision: false,
    imageUnderstanding: false,
    toolCalling: false,
    jsonOutput: false,
    longContext: Boolean(model.maxContextWindow && model.maxContextWindow >= 100_000),
  };

  if (model.protocol === 'google-gemini') {
    base.streaming = true;
    base.vision = true;
    base.imageUnderstanding = true;
    base.toolCalling = true;
    base.jsonOutput = true;
    if (!model.maxContextWindow) base.longContext = true;
  } else if (model.protocol === 'anthropic') {
    base.streaming = true;
    base.toolCalling = true;
    base.jsonOutput = true;
    base.longContext = !model.maxContextWindow || model.maxContextWindow >= 100_000;
    if (
      id.includes('claude-3') ||
      id.includes('claude-4') ||
      id.includes('sonnet') ||
      id.includes('opus') ||
      id.includes('haiku')
    ) {
      base.vision = true;
      base.imageUnderstanding = true;
    }
  } else if (model.protocol === 'openai-compatible') {
    base.streaming = true;
    if (
      id.includes('gpt-4o') ||
      id.includes('gpt-4-turbo') ||
      id.includes('gpt-4.1') ||
      id.includes('gpt-4.5') ||
      id.includes('o3') ||
      id.includes('o4') ||
      id.includes('vision') ||
      id.includes('llava') ||
      id.includes('pixtral') ||
      id.includes('qwen-vl')
    ) {
      base.vision = true;
      base.imageUnderstanding = true;
    }
    if (
      id.includes('gpt-4') ||
      id.includes('gpt-3.5') ||
      id.includes('o1') ||
      id.includes('o3') ||
      id.includes('o4') ||
      id.includes('deepseek') ||
      id.includes('qwen') ||
      id.includes('llama-3')
    ) {
      base.toolCalling = true;
      base.jsonOutput = true;
    }
  }

  return {
    ...base,
    ...(model.capabilities || {}),
  };
}
