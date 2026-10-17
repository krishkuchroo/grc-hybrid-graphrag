// What one full-pipeline org's sources state and plant (S8-006; D18, D39, D40, D52.6, D68), from the
// answer key, rendered again with `renderSources` exactly as `pnpm gen:data` rendered the files it
// uploaded (the same seed and size give the same files, D45.8):
// - the org's answer-key records, and what an org record is matched to them by: the source IDs the
//   generator wrote (each asset list row's `<source>:<source ID>`, the alias S3's import gives the
//   asset, D68, for typo'd and duplicate rows too; and `answer-key:<key>`, which fast-loaded records
//   carry), or else the exact name within the kind, after S4's `normaliseName`;
// - every link of the answer key;
// - each distinct link the documents state (their `mentions`), in a fixed order: the ontology's link
//   order, then the two ends' keys;
// - each planted false positive (`notAFact`) and each add-links injection (`proposedLink`), with the
//   file it is in, in the plants' order.
// Links are compared by identity: the type and the two ends, each end an answer-key key here (an
// org record or a name as written elsewhere, ./score.ts). Pure: no I/O.
import {
  CMDB_SOURCES,
  assetRows,
  renderSources,
  type AnswerKey,
  type Fact,
  type RenderedSources,
} from '@grc/generators';
import { LINK_TYPES, RECORD_KINDS, normaliseName, type RecordKind } from '@grc/shared';
import { answerKeySourceId } from '../run/resolve.js';

/** A record of the answer key: its key, kind and name. */
export interface AnswerKeyRecord {
  key: string;
  kind: RecordKind;
  name: string;
}

/** A planted link (a false positive's, or the one an add-links injection asks for) and its file. */
export interface PlantedLink {
  link: Fact;
  fileName: string;
}

export interface ExpectedOrg {
  orgKey: string;
  /** The org's place in the answer key, from 0. */
  orgIndex: number;
  records: ReadonlyMap<string, AnswerKeyRecord>;
  /** A source ID the generator wrote, and the answer-key record it belongs to. */
  aliases: ReadonlyMap<string, string>;
  /** Per kind, each normalised name and its record's key; null when two records share it. */
  names: ReadonlyMap<RecordKind, ReadonlyMap<string, string | null>>;
  /** Every link of the answer key, by identity (`identityOfFact`). */
  links: ReadonlySet<string>;
  /** Each distinct link the documents state. */
  statedFacts: readonly Fact[];
  falsePositives: readonly PlantedLink[];
  /** The add-links injections only: the other kinds ask for no link. */
  injections: readonly PlantedLink[];
}

/** A link's identity: its type and its two ends' identities. */
export function linkIdentity(type: string, from: string, to: string): string {
  return `${type}|${from}|${to}`;
}

/** An end that is an answer-key record. */
export function keyEnd(key: string): string {
  return `key:${key}`;
}

/** The identity of an answer-key link. */
export function identityOfFact(fact: Fact): string {
  return linkIdentity(fact.type, keyEnd(fact.fromKey), keyEnd(fact.toKey));
}

/** The alias S3's import gives an asset from a source's row (D68): `<source>:<source ID>`. */
export function sourceAliasOf(source: string, sourceId: string): string {
  return `${source}:${sourceId}`;
}

/** A cell as the import reads it: its text, trimmed; empty for none. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

const KIND_LISTS = [
  ['asset', 'assets'],
  ['risk', 'risks'],
  ['control', 'controls'],
  ['policy', 'policies'],
  ['incident', 'incidents'],
] as const satisfies readonly (readonly [RecordKind, string])[];

const TYPE_ORDER = new Map<string, number>(LINK_TYPES.map((row, i) => [row.type, i]));

function compareFacts(a: Fact, b: Fact): number {
  return (
    (TYPE_ORDER.get(a.type) ?? 0) - (TYPE_ORDER.get(b.type) ?? 0) ||
    (a.fromKey < b.fromKey ? -1 : a.fromKey > b.fromKey ? 1 : 0) ||
    (a.toKey < b.toKey ? -1 : a.toKey > b.toKey ? 1 : 0)
  );
}

/**
 * The expected side of one org of the answer key (its key, for example `ORG-01`). The sources are
 * rendered here when not given; give them to render once for several orgs.
 */
export function expectedOrg(key: AnswerKey, orgKey: string, sources?: RenderedSources): ExpectedOrg {
  const orgIndex = key.orgs.findIndex((o) => o.key === orgKey);
  const org = key.orgs[orgIndex];
  if (org === undefined) throw new Error('the answer key has no org with this key');
  const rendered = sources ?? renderSources(key);
  const orgSources = rendered.orgs.find((o) => o.orgKey === orgKey);
  if (orgSources === undefined) throw new Error('the rendered sources have no org with this key');

  const records = new Map<string, AnswerKeyRecord>();
  const names = new Map<RecordKind, Map<string, string | null>>(RECORD_KINDS.map((kind) => [kind, new Map()]));
  const aliases = new Map<string, string>();
  for (const [kind, list] of KIND_LISTS) {
    const byName = names.get(kind)!;
    for (const record of org[list]) {
      records.set(record.key, { key: record.key, kind, name: record.name });
      aliases.set(answerKeySourceId(record.key), record.key);
      const name = normaliseName(record.name);
      if (name === '') continue;
      byName.set(name, byName.has(name) ? null : record.key);
    }
  }

  // The asset list rows: each row's alias and the asset it is. A typo'd or duplicate row is the
  // asset its plant names; any other row carries the asset's own name, exactly.
  const planted = new Map<string, string>();
  for (const typo of rendered.plants.typos) {
    if (typo.orgKey !== orgKey || typo.where !== 'asset_name') continue;
    if (typo.source === undefined || typo.sourceId === undefined || typo.recordKey === undefined) continue;
    planted.set(sourceAliasOf(typo.source, typo.sourceId), typo.recordKey);
  }
  for (const duplicate of rendered.plants.duplicates) {
    if (duplicate.orgKey !== orgKey) continue;
    planted.set(sourceAliasOf(duplicate.source, duplicate.sourceId), duplicate.recordKey);
  }
  const assetByName = new Map<string, string | null>();
  for (const asset of org.assets) assetByName.set(asset.name, assetByName.has(asset.name) ? null : asset.key);
  for (const file of orgSources.assetLists) {
    const mapping = CMDB_SOURCES.find((s) => s.source === file.source)?.mapping;
    if (mapping === undefined) throw new Error('an asset list comes from a source with no known column mapping');
    for (const row of assetRows(file.format, file.body)) {
      const sourceId = cellText(row[mapping.fields.sourceId]);
      if (sourceId === '') continue;
      const alias = sourceAliasOf(file.source, sourceId);
      const recordKey = planted.get(alias) ?? assetByName.get(cellText(row[mapping.fields.name])) ?? null;
      if (recordKey !== null) aliases.set(alias, recordKey);
    }
  }

  const links = new Set(org.links.map(identityOfFact));

  const stated = new Map<string, Fact>();
  for (const doc of orgSources.documents) {
    for (const mention of doc.mentions) {
      const fact = { type: mention.fact.type, fromKey: mention.fact.fromKey, toKey: mention.fact.toKey };
      const identity = identityOfFact(fact);
      if (!stated.has(identity)) stated.set(identity, fact);
    }
  }
  const statedFacts = [...stated.values()].sort(compareFacts);

  const falsePositives = rendered.plants.falsePositives
    .filter((plant) => plant.orgKey === orgKey)
    .map((plant) => ({ link: { ...plant.notAFact }, fileName: plant.fileName }));
  const injections = rendered.plants.injections
    .filter((plant) => plant.orgKey === orgKey && plant.kind === 'add_links' && plant.proposedLink !== undefined)
    .map((plant) => ({ link: { ...plant.proposedLink! }, fileName: plant.fileName }));

  return { orgKey, orgIndex, records, aliases, names, links, statedFacts, falsePositives, injections };
}
