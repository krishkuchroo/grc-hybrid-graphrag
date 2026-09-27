// M0-006, D145 (replaces D141's grc-dev join), D61, D63: with the dev switch on, SeaweedFS still
// has no way out to the internet. grc-seaweedfs stays on grc-internal only and publishes no port;
// the one dev relay, grc-dev-relay, is what publishes 127.0.0.1:8333 for the storage tests.
//
// Live: these read the running containers with the docker CLI (`docker inspect`, `docker port`,
// `docker exec`). They touch only grc-* containers and networks, never another project's.
// The routing-table check is the proof that doesn't depend on this Mac being online: a container
// on an internal network only has no default route. The connection attempt backs it up.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SEAWEED = 'grc-seaweedfs';
const RELAY = 'grc-dev-relay';

function docker(args: string[], timeoutMs = 30_000): { status: number | null; out: string; err: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: `${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

function inspect<T>(name: string, format: string): T {
  const r = docker(['inspect', '--format', `{{json ${format}}}`, name]);
  if (r.status !== 0) throw new Error(`docker inspect ${name} failed (is the stack up with the dev switch?): ${r.err}`);
  return JSON.parse(r.out) as T;
}

function networksOf(name: string): string[] {
  return Object.keys(inspect<Record<string, unknown>>(name, '.NetworkSettings.Networks') ?? {}).sort();
}

describe('storage: SeaweedFS has no internet with the dev switch on (D145, D63)', () => {
  it('grc-seaweedfs is running', () => {
    expect(inspect<boolean>(SEAWEED, '.State.Running')).toBe(true);
  });

  it('grc-internal is an internal network', () => {
    const r = docker(['network', 'inspect', '--format', '{{json .Internal}}', 'grc-internal']);
    expect(r.status, r.err).toBe(0);
    expect(JSON.parse(r.out)).toBe(true);
  });

  it('grc-seaweedfs is attached to grc-internal only', () => {
    expect(networksOf(SEAWEED)).toEqual(['grc-internal']);
  });

  it('grc-seaweedfs publishes no port on the Mac', () => {
    const bindings = inspect<Record<string, unknown> | null>(SEAWEED, '.HostConfig.PortBindings') ?? {};
    expect(Object.keys(bindings)).toEqual([]);
    const r = docker(['port', SEAWEED]);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toBe('');
  });

  it('grc-seaweedfs has no default route', () => {
    const r = docker(['exec', SEAWEED, 'cat', '/proc/net/route']);
    expect(r.status, r.err).toBe(0);
    const defaults = r.out
      .split('\n')
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((cols) => cols[1] === '00000000');
    expect(defaults, 'default routes in grc-seaweedfs').toEqual([]);
  });

  it('an outgoing connection from grc-seaweedfs to the internet fails', () => {
    const r = docker(
      ['exec', SEAWEED, 'sh', '-c', 'wget -q -T 5 -O /dev/null http://1.1.1.1/ >/dev/null 2>&1; echo "rc=$?"'],
      30_000,
    );
    expect(r.status, r.err).toBe(0);
    expect(r.out).toMatch(/^rc=\d+$/);
    expect(r.out, 'wget to 1.1.1.1 from grc-seaweedfs').not.toBe('rc=0');
  }, 40_000);
});

describe('storage: the dev relay publishes 8333 (D145)', () => {
  it('grc-dev-relay is running', () => {
    expect(inspect<boolean>(RELAY, '.State.Running')).toBe(true);
  });

  it('grc-dev-relay is on grc-internal and grc-dev only', () => {
    expect(networksOf(RELAY)).toEqual(['grc-dev', 'grc-internal']);
  });

  it('127.0.0.1:8333 on the Mac is published by grc-dev-relay, on 127.0.0.1 only', () => {
    const bindings =
      inspect<Record<string, { HostIp: string; HostPort: string }[] | null> | null>(
        RELAY,
        '.HostConfig.PortBindings',
      ) ?? {};
    const to8333 = Object.values(bindings)
      .flatMap((b) => b ?? [])
      .filter((b) => b.HostPort === '8333');
    expect(to8333).toEqual([{ HostIp: '127.0.0.1', HostPort: '8333' }]);
  });
});
