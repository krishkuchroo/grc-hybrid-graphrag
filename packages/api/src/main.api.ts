// The API program (D28, D36): NestJS on Fastify, every route under /api/v1 (D47), one error
// format (D47), a 1 MB body cap, 300 requests a minute per person and security headers (D64).
// Importing this file builds nothing; running it directly starts listening.
import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { ErrorFilter } from './common/errors.js';
import { createLogger, PinoNestLogger, type LogStream } from './common/logger.js';
import { API_PREFIX } from './common/openapi.js';
import { RateLimiter, REQUESTS_PER_MINUTE, registerRateLimit } from './common/rate-limit.js';
import { registerSecurityHeaders } from './common/security-headers.js';

/** 1 MB for every request body. Uploads (25 MB) get their own limit on their own route (D53). */
export const BODY_LIMIT_BYTES = 1_048_576;

export interface ApiAppOptions {
  /** Extra Nest modules mounted next to AppModule. */
  imports?: unknown[];
  /** Where pino writes its JSON lines (stdout when not given). */
  logStream?: LogStream;
}

export async function createApiApp(opts: ApiAppOptions = {}): Promise<NestFastifyApplication> {
  const log = createLogger(opts.logStream);
  const adapter = new FastifyAdapter({ loggerInstance: log, bodyLimit: BODY_LIMIT_BYTES });
  const fastify = adapter.getInstance();
  registerSecurityHeaders(fastify);
  registerRateLimit(fastify, new RateLimiter(REQUESTS_PER_MINUTE));

  class ApiRootModule {}
  Module({ imports: [AppModule, ...((opts.imports ?? []) as never[])] })(ApiRootModule);

  const app = await NestFactory.create<NestFastifyApplication>(ApiRootModule, adapter, {
    logger: new PinoNestLogger(log),
  });
  app.setGlobalPrefix(API_PREFIX.slice(1));
  app.useGlobalFilters(new ErrorFilter(log));
  await app.init();
  return app;
}

async function main(): Promise<void> {
  const app = await createApiApp();
  app.enableShutdownHooks();
  // Inside the container HOST is set so Caddy can reach the API over the Docker network; the API
  // publishes no ports (D61). Elsewhere it stays on 127.0.0.1.
  await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3000) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
