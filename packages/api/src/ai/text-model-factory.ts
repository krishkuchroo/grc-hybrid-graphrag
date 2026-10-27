// The one place that picks the text model's class from the settings (D8, D236): Ollama
// (gemma4:12b by default) or an OpenAI-compatible server (the user's Unsloth Studio model). Used by
// ai.module.ts (the API and the worker), check.ts and the three try commands. Building a model
// calls nothing; the first call goes out when a caller asks.
import type { Logger } from 'pino';
import type { AiSettings } from './ai-settings.js';
import { OllamaTextModel } from './ollama-text-model.js';
import { OpenAiCompatibleTextModel } from './openai-compatible-text-model.js';
import type { TextModel } from './text-model.js';

export function createTextModel(settings: AiSettings, opts: { log?: Logger } = {}): TextModel {
  const { log } = opts;
  switch (settings.textProvider) {
    case 'ollama':
      return new OllamaTextModel({ settings, log });
    case 'openai-compatible': {
      // Fail safe: no connection settings means no client, never a fall back to Ollama.
      const connection = settings.openAiCompatible;
      if (connection === undefined) {
        throw new Error('AI_TEXT_PROVIDER is openai-compatible, but AI_TEXT_BASE_URL and AI_TEXT_API_KEY are missing');
      }
      return new OpenAiCompatibleTextModel({
        connection,
        model: settings.textModel,
        contextTokens: settings.textContextTokens,
        log,
      });
    }
    default:
      throw new Error('AI_TEXT_PROVIDER must be ollama or openai-compatible');
  }
}
