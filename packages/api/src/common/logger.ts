// pino for every log line (D28), including Nest's own messages. JSON lines on stdout unless a
// stream is given (the tests pass one to read the lines back).
import type { LoggerService } from '@nestjs/common';
import { pino, type Logger } from 'pino';

export interface LogStream {
  write(line: string): void;
}

export function createLogger(stream?: LogStream): Logger {
  const options = { level: process.env.LOG_LEVEL || 'info' };
  return stream ? pino(options, stream) : pino(options);
}

/** Nest's LoggerService on top of pino. Nest passes the context as the last extra argument. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly pino: Logger) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  private write(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    rest: unknown[],
  ): void {
    const context = typeof rest[rest.length - 1] === 'string' ? (rest[rest.length - 1] as string) : undefined;
    if (message instanceof Error) {
      this.pino[level]({ err: message, context }, message.message);
    } else {
      this.pino[level]({ context }, typeof message === 'string' ? message : JSON.stringify(message));
    }
  }
}
