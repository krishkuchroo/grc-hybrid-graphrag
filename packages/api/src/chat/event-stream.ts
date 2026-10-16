// The ask route's `text/event-stream` answer (D47: chat streams its answer; S6 shared notes, "The
// stream"), written straight to Node's response once Fastify has handed it over (`reply.hijack()`).
// - Opening it sends the status and headers at once: the event-stream type, no caching or
//   transforming (so Caddy passes each event straight through), and the API's security headers,
//   which Fastify's own hooks no longer add to a hijacked reply (D64).
// - Each event is one S6-001 frame (`encodeChatStreamEvent`). A write the connection can't take yet
//   waits for it to drain, so a slow reader slows the answer instead of filling memory.
// - A comment line goes out after every 15 s with nothing else sent, which keeps the connection
//   (and Caddy's) open while the question waits in the queue or Gemma thinks.
// - `left` aborts when the connection closes before the stream has ended: the person left or
//   pressed Stop. Writes after that do nothing.
import type { ServerResponse } from 'node:http';
import { CHAT_STREAM_CONTENT_TYPE, encodeChatStreamEvent, type ChatStreamEvent } from '@grc/shared';
import { SECURITY_HEADERS } from '../common/security-headers.js';

/** A comment line goes out after this long with nothing else sent. */
export const KEEP_ALIVE_MS = 15_000;

const KEEP_ALIVE_FRAME = ': keep-alive\n\n';

export class ChatEventStream {
  private readonly leaving = new AbortController();
  private opened = false;
  private ended = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly res: ServerResponse,
    private readonly keepAliveMs: number = KEEP_ALIVE_MS,
  ) {
    res.on('close', () => {
      this.stopTimer();
      if (!this.ended) this.leaving.abort();
    });
    // A broken connection also closes it; the error itself holds nothing worth logging here.
    res.on('error', () => undefined);
  }

  /** Aborts when the connection closes before the stream has ended. */
  get left(): AbortSignal {
    return this.leaving.signal;
  }

  /** Whether events can still be written. */
  get writable(): boolean {
    return this.opened && !this.ended && !this.leaving.signal.aborted && !this.res.destroyed;
  }

  /** Sends the status and headers. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': `${CHAT_STREAM_CONTENT_TYPE}; charset=utf-8`,
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    this.res.flushHeaders();
    this.armTimer();
  }

  /** Writes one event; resolves once the connection has taken it (or has closed). */
  async send(event: ChatStreamEvent): Promise<void> {
    await this.write(encodeChatStreamEvent(event));
  }

  /** Ends the stream. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.stopTimer();
    if (this.opened && !this.res.destroyed && !this.res.writableEnded) this.res.end();
  }

  private async write(frame: string): Promise<void> {
    if (!this.writable) return;
    this.armTimer();
    const taken = this.res.write(frame);
    if (taken) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        this.res.off('drain', done);
        this.res.off('close', done);
        resolve();
      };
      this.res.on('drain', done);
      this.res.on('close', done);
    });
  }

  private armTimer(): void {
    this.stopTimer();
    if (this.ended) return;
    this.timer = setTimeout(() => {
      void this.write(KEEP_ALIVE_FRAME);
    }, this.keepAliveMs);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
