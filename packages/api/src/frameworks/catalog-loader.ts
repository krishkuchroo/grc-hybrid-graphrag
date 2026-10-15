// The framework catalog loader (S2-003; D20, D37, D45.4, D45.5, D66, D67, D68, D69, D73, D144).
// Copies the four catalogs (S2-002's committed files) and NIST's cross-framework MAPS_TO links into
// one org's graph, the same way in every org, so a catalog update reaches every org (D66).
//
// - One framework per transaction, in catalog order (FRAMEWORK_KEYS), as grc_writer in
//   `org-<orgId>` through `AuditOutbox.withAuditedWrite` (D37, D45.4). The changes and their one
//   `framework.loaded` audit entry commit together, or neither does.
// - Each transaction first takes the Framework node's write lock (MERGE by its stable ID, then a
//   set-and-remove of a lock property), so two loads of the same org queue on it, then reads what
//   is stored and diffs it against the files (`planCatalogChanges`, pure). When nothing differs it
//   throws a private signal that rolls the transaction back: no commit and no audit entry.
// - New nodes get every catalog property (S2 shared notes), version 1 and the next free number
//   (`FWK` / `REQ` + 7 digits, the org's highest + 1, from 1001; on a first load that is catalog
//   order across all four frameworks). A node that exists keeps its number. A changed node gets
//   the new values, version + 1 and a new `updatedAt`; an unchanged one isn't touched. A
//   requirement no longer in the file is retired (version + 1), never deleted (D69); one that
//   comes back is set active again.
// - MAPS_TO links (origin `import`) are MERGEd; an `import` link no longer in the files is deleted
//   (catalog content, not people's links). Links of any other origin, and every SATISFIES link,
//   are never touched. A link between two frameworks is looked after by the later of the two in
//   catalog order (`mapsToOwner`): by then both of its ends are loaded, so a first load adds
//   every link, and each link counts in exactly one framework's entry.
// - Counts (the report and the audit entry) are of nodes: the Framework node and its
//   requirements. A requirement set active again counts as updated.
// - No Cypher names a database (D144), nothing here touches Postgres (the outbox relay copies the
//   entries), and errors name only the framework key and counts, never titles or descriptions
//   (D163, D164).
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import {
  FIRST_NUMBER,
  FRAMEWORK_KEYS,
  FRAMEWORKS,
  formatCatalogNumber,
  frameworkIdFor,
  isFrameworkKey,
  parentCodeOf,
  requirementIdFor,
  sortKeyOf,
  type FrameworkKey,
  type Label,
} from '@grc/shared';
import type { AuditActor, AuditOutbox, OutboxAudit } from '../audit/outbox.js';
import { NUMBER_CLASH_ATTEMPTS, isNumberClash } from '../records/record-numbers.js';
import { readCatalogFiles, type CatalogFiles } from './catalog-files.js';

/** Who the loader's audit entries name. */
export const CATALOG_ACTOR: AuditActor = Object.freeze({ actorType: 'system', actorId: 'framework-catalog' });
/** `createdBy` and `updatedBy` on catalog nodes and links. */
export const CATALOG_AUTHOR = 'system:framework-catalog';
/** `owner` on catalog nodes. */
export const CATALOG_OWNER = 'system';
/** Every catalog node's label (D51's default for anything that isn't an asset, incident or evidence). */
export const CATALOG_LABEL: Label = 'internal';
/** The origin of catalog nodes and NIST's MAPS_TO links. */
export const CATALOG_ORIGIN = 'import';
/** The audit action of one framework's load. */
export const FRAMEWORK_LOADED = 'framework.loaded';

const FRAMEWORK = 'Framework';
const REQUIREMENT = 'Requirement';
const MAPS_TO = 'MAPS_TO';
/** Set and removed in the same transaction: it only takes the Framework node's write lock. */
const LOCK_PROPERTY = '_catalogLoadLock';

/** A Framework node's content, as the files and the shared FRAMEWORKS table give it. */
export interface FrameworkContent {
  id: string;
  key: FrameworkKey;
  name: string;
  frameworkVersion: string;
  publisher: string;
  description: string;
}

/** A Requirement node's content, as the file gives it. `name` is `<code> <title>`. */
export interface RequirementContent {
  id: string;
  code: string;
  title: string;
  description: string;
  framework: FrameworkKey;
  group: string;
  parentCode: string | null;
  sortKey: string;
  name: string;
}

/** A NIST MAPS_TO link, by its two requirements' IDs: the citing one to the cited one. */
export interface MapsToLink {
  fromId: string;
  toId: string;
}

/** A catalog node as stored: its ID, status and number, and whichever content fields it has. */
export type StoredNode = { id: string; status?: unknown; number?: unknown } & Record<string, unknown>;

/** What one framework's graph holds now. */
export interface StoredCatalog {
  /** The Framework node, or null when it isn't loaded yet. */
  framework: StoredNode | null;
  /** Every Requirement node of the framework, active and retired. */
  requirements: StoredNode[];
  /** The `import` MAPS_TO links this framework's load looks after (`mapsToOwner`). */
  mapsTo: MapsToLink[];
}

/** What one framework's graph should hold, from the files. */
export interface FileCatalog {
  framework: FrameworkContent;
  /** In the file's (natural code) order: new ones are numbered in this order. */
  requirements: RequirementContent[];
  /** The NIST MAPS_TO links this framework's load looks after (`mapsToOwner`). */
  mapsTo: MapsToLink[];
}

/** The difference between what is stored and the files, for one framework. */
export interface CatalogPlan {
  /** What happens to the Framework node itself. */
  framework: 'add' | 'update' | 'unchanged';
  /** Requirements not in the graph yet, in file order. */
  add: RequirementContent[];
  /** Active requirements whose content changed. */
  update: RequirementContent[];
  /** The IDs of requirements no longer in the file that aren't retired yet. */
  retire: string[];
  /** Requirements back in the file after being retired, with their content from the file. */
  revive: RequirementContent[];
  /** Requirements left as they are (retired ones that stay retired included). */
  unchanged: number;
  mapsToAdd: MapsToLink[];
  mapsToRemove: MapsToLink[];
}

/** One framework's counts: nodes (the Framework node and its requirements) added, updated
 * (requirements set active again included), retired and left unchanged. */
export interface FrameworkLoadCounts {
  key: FrameworkKey;
  added: number;
  updated: number;
  retired: number;
  unchanged: number;
}

export interface LoadReport {
  frameworks: FrameworkLoadCounts[];
  /** MAPS_TO links added, and `import` links no longer in the files (deleted). */
  mapsTo: { added: number; retired: number };
}

/** A load that can't finish as planned (a MAPS_TO end missing). Names the framework key only. */
export class CatalogLoadError extends Error {
  constructor(
    readonly framework: FrameworkKey,
    problem: string,
  ) {
    super(`framework catalog load: ${framework}: ${problem}`);
    this.name = 'CatalogLoadError';
  }
}

/** Rolls a transaction with nothing to change back, carrying the (empty) plan out. */
class NothingToLoad extends Error {
  constructor(readonly plan: CatalogPlan) {
    super('nothing to load');
    this.name = 'NothingToLoad';
  }
}

/** The framework whose load looks after a link between `from` and `to`: the later of the two in
 * catalog order, so both ends are loaded by the time its transaction runs. */
export function mapsToOwner(from: FrameworkKey, to: FrameworkKey): FrameworkKey {
  return FRAMEWORK_KEYS.indexOf(from) >= FRAMEWORK_KEYS.indexOf(to) ? from : to;
}

/** What the files say framework `key`'s graph should hold. */
export function fileCatalogOf(key: FrameworkKey, catalogs: CatalogFiles): FileCatalog {
  const catalog = catalogs.catalogs[key];
  const info = FRAMEWORKS[key];
  const requirements = catalog.requirements.map((r): RequirementContent => ({
    id: requirementIdFor(key, r.code),
    code: r.code,
    title: r.title,
    description: r.description,
    framework: key,
    group: r.group,
    parentCode: parentCodeOf(key, r.code),
    sortKey: sortKeyOf(key, r.code),
    name: `${r.code} ${r.title}`,
  }));
  const mapsTo: MapsToLink[] = [];
  for (const file of catalogs.mappings) {
    for (const m of file.mappings) {
      if (mapsToOwner(m.from.framework, m.to.framework) !== key) continue;
      mapsTo.push({
        fromId: requirementIdFor(m.from.framework, m.from.code),
        toId: requirementIdFor(m.to.framework, m.to.code),
      });
    }
  }
  return {
    framework: {
      id: frameworkIdFor(key),
      key,
      name: info.name,
      frameworkVersion: catalog.frameworkVersion,
      publisher: info.publisher,
      description: info.description,
    },
    requirements,
    mapsTo,
  };
}

const FRAMEWORK_FIELDS = ['key', 'name', 'frameworkVersion', 'publisher', 'description'] as const;
const REQUIREMENT_FIELDS = [
  'code',
  'framework',
  'name',
  'title',
  'description',
  'group',
  'parentCode',
  'sortKey',
] as const;

/** True when a stored field differs from the file's. A missing property reads as null, as Neo4j
 * stores no nulls (an 800-53 base control's `parentCode`). */
function differs<T extends object>(stored: StoredNode, wanted: T, fields: readonly (keyof T & string)[]): boolean {
  return fields.some((f) => (stored[f] ?? null) !== ((wanted[f] as unknown) ?? null));
}

function linkKey(link: MapsToLink): string {
  return `${link.fromId}>${link.toId}`;
}

/** The links of `a` that aren't in `b`, each once. */
function linksMissingFrom(a: readonly MapsToLink[], b: readonly MapsToLink[]): MapsToLink[] {
  const inB = new Set(b.map(linkKey));
  const seen = new Set<string>();
  const out: MapsToLink[] = [];
  for (const link of a) {
    const key = linkKey(link);
    if (inB.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ fromId: link.fromId, toId: link.toId });
  }
  return out;
}

/** Diffs one framework's stored state against its files. Pure. */
export function planCatalogChanges(stored: StoredCatalog, file: FileCatalog): CatalogPlan {
  let framework: CatalogPlan['framework'] = 'unchanged';
  if (stored.framework === null) framework = 'add';
  else if (stored.framework.status !== 'active' || differs(stored.framework, file.framework, FRAMEWORK_FIELDS)) {
    framework = 'update';
  }

  const storedById = new Map(stored.requirements.map((r) => [r.id, r]));
  const wantedIds = new Set<string>();
  const plan: CatalogPlan = {
    framework,
    add: [],
    update: [],
    retire: [],
    revive: [],
    unchanged: 0,
    mapsToAdd: linksMissingFrom(file.mapsTo, stored.mapsTo),
    mapsToRemove: linksMissingFrom(stored.mapsTo, file.mapsTo),
  };
  for (const wanted of file.requirements) {
    if (wantedIds.has(wanted.id)) continue;
    wantedIds.add(wanted.id);
    const found = storedById.get(wanted.id);
    if (found === undefined) plan.add.push(wanted);
    else if (found.status !== 'active') plan.revive.push(wanted);
    else if (differs(found, wanted, REQUIREMENT_FIELDS)) plan.update.push(wanted);
    else plan.unchanged += 1;
  }
  for (const found of storedById.values()) {
    if (wantedIds.has(found.id)) continue;
    if (found.status === 'retired') plan.unchanged += 1;
    else plan.retire.push(found.id);
  }
  return plan;
}

/** True when the plan changes nothing. */
export function isEmptyPlan(plan: CatalogPlan): boolean {
  return (
    plan.framework === 'unchanged' &&
    plan.add.length === 0 &&
    plan.update.length === 0 &&
    plan.retire.length === 0 &&
    plan.revive.length === 0 &&
    plan.mapsToAdd.length === 0 &&
    plan.mapsToRemove.length === 0
  );
}

/** The plan's node counts for framework `key`. */
export function countsOf(key: FrameworkKey, plan: CatalogPlan): FrameworkLoadCounts {
  return {
    key,
    added: plan.add.length + (plan.framework === 'add' ? 1 : 0),
    updated: plan.update.length + plan.revive.length + (plan.framework === 'update' ? 1 : 0),
    retired: plan.retire.length,
    unchanged: plan.unchanged + (plan.framework === 'unchanged' ? 1 : 0),
  };
}

// ---- Reading and writing one framework, inside its transaction ----

async function single(
  tx: ManagedTransaction,
  query: string,
  params: Record<string, unknown>,
  key: string,
): Promise<unknown> {
  const res = await tx.run(query, params);
  return res.records[0]?.get(key);
}

/** A whole number from Neo4j (a plain number, or an Integer from a driver that keeps them), or null. */
function wholeNumber(value: unknown): number | null {
  if (neo4j.isInt(value)) return value.toNumber();
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Takes the Framework node's write lock (making a bare node if it isn't there; a rolled-back
 * transaction drops it again) and reads what the framework's graph holds. */
async function readStored(tx: ManagedTransaction, file: FileCatalog): Promise<StoredCatalog> {
  const key = file.framework.key;
  const p = (await single(
    tx,
    `MERGE (f:${FRAMEWORK} {id: $id})
     SET f.${LOCK_PROPERTY} = true
     REMOVE f.${LOCK_PROPERTY}
     RETURN f {.id, .status, .number, .key, .name, .frameworkVersion, .publisher, .description} AS p`,
    { id: file.framework.id },
    'p',
  )) as Record<string, unknown> | null | undefined;
  const framework = p && p['number'] !== null && p['number'] !== undefined ? (p as StoredNode) : null;

  const reqs = await tx.run(
    `MATCH (n:${REQUIREMENT} {framework: $key})
     RETURN n {.id, .status, .number, .code, .framework, .name, .title, .description, .group, .parentCode, .sortKey} AS p`,
    { key },
  );
  const requirements = reqs.records.map((r) => r.get('p') as StoredNode).filter((n) => typeof n.id === 'string');

  const links = await tx.run(
    `MATCH (a:${REQUIREMENT})-[r:${MAPS_TO}]->(b:${REQUIREMENT})
     WHERE r.origin = $origin AND (a.framework = $key OR b.framework = $key)
     RETURN DISTINCT a.id AS fromId, a.framework AS fromFramework, b.id AS toId, b.framework AS toFramework`,
    { key, origin: CATALOG_ORIGIN },
  );
  const mapsTo: MapsToLink[] = [];
  for (const r of links.records) {
    const from = r.get('fromFramework') as unknown;
    const to = r.get('toFramework') as unknown;
    if (!isFrameworkKey(from) || !isFrameworkKey(to) || mapsToOwner(from, to) !== key) continue;
    mapsTo.push({ fromId: r.get('fromId') as string, toId: r.get('toId') as string });
  }
  return { framework, requirements, mapsTo };
}

/** The org's highest `FWK` or `REQ` number, or FIRST_NUMBER - 1 when there is none. */
async function topNumber(tx: ManagedTransaction, label: string, prefix: 'FWK' | 'REQ'): Promise<number> {
  const top = wholeNumber(
    await single(
      tx,
      `MATCH (n:${label}) WHERE n.number =~ $pattern RETURN max(toInteger(substring(n.number, 3))) AS top`,
      { pattern: `${prefix}[0-9]{7}` },
      'top',
    ),
  );
  return top === null ? FIRST_NUMBER - 1 : Math.max(top, FIRST_NUMBER - 1);
}

/** The properties every new catalog node gets besides its content and number. */
function newNodeProps(now: string): Record<string, unknown> {
  return {
    sourceIds: [],
    sensitivity: CATALOG_LABEL,
    status: 'active',
    owner: CATALOG_OWNER,
    version: neo4j.int(1),
    createdAt: now,
    createdBy: CATALOG_AUTHOR,
    updatedAt: now,
    updatedBy: CATALOG_AUTHOR,
    origin: CATALOG_ORIGIN,
  };
}

function requirementProps(r: RequirementContent): Record<string, unknown> {
  return {
    code: r.code,
    title: r.title,
    description: r.description,
    framework: r.framework,
    group: r.group,
    parentCode: r.parentCode,
    sortKey: r.sortKey,
    name: r.name,
  };
}

function frameworkProps(f: FrameworkContent): Record<string, unknown> {
  return {
    key: f.key,
    name: f.name,
    frameworkVersion: f.frameworkVersion,
    publisher: f.publisher,
    description: f.description,
  };
}

/** Applies the plan; returns the Framework node's number. */
async function applyPlan(
  tx: ManagedTransaction,
  file: FileCatalog,
  stored: StoredCatalog,
  plan: CatalogPlan,
): Promise<string> {
  const key = file.framework.key;
  const now = new Date().toISOString();
  const touched = { now, by: CATALOG_AUTHOR };

  let number = typeof stored.framework?.number === 'string' ? stored.framework.number : '';
  if (plan.framework === 'add') {
    number = formatCatalogNumber('framework', (await topNumber(tx, FRAMEWORK, 'FWK')) + 1);
    await tx.run(`MATCH (f:${FRAMEWORK} {id: $id}) SET f += $props`, {
      id: file.framework.id,
      props: { ...newNodeProps(now), ...frameworkProps(file.framework), number },
    });
  } else if (plan.framework === 'update') {
    await tx.run(
      `MATCH (f:${FRAMEWORK} {id: $id})
       SET f += $props, f.version = coalesce(f.version, 0) + 1, f.updatedAt = $now, f.updatedBy = $by`,
      { id: file.framework.id, props: { ...frameworkProps(file.framework), status: 'active' }, ...touched },
    );
  }

  if (plan.mapsToRemove.length > 0) {
    await tx.run(
      `UNWIND $links AS l
       MATCH (a:${REQUIREMENT} {id: l.fromId})-[r:${MAPS_TO}]->(b:${REQUIREMENT} {id: l.toId})
       WHERE r.origin = $origin
       DELETE r`,
      { links: plan.mapsToRemove, origin: CATALOG_ORIGIN },
    );
  }

  if (plan.add.length > 0) {
    const first = (await topNumber(tx, REQUIREMENT, 'REQ')) + 1;
    const rows = plan.add.map((r, i) => ({
      ...newNodeProps(now),
      ...requirementProps(r),
      id: r.id,
      number: formatCatalogNumber('requirement', first + i),
    }));
    await tx.run(
      `UNWIND $rows AS row
       MERGE (n:${REQUIREMENT} {id: row.id})
       ON CREATE SET n += row`,
      { rows },
    );
  }

  const changed = [...plan.update, ...plan.revive];
  if (changed.length > 0) {
    await tx.run(
      `UNWIND $rows AS row
       MATCH (n:${REQUIREMENT} {id: row.id})
       SET n += row.props, n.version = coalesce(n.version, 0) + 1, n.updatedAt = $now, n.updatedBy = $by`,
      { rows: changed.map((r) => ({ id: r.id, props: { ...requirementProps(r), status: 'active' } })), ...touched },
    );
  }

  if (plan.retire.length > 0) {
    await tx.run(
      `UNWIND $ids AS id
       MATCH (n:${REQUIREMENT} {id: id})
       SET n.status = 'retired', n.version = coalesce(n.version, 0) + 1, n.updatedAt = $now, n.updatedBy = $by`,
      { ids: plan.retire, ...touched },
    );
  }

  if (plan.mapsToAdd.length > 0) {
    const made = wholeNumber(
      await single(
        tx,
        `UNWIND $links AS l
       MATCH (a:${REQUIREMENT} {id: l.fromId})
       MATCH (b:${REQUIREMENT} {id: l.toId})
       MERGE (a)-[r:${MAPS_TO} {origin: $origin}]->(b)
       ON CREATE SET r.createdAt = $now, r.createdBy = $by
       RETURN count(r) AS n`,
        { links: plan.mapsToAdd, origin: CATALOG_ORIGIN, ...touched },
        'n',
      ),
    );
    if (made !== plan.mapsToAdd.length) {
      throw new CatalogLoadError(key, `${plan.mapsToAdd.length - (made ?? 0)} MAPS_TO links have an end not loaded`);
    }
  }
  return number;
}

function loadedAudit(file: FileCatalog, number: string, plan: CatalogPlan): OutboxAudit {
  const counts = countsOf(file.framework.key, plan);
  return {
    action: FRAMEWORK_LOADED,
    targetType: 'framework',
    targetId: file.framework.id,
    before: null,
    after: {
      frameworkVersion: file.framework.frameworkVersion,
      added: counts.added,
      updated: counts.updated,
      retired: counts.retired,
      mapsToAdded: plan.mapsToAdd.length,
      mapsToRemoved: plan.mapsToRemove.length,
    },
    meta: { number, label: CATALOG_LABEL },
  };
}

/** Loads one framework in one transaction; returns what it changed (an empty plan when nothing). */
async function loadFramework(
  outbox: Pick<AuditOutbox, 'withAuditedWrite'>,
  orgId: string,
  file: FileCatalog,
): Promise<CatalogPlan> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await outbox.withAuditedWrite(orgId, CATALOG_ACTOR, async (tx) => {
        const stored = await readStored(tx, file);
        const plan = planCatalogChanges(stored, file);
        if (isEmptyPlan(plan)) throw new NothingToLoad(plan);
        const number = await applyPlan(tx, file, stored, plan);
        return { result: plan, audit: loadedAudit(file, number, plan) };
      });
    } catch (err) {
      if (err instanceof NothingToLoad) return err.plan;
      // Another load of the same org took the same number first: read again and renumber.
      if (isNumberClash(err) && attempt < NUMBER_CLASH_ATTEMPTS) continue;
      throw err;
    }
  }
}

/**
 * Loads the framework catalogs and NIST's MAPS_TO links into `org-<orgId>` (see the top of this
 * file). Safe to re-run: a second load with the same files changes nothing and writes no entry.
 * Stops at the first framework that fails (its transaction leaves nothing behind); a re-run
 * finishes the rest.
 */
export async function loadFrameworkCatalogs(
  deps: { outbox: Pick<AuditOutbox, 'withAuditedWrite'> },
  orgId: string,
  catalogs: CatalogFiles = readCatalogFiles(),
): Promise<LoadReport> {
  const report: LoadReport = { frameworks: [], mapsTo: { added: 0, retired: 0 } };
  for (const key of FRAMEWORK_KEYS) {
    const plan = await loadFramework(deps.outbox, orgId, fileCatalogOf(key, catalogs));
    report.frameworks.push(countsOf(key, plan));
    report.mapsTo.added += plan.mapsToAdd.length;
    report.mapsTo.retired += plan.mapsToRemove.length;
  }
  return report;
}
