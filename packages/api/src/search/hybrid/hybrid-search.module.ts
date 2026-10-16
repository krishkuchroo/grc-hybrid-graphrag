// Search part 3, fusion (S6-005): the two paths become one ranked, filtered set of sources with RRF
// (k=60), the entity filter and the context, in hybrid or vector-only mode, plus the
// `POST /api/v1/search` route. It provides and exports `RETRIEVAL` (../retrieval.ts), built only on
// `VECTOR_SEARCH` and `GRAPH_SEARCH`. Runs in the API program; the module declares its own imports.
// An empty module for now (S6-001); S6-005 fills it in.
import { Module } from '@nestjs/common';

export class HybridSearchModule {}
Module({})(HybridSearchModule);
