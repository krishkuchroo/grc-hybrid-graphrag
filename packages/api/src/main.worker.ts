// The worker program (D36): the same codebase as the API, with no HTTP. It starts pg-boss and
// processes jobs (D29, D72). Importing this file builds nothing; running it directly starts it.
import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createLogger, PinoNestLogger, type LogStream } from './common/logger.js';
import { WorkerModule } from './worker.module.js';

export interface WorkerAppOptions {
  /** Where pino writes its JSON lines (stdout when not given). */
  logStream?: LogStream;
}

export async function createWorkerApp(opts: WorkerAppOptions = {}): Promise<INestApplicationContext> {
  const log = createLogger(opts.logStream);
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: new PinoNestLogger(log) });
  await app.init();
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createWorkerApp()
    .then((app) => app.enableShutdownHooks())
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
