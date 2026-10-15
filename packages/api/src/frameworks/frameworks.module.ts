// Framework catalogs and mappings (D66, D67). The read side (S2-004): the FrameworksService and
// the frameworks, requirements and control-requirements routes.
import { Module } from '@nestjs/common';
import { GRAPH } from '../graph/graph.module.js';
import type { GraphService } from '../graph/graph.service.js';
import {
  ControlRequirementsController,
  FrameworksController,
  RequirementsController,
} from './frameworks.controller.js';
import { FrameworksService } from './frameworks.service.js';

export class FrameworksModule {}
Module({
  controllers: [FrameworksController, RequirementsController, ControlRequirementsController],
  providers: [
    {
      provide: FrameworksService,
      useFactory: (graph: GraphService) => new FrameworksService({ graph }),
      inject: [GRAPH],
    },
  ],
  exports: [FrameworksService],
})(FrameworksModule);
