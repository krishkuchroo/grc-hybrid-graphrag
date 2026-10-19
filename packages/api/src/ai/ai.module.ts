// The model and embedding clients behind small interfaces (D8, D31, D45.2): TEXT_MODEL (schema-
// checked answers, one call at a time per program) and EMBEDDER (bge-m3, 1,024 numbers per text).
// TEXT_MODEL runs on the Mac's Ollama (gemma4:12b, the default) or on an OpenAI-compatible server
// (the user's Unsloth Studio model), as AI_TEXT_PROVIDER says (D236); EMBEDDER always runs on
// Ollama at OLLAMA_BASE_URL. Exported for the processing parts (S4) and chat (S6). Building them
// calls nothing; the first call goes out when a caller asks. Both the API and the worker build
// TEXT_MODEL once at start, and it logs one warning for each AI address that isn't on this Mac
// (D242): the setting's name only, never the address or a key, and nothing is blocked.
import { Module } from '@nestjs/common';
import { createLogger } from '../common/logger.js';
import { aiSettingsFromEnv, offMacAddressSettings } from './ai-settings.js';
import { EMBEDDER, type Embedder } from './embedder.js';
import { OllamaEmbedder } from './ollama-embedder.js';
import { TEXT_MODEL, type TextModel } from './text-model.js';
import { createTextModel } from './text-model-factory.js';

function textModelAtStart(): TextModel {
  const settings = aiSettingsFromEnv();
  const off = offMacAddressSettings(settings);
  if (off.length > 0) {
    const log = createLogger();
    for (const setting of off) {
      log.warn(
        { context: 'AiSettings', setting },
        'AI address is not on this Mac: model calls will leave the Mac (D57)',
      );
    }
  }
  return createTextModel(settings);
}

export class AiModule {}
Module({
  providers: [
    {
      provide: TEXT_MODEL,
      useFactory: textModelAtStart,
    },
    {
      provide: EMBEDDER,
      useFactory: (): Embedder => new OllamaEmbedder({ settings: aiSettingsFromEnv() }),
    },
  ],
  exports: [TEXT_MODEL, EMBEDDER],
})(AiModule);
