// M0-002: the Docker Compose stack and its dev switch.
// Decisions: D5 (Neo4j and Ollama run natively, reached through host.docker.internal),
// D13, D21, D28, D35, D57 (.env.example lists names only), D60, D61 (only Caddy is
// published, on 127.0.0.1), D63 (Postgres and SeaweedFS sit on an internal network),
// D82 (the stack stays under 4 GB), D98, D106, D132 and D137 (the dev switch also opens
// SeaweedFS's S3 port 8333 on 127.0.0.1, off by default).
//
// How these tests read the stack: `docker compose ... config --format json`, so they see
// the file exactly as Docker resolves it (merges, units, defaults). That needs only the
// docker CLI, not a running daemon. Variables are filled from a throwaway env file with
// a dummy value for every name in `.env.example`, never from a real `.env`, and the
// subprocess gets a clean environment (no COMPOSE_* or app variables leak in).
//
// The dev-switch tests run base + dev together and compare the result with the base
// alone. By D145 (which replaces D141's grc-dev join), grc-postgres and grc-seaweedfs stay
// on grc-internal only, always, and every base service is left exactly as it is. The only
// allowed additions are one small relay service `grc-dev-relay` on grc-internal plus one
// normal dev-only network `grc-dev`, both defined only in compose.dev.yaml. The relay
// publishes exactly 127.0.0.1:5433 (to grc-postgres:5432) and 127.0.0.1:8333 (to
// grc-seaweedfs:8333). Docker publishes no port for a container that is only on an
// internal network, which is why the relay needs grc-dev.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const INFRA = join(ROOT, 'packages', 'infra');
const COMPOSE = join(INFRA, 'compose.yaml');
const COMPOSE_DEV = join(INFRA, 'compose.dev.yaml');
const ENV_EXAMPLE = join(ROOT, '.env.example');
const API_DOCKERFILE = join(ROOT, 'packages', 'api', 'Dockerfile');

const REQUIRED_SERVICES = ['grc-postgres', 'grc-seaweedfs', 'grc-caddy', 'grc-api', 'grc-worker'] as const;
const FOUR_GIB = 4 * 1024 ** 3;
// D145: the one dev-only relay service and the one dev-only network it joins.
const RELAY = 'grc-dev-relay';
const DEV_NET = 'grc-dev';

type Json = Record<string, unknown>;
interface Port {
  host_ip?: string;
  target: number;
  published?: string;
  protocol?: string;
}
interface Service {
  image?: string;
  container_name?: string;
  build?: { context: string; dockerfile?: string };
  command?: unknown;
  entrypoint?: unknown;
  networks?: Record<string, unknown>;
  ports?: Port[];
  extra_hosts?: string[] | Record<string, string>;
  environment?: Record<string, string | null>;
  mem_limit?: string | number;
  deploy?: { resources?: { limits?: { memory?: string | number } } };
  volumes?: { type: string; source?: string }[];
}
interface Network {
  name?: string;
  internal?: boolean;
  external?: boolean;
  driver?: string;
  driver_opts?: Record<string, string>;
}
interface Project {
  name: string;
  services: Record<string, Service>;
  networks?: Record<string, Network>;
  volumes?: Record<string, { name?: string }>;
}

function envNamesInExample(): string[] {
  if (!existsSync(ENV_EXAMPLE)) return [];
  return readFileSync(ENV_EXAMPLE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => l.split('=')[0]!.trim());
}

let tmp = '';
let dummyEnv = '';

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  if (process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  return env;
}

function composeConfig(files: string[], envFile: string | null = dummyEnv): { ok: boolean; out: string; err: string } {
  for (const f of files) {
    if (!existsSync(f)) return { ok: false, out: '', err: `missing compose file: ${f}` };
  }
  const args = ['compose', ...files.flatMap((f) => ['-f', f])];
  if (envFile) args.push('--env-file', envFile);
  args.push('config', '--format', 'json');
  const r = spawnSync('docker', args, { cwd: ROOT, env: cleanEnv(), encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout ?? '', err: `${r.stderr ?? ''}${r.error ? String(r.error) : ''}` };
}

function load(files: string[]): Project {
  const r = composeConfig(files);
  if (!r.ok) throw new Error(`docker compose config failed: ${r.err}`);
  return JSON.parse(r.out) as Project;
}

let base: Project;
let dev: Project;
let baseError: Error | null = null;
let devError: Error | null = null;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'grc-compose-test-'));
  dummyEnv = join(tmp, 'dummy.env');
  writeFileSync(
    dummyEnv,
    envNamesInExample()
      .map((n) => `${n}=dummy-${n.toLowerCase()}`)
      .join('\n') + '\n',
  );
  try {
    base = load([COMPOSE]);
  } catch (e) {
    baseError = e as Error;
  }
  try {
    dev = load([COMPOSE, COMPOSE_DEV]);
  } catch (e) {
    devError = e as Error;
  }
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function stack(): Project {
  if (baseError) throw baseError;
  return base;
}
function devStack(): Project {
  if (devError) throw devError;
  return dev;
}
function svc(p: Project, name: string): Service {
  const s = p.services[name];
  if (!s) throw new Error(`service ${name} is missing`);
  return s;
}
function netsOf(s: Service): string[] {
  return Object.keys(s.networks ?? {}).sort();
}
function without<T>(o: Record<string, T> | undefined, key: string): Record<string, T> | undefined {
  if (!o) return o;
  return Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
}
function portKey(p: Port): string {
  return `${p.host_ip ?? '0.0.0.0'}:${p.published ?? ''}:${p.target}`;
}
function toBytes(v: string | number | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i.exec(v.trim());
  if (!m) return null;
  const mult: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return Number(m[1]) * mult[m[2]!.toLowerCase()]!;
}
function memLimit(s: Service): number | null {
  return toBytes(s.deploy?.resources?.limits?.memory) ?? toBytes(s.mem_limit);
}
function extraHosts(s: Service): string[] {
  const h = s.extra_hosts;
  if (!h) return [];
  if (Array.isArray(h)) return h.map((x) => x.replace('=', ':'));
  return Object.entries(h).map(([k, v]) => `${k}:${v}`);
}

describe('compose: files and validation (criterion 8)', () => {
  it('packages/infra/compose.yaml exists', () => {
    expect(existsSync(COMPOSE)).toBe(true);
  });

  it('packages/infra/compose.dev.yaml (the dev switch) exists', () => {
    expect(existsSync(COMPOSE_DEV)).toBe(true);
  });

  it('`docker compose -f packages/infra/compose.yaml config` validates', () => {
    const r = composeConfig([COMPOSE]);
    expect(r.ok, r.err).toBe(true);
  });

  it('the base file plus the dev switch validates', () => {
    const r = composeConfig([COMPOSE, COMPOSE_DEV]);
    expect(r.ok, r.err).toBe(true);
  });

  it('the dev switch is off by default: no override file that Docker would load on its own', () => {
    for (const f of [
      'compose.override.yaml',
      'compose.override.yml',
      'docker-compose.override.yaml',
      'docker-compose.override.yml',
    ]) {
      expect(existsSync(join(INFRA, f)), f).toBe(false);
    }
  });

  it('packages/api/Dockerfile exists', () => {
    expect(existsSync(API_DOCKERFILE)).toBe(true);
  });
});

describe('compose: names (criterion 1)', () => {
  it('the project name is grc', () => {
    expect(stack().name).toBe('grc');
  });

  it('has the five services', () => {
    expect(Object.keys(stack().services)).toEqual(expect.arrayContaining([...REQUIRED_SERVICES]));
  });

  it('grc-postgres runs pgvector/pgvector:pg18', () => {
    expect(svc(stack(), 'grc-postgres').image).toBe('pgvector/pgvector:pg18');
  });

  it('every service name and container_name starts with grc-', () => {
    for (const [name, s] of Object.entries(stack().services)) {
      expect(name, `service ${name}`).toMatch(/^grc-/);
      expect(s.container_name, `container_name of ${name}`).toMatch(/^grc-/);
    }
  });

  it('every network starts with grc- or grc_', () => {
    const nets = stack().networks ?? {};
    expect(Object.keys(nets).length).toBeGreaterThan(0);
    for (const [key, n] of Object.entries(nets)) {
      expect(key).toMatch(/^grc[-_]/);
      expect(n.name ?? key).toMatch(/^grc[-_]/);
    }
  });

  it('every named volume starts with grc- or grc_', () => {
    for (const [key, v] of Object.entries(stack().volumes ?? {})) {
      expect(key).toMatch(/^grc[-_]/);
      expect(v.name ?? key).toMatch(/^grc[-_]/);
    }
    for (const [name, s] of Object.entries(stack().services)) {
      for (const v of s.volumes ?? []) {
        if (v.type === 'volume' && v.source) expect(v.source, `volume in ${name}`).toMatch(/^grc[-_]/);
      }
    }
  });

  it('Postgres keeps its data in a named grc volume', () => {
    const vols = (svc(stack(), 'grc-postgres').volumes ?? []).filter((v) => v.type === 'volume');
    expect(vols.length).toBeGreaterThan(0);
  });
});

describe('compose: networks (criterion 2, D63)', () => {
  it('grc-internal exists and is internal (no internet)', () => {
    expect(stack().networks?.['grc-internal']?.internal).toBe(true);
  });

  it('grc-edge exists and is not internal', () => {
    const edge = stack().networks?.['grc-edge'];
    expect(edge).toBeDefined();
    expect(edge?.internal ?? false).toBe(false);
  });

  it('Postgres is on grc-internal only', () => {
    expect(netsOf(svc(stack(), 'grc-postgres'))).toEqual(['grc-internal']);
  });

  it('SeaweedFS is on grc-internal only', () => {
    expect(netsOf(svc(stack(), 'grc-seaweedfs'))).toEqual(['grc-internal']);
  });

  it('the API is on grc-internal and grc-edge', () => {
    expect(netsOf(svc(stack(), 'grc-api'))).toEqual(['grc-edge', 'grc-internal']);
  });

  it('the worker is on grc-internal and grc-edge', () => {
    expect(netsOf(svc(stack(), 'grc-worker'))).toEqual(['grc-edge', 'grc-internal']);
  });

  it('Caddy is on grc-edge and not on grc-internal', () => {
    const nets = netsOf(svc(stack(), 'grc-caddy'));
    expect(nets).toContain('grc-edge');
    expect(nets).not.toContain('grc-internal');
  });

  it('no service uses host networking', () => {
    for (const [name, s] of Object.entries(stack().services)) {
      expect((s as Json).network_mode, name).toBeUndefined();
    }
  });
});

describe('compose: published ports (criterion 3, D61)', () => {
  it('Caddy publishes exactly 127.0.0.1:443:443 and 127.0.0.1:80:80', () => {
    const keys = new Set((svc(stack(), 'grc-caddy').ports ?? []).map(portKey));
    expect([...keys].sort()).toEqual(['127.0.0.1:443:443', '127.0.0.1:80:80']);
  });

  it('every published port binds to 127.0.0.1', () => {
    for (const [name, s] of Object.entries(stack().services)) {
      for (const p of s.ports ?? []) expect(p.host_ip, `${name} ${portKey(p)}`).toBe('127.0.0.1');
    }
  });

  it.each(['grc-api', 'grc-worker', 'grc-postgres', 'grc-seaweedfs'])('%s publishes no ports', (name) => {
    expect(svc(stack(), name).ports ?? []).toEqual([]);
  });

  it('no service other than Caddy publishes a port', () => {
    for (const [name, s] of Object.entries(stack().services)) {
      if (name !== 'grc-caddy') expect(s.ports ?? [], name).toEqual([]);
    }
  });
});

describe('compose: the dev switch (criterion 4, D61, D132, D137, D145)', () => {
  it('opens exactly 127.0.0.1:5433 and 127.0.0.1:8333, both on grc-dev-relay', () => {
    const baseKeys = new Set(
      Object.entries(stack().services).flatMap(([name, s]) => (s.ports ?? []).map((p) => `${name} ${portKey(p)}`)),
    );
    const opened = Object.entries(devStack().services).flatMap(([name, s]) =>
      (s.ports ?? [])
        .filter((p) => !baseKeys.has(`${name} ${portKey(p)}`))
        .map((p) => `${name} ${p.host_ip ?? '0.0.0.0'}:${p.published ?? ''}`),
    );
    expect(opened.sort()).toEqual([`${RELAY} 127.0.0.1:5433`, `${RELAY} 127.0.0.1:8333`]);
  });

  it('every port it opens binds to 127.0.0.1', () => {
    for (const [name, s] of Object.entries(devStack().services)) {
      for (const p of s.ports ?? []) expect(p.host_ip, `${name} ${portKey(p)}`).toBe('127.0.0.1');
    }
  });

  it.each(['grc-postgres', 'grc-seaweedfs'])('%s publishes no ports and stays on grc-internal only (D145)', (name) => {
    expect(svc(devStack(), name).ports ?? []).toEqual([]);
    expect(netsOf(svc(devStack(), name))).toEqual(['grc-internal']);
  });

  it('changes nothing else: every base service, network and volume is exactly as in the base stack', () => {
    const b = stack();
    const d = devStack();
    expect(d.name).toBe(b.name);
    expect(Object.keys(without(d.services, RELAY) ?? {}).sort()).toEqual(Object.keys(b.services).sort());
    expect(without(d.networks, DEV_NET)).toEqual(b.networks);
    expect(d.volumes).toEqual(b.volumes);
    for (const name of Object.keys(b.services)) {
      expect(d.services[name], `service ${name}`).toEqual(b.services[name]);
    }
  });

  it('adds exactly one service, grc-dev-relay, and one network, grc-dev', () => {
    const addedServices = Object.keys(devStack().services).filter((k) => !(k in stack().services));
    const addedNets = Object.keys(devStack().networks ?? {}).filter((k) => !(k in (stack().networks ?? {})));
    expect(addedServices).toEqual([RELAY]);
    expect(addedNets).toEqual([DEV_NET]);
  });
});

describe('compose: the dev relay grc-dev-relay (D145)', () => {
  it('the base stack has no relay and no grc-dev network', () => {
    expect(Object.keys(stack().services)).not.toContain(RELAY);
    expect(Object.keys(stack().networks ?? {})).not.toContain(DEV_NET);
    for (const [name, s] of Object.entries(stack().services)) {
      expect(netsOf(s), name).not.toContain(DEV_NET);
    }
  });

  it('the relay and grc-dev are defined in compose.dev.yaml and not in compose.yaml', () => {
    const devText = readFileSync(COMPOSE_DEV, 'utf8');
    expect(devText).toMatch(/^\s+grc-dev-relay:/m);
    expect(devText).toMatch(/^\s+grc-dev:/m);
    expect(readFileSync(COMPOSE, 'utf8')).not.toMatch(/grc-dev/);
  });

  it('the relay container is named grc-dev-relay', () => {
    expect(svc(devStack(), RELAY).container_name).toBe(RELAY);
  });

  it('the relay is on grc-internal and grc-dev only', () => {
    expect(netsOf(svc(devStack(), RELAY))).toEqual([DEV_NET, 'grc-internal']);
  });

  it('only the relay joins grc-dev', () => {
    const members = Object.entries(devStack().services)
      .filter(([, s]) => netsOf(s).includes(DEV_NET))
      .map(([name]) => name);
    expect(members).toEqual([RELAY]);
  });

  it('grc-dev is a normal bridge network named grc-dev (not internal, not external)', () => {
    const n = devStack().networks?.[DEV_NET];
    expect(n).toBeDefined();
    expect(n?.name ?? DEV_NET).toBe(DEV_NET);
    expect(n?.driver ?? 'bridge').toBe('bridge');
    expect(n?.internal ?? false).toBe(false);
    expect(n?.external ?? false).toBe(false);
  });

  it('the relay forwards 5433 to grc-postgres:5432 and 8333 to grc-seaweedfs:8333', () => {
    const r = svc(devStack(), RELAY);
    const published = (r.ports ?? []).map((p) => p.published ?? '').sort();
    expect(published).toEqual(['5433', '8333']);
    const cfg = JSON.stringify([r.entrypoint, r.command, r.environment]);
    expect(cfg).toContain('grc-postgres:5432');
    expect(cfg).toContain('grc-seaweedfs:8333');
  });

  it('the relay has no volumes, no host mappings and no host networking', () => {
    const r = svc(devStack(), RELAY);
    expect(r.volumes ?? []).toEqual([]);
    expect(extraHosts(r)).toEqual([]);
    expect((r as Json).network_mode).toBeUndefined();
  });

  it('the relay has a memory limit, and with it the dev stack stays under 4 GB', () => {
    expect(memLimit(svc(devStack(), RELAY))).not.toBeNull();
    const total = Object.values(devStack().services).reduce((sum, s) => sum + (memLimit(s) ?? Infinity), 0);
    expect(total).toBeLessThan(FOUR_GIB);
  });
});

describe('compose: reaching the Mac (criterion 5, D5)', () => {
  it.each(['grc-api', 'grc-worker'])('%s maps host.docker.internal to the host gateway', (name) => {
    expect(extraHosts(svc(stack(), name))).toContain('host.docker.internal:host-gateway');
  });

  it.each(['grc-api', 'grc-worker'])('%s gets NEO4J_URI=bolt://host.docker.internal:7687', (name) => {
    expect(svc(stack(), name).environment?.NEO4J_URI).toBe('bolt://host.docker.internal:7687');
  });

  it.each(['grc-api', 'grc-worker'])('%s gets an Ollama address on host.docker.internal:11434', (name) => {
    const values = Object.values(svc(stack(), name).environment ?? {});
    expect(values.some((v) => typeof v === 'string' && /^https?:\/\/host\.docker\.internal:11434/.test(v))).toBe(true);
  });
});

describe('compose: one API image, two programs', () => {
  it('the API and worker build from packages/api/Dockerfile', () => {
    for (const name of ['grc-api', 'grc-worker']) {
      const b = svc(stack(), name).build;
      expect(b, `${name} build`).toBeDefined();
      expect(resolve(b!.context, b!.dockerfile ?? 'Dockerfile'), name).toBe(API_DOCKERFILE);
    }
  });

  it('the API and worker share the same build and differ in their start command', () => {
    const api = svc(stack(), 'grc-api');
    const worker = svc(stack(), 'grc-worker');
    expect(worker.build).toEqual(api.build);
    expect(worker.image).toEqual(api.image);
    expect(JSON.stringify([worker.entrypoint, worker.command])).not.toBe(JSON.stringify([api.entrypoint, api.command]));
  });
});

describe('compose: memory (criterion 6, D82)', () => {
  it('every service has a memory limit', () => {
    for (const [name, s] of Object.entries(stack().services)) {
      expect(memLimit(s), `memory limit of ${name}`).not.toBeNull();
    }
  });

  it('the limits add up to less than 4 GB', () => {
    const total = Object.values(stack().services).reduce((sum, s) => sum + (memLimit(s) ?? Infinity), 0);
    expect(total).toBeLessThan(FOUR_GIB);
  });
});

describe('.env.example (D57)', () => {
  it('lists names only, with no values', () => {
    expect(existsSync(ENV_EXAMPLE)).toBe(true);
    const lines = readFileSync(ENV_EXAMPLE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/^[A-Z][A-Z0-9_]*=$/);
  });

  it('lists the secrets the stack needs', () => {
    expect(envNamesInExample()).toEqual(
      expect.arrayContaining([
        'POSTGRES_PASSWORD',
        'NEO4J_ADMIN_PASSWORD',
        'NEO4J_WRITER_PASSWORD',
        'NEO4J_DESKTOP_PASSWORD',
      ]),
    );
  });

  it('lists every variable the compose files use', () => {
    const names = new Set(envNamesInExample());
    const used = new Set<string>();
    for (const f of [COMPOSE, COMPOSE_DEV]) {
      expect(existsSync(f), f).toBe(true);
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]!);
      for (const m of text.matchAll(/(?<!\$)\$([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]!);
    }
    for (const u of used) expect(names.has(u), `${u} missing from .env.example`).toBe(true);
  });
});
