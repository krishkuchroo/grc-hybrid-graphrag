// GET /api/v1/health: whether the API can reach Postgres and Neo4j.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Controller, Get, Inject, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { documentRoute } from '../common/openapi.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { GRAPH } from '../graph/graph.module.js';
import type { GraphService } from '../graph/graph.service.js';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  postgres: z.enum(['up', 'down']),
  neo4j: z.enum(['up', 'down']),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

const CHECK_TIMEOUT_MS = 3_000;

async function reachable(check: () => Promise<unknown>): Promise<'up' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export class HealthController {
  constructor(
    private readonly db: Db,
    private readonly graph: GraphService,
  ) {}

  async check(): Promise<HealthResponse> {
    const [postgres, neo4j] = await Promise.all([
      reachable(() => this.db.execute(sql`SELECT 1`)),
      reachable(() => this.graph.ping()),
    ]);
    return healthResponseSchema.parse({
      status: postgres === 'up' && neo4j === 'up' ? 'ok' : 'degraded',
      postgres,
      neo4j,
    });
  }
}
Controller('health')(HealthController);
Get()(HealthController.prototype, 'check', Object.getOwnPropertyDescriptor(HealthController.prototype, 'check')!);
Inject(DB)(HealthController, undefined, 0);
Inject(GRAPH)(HealthController, undefined, 1);

documentRoute({
  method: 'get',
  path: '/health',
  summary: 'Whether the API can reach Postgres and Neo4j',
  response: healthResponseSchema,
});

export class HealthModule {}
Module({ controllers: [HealthController] })(HealthModule);
