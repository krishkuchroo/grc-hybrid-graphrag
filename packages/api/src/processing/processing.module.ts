// Processing (S4; D38, D39, D41–D43, D71, D72): chunks and vectors, Gemma extraction, duplicate
// matching, the rule checks and mapping suggestions. One Nest module per part, each in its own
// folder, so a part's task never edits this file (S4-002):
//   reader/   S4-004  processing.document-read: read the text, cut it into chunks
//   embed/    S4-005  processing.document-embed: chunk vectors and record name embeddings
//   extract/  S4-006  processing.chunk-extract: Gemma's records and links for a chunk
//   match/    S4-007  duplicate matching, processing.record-dedupe
//   decide/   S4-008  processing.chunk-resolve: the rule checks, live links and review findings
//   suggest/  S4-009  processing.mapping-suggest: mapping suggestions for the Analyst
// Each part registers its job handlers in the worker program only and declares its own imports.
// The tables are in ./processing.schema.ts, the queues in ./queues.ts.
import { Module } from '@nestjs/common';
import { DecideModule } from './decide/decide.module.js';
import { EmbedModule } from './embed/embed.module.js';
import { ExtractModule } from './extract/extract.module.js';
import { MatchModule } from './match/match.module.js';
import { ReaderModule } from './reader/reader.module.js';
import { SuggestModule } from './suggest/suggest.module.js';

export class ProcessingModule {}
Module({
  imports: [ReaderModule, EmbedModule, ExtractModule, MatchModule, DecideModule, SuggestModule],
})(ProcessingModule);
