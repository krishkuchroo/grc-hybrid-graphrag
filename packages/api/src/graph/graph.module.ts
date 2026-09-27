// The graph module (D14, D45.2): provides the GraphService, built from the environment.
// NEO4J_URI is bolt://127.0.0.1:7687 on the Mac and bolt://host.docker.internal:7687 in the
// containers. M0-007 registers `graphProvider` in the NestJS app.
import { GraphService } from './graph.service.js';

export const GRAPH = Symbol('GRAPH');

export function graphFromEnv(env: NodeJS.ProcessEnv = process.env): GraphService {
  const adminPassword = env.NEO4J_ADMIN_PASSWORD;
  const writerPassword = env.NEO4J_WRITER_PASSWORD;
  if (!adminPassword) throw new Error('NEO4J_ADMIN_PASSWORD is not set');
  if (!writerPassword) throw new Error('NEO4J_WRITER_PASSWORD is not set');
  return new GraphService({ uri: env.NEO4J_URI || 'bolt://127.0.0.1:7687', adminPassword, writerPassword });
}

export const graphProvider = { provide: GRAPH, useFactory: (): GraphService => graphFromEnv() };
