// M0-004 criteria 2 and 3: one database per org, created on demand, and the writer
// stays inside the org it was given.
// Decisions: D22 (the org ID picks the database), D45.2 (graph access behind a small
// interface), D57 (the admin account only creates databases), D73 (one writer account).
//
// Contract:
// - `new GraphService({ uri, adminPassword, writerPassword })` in
//   packages/api/src/graph/graph.service.ts, with `close(): Promise<void>`.
// - `createOrgDatabase(orgId)` uses the admin account. It makes `org-<orgId>` and resolves
//   only once the database is online. If it already exists and is online, it does
//   nothing. Two calls at once (from one service or two) both resolve, leaving one
//   online database.
// - `write(orgId, fn)` runs `fn(tx)` in one write transaction in `org-<orgId>` as the
//   writer account, and resolves to what `fn` returns. If `fn` throws, nothing is kept.
// - `read(orgId, fn)` runs `fn(tx)` in a read transaction in `org-<orgId>` as the writer
//   account. A write inside it fails.
// - `tx` is the neo4j-driver transaction (`tx.run(cypher, params)`).
//
// Setup: `pnpm setup:neo4j` runs first (idempotent), so the two accounts exist. Every
// org here has a fresh random UUID, tracked before it is made; the databases are dropped at the end
// with ThrowawayDatabases.dropAll (S1-014), which fails loudly.
// Needs the running Neo4j Desktop DBMS (bolt://127.0.0.1:7687).
import type { Driver, ManagedTransaction } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseStatuses, graphTestEnv, newOrgId, refused, runOn, runSetupNeo4j, superDriver } from './helpers.js';
import { ThrowawayDatabases } from './throwaway-databases.js';

const LONG = 120_000;

type GraphServiceCtor = typeof import('../../src/graph/graph.service.js').GraphService;
type GraphServiceInstance = InstanceType<GraphServiceCtor>;

let sup: Driver;
const services: GraphServiceInstance[] = [];
let databases: ThrowawayDatabases;

async function makeService(
  overrides: Partial<{ adminPassword: string; writerPassword: string }> = {},
): Promise<GraphServiceInstance> {
  const { GraphService } = await import('../../src/graph/graph.service.js');
  const env = graphTestEnv();
  const svc = new GraphService({
    uri: env.uri,
    adminPassword: env.adminPassword,
    writerPassword: env.writerPassword,
    ...overrides,
  });
  services.push(svc);
  return svc;
}

function trackOrg(): string {
  const id = newOrgId();
  databases.track(`org-${id}`);
  return id;
}

async function markerCount(database: string, marker: string): Promise<number> {
  const rows = await runOn(sup, database, 'MATCH (n:GrcTestProbe {marker: $marker}) RETURN count(n) AS n', { marker });
  return Number(rows[0]?.['n'] ?? 0);
}

beforeAll(async () => {
  graphTestEnv();
  sup = superDriver();
  databases = new ThrowawayDatabases(sup);
  await runOn(sup, 'system', 'SHOW DATABASES YIELD name RETURN count(*) AS n');
  const setup = await runSetupNeo4j();
  if (setup.status !== 0) throw new Error(`pnpm setup:neo4j failed (${setup.status}): ${setup.stderr}`);
}, LONG);

afterAll(async () => {
  try {
    for (const svc of services) await svc.close().catch(() => undefined);
    if (databases) await databases.dropAll();
  } finally {
    await sup?.close();
  }
}, LONG);

describe('createOrgDatabase (criterion 2)', () => {
  it(
    'creates org-<orgId> and resolves only once it is online',
    async () => {
      const svc = await makeService();
      const orgId = trackOrg();
      await svc.createOrgDatabase(orgId);
      expect(await databaseStatuses(sup, `org-${orgId}`)).toEqual(['online']);
    },
    LONG,
  );

  it(
    'does nothing when called a second time',
    async () => {
      const svc = await makeService();
      const orgId = trackOrg();
      await svc.createOrgDatabase(orgId);
      await svc.write(orgId, (tx: ManagedTransaction) => tx.run('CREATE (:GrcTestProbe {marker: "kept"})'));
      await expect(svc.createOrgDatabase(orgId)).resolves.toBeUndefined();
      expect(await databaseStatuses(sup, `org-${orgId}`)).toEqual(['online']);
      // The existing database was left alone, data and all.
      expect(await markerCount(`org-${orgId}`, 'kept')).toBe(1);
    },
    LONG,
  );

  it(
    'ends with one online database when one service calls it several times at once',
    async () => {
      const svc = await makeService();
      const orgId = trackOrg();
      const results = await Promise.allSettled([
        svc.createOrgDatabase(orgId),
        svc.createOrgDatabase(orgId),
        svc.createOrgDatabase(orgId),
      ]);
      expect(results.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok'))).toEqual(['ok', 'ok', 'ok']);
      expect(await databaseStatuses(sup, `org-${orgId}`)).toEqual(['online']);
    },
    LONG,
  );

  it(
    'ends with one online database when two services (API and worker) call it at once',
    async () => {
      const a = await makeService();
      const b = await makeService();
      const orgId = trackOrg();
      const results = await Promise.allSettled([a.createOrgDatabase(orgId), b.createOrgDatabase(orgId)]);
      expect(results.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok'))).toEqual(['ok', 'ok']);
      expect(await databaseStatuses(sup, `org-${orgId}`)).toEqual(['online']);
    },
    LONG,
  );

  it(
    'uses the admin account: it works with a wrong writer password and fails with a wrong admin password',
    async () => {
      const orgOk = trackOrg();
      const badWriter = await makeService({ writerPassword: 'wrong-writer-password' });
      await badWriter.createOrgDatabase(orgOk);
      expect(await databaseStatuses(sup, `org-${orgOk}`)).toEqual(['online']);

      const orgNo = trackOrg();
      const badAdmin = await makeService({ adminPassword: 'wrong-admin-password' });
      await expect(badAdmin.createOrgDatabase(orgNo)).rejects.toThrow();
      expect(await databaseStatuses(sup, `org-${orgNo}`)).toEqual([]);
    },
    LONG,
  );
});

describe('write and read stay inside their org (criterion 3)', () => {
  let svc: GraphServiceInstance;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    svc = await makeService();
    orgA = trackOrg();
    orgB = trackOrg();
    await svc.createOrgDatabase(orgA);
    await svc.createOrgDatabase(orgB);
    await runOn(sup, `org-${orgB}`, 'CREATE (:GrcTestProbe {marker: "b-secret"})');
  }, LONG);

  it('write returns what the function returns', async () => {
    const out = await svc.write(orgA, async (tx: ManagedTransaction) => {
      const res = await tx.run('RETURN 41 + 1 AS answer');
      return res.records[0]?.get('answer') as unknown;
    });
    expect(Number(out)).toBe(42);
  });

  it('write(orgA) creates nodes in org-<orgA> and not in org-<orgB>', async () => {
    await svc.write(orgA, (tx: ManagedTransaction) => tx.run('CREATE (:GrcTestProbe {marker: "a-write"})'));
    expect(await markerCount(`org-${orgA}`, 'a-write')).toBe(1);
    expect(await markerCount(`org-${orgB}`, 'a-write')).toBe(0);
  });

  it('write(orgA) cannot see nodes in org-<orgB>', async () => {
    const seen = await svc.write(orgA, async (tx: ManagedTransaction) => {
      const res = await tx.run('MATCH (n:GrcTestProbe {marker: "b-secret"}) RETURN count(n) AS n');
      return Number(res.records[0]?.get('n'));
    });
    expect(seen).toBe(0);
  });

  it('read(orgA) cannot see nodes in org-<orgB>', async () => {
    const seen = await svc.read(orgA, async (tx: ManagedTransaction) => {
      const res = await tx.run('MATCH (n:GrcTestProbe {marker: "b-secret"}) RETURN count(n) AS n');
      return Number(res.records[0]?.get('n'));
    });
    expect(seen).toBe(0);
  });

  it('read(orgB) does see its own node, so the checks above are not empty by accident', async () => {
    const seen = await svc.read(orgB, async (tx: ManagedTransaction) => {
      const res = await tx.run('MATCH (n:GrcTestProbe {marker: "b-secret"}) RETURN count(n) AS n');
      return Number(res.records[0]?.get('n'));
    });
    expect(seen).toBe(1);
  });

  it('write(orgA) cannot create in org-<orgB> by naming it with USE', async () => {
    await svc
      .write(orgA, (tx: ManagedTransaction) =>
        tx.run(`USE \`org-${orgB}\` CREATE (:GrcTestProbe {marker: "a-use-write"})`),
      )
      .catch(() => undefined);
    expect(await markerCount(`org-${orgB}`, 'a-use-write')).toBe(0);
  });

  it('write(orgA) cannot read org-<orgB> by naming it with USE', async () => {
    const seen = await svc
      .write(orgA, async (tx: ManagedTransaction) => {
        const res = await tx.run(
          `USE \`org-${orgB}\` MATCH (n:GrcTestProbe {marker: "b-secret"}) RETURN count(n) AS n`,
        );
        return Number(res.records[0]?.get('n'));
      })
      .catch(() => 0);
    expect(seen).toBe(0);
  });

  it('write is one transaction: if the function throws, nothing is kept', async () => {
    await expect(
      svc.write(orgA, async (tx: ManagedTransaction) => {
        await tx.run('CREATE (:GrcTestProbe {marker: "rolled-back"})');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await markerCount(`org-${orgA}`, 'rolled-back')).toBe(0);
  });

  it('read runs a read transaction: a write inside it fails and keeps nothing', async () => {
    await refused(svc.read(orgA, (tx: ManagedTransaction) => tx.run('CREATE (:GrcTestProbe {marker: "read-write"})')));
    expect(await markerCount(`org-${orgA}`, 'read-write')).toBe(0);
  });

  it('write uses the writer account: a wrong writer password fails', async () => {
    const bad = await makeService({ writerPassword: 'wrong-writer-password' });
    await expect(
      bad.write(orgA, (tx: ManagedTransaction) => tx.run('CREATE (:GrcTestProbe {marker: "bad-writer"})')),
    ).rejects.toThrow();
    expect(await markerCount(`org-${orgA}`, 'bad-writer')).toBe(0);
  });

  it('write and read do not need the admin account', async () => {
    const noAdmin = await makeService({ adminPassword: 'wrong-admin-password' });
    await noAdmin.write(orgA, (tx: ManagedTransaction) => tx.run('CREATE (:GrcTestProbe {marker: "no-admin"})'));
    const seen = await noAdmin.read(orgA, async (tx: ManagedTransaction) => {
      const res = await tx.run('MATCH (n:GrcTestProbe {marker: "no-admin"}) RETURN count(n) AS n');
      return Number(res.records[0]?.get('n'));
    });
    expect(seen).toBe(1);
  });

  it('a bad org ID creates no database and runs no query (criterion 5, live)', async () => {
    const bad = `${orgA}\`; DROP DATABASE \`org-${orgB}`;
    await expect(svc.createOrgDatabase(bad)).rejects.toThrow();
    await expect(
      svc.write(bad, (tx: ManagedTransaction) => tx.run('CREATE (:GrcTestProbe {marker: "bad-id"})')),
    ).rejects.toThrow();
    // Only look at names built from this test's orgs, since other runs may share the DBMS.
    const rows = await runOn(
      sup,
      'system',
      'SHOW DATABASES YIELD name WHERE name CONTAINS $a OR name CONTAINS $b RETURN collect(DISTINCT name) AS names',
      { a: orgA, b: orgB },
    );
    expect(new Set(rows[0]?.['names'] as string[])).toEqual(new Set([`org-${orgA}`, `org-${orgB}`]));
    expect(await databaseStatuses(sup, `org-${orgB}`)).toEqual(['online']);
    expect(await markerCount(`org-${orgA}`, 'bad-id')).toBe(0);
  });
});
