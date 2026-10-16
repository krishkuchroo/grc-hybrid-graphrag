// The file sandbox (D53: only the worker opens files, with time and memory limits). A parse runs
// in its own `worker_threads` Worker with a V8 heap limit (256 MB by default) and a time limit
// (30 s by default); the Worker is terminated as soon as it answers, fails or runs out of either.
// S4's document readers reuse it with their own module, through `runInProcessSandbox`: the same
// Worker, hosted in a child process of its own whose whole memory is limited, not only the V8 heap
// (PDF and DOCX readers decompress into buffers outside the heap; see that function).
//
// - The task is a module URL and the name of a function it exports. The Worker imports it and calls
//   `fn(input, ...args)`; what the function returns must survive structured cloning.
// - The input bytes are copied once and transferred to the Worker, never shared.
// - The Worker gets an empty environment, so nothing in a file can read the program's secrets, and
//   its stdout and stderr are thrown away, so nothing from a file reaches the logs (D163, D164).
// - A refusal comes back as a `SandboxError`: the task's own code (for example `malformed`) and row
//   when the function threw an error carrying them, `timed_out` or `too_much_memory` when a limit
//   stopped it, else `sandbox_failed`. Error messages never cross over: they could hold file content.
import { spawn, type ChildProcess } from 'node:child_process';
import { Worker } from 'node:worker_threads';

/** The default limits (S3-006). */
export const SANDBOX_MEMORY_MB = 256;
export const SANDBOX_TIMEOUT_MS = 30_000;

/** How often a process sandbox looks at its own memory, in ms. */
export const SANDBOX_MEMORY_WATCH_MS = 10;

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

// The host program of a process sandbox, run as a CommonJS script by a fresh Node process with an
// empty environment, no stdin and its stdout and stderr thrown away. It:
// - asks the kernel (Linux) to pick it first, never the program that started it, should memory run
//   out before its own watch notices (an unprivileged process may raise its own score);
// - takes its task over the IPC channel, runs it in a Worker on BOOTSTRAP with the heap limit, and
//   passes the Worker's one answer back as it is (the parent ends the process once it has it);
// - meanwhile its main thread, which does nothing else, looks at the whole process's resident memory
//   every few ms, and kills the process outright once it has grown past the limit since it started:
//   the heap, the buffers PDF and DOCX data decompress into, everything;
// - ends itself when the program that started it goes away.
const PROCESS_HOST = `
'use strict';
const { Worker } = require('node:worker_threads');
try { require('node:fs').writeFileSync('/proc/self/oom_score_adj', '1000'); } catch {}
const startRss = process.memoryUsage.rss();
const die = () => process.kill(process.pid, 'SIGKILL');
process.on('disconnect', die);
process.once('message', (task) => {
  const limit = startRss + task.memoryMb * 1024 * 1024;
  setInterval(() => { if (process.memoryUsage.rss() > limit) die(); }, task.watchMs);
  const answer = (message) => { try { process.send(message); } catch { die(); } };
  const refused = (code) => answer({ ok: false, error: { name: 'Error', code, row: 0 } });
  let worker;
  try {
    // The IPC message's bytes may be a view on a larger buffer: copy them to one of their own.
    const input = new Uint8Array(task.input);
    worker = new Worker(task.bootstrap, {
      eval: true,
      workerData: { moduleUrl: task.moduleUrl, exportName: task.exportName, input, args: task.args },
      transferList: [input.buffer],
      resourceLimits: { maxOldGenerationSizeMb: task.memoryMb },
      env: {},
      stdout: true,
      stderr: true,
    });
  } catch {
    refused(null);
    return;
  }
  worker.stdout.resume();
  worker.stderr.resume();
  let done = false;
  worker.on('message', (message) => { if (!done) { done = true; answer(message); } });
  worker.on('error', (err) => {
    if (done) return;
    done = true;
    refused(err && err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'too_much_memory' : null);
  });
  worker.on('exit', () => { if (!done) { done = true; refused(null); } });
});
`;

/**
 * Runs `task` like `runInSandbox`, but hosts its Worker in a child process of its own, so the
 * memory limit holds for the whole read and not only the V8 heap (D53): the buffers unpdf and
 * mammoth decompress PDF and DOCX data into live outside the heap, and in a Worker of this program
 * they could take the whole program past its container's limit. Here (see PROCESS_HOST):
 * - the process ends, killed outright, as soon as its resident memory has grown past `memoryMb`
 *   since it started (the Worker keeps the same heap limit too), and the run fails with
 *   `too_much_memory`. So does a kill nobody here asked for (the kernel's, when memory runs out
 *   faster than the watch looks: Linux kills the host first, never this program);
 * - the time limit is the parent's: past it the process is killed and the run fails `timed_out`;
 * - the process gets an empty environment and its output is thrown away, as the Worker's is; the
 *   input bytes are sent once over the IPC channel (a copy), never shared;
 * - the process is killed as soon as the run has its answer, whatever happened.
 */
export function runInProcessSandbox<T>(task: SandboxTask, limits: SandboxLimits = {}): Promise<T> {
  const memoryMb = limits.memoryMb ?? SANDBOX_MEMORY_MB;
  const timeoutMs = limits.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const moduleUrl = task.module instanceof URL ? task.module.href : task.module;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let killedHere = false;
    let host: ChildProcess;
    try {
      host = spawn(process.execPath, ['-e', PROCESS_HOST], {
        env: {},
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
        windowsHide: true,
      });
    } catch {
      reject(new SandboxError('sandbox_failed'));
      return;
    }

    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (host.exitCode === null && host.signalCode === null) {
        killedHere = true;
        host.kill('SIGKILL');
      }
      outcome();
    };
    const timer = setTimeout(() => finish(() => reject(new SandboxError('timed_out'))), timeoutMs);

    host.on('message', (answer: WorkerAnswer) => {
      finish(() => (answer.ok ? resolve(answer.result as T) : reject(errorFromWorker(answer.error))));
    });
    host.on('error', () => finish(() => reject(new SandboxError('sandbox_failed'))));
    host.on('exit', (_code, signal) => {
      // Killed, and not by us: the host's own memory watch, or the kernel's when memory ran out.
      const outOfMemory = signal === 'SIGKILL' && !killedHere;
      finish(() => reject(new SandboxError(outOfMemory ? 'too_much_memory' : 'sandbox_failed')));
    });

    const message = {
      bootstrap: BOOTSTRAP,
      moduleUrl,
      exportName: task.exportName,
      input: task.input,
      args: task.args ?? [],
      memoryMb,
      watchMs: SANDBOX_MEMORY_WATCH_MS,
    };
    try {
      host.send(message, (err) => {
        if (err) finish(() => reject(new SandboxError('sandbox_failed')));
      });
    } catch {
      finish(() => reject(new SandboxError('sandbox_failed')));
    }
  });
}
