// Framework catalogs and mappings (D66, D67). The read side (S2-004): the FrameworksService and
// the frameworks, requirements and control-requirements routes. The write side (S2-005): the
// MappingsService and the mapping routes under /api/v1/mappings.
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuditOutbox } from '../audit/outbox.js';
import { GRAPH } from '../graph/graph.module.js';
import type { GraphService } from '../graph/graph.service.js';
import {
  ControlRequirementsController,
  FrameworksController,
  RequirementsController,
} from './frameworks.controller.js';
import { FrameworksService } from './frameworks.service.js';
import { MappingsController } from './mappings.controller.js';
import { MappingsService } from './mappings.service.js';

export class FrameworksModule {}
Module({
  imports: [AuditModule],
  controllers: [FrameworksController, RequirementsController, ControlRequirementsController, MappingsController],
  providers: [
    {
      provide: FrameworksService,
      useFactory: (graph: GraphService) => new FrameworksService({ graph }),
      inject: [GRAPH],
    },
    {
      provide: MappingsService,
      useFactory: (graph: GraphService, outbox: AuditOutbox) => new MappingsService({ graph, outbox }),
      inject: [GRAPH, AuditOutbox],
    },
  ],
  exports: [FrameworksService, MappingsService],
})(FrameworksModule);
