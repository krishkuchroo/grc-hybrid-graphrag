// The file sandbox (D53: only the worker opens files, with time and memory limits). A parse runs
// in its own `worker_threads` Worker with a V8 heap limit (256 MB by default) and a time limit
// (30 s by default); the Worker is terminated as soon as it answers, fails or runs out of either.
// S4's document readers reuse it with their own module.
//
// - The task is a module URL and the name of a function it exports. The Worker imports it and calls
//   `fn(input, ...args)`; what the function returns must survive structured cloning.
// - The input bytes are copied once and transferred to the Worker, never shared.
// - The Worker gets an empty environment, so nothing in a file can read the program's secrets, and
//   its stdout and stderr are thrown away, so nothing from a file reaches the logs (D163, D164).
// - A refusal comes back as a `SandboxError`: the task's own code (for example `malformed`) and row
//   when the function threw an error carrying them, `timed_out` or `too_much_memory` when a limit
//   stopped it, else `sandbox_failed`. Error messages never cross over: they could hold file content.
import { Worker } from 'node:worker_threads';

/** The default limits (S3-006). */
export const SANDBOX_MEMORY_MB = 256;
export const SANDBOX_TIMEOUT_MS = 30_000;

export interface SandboxTask {
  /** The module to load in the Worker, as a `file:` URL. */
  module: URL | string;
  /** The exported function to call with the input. */
  exportName: string;
  /** The bytes to hand the function (copied, then transferred). */
  input: Uint8Array;
  /** More arguments after the input; they must survive structured cloning. */
  args?: readonly unknown[];
}

export interface SandboxLimits {
  /** The Worker's V8 old-generation heap limit, in MB. */
  memoryMb?: number;
  /** How long the Worker may run, in ms. */
  timeoutMs?: number;
}

/** The codes the sandbox itself gives; a task's own codes come through as they are. */
export const SANDBOX_LIMIT_CODES = ['timed_out', 'too_much_memory'] as const;

/** A run that didn't answer: the code, and the row when the task gave one. */
export class SandboxError extends Error {
  readonly code: string;
  readonly row: number;

  constructor(code: string, row = 0) {
    super(`The sandboxed read did not finish (${code}).`);
    this.name = 'SandboxError';
    this.code = code;
    this.row = row;
  }
}

// The Worker's program, run as a CommonJS script. It sends back the result, or only the error's
// name, code and row.
const BOOTSTRAP = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const mod = await import(workerData.moduleUrl);
    const fn = mod[workerData.exportName];
    if (typeof fn !== 'function') throw new TypeError('the sandbox task is not a function');
    const result = await fn(workerData.input, ...workerData.args);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    const e = typeof err === 'object' && err !== null ? err : {};
    parentPort.postMessage({
      ok: false,
      error: {
        name: typeof e.name === 'string' ? e.name : 'Error',
        code: typeof e.code === 'string' ? e.code : null,
        row: typeof e.row === 'number' && Number.isInteger(e.row) && e.row >= 0 ? e.row : 0,
      },
    });
  }
})();
`;

interface WorkerAnswer {
  ok: boolean;
  result?: unknown;
  error?: { name: string; code: string | null; row: number };
}

const TASK_CODE = /^[a-z][a-z_]{0,63}$/;

function errorFromWorker(error: WorkerAnswer['error']): SandboxError {
  if (error?.code && TASK_CODE.test(error.code)) return new SandboxError(error.code, error.row);
  // V8 throws RangeError when a string, array or buffer can't grow any more.
  if (error?.name === 'RangeError') return new SandboxError('too_much_memory');
  return new SandboxError('sandbox_failed');
}

/** Runs `task` in a fresh Worker within the limits, and terminates the Worker afterwards. */
export function runInSandbox<T>(task: SandboxTask, limits: SandboxLimits = {}): Promise<T> {
  const memoryMb = limits.memoryMb ?? SANDBOX_MEMORY_MB;
  const timeoutMs = limits.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const input = new Uint8Array(task.input);
  const moduleUrl = task.module instanceof URL ? task.module.href : task.module;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(BOOTSTRAP, {
        eval: true,
        workerData: { moduleUrl, exportName: task.exportName, input, args: task.args ?? [] },
        transferList: [input.buffer],
        resourceLimits: { maxOldGenerationSizeMb: memoryMb },
        env: {},
        stdout: true,
        stderr: true,
      });
    } catch {
      reject(new SandboxError('sandbox_failed'));
      return;
    }
    worker.stdout.resume();
    worker.stderr.resume();

    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      outcome();
    };
    const timer = setTimeout(() => finish(() => reject(new SandboxError('timed_out'))), timeoutMs);

    worker.on('message', (answer: WorkerAnswer) => {
      finish(() => (answer.ok ? resolve(answer.result as T) : reject(errorFromWorker(answer.error))));
    });
    worker.on('error', (err: unknown) => {
      const code = (err as { code?: unknown }).code;
      finish(() =>
        reject(new SandboxError(code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'too_much_memory' : 'sandbox_failed')),
      );
    });
    worker.on('exit', () => finish(() => reject(new SandboxError('sandbox_failed'))));
  });
}
