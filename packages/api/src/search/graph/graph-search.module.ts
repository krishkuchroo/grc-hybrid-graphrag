// Search part 2, Path B (S6-004): Gemma writes one read-only graph query from the question, our code
// checks it, and it runs in the org's own Neo4j database as the asker's role x clearance account,
// with a time limit (D15, D22, D131). It provides and exports `GRAPH_SEARCH` (../retrieval.ts),
// built on the shared Neo4j connection (GRAPH, from the global connections module). The model that
// writes the query is passed in on each search, so the module needs no AI client of its own.
// Runs in the API program; S6 adds no background job.
import { Module } from '@nestjs/common';
import { GRAPH } from '../../graph/graph.module.js';
import type { GraphService } from '../../graph/graph.service.js';
import { GRAPH_SEARCH, type GraphSearch } from '../retrieval.js';
import { GraphSearchService } from './graph-search.service.js';

export class GraphSearchModule {}
Module({
  providers: [
    {
      provide: GRAPH_SEARCH,
      useFactory: (graph: GraphService): GraphSearch => new GraphSearchService({ graph }),
      inject: [GRAPH],
    },
  ],
  exports: [GRAPH_SEARCH],
})(GraphSearchModule);
