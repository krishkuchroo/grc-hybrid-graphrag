// Search part 3, fusion (S6-005): the two paths become one ranked, filtered set of sources with RRF
// (k=60), the entity filter and the context, in hybrid or vector-only mode (./retrieval.service.ts,
// ./fusion.ts, ./entity-filter.ts, ./context.ts), plus the `POST /api/v1/search` route
// (./search.controller.ts). It provides and exports `RETRIEVAL` (../retrieval.ts), built only on
// `VECTOR_SEARCH` (vector/, S6-003) and `GRAPH_SEARCH` (graph/, S6-004). Runs in the API program;
// the module declares its own imports: the two paths' modules, and the text model from AiModule
// (Path B's model when a caller passes none); Postgres and Neo4j (GRAPH, read by the named record
// finder, ../named/named-records.ts) are global.
import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { TEXT_MODEL, type TextModel } from '../../ai/text-model.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { GRAPH } from '../../graph/graph.module.js';
import type { GraphService } from '../../graph/graph.service.js';
import { GraphSearchModule } from '../graph/graph-search.module.js';
import {
  GRAPH_SEARCH,
  RETRIEVAL,
  VECTOR_SEARCH,
  type GraphSearch,
  type Retrieval,
  type VectorSearch,
} from '../retrieval.js';
import { findNamedRecords } from '../named/named-records.js';
import { VectorSearchModule } from '../vector/vector-search.module.js';
import { HybridRetrieval } from './retrieval.service.js';
import { SearchController } from './search.controller.js';

export class HybridSearchModule {}
Module({
  imports: [AiModule, VectorSearchModule, GraphSearchModule],
  controllers: [SearchController],
  providers: [
    {
      provide: RETRIEVAL,
      useFactory: (
        db: Db,
        vector: VectorSearch,
        graph: GraphSearch,
        textModel: TextModel,
        neo4jGraph: GraphService,
      ): Retrieval => {
        const log = createLogger();
        const namedLog = log.child({ context: 'NamedRecords' });
        return new HybridRetrieval({
          db,
          vector,
          graph,
          named: {
            find: (caller, question) => findNamedRecords({ graph: neo4jGraph, log: namedLog }, caller, question),
          },
          textModel,
          contextTokens: textModel.contextTokens,
          log,
        });
      },
      inject: [DB, VECTOR_SEARCH, GRAPH_SEARCH, TEXT_MODEL, GRAPH],
    },
  ],
  exports: [RETRIEVAL],
})(HybridSearchModule);
