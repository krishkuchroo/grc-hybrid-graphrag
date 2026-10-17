// Search (S6, S8; D1, D13, D15, D22, D46): vector search, AI-written graph queries and RRF, in hybrid
// mode and in the vector-only mode the benchmark compares it with, and the benchmark runs. One Nest
// module per part, each in its own folder, so a part's task never edits this file (S6-001, S8-001):
//   vector/     S6-003  Path A: vector search over the passages the asker may see   (VECTOR_SEARCH)
//   graph/      S6-004  Path B: the AI-written graph query, checked and run as the asker (GRAPH_SEARCH)
//   hybrid/     S6-005  fusion, the entity filter, the context, and POST /api/v1/search (RETRIEVAL)
//   benchmark/  S8-002  the benchmark runs and their results, /api/v1/benchmark/runs (Admins only)
// Each search part provides one interface behind a token, declared in ./retrieval.ts, so the parts
// that use another build against its interface. This module re-exports the parts, so the chat
// (S6-006) gets them by importing SearchModule. Everything runs in the API program; S6 and S8 add
// no background job. The shared model (modes, limits, RRF, shapes and names) is in @grc/shared
// (packages/shared/src/search/, packages/shared/src/chat/ and packages/shared/src/benchmark/).
import { Module } from '@nestjs/common';
import { BenchmarkPartModule } from './benchmark/benchmark-part.module.js';
import { GraphSearchModule } from './graph/graph-search.module.js';
import { HybridSearchModule } from './hybrid/hybrid-search.module.js';
import { VectorSearchModule } from './vector/vector-search.module.js';

export class SearchModule {}
Module({
  imports: [VectorSearchModule, GraphSearchModule, HybridSearchModule, BenchmarkPartModule],
  exports: [VectorSearchModule, GraphSearchModule, HybridSearchModule, BenchmarkPartModule],
})(SearchModule);
