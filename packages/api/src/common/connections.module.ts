// The database connections both programs share: Postgres as grc_app (D57, D73) and Neo4j (D14).
// They are closed when the program shuts down.
import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Db } from '../db/client.js';
import { DB, dbProvider } from '../db/db.module.js';
import { GRAPH, graphProvider } from '../graph/graph.module.js';
import type { GraphService } from '../graph/graph.service.js';

export class ConnectionsCloser implements OnApplicationShutdown {
  constructor(
    private readonly db: Db,
    private readonly graph: GraphService,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.db.$client.end(), this.graph.close()]);
  }
}

export class ConnectionsModule {}
Global()(ConnectionsModule);
Module({
  providers: [
    dbProvider,
    graphProvider,
    {
      provide: ConnectionsCloser,
      useFactory: (db: Db, graph: GraphService) => new ConnectionsCloser(db, graph),
      inject: [DB, GRAPH],
    },
  ],
  exports: [DB, GRAPH],
})(ConnectionsModule);
