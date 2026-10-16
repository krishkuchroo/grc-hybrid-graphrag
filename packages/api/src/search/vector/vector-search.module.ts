// Search part 1, Path A (S6-003): vector search over the org's document passages in Postgres
// (pgvector, HNSW with iterative scan on, D71), limited to what the asker may see. It provides and
// exports `VECTOR_SEARCH` (../retrieval.ts). Runs in the API program; the module declares its own
// imports. An empty module for now (S6-001); S6-003 fills it in.
import { Module } from '@nestjs/common';

export class VectorSearchModule {}
Module({})(VectorSearchModule);
