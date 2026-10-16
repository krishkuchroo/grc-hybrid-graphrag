// Search part 1, Path A (S6-003): vector search over the org's document passages in Postgres
// (pgvector, HNSW with iterative scan on, D71), limited to what the asker may see. It provides and
// exports `VECTOR_SEARCH` (../retrieval.ts), built on the embedder from AiModule (bge-m3) and
// Postgres (global). Runs in the API program; the module declares its own imports.
import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { EMBEDDER, type Embedder } from '../../ai/embedder.js';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { VECTOR_SEARCH, type VectorSearch } from '../retrieval.js';
import { PgVectorSearch } from './vector-search.service.js';

export class VectorSearchModule {}
Module({
  imports: [AiModule],
  providers: [
    {
      provide: VECTOR_SEARCH,
      useFactory: (db: Db, embedder: Embedder): VectorSearch => new PgVectorSearch({ db, embedder }),
      inject: [DB, EMBEDDER],
    },
  ],
  exports: [VECTOR_SEARCH],
})(VectorSearchModule);
