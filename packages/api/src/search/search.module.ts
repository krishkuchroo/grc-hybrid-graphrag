// Search (S6; D13, D15, D22, D46): vector search, AI-written graph queries and RRF, in hybrid mode
// and in the vector-only mode the benchmark compares it with. One Nest module per part, each in its
// own folder, so a part's task never edits this file (S6-001):
//   vector/  S6-003  Path A: vector search over the passages the asker may see   (VECTOR_SEARCH)
//   graph/   S6-004  Path B: the AI-written graph query, checked and run as the asker (GRAPH_SEARCH)
//   hybrid/  S6-005  fusion, the entity filter, the context, and POST /api/v1/search (RETRIEVAL)
// Each part provides one interface behind a token, declared in ./retrieval.ts, so the parts that use
// another build against its interface. This module re-exports the three, so the chat (S6-006) gets
// them by importing SearchModule. Everything runs in the API program; S6 adds no background job.
// The shared model (modes, limits, RRF, shapes and names) is in @grc/shared
// (packages/shared/src/search/ and packages/shared/src/chat/).
import { Module } from '@nestjs/common';
import { GraphSearchModule } from './graph/graph-search.module.js';
import { HybridSearchModule } from './hybrid/hybrid-search.module.js';
import { VectorSearchModule } from './vector/vector-search.module.js';

export class SearchModule {}
Module({
  imports: [VectorSearchModule, GraphSearchModule, HybridSearchModule],
  exports: [VectorSearchModule, GraphSearchModule, HybridSearchModule],
})(SearchModule);
