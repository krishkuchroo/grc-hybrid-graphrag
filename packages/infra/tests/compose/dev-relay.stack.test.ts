// M0-003 (D145, replacing D141's grc-dev join; D61, D63): a live check of the running dev
// stack, started with the dev switch on:
//   docker compose -f packages/infra/compose.yaml -f packages/infra/compose.dev.yaml --env-file .env up -d
//
// What it proves, on the containers as Docker actually runs them:
// - grc-postgres and grc-seaweedfs sit on grc-internal only and publish no host ports.
// - Neither can open an outgoing TCP connection to the internet (1.1.1.1:443, 8.8.8.8:53).
//   On Docker Desktop "no masquerade" did not stop this (the M0-003 security review saw
//   grc-postgres reach 1.1.1.1:443), so this is a behaviour check, not a config check.
//   Each probe has a control: the same probe reaching a peer on grc-internal must succeed,
//   so a missing tool or a broken probe can't pass as "blocked".
// - The relay grc-dev-relay runs and publishes exactly 127.0.0.1:5433 and 127.0.0.1:8333.
// - 127.0.0.1:5433 still reaches Postgres (it answers the Postgres SSLRequest handshake, no
//   credentials needed) and 127.0.0.1:8333 still reaches SeaweedFS's S3 API.
//
// These tests need the dev stack running. They fail (not skip) when it isn't, with a
// message that says so. They only read: `docker inspect` and `docker exec` with a short
// TCP probe. They never start, stop or change a container, and touch only grc-* ones.
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';

const POSTGRES = 'grc-postgres';
const SEAWEEDFS = 'grc-seaweedfs';
const RELAY = 'grc-dev-relay';
const INTERNET_TARGETS: [string, number][] = [
  ['1.1.1.1', 443],
  ['8.8.8.8', 53],
];
const PROBE_TIMEOUT_S = 5;

function docker(args: string[], timeoutMs = 20_000): { status: number | null; out: string; err: string } {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  if (process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  const r = spawnSync('docker', args, { env, encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, out: r.stdout ?? '', err: `${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

interface Inspect {
  State?: { Running?: boolean };
  NetworkSettings?: {
    Networks?: Record<string, unknown>;
    Ports?: Record<string, { HostIp: string; HostPort: string }[] | null>;
  };
  HostConfig?: { PortBindings?: Record<string, { HostIp: string; HostPort: string }[] | null> | null };
}

function inspect(name: string): Inspect {
  const r = docker(['inspect', name]);
  if (r.status !== 0) {
    throw new Error(`container ${name} not found; start the dev stack with the dev switch on (${r.err.trim()})`);
  }
  const [info] = JSON.parse(r.out) as Inspect[];
  if (!info?.State?.Running)
    throw new Error(`container ${name} is not running; start the dev stack with the dev switch on`);
  return info;
}

function hostBindings(info: Inspect): string[] {
  const out: string[] = [];
  for (const bindings of Object.values(info.NetworkSettings?.Ports ?? {})) {
    for (const b of bindings ?? []) out.push(`${b.HostIp}:${b.HostPort}`);
  }
  for (const bindings of Object.values(info.HostConfig?.PortBindings ?? {})) {
    for (const b of bindings ?? []) out.push(`${b.HostIp}:${b.HostPort}`);
  }
  return [...new Set(out)].sort();
}

// A TCP connect from inside a container. Exit 0 means the connection opened.
function probe(container: string, host: string, port: number): { status: number | null; err: string } {
  const cmd =
    container === POSTGRES
      ? ['bash', '-c', `timeout ${PROBE_TIMEOUT_S} bash -c 'echo > /dev/tcp/${host}/${port}'`]
      : ['sh', '-c', `nc -z -w ${PROBE_TIMEOUT_S} ${host} ${port}`];
  const r = docker(['exec', container, ...cmd], (PROBE_TIMEOUT_S + 10) * 1000);
  return { status: r.status, err: r.err };
}

function tcpExchange(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const sock = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`no reply on 127.0.0.1:${port} within 5 s`));
    }, 5000);
    sock.on('connect', () => sock.write(payload));
    sock.on('data', (d) => {
      chunks.push(d);
      clearTimeout(timer);
      sock.destroy();
      resolvePromise(Buffer.concat(chunks));
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

describe('dev stack, live: Postgres and SeaweedFS stay on grc-internal (D145, D63)', () => {
  it.each([POSTGRES, SEAWEEDFS])('%s is attached to grc-internal only', (name) => {
    expect(Object.keys(inspect(name).NetworkSettings?.Networks ?? {}).sort()).toEqual(['grc-internal']);
  });

  it.each([POSTGRES, SEAWEEDFS])('%s publishes no host ports', (name) => {
    expect(hostBindings(inspect(name))).toEqual([]);
  });
});

describe('dev stack, live: no internet from Postgres or SeaweedFS (D145, D63)', () => {
  it('control: the probe in grc-postgres reaches a peer on grc-internal (grc-seaweedfs:8333)', () => {
    inspect(POSTGRES);
    const r = probe(POSTGRES, SEAWEEDFS, 8333);
    expect(r.status, r.err).toBe(0);
  });

  it('control: the probe in grc-seaweedfs reaches a peer on grc-internal (grc-postgres:5432)', () => {
    inspect(SEAWEEDFS);
    const r = probe(SEAWEEDFS, POSTGRES, 5432);
    expect(r.status, r.err).toBe(0);
  });

  it.each(INTERNET_TARGETS)(
    'grc-postgres cannot open a TCP connection to %s:%i',
    (host, port) => {
      inspect(POSTGRES);
      const r = probe(POSTGRES, host, port);
      expect(r.status, `grc-postgres reached ${host}:${port}`).not.toBe(0);
    },
    30_000,
  );

  it.each(INTERNET_TARGETS)(
    'grc-seaweedfs cannot open a TCP connection to %s:%i',
    (host, port) => {
      inspect(SEAWEEDFS);
      const r = probe(SEAWEEDFS, host, port);
      expect(r.status, `grc-seaweedfs reached ${host}:${port}`).not.toBe(0);
    },
    30_000,
  );
});

describe('dev stack, live: the relay keeps the dev ports working (D145, D61)', () => {
  it('grc-dev-relay is running and publishes exactly 127.0.0.1:5433 and 127.0.0.1:8333', () => {
    expect(hostBindings(inspect(RELAY))).toEqual(['127.0.0.1:5433', '127.0.0.1:8333']);
  });

  it('grc-dev-relay is attached to grc-internal and one other network', () => {
    const nets = Object.keys(inspect(RELAY).NetworkSettings?.Networks ?? {});
    expect(nets).toContain('grc-internal');
    expect(nets).toHaveLength(2);
  });

  it('127.0.0.1:5433 reaches Postgres (it answers the SSLRequest handshake)', async () => {
    // SSLRequest: length 8, code 80877103. A Postgres server answers with one byte, S or N.
    const reply = await tcpExchange(5433, Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]));
    expect(['S', 'N']).toContain(reply.subarray(0, 1).toString('latin1'));
  });

  it("127.0.0.1:8333 reaches SeaweedFS's S3 API", async () => {
    const res = await fetch('http://127.0.0.1:8333/', { signal: AbortSignal.timeout(5000) });
    expect(res.headers.get('server') ?? '').toMatch(/^SeaweedFS/);
  });
});
