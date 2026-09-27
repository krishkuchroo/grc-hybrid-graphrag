// Shared set-up for the M0-005 graph-account tests (test writer's file, D89/D96).
//
// Decisions: D15, D22, D23, D50, D51 (a link is visible only if both ends are), D52.2, D57,
// D73 (28 read-only accounts; the audit outbox is hidden from them), D131, D144.
//
// Where the settings come from:
// - fullEnv(): every name in the nearest `.env` (walking up from this folder, so a worktree
//   finds the main checkout's `.env`), with process.env winning. It is handed whole to
//   `graphFromEnv` and to `pnpm setup:neo4j`, so whatever settings the builder adds for the 28
//   accounts reach them without these tests knowing their names.
// - The tests use the Desktop `neo4j` account only to set up fixtures, to check, and to run a
//   session *as* a query account (Neo4j Enterprise impersonation): privileges are then those
//   of the query account, so the database's own rules are tested without their passwords.
//
// Throwaway data (D82): two org databases `org-<random uuid>`, dropped in afterAll.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import neo4j, { type Driver, type ManagedTransaction } from 'neo4j-driver';
import { LABELS, ROLES, ROLE_TABLE, type Label, type Role } from '@grc/shared';
import { ROOT, dropDatabases, refused, runOn, superDriver } from '../graph/helpers.js';
import { graphFromEnv } from '../../src/graph/graph.module.js';

export { ROOT, dropDatabases, refused, runOn, superDriver };

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(HERE, '..', '..');
export const LONG = 180_000;

// ---------------------------------------------------------------------------------------------
// The code under test. Loaded on use, so a missing file or export fails the tests that need it
// with a clear message instead of failing the whole file at import.

/** `GraphService` as M0-005 extends it. */
export interface QueryGraph {
  readAs<T>(
    orgId: string,
    role: string,
    clearance: string,
    fn: (tx: ManagedTransaction) => Promise<T>,
    options: { timeoutMs: number },
  ): Promise<T>;
  close(): Promise<void>;
}

async function load<T>(rel: string, name: string): Promise<T> {
  const file = join(API_DIR, rel);
  if (!existsSync(file)) throw new Error(`${rel} does not exist yet`);
  const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  if (typeof mod[name] !== 'function') throw new Error(`${rel} must export ${name}`);
  return mod[name] as T;
}

export function loadQueryAccountName(): Promise<(role: string, clearance: string) => string> {
  return load('src/graph/query-accounts.ts', 'queryAccountName');
}

export function loadAssertNoDatabaseReference(): Promise<(cypher: string) => void> {
  return load('src/graph/query-guard.ts', 'assertNoDatabaseReference');
}

export function loadGraphQueryRefused(): Promise<new (message: string) => Error> {
  return load('src/graph/query-guard.ts', 'GraphQueryRefused');
}

function findDotEnv(start: string): string | undefined {
  let dir = start;
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** The `.env` names plus process.env (process.env wins). */
export function fullEnv(): NodeJS.ProcessEnv {
  const file = findDotEnv(HERE);
  const fromFile = file ? parseDotEnv(readFileSync(file, 'utf8')) : {};
  const env: NodeJS.ProcessEnv = { ...fromFile };
  for (const [k, v] of Object.entries(process.env)) if (v) env[k] = v;
  if (!env.NEO4J_URI) env.NEO4J_URI = 'bolt://127.0.0.1:7687';
  return env;
}

/** Every secret-looking value in the env, for the "never prints a password" check. */
export function secretValues(): string[] {
  return Object.entries(fullEnv())
    .filter(([k, v]) => /PASSWORD|SECRET|TOKEN|KEY/.test(k) && typeof v === 'string' && v.length >= 8)
    .map(([, v]) => v as string);
}

/** Runs the root `pnpm setup:neo4j` from the repo root with the full env. */
export function runSetupNeo4j(): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('pnpm', ['setup:neo4j'], { cwd: ROOT, env: fullEnv(), encoding: 'utf8', timeout: LONG });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** A GraphService built the way the app builds it, from the environment. */
export function newGraph(): QueryGraph {
  return graphFromEnv(fullEnv()) as unknown as QueryGraph;
}

/** Fails with a clear message while `readAs` is missing. */
export function requireReadAs(graph: QueryGraph | undefined): QueryGraph {
  if (!graph) throw new Error('graphFromEnv failed to build a GraphService');
  if (typeof (graph as Partial<QueryGraph>).readAs !== 'function')
    throw new Error('GraphService.readAs does not exist yet');
  return graph;
}

// ---------------------------------------------------------------------------------------------
// The 28 accounts.

export interface Account {
  role: Role;
  clearance: Label;
  name: string;
}

/** Every role × clearance pair, with the D73/brief name `grc_ro_<role>_<clearance>`. */
export const ACCOUNTS: Account[] = ROLES.flatMap((role) =>
  LABELS.map((clearance) => ({ role, clearance, name: `grc_ro_${role}_${clearance}` })),
);

// ---------------------------------------------------------------------------------------------
// Fixture graph: every node type × every label, in two org databases.

/** Neo4j node label → the D50 row that decides whether a role may view it. */
export const NODE_TYPES = {
  Asset: 'asset',
  Risk: 'risk',
  Control: 'control',
  Policy: 'policy',
  Incident: 'incident',
  Framework: 'framework_mapping',
  Requirement: 'framework_mapping',
  Evidence: 'evidence',
  AuditFinding: 'audit_finding',
} as const;
export type NodeType = keyof typeof NODE_TYPES;
export const NODE_TYPE_NAMES = Object.keys(NODE_TYPES) as NodeType[];

export interface FixtureNode {
  id: string;
  type: NodeType;
  label: Label;
}

export interface FixtureRel {
  id: string;
  from: FixtureNode;
  to: FixtureNode;
}

export interface FixtureOrg {
  orgId: string;
  database: string;
  nodes: FixtureNode[];
  rels: FixtureRel[];
  outboxIds: string[];
}

export function fixtureNodeId(orgId: string, type: NodeType, label: Label): string {
  return `${orgId}:${type}:${label}`;
}

/**
 * Makes `org-<orgId>` with: one node per type × label (property `sensitivity`), a CONCERNS
 * link between every ordered pair of them, and AuditOutbox entries (one per label, one without
 * a label) each linked to a public Asset.
 */
export async function createFixtureOrg(sup: Driver): Promise<FixtureOrg> {
  const orgId = randomUUID();
  const database = `org-${orgId}`;
  await runOn(sup, 'system', `CREATE DATABASE \`${database}\` IF NOT EXISTS WAIT`);
  const nodes: FixtureNode[] = NODE_TYPE_NAMES.flatMap((type) =>
    LABELS.map((label) => ({ id: fixtureNodeId(orgId, type, label), type, label })),
  );
  for (const type of NODE_TYPE_NAMES) {
    await runOn(
      sup,
      database,
      `UNWIND $rows AS row CREATE (n:\`${type}\`) SET n.id = row.id, n.name = row.id, n.sensitivity = row.label,
         n.orgId = $orgId, n.status = 'active', n.fixture = true`,
      { rows: nodes.filter((n) => n.type === type).map((n) => ({ id: n.id, label: n.label })), orgId },
    );
  }
  await runOn(
    sup,
    database,
    `MATCH (a {fixture: true}), (b {fixture: true}) WHERE a.id <> b.id
     CREATE (a)-[:CONCERNS {id: a.id + '->' + b.id}]->(b)`,
  );
  const rels: FixtureRel[] = [];
  for (const from of nodes)
    for (const to of nodes) if (from.id !== to.id) rels.push({ id: `${from.id}->${to.id}`, from, to });

  const outboxIds = [...LABELS.map((l) => `${orgId}:outbox:${l}`), `${orgId}:outbox:unlabelled`];
  await runOn(
    sup,
    database,
    `UNWIND $rows AS row CREATE (o:AuditOutbox {id: row.id, name: row.id, orgId: $orgId, payload: 'audit entry'})
     FOREACH (_ IN CASE WHEN row.label IS NULL THEN [] ELSE [1] END | SET o.sensitivity = row.label)
     WITH o MATCH (a:Asset {id: $asset}) CREATE (o)-[:CONCERNS {id: o.id + '->' + a.id}]->(a)`,
    {
      rows: outboxIds.map((id, i) => ({ id, label: LABELS[i] ?? null })),
      orgId,
      asset: fixtureNodeId(orgId, 'Asset', 'public'),
    },
  );
  return { orgId, database, nodes, rels, outboxIds };
}

// ---------------------------------------------------------------------------------------------
// Expected visibility (D50 + D51).

/**
 * true: the role may view the type; false: D50 says `—`; undefined: the cell depends on
 * ownership (`edit_own`, `upload_own`), which a shared account can't know, so these tests
 * don't assert either way.
 */
export function typeVisible(role: Role, type: NodeType): boolean | undefined {
  const cell = ROLE_TABLE[NODE_TYPES[type]][role];
  if (cell === 'none') return false;
  if (cell === 'edit_own' || cell === 'upload_own') return undefined;
  return true;
}

export function labelVisible(clearance: Label, label: Label): boolean {
  return LABELS.indexOf(clearance) >= LABELS.indexOf(label);
}

export function nodeVisible(account: Account, node: FixtureNode): boolean | undefined {
  if (!labelVisible(account.clearance, node.label)) return false;
  return typeVisible(account.role, node.type);
}

export function relVisible(account: Account, rel: FixtureRel): boolean | undefined {
  const a = nodeVisible(account, rel.from);
  const b = nodeVisible(account, rel.to);
  if (a === false || b === false) return false;
  if (a === undefined || b === undefined) return undefined;
  return true;
}

/** The ids we can assert on for this account, and which of them must be visible. */
export function expectedNodes(account: Account, org: FixtureOrg): { decided: Set<string>; visible: string[] } {
  const decided = new Set<string>();
  const visible: string[] = [];
  for (const n of org.nodes) {
    const v = nodeVisible(account, n);
    if (v === undefined) continue;
    decided.add(n.id);
    if (v) visible.push(n.id);
  }
  return { decided, visible: visible.sort() };
}

export function expectedRels(account: Account, org: FixtureOrg): { decided: Set<string>; visible: string[] } {
  const decided = new Set<string>();
  const visible: string[] = [];
  for (const r of org.rels) {
    const v = relVisible(account, r);
    if (v === undefined) continue;
    decided.add(r.id);
    if (v) visible.push(r.id);
  }
  return { decided, visible: visible.sort() };
}

/**
 * Drops only the ids whose visibility these tests leave open. Anything else, including ids
 * from another org, outbox ids and nulls (a node seen without its properties), is kept, so it
 * shows up as a mismatch.
 */
export function keepAsserted(ids: unknown[], org: FixtureOrg, undecided: (id: string) => boolean): string[] {
  return ids
    .map((id) => (typeof id === 'string' ? id : `<${String(id)}>`))
    .filter((id) => !(id.startsWith(`${org.orgId}:`) && undecided(id)))
    .sort();
}

// ---------------------------------------------------------------------------------------------
// Running Cypher as a query account.

export type Runner = (org: FixtureOrg, cypher: string) => Promise<Record<string, unknown>[]>;

/** Through the interface under test: `GraphService.readAs`. */
export function readAsRunner(graph: QueryGraph | undefined, account: Account, timeoutMs = 60_000): Runner {
  return async (org, cypher) =>
    requireReadAs(graph).readAs(
      org.orgId,
      account.role,
      account.clearance,
      async (tx) => (await tx.run(cypher)).records.map((r) => r.toObject() as Record<string, unknown>),
      { timeoutMs },
    );
}

/** Straight to Neo4j, as the account (impersonation), so only the database's rules apply. */
export function impersonatedRunner(sup: Driver, account: Account, mode: 'READ' | 'WRITE' = 'READ'): Runner {
  return async (org, cypher) => {
    const session = sup.session({
      database: org.database,
      impersonatedUser: account.name,
      defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE,
    });
    try {
      const res = await session.run(cypher);
      return res.records.map((r) => r.toObject() as Record<string, unknown>);
    } finally {
      await session.close();
    }
  };
}

export async function visibleNodeIds(run: Runner, org: FixtureOrg): Promise<unknown[]> {
  return (await run(org, 'MATCH (n) RETURN n.id AS id')).map((r) => r['id']);
}

export async function visibleRelIds(run: Runner, org: FixtureOrg): Promise<unknown[]> {
  return (await run(org, 'MATCH ()-[r]->() RETURN r.id AS id')).map((r) => r['id']);
}
