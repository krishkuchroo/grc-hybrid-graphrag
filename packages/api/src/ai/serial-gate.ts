// One at a time, in order (D34, D48, D72 "Gemma x1"): each task starts when the one before it has
// settled, whether it succeeded or failed, so tasks queue first come, first served.
//
// A waiting task can be told its place (1 means next) each time it changes, and its abort signal
// takes it out of the queue without running it; the tasks behind it move up. A running task whose
// signal aborts frees the slot at once: the gate doesn't wait for the task to wind down, so the task
// must stop on the same signal (the text model's calls do).
import { AiStopped } from './ai-failure.js';

export interface GateOptions {
  /**
   * Told the task's place while it waits (1 means next), each time it changes: never while it runs,
   * and not at all when the slot is free. Called in the gate's own step; a listener that throws or
   * rejects is ignored, so it never holds up the queue.
   */
  onPosition?: (position: number) => unknown;
  /**
   * Aborting it takes a waiting task out of the queue (rejecting with `AiStopped`), or frees the
   * slot of a running one.
   */
  signal?: AbortSignal;
}

interface Waiter {
  begin: () => void;
  onPosition?: (position: number) => unknown;
  /** The place it was last told. */
  told?: number;
  /** Stops listening for an abort while waiting. */
  stopListening?: () => void;
}

export class SerialGate {
  private running = false;
  private readonly waiters: Waiter[] = [];

  /** Tasks waiting or running. */
  get size(): number {
    return this.waiters.length + (this.running ? 1 : 0);
  }

  /** Tasks waiting for the slot. */
  get waiting(): number {
    return this.waiters.length;
  }

  run<T>(task: () => Promise<T>, opts: GateOptions = {}): Promise<T> {
    const { signal, onPosition } = opts;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AiStopped());
        return;
      }

      const begin = (): void => {
        this.running = true;
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          signal?.removeEventListener('abort', release);
          this.next();
        };
        signal?.addEventListener('abort', release, { once: true });
        let settled: Promise<T>;
        try {
          settled = Promise.resolve(task());
        } catch (err) {
          settled = Promise.reject(err);
        }
        void settled.then(resolve, reject).finally(release);
      };

      if (!this.running && this.waiters.length === 0) {
        begin();
        return;
      }

      const waiter: Waiter = { begin };
      if (onPosition !== undefined) waiter.onPosition = onPosition;
      if (signal !== undefined) {
        const leave = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index === -1) return;
          this.waiters.splice(index, 1);
          reject(new AiStopped());
          this.tellPlaces();
        };
        signal.addEventListener('abort', leave, { once: true });
        waiter.stopListening = () => signal.removeEventListener('abort', leave);
      }
      this.waiters.push(waiter);
      this.tellPlaces();
    });
  }

  /** The slot is free: the first waiter starts, and the rest are told their new places. */
  private next(): void {
    this.running = false;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.stopListening?.();
      waiter.begin();
    }
    this.tellPlaces();
  }

  private tellPlaces(): void {
    // A listener may abort another waiter, which changes the queue: each place is read afresh.
    for (const waiter of [...this.waiters]) {
      const place = this.waiters.indexOf(waiter) + 1;
      if (place === 0 || place === waiter.told || waiter.onPosition === undefined) continue;
      waiter.told = place;
      try {
        const result = waiter.onPosition(place);
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        // A listener's failure is the listener's; the queue goes on.
      }
    }
  }
}
