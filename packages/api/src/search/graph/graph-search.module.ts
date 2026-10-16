// Search part 2, Path B (S6-004): Gemma writes one read-only graph query from the question, our code
// checks it, and it runs in the org's own Neo4j database as the asker's role x clearance account,
// with a time limit (D15, D22, D131). It provides and exports `GRAPH_SEARCH` (../retrieval.ts).
// Runs in the API program; the module declares its own imports. An empty module for now (S6-001);
// S6-004 fills it in.
import { Module } from '@nestjs/common';

export class GraphSearchModule {}
Module({})(GraphSearchModule);
