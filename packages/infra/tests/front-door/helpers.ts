// M0-016: shared helpers for the front-door tests (D60, D61, D64, D65).
//
// These tests talk to the running stack exactly as a browser on the Mac would: over
// https://grc.localhost on 127.0.0.1:443 (and http on 127.0.0.1:80). They trust ONLY Caddy's own
// local root CA (`tls internal`), read out of the grc-caddy container, never the Mac's keychain and
// never `rejectUnauthorized: false`. So a certificate from any other issuer fails the handshake.
//
// They need the stack running:
//   docker compose -f packages/infra/compose.yaml --env-file .env up -d
// When it isn't, they fail (not skip) with a message that says so. They only read: `docker exec
// grc-caddy cat …` for the root certificate and `docker logs grc-api` to see which requests
// reached the API. They never start, stop or change a container, and touch only grc-* ones.
import { spawnSync } from 'node:child_process';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect, type DetailedPeerCertificate } from 'node:tls';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const HOST = 'grc.localhost';
export const ORIGIN = `https://${HOST}`;
export const CADDY = 'grc-caddy';
export const API = 'grc-api';
/** Where Caddy keeps the root of its local CA inside the container (`tls internal`). */
export const CADDY_ROOT_CERT = '/data/caddy/pki/authorities/local/root.crt';

/** D53, D64: 25 MB for uploads and 1 MB for other requests, in the same binary megabytes as the
 * API's own 1 MB cap (BODY_LIMIT_BYTES = 1_048_576 in packages/api/src/main.api.ts). */
export const MB = 1_048_576;
export const UPLOAD_CAP_BYTES = 25 * MB;
export const API_CAP_BYTES = 1 * MB;

export function docker(args: string[], timeoutMs = 20_000): { status: number | null; out: string; err: string } {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  if (process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  const r = spawnSync('docker', args, { env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * MB });
  return { status: r.status, out: r.stdout ?? '', err: `${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

let rootCa: string | undefined;

/** Caddy's local root certificate (PEM), read from the running grc-caddy container. */
export function caddyRootCa(): string {
  if (rootCa) return rootCa;
  const r = docker(['exec', CADDY, 'cat', CADDY_ROOT_CERT]);
  if (r.status !== 0 || !r.out.includes('BEGIN CERTIFICATE')) {
    throw new Error(
      `could not read Caddy's local root CA from ${CADDY}:${CADDY_ROOT_CERT}. Is the stack running ` +
        `(docker compose -f packages/infra/compose.yaml --env-file .env up -d) with Caddy on \`tls internal\`? ` +
        `(${r.err.trim() || 'no certificate in the output'})`,
    );
  }
  rootCa = r.out;
  return rootCa;
}

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  /** Header names and values exactly as sent, so a header sent twice shows up twice. */
  rawHeaders: string[];
  body: Buffer;
  text: string;
  /** Set only with `cutShortOk`: the write error that ended the exchange while the body was still
   * being sent. When it came before the answer, status is 0 and there is no answer. */
  cutShort?: string;
}

export interface SendOptions {
  method?: string;
  headers?: Record<string, string | number>;
  /** A body sent as-is. */
  body?: Buffer | string;
  /** Or a body of this many bytes, streamed in 1 MB pieces with a Content-Length header. */
  bodyBytes?: number;
  timeoutMs?: number;
  /**
   * For a big body the far side may stop reading. The API answers a request it won't read (today
   * its 404, later its own 1 MB cap) and the connection is closed while the body is still being
   * sent. The answer and our write error (EPIPE or ECONNRESET) then arrive about 1 ms apart, and if
   * this process is slow to read its socket (a busy full-suite run), the write error wins and the
   * answer is lost. With this set, that write error ends the exchange (see `Reply.cutShort`)
   * instead of failing it. Use it only where the answer isn't what the test checks.
   */
  cutShortOk?: boolean;
}

const WRITE_CUT = new Set(['EPIPE', 'ECONNRESET']);

function collect(req: ReturnType<typeof httpsRequest>, opts: SendOptions, what: string): Promise<Reply> {
  return new Promise((resolvePromise, reject) => {
    let answered = false;
    let settled = false;
    let res: IncomingMessage | undefined;
    const chunks: Buffer[] = [];
    let cutShort: string | undefined;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const body = Buffer.concat(chunks);
      resolvePromise({
        status: res?.statusCode ?? 0,
        headers: res?.headers ?? {},
        rawHeaders: res?.rawHeaders ?? [],
        body,
        text: body.toString('utf8'),
        ...(cutShort ? { cutShort } : {}),
      });
    };
    const timer = setTimeout(() => {
      req.destroy(new Error(`no reply from ${what} within ${opts.timeoutMs ?? 30_000} ms`));
    }, opts.timeoutMs ?? 30_000);
    req.on('response', (r) => {
      answered = true;
      res = r;
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', settle);
      r.on('error', (e: NodeJS.ErrnoException) => {
        if (opts.cutShortOk && e.code && WRITE_CUT.has(e.code)) {
          cutShort = e.code;
          return;
        }
        clearTimeout(timer);
        reject(e);
      });
    });
    if (opts.cutShortOk) {
      // The exchange is over once the connection has closed, whatever arrived by then.
      req.on('close', () => {
        if (cutShort) settle();
      });
    }
    req.on('error', (e: NodeJS.ErrnoException) => {
      // A server that refuses a big body may answer and close before the whole body is sent.
      // Once the answer has arrived, a write error on the rest of the body is expected.
      if (e.code && WRITE_CUT.has(e.code) && (answered || opts.cutShortOk)) {
        if (opts.cutShortOk) cutShort = e.code;
        return;
      }
      clearTimeout(timer);
      reject(
        new Error(
          `${what}: ${e.code ?? e.message}. Is the stack running with grc-caddy on 127.0.0.1:443/80 and ` +
            `the hosts line \`127.0.0.1 ${HOST}\`?`,
        ),
      );
    });

    if (opts.bodyBytes !== undefined) {
      const piece = Buffer.alloc(MB, 0x61);
      let left = opts.bodyBytes;
      const pump = (): void => {
        while (left > 0) {
          const n = Math.min(left, piece.length);
          left -= n;
          const more = req.write(n === piece.length ? piece : piece.subarray(0, n));
          if (!more) {
            req.once('drain', pump);
            return;
          }
        }
        req.end();
      };
      pump();
    } else {
      req.end(opts.body);
    }
  });
}

function headersFor(opts: SendOptions): Record<string, string | number> {
  const headers: Record<string, string | number> = { host: HOST, ...(opts.headers ?? {}) };
  if (opts.bodyBytes !== undefined) headers['content-length'] = opts.bodyBytes;
  else if (opts.body !== undefined) headers['content-length'] = Buffer.byteLength(opts.body);
  return headers;
}

/** A request to https://grc.localhost<path>, trusting only Caddy's local root CA. */
export function https(path: string, opts: SendOptions = {}): Promise<Reply> {
  const req = httpsRequest({
    host: '127.0.0.1',
    port: 443,
    servername: HOST,
    path,
    method: opts.method ?? 'GET',
    headers: headersFor(opts),
    ca: caddyRootCa(),
    rejectUnauthorized: true,
    agent: false,
  });
  return collect(req, opts, `${opts.method ?? 'GET'} ${ORIGIN}${path}`);
}

/** A plain-HTTP request to http://grc.localhost<path> on 127.0.0.1:80. */
export function http(path: string, opts: SendOptions = {}): Promise<Reply> {
  const req = httpRequest({
    host: '127.0.0.1',
    port: 80,
    path,
    method: opts.method ?? 'GET',
    headers: headersFor(opts),
    agent: false,
  });
  return collect(req, opts, `${opts.method ?? 'GET'} http://${HOST}${path}`);
}

/** The certificate chain Caddy presents for grc.localhost, verified against Caddy's root only. */
export function peerCertificate(): Promise<{ authorized: boolean; error?: string; cert: DetailedPeerCertificate }> {
  return new Promise((resolvePromise, reject) => {
    const sock = tlsConnect({
      host: '127.0.0.1',
      port: 443,
      servername: HOST,
      ca: caddyRootCa(),
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`no TLS handshake on 127.0.0.1:443 within 10 s`));
    }, 10_000);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = sock.getPeerCertificate(true);
      const out = {
        authorized: sock.authorized,
        error: sock.authorizationError ? String(sock.authorizationError) : undefined,
        cert,
      };
      sock.end();
      resolvePromise(out);
    });
    sock.once('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(`TLS to 127.0.0.1:443 for ${HOST}: ${e.code ?? e.message}. Is grc-caddy running?`));
    });
  });
}

/** How many times a header name appears in a response, ignoring case. */
export function headerCount(reply: Reply, name: string): number {
  let n = 0;
  for (let i = 0; i < reply.rawHeaders.length; i += 2) {
    if (reply.rawHeaders[i]!.toLowerCase() === name.toLowerCase()) n++;
  }
  return n;
}

/** grc-api's log lines since the given time (container stdout and stderr). */
export function apiLogsSince(since: Date): string {
  const r = docker(['logs', '--since', since.toISOString(), API], 30_000);
  if (r.status !== 0) {
    throw new Error(`could not read ${API}'s logs; is the stack running? (${r.err.trim()})`);
  }
  // docker logs writes the container's stderr to its own stderr.
  return `${r.out}\n${r.err}`;
}

/** Waits until the marker shows up in grc-api's logs, or the time runs out. */
export async function apiLogged(marker: string, since: Date, waitMs = 5_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (;;) {
    if (apiLogsSince(since).includes(marker)) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The one error format (D47): { error: { code, message, referenceId } }. */
export function errorBody(reply: Reply): { code: string; message: string; referenceId: string } | undefined {
  try {
    const parsed = JSON.parse(reply.text) as { error?: { code?: unknown; message?: unknown; referenceId?: unknown } };
    const e = parsed.error;
    if (e && typeof e.code === 'string' && typeof e.message === 'string' && typeof e.referenceId === 'string') {
      return { code: e.code, message: e.message, referenceId: e.referenceId };
    }
  } catch {
    // not JSON
  }
  return undefined;
}
