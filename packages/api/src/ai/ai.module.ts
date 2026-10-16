// The model and embedding clients behind small interfaces (D8, D31, D45.2): TEXT_MODEL (Gemma,
// schema-checked answers, one call at a time per program) and EMBEDDER (bge-m3, 1,024 numbers per
// text), both on the Mac's Ollama at OLLAMA_BASE_URL. Exported for the processing parts (S4) and
// chat (S6). Building them calls nothing; the first call goes out when a caller asks.
import { Module } from '@nestjs/common';
import { aiSettingsFromEnv } from './ai-settings.js';
import { EMBEDDER, type Embedder } from './embedder.js';
import { OllamaEmbedder } from './ollama-embedder.js';
import { OllamaTextModel } from './ollama-text-model.js';
import { TEXT_MODEL, type TextModel } from './text-model.js';

export class AiModule {}
Module({
  providers: [
    {
      provide: TEXT_MODEL,
      useFactory: (): TextModel => new OllamaTextModel({ settings: aiSettingsFromEnv() }),
    },
    {
      provide: EMBEDDER,
      useFactory: (): Embedder => new OllamaEmbedder({ settings: aiSettingsFromEnv() }),
    },
  ],
  exports: [TEXT_MODEL, EMBEDDER],
})(AiModule);
