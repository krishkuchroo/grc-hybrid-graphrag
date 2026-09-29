// The checks the world tests share: each returns a list of problems (empty when the org is right),
// so a failing test names every broken record or link rather than the first one.
// The shared record model (S1-001) is read from its source, so these checks use exactly the
// schemas and link rules the API uses.
import { createSchemas, isAllowedLink } from '../../../shared/src/index.js';
import { KINDS, LIST_OF, type Kind, type SizeSpec, type WorldLink, type WorldOrg, type WorldRecord } from './load.js';

/** Every record of the org with its kind. */
export function recordsOf(org: WorldOrg): { kind: Kind; record: WorldRecord }[] {
  return KINDS.flatMap((kind) => (org[LIST_OF[kind]] ?? []).map((record) => ({ kind, record })));
}

/** The kind of each key in the org. */
export function kindByKey(org: WorldOrg): Map<string, Kind> {
  return new Map(recordsOf(org).map(({ kind, record }) => [record.key, kind]));
}

/** The org's records by key. */
export function recordByKey(org: WorldOrg): Map<string, WorldRecord> {
  return new Map(recordsOf(org).map(({ record }) => [record.key, record]));
}

/** Criterion 2: the counts match the size exactly. */
export function countProblems(org: WorldOrg, size: SizeSpec): string[] {
  const problems: string[] = [];
  for (const kind of KINDS) {
    const list = LIST_OF[kind];
    const have = Array.isArray(org[list]) ? org[list].length : 'none';
    if (have !== size[list]) problems.push(`${org.key}: ${list} ${have}, expected ${size[list]}`);
  }
  if (!Array.isArray(org.links)) problems.push(`${org.key}: no links list`);
  return problems;
}

/** Criterion 2: every record has a unique key and a canonical name, and passes S1's create schema. */
export function recordProblems(org: WorldOrg): string[] {
  const problems: string[] = [];
  const seenKeys = new Set<string>();
  const seenNames = new Map<Kind, Set<string>>(KINDS.map((kind) => [kind, new Set<string>()]));
  for (const { kind, record } of recordsOf(org)) {
    if (typeof record.key !== 'string' || record.key.length === 0) {
      problems.push(`${org.key}: a ${kind} has no key`);
      continue;
    }
    if (seenKeys.has(record.key)) problems.push(`${org.key}: key ${record.key} is used twice`);
    seenKeys.add(record.key);
    if (kind === 'asset' && !/^AST-\d{4,}$/.test(record.key)) {
      problems.push(`${org.key}: asset key ${record.key} is not like AST-0001`);
    }
    if (typeof record.name !== 'string' || record.name.trim().length === 0) {
      problems.push(`${org.key}: ${record.key} has no name`);
    } else {
      const names = seenNames.get(kind)!;
      if (names.has(record.name)) problems.push(`${org.key}: ${kind} name "${record.name}" is used twice`);
      names.add(record.name);
    }
    // The record is its key plus exactly the fields of S1's create schema for its kind.
    const { key: _key, ...fields } = record;
    void _key;
    const parsed = createSchemas[kind].safeParse(fields);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(record)'}: ${issue.message}`);
      problems.push(`${org.key}: ${record.key} fails createSchemas.${kind}: ${issues.join('; ')}`);
    }
  }
  return problems;
}

/** Criterion 2: every link joins two records of the org and passes `isAllowedLink`. */
export function linkProblems(org: WorldOrg): string[] {
  const problems: string[] = [];
  const kinds = kindByKey(org);
  for (const link of org.links ?? []) {
    const from = kinds.get(link.fromKey);
    const to = kinds.get(link.toKey);
    if (typeof link.type !== 'string') problems.push(`${org.key}: a link has no type`);
    if (!from) problems.push(`${org.key}: ${link.type} from unknown key ${link.fromKey}`);
    if (!to) problems.push(`${org.key}: ${link.type} to unknown key ${link.toKey}`);
    if (from && to && !isAllowedLink(link.type, from, to)) {
      problems.push(
        `${org.key}: ${link.type} ${link.fromKey} (${from}) -> ${link.toKey} (${to}) is not an allowed link`,
      );
    }
  }
  return problems;
}

const ESTATE = new Set(['HOSTS', 'RUNS']);

/** The HOSTS and RUNS links of the org. */
export function estateLinks(org: WorldOrg): WorldLink[] {
  return (org.links ?? []).filter((link) => ESTATE.has(link.type));
}

/** Criterion 2: HOSTS and RUNS together have no cycle (a self-link counts as one). */
export function cycleProblems(org: WorldOrg): string[] {
  const next = new Map<string, string[]>();
  for (const link of estateLinks(org)) {
    next.set(link.fromKey, [...(next.get(link.fromKey) ?? []), link.toKey]);
  }
  const state = new Map<string, 'open' | 'done'>();
  const problems: string[] = [];
  for (const start of next.keys()) {
    if (state.has(start)) continue;
    // An iterative depth-first search, so a 2,000-asset estate can't overflow the stack.
    const stack: { key: string; i: number }[] = [{ key: start, i: 0 }];
    state.set(start, 'open');
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const children = next.get(top.key) ?? [];
      if (top.i >= children.length) {
        state.set(top.key, 'done');
        stack.pop();
        continue;
      }
      const child = children[top.i++]!;
      const seen = state.get(child);
      if (seen === 'open') {
        problems.push(`${org.key}: HOSTS/RUNS cycle through ${child}`);
      } else if (seen === undefined) {
        state.set(child, 'open');
        stack.push({ key: child, i: 0 });
      }
    }
  }
  return problems;
}

/** The brief's layered estate: which asset types may host or run which. */
export const ESTATE_LAYERS: Record<string, readonly [string, string][]> = {
  HOSTS: [
    ['network_device', 'server'],
    ['cloud_service', 'server'],
    ['server', 'database'],
  ],
  RUNS: [['server', 'application']],
};

function distinctTargets(org: WorldOrg, type: string, fromKey: string): number {
  return new Set((org.links ?? []).filter((l) => l.type === type && l.fromKey === fromKey).map((l) => l.toKey)).size;
}

function distinctSources(org: WorldOrg, type: string, toKey: string): number {
  return new Set((org.links ?? []).filter((l) => l.type === type && l.toKey === toKey).map((l) => l.fromKey)).size;
}

/** Criterion 3: the brief's shape rules. */
export function shapeProblems(org: WorldOrg): string[] {
  const problems: string[] = [];
  const records = recordByKey(org);

  // HOSTS and RUNS form a layered estate: network devices and cloud services host servers, servers
  // host databases and run applications.
  for (const link of estateLinks(org)) {
    const fromType = records.get(link.fromKey)?.assetType;
    const toType = records.get(link.toKey)?.assetType;
    const layers = ESTATE_LAYERS[link.type] ?? [];
    if (!layers.some(([from, to]) => from === fromType && to === toType)) {
      problems.push(`${org.key}: ${link.fromKey} (${String(fromType)}) ${link.type} ${link.toKey} (${String(toType)})`);
    }
  }

  for (const risk of org.risks ?? []) {
    if (distinctSources(org, 'EXPOSED_TO', risk.key) < 1)
      problems.push(`${org.key}: risk ${risk.key} has no asset exposed to it`);
    const controls = distinctTargets(org, 'MITIGATED_BY', risk.key);
    if (controls < 1 || controls > 3)
      problems.push(`${org.key}: risk ${risk.key} is mitigated by ${controls} controls, expected 1 to 3`);
  }

  for (const control of org.controls ?? []) {
    const policies = (org.links ?? []).filter((l) => l.type === 'GOVERNED_BY' && l.fromKey === control.key).length;
    if (policies !== 1)
      problems.push(`${org.key}: control ${control.key} is governed by ${policies} policies, expected 1`);
  }

  for (const incident of org.incidents ?? []) {
    const assets = distinctTargets(org, 'IMPACTS', incident.key);
    if (assets < 1 || assets > 3)
      problems.push(`${org.key}: incident ${incident.key} impacts ${assets} assets, expected 1 to 3`);
    const risks = distinctTargets(org, 'EXPOSES', incident.key);
    if (risks > 2) problems.push(`${org.key}: incident ${incident.key} exposes ${risks} risks, expected 0 to 2`);
  }
  return problems;
}

/** Criterion 5: what makes an estate: each asset key's type and name, and the HOSTS/RUNS links. */
export function estateSignature(org: WorldOrg): { names: string; structure: string } {
  const names = (org.assets ?? []).map((asset) => asset.name).sort();
  const types = (org.assets ?? []).map((asset) => `${asset.key}:${String(asset.assetType)}`).sort();
  const links = estateLinks(org)
    .map((link) => `${link.fromKey} ${link.type} ${link.toKey}`)
    .sort();
  return { names: JSON.stringify(names), structure: JSON.stringify({ types, links }) };
}

/** Criterion 5: every pair of orgs has different names and a different estate. */
export function sameOrgProblems(orgs: WorldOrg[]): string[] {
  const problems: string[] = [];
  const orgNames = orgs.map((org) => org.name);
  if (new Set(orgNames).size !== orgNames.length) problems.push(`org names repeat: ${orgNames.join(', ')}`);
  const orgKeys = orgs.map((org) => org.key);
  if (new Set(orgKeys).size !== orgKeys.length) problems.push(`org keys repeat: ${orgKeys.join(', ')}`);
  const signatures = orgs.map(estateSignature);
  for (let a = 0; a < orgs.length; a++) {
    for (let b = a + 1; b < orgs.length; b++) {
      if (signatures[a]!.names === signatures[b]!.names) {
        problems.push(`${orgs[a]!.key} and ${orgs[b]!.key} have the same asset names`);
      }
      if (signatures[a]!.structure === signatures[b]!.structure) {
        problems.push(`${orgs[a]!.key} and ${orgs[b]!.key} have the same estate (asset types and HOSTS/RUNS links)`);
      }
    }
  }
  return problems;
}
