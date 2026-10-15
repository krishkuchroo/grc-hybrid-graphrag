// Framework catalogs and mappings (D66, D67). The MappingsService and the mapping routes under
// /api/v1/mappings (S2-005); the other S2 tasks add the catalog routes and the loader.
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuditOutbox } from '../audit/outbox.js';
import { GRAPH } from '../graph/graph.module.js';
import type { GraphService } from '../graph/graph.service.js';
import { MappingsController } from './mappings.controller.js';
import { MappingsService } from './mappings.service.js';

export class FrameworksModule {}
Module({
  imports: [AuditModule],
  controllers: [MappingsController],
  providers: [
    {
      provide: MappingsService,
      useFactory: (graph: GraphService, outbox: AuditOutbox) => new MappingsService({ graph, outbox }),
      inject: [GRAPH, AuditOutbox],
    },
  ],
  exports: [MappingsService],
})(FrameworksModule);
