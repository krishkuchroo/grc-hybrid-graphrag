// One at a time, in order (D34, D72 "Gemma x1"): each task starts when the one before it has
// settled, whether it succeeded or failed, so calls queue first come, first served.

export class SerialGate {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  /** Tasks waiting or running. */
  get size(): number {
    return this.queued;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queued += 1;
    return previous.then(task).finally(() => {
      this.queued -= 1;
      release();
    });
  }
}
