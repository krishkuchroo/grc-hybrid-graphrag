// The dataset scorer (FT-001; D24, D38, D43, D69, D234, D235): how an org's ingestion did against a
// dataset folder's keys (`facts.json`, `duplicates.json`, `normalisation.json`), from the org as the
// API shows it (records of every status with their source IDs and fields, the links between active
// records, the link findings and the duplicate findings). Pure: no I/O, no clock; the same org and
// folder always give the same score, items in the same order.
//
// Matching: each org record is matched to an answer-key key by the first rule that applies:
//   1. its source ID `answer-key:<key>` (a fast-loaded record);
//   2. an alias `<source>:<sourceId>` of a `duplicates.json` scanner row, which gives the row's
//      `sameAs`;
//   3. its exact name within its kind, after `normaliseName`.
// Only keys of the record's own kind count. A rule that gives two keys (two source IDs, two scanner
// rows, or a name two answer-key records share) leaves the record unmatched, as does no rule at all;
// unmatched active records are counted per kind.
//
// Links, against `facts.json`, each a link of the answer key known by its identity (its type and its
// two ends' keys; an end with no key is its org record, so it never equals a fact):
//   `found`    a live link with that identity, of any origin (`ai`, `import`, `manual`, counted);
//   `waiting`  none live, but a pending link finding with that identity (its decision's records
//              when it has one, else its ends: the matched record, or the name as written, matched
//              by rule 3);
//   `missed`   neither.
// Live links of the ontology types whose identity no fact has are `extra`, counted per type. The
// facts' states are also given per type and per origin (`public`, `derived`, `synthetic`, from
// `provenance.json`'s links, else the fact's own).
//
// Duplicates, against `duplicates.json`'s scanner rows. A row's alias is `<source>:<sourceId>`, its
// source the `import-mappings.json` row of its file. Its record is the one holding the alias (an
// active one first: after a merge, the kept record). That record's own key is its match with this
// alias left out (rules 1 to 3 on what else it holds and its name):
//   `not_imported`  no record holds the alias;
//   `wrong_merge`   the record's own key is another asset's: the row was merged into the wrong one;
//   `merged`        the record is active, its own key is `sameAs`, and no other active record is
//                   `sameAs`'s by rule 1 or 3: the row was merged into the asset it is;
//   `flagged`       otherwise the row has its own record, and a duplicate finding names it with a
//                   record of `sameAs` (counted by the finding's status);
//   `missed`        separate records, and no finding names the pair.
// Normalisation, against `normalisation.json`: the record holding the row's alias (an active one
// first, so after a merge the kept record); `match` when its stored field equals `expected`,
// `differs` when it doesn't, `not_imported` when no record holds the alias.
// An org whose records hold no alias of the folder's asset list sources (a fast-loaded org) has no
// duplicates or normalisation score: both are null, "not applicable".
import {
  LINK_TYPES,
  RECORD_KINDS,
  REVIEW_FINDING_STATUSES,
  normaliseName,
  type LinkType,
  type RecordKind,
  type ReviewFindingStatus,
} from '@grc/shared';
import type { LinkFinding, OrgLink, OrgSnapshot } from '../extraction/snapshot.js';
import type { DuplicateFindingRow, LinkFindingEnd, OrgRecordRow } from '../run/api-client.js';
import { answerKeySourceId } from '../run/resolve.js';
import { DATASET_LINK_ORIGINS, type DatasetFolder, type DatasetLinkOrigin } from './folder.js';

export const FACT_STATES = ['found', 'waiting', 'missed'] as const;
export type FactState = (typeof FACT_STATES)[number];

export const DUPLICATE_STATES = ['merged', 'flagged', 'wrong_merge', 'missed', 'not_imported'] as const;
export type DuplicateState = (typeof DUPLICATE_STATES)[number];

export const NORMALISATION_STATES = ['match', 'differs', 'not_imported'] as const;
export type NormalisationState = (typeof NORMALISATION_STATES)[number];

/** The origins a live link can have, and `unknown` for one that gave none. */
export const LIVE_LINK_ORIGINS = ['ai', 'import', 'manual', 'unknown'] as const;
export type LiveLinkOrigin = (typeof LIVE_LINK_ORIGINS)[number];

const LINK_TYPE_NAMES: readonly LinkType[] = LINK_TYPES.map((row) => row.type);

/** A fast-loaded record's source IDs start with this (`answer-key:<key>`). */
const ANSWER_KEY_PREFIX = answerKeySourceId('');

/** The org as the scorer reads it: the extraction part's snapshot plus the duplicate findings. */
export interface DatasetSnapshot extends OrgSnapshot {
  duplicateFindings: DuplicateFindingRow[];
}

/** A record's match: its key, the rule that gave it, or why it has none. */
export interface RecordMatch {
  key: string | null;
  rule: 1 | 2 | 3 | null;
  /** `two_keys`: the first rule that applied gave two keys; `none`: no rule applied. */
  unmatched: 'two_keys' | 'none' | null;
}

/** An org record in an item: its number, name and status, and the key it matched. */
export interface RecordRef {
  number: string;
  name: string;
  status: string;
  key: string | null;
}

export interface FactItem {
  type: LinkType;
  fromKey: string;
  toKey: string;
  from: string;
  to: string;
  origin: DatasetLinkOrigin;
  state: FactState;
  /** The live links' origins, for a found fact. */
  linkOrigins: LiveLinkOrigin[];
  /** The pending findings' IDs, for a waiting fact. */
  findingIds: string[];
  statedIn: { file: string; sentence: string }[];
}

export interface ExtraLinkItem {
  type: LinkType;
  from: RecordRef;
  to: RecordRef;
  origins: LiveLinkOrigin[];
}

export interface DuplicateItem {
  file: string;
  source: string;
  sourceId: string;
  sameAs: string;
  sameAsName: string;
  state: DuplicateState;
  record: RecordRef | null;
  /** For `flagged`: the finding naming the pair, and its status. */
  findingId: string | null;
  findingStatus: ReviewFindingStatus | null;
}

export interface NormalisationItem {
  file: string;
  source: string;
  sourceId: string;
  field: string;
  expected: string;
  stored: string | number | null;
  state: NormalisationState;
  record: RecordRef | null;
}

export interface UnmatchedItem extends RecordRef {
  kind: RecordKind;
  reason: 'two_keys' | 'none';
}

type Counts<K extends string> = Record<K, number>;

export interface DatasetScore {
  records: {
    /** Every record read, per kind, and the active ones. */
    read: Counts<RecordKind>;
    active: Counts<RecordKind>;
    /** Active records matched to no key, per kind. */
    unmatched: Counts<RecordKind>;
  };
  links: {
    /** Live links between active records, of the ontology's types. */
    live: number;
    facts: number;
    byState: Counts<FactState>;
    byType: Record<LinkType, Counts<FactState>>;
    byOrigin: Record<DatasetLinkOrigin, Counts<FactState>>;
    /** Found facts by the origin of the live links that make them found (a fact with links of two
     * origins counts in both). */
    foundByLinkOrigin: Counts<LiveLinkOrigin>;
    /** Link findings read, per status. */
    findings: Counts<ReviewFindingStatus>;
    extra: number;
    extraByType: Record<LinkType, number>;
  };
  /** Null when the org holds no asset list aliases ("not applicable"). */
  duplicates: {
    rows: number;
    byState: Counts<DuplicateState>;
    flaggedByStatus: Counts<ReviewFindingStatus>;
    /** Duplicate findings read, per status. */
    findings: Counts<ReviewFindingStatus>;
  } | null;
  normalisation: {
    rows: number;
    byState: Counts<NormalisationState>;
    byField: Record<string, Counts<NormalisationState>>;
  } | null;
  items: {
    facts: FactItem[];
    extraLinks: ExtraLinkItem[];
    duplicates: DuplicateItem[];
    normalisation: NormalisationItem[];
    unmatched: UnmatchedItem[];
  };
}

function countsOf<K extends string>(keys: readonly K[]): Counts<K> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Counts<K>;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Active records first, then by number, then by ID. */
function byActiveThenNumber(a: OrgRecordRow, b: OrgRecordRow): number {
  return (
    Number(b.status === 'active') - Number(a.status === 'active') ||
    compareText(a.number, b.number) ||
    compareText(a.id, b.id)
  );
}

function liveOrigin(origin: string): LiveLinkOrigin {
  return (LIVE_LINK_ORIGINS as readonly string[]).includes(origin) ? (origin as LiveLinkOrigin) : 'unknown';
}

/** The ingestion score of an org against a dataset folder (see the top of the file). */
export function scoreDataset(folder: DatasetFolder, org: DatasetSnapshot): DatasetScore {
  const answerOrg = folder.answerOrg;

  // The answer key's records: kind and name by key, and each kind's keys by normalised name.
  const keyRecords = new Map<string, { kind: RecordKind; name: string }>();
  const lists: [RecordKind, readonly { key: string; name: string }[]][] = [
    ['asset', answerOrg.assets],
    ['risk', answerOrg.risks],
    ['control', answerOrg.controls],
    ['policy', answerOrg.policies],
    ['incident', answerOrg.incidents],
  ];
  const names = new Map<RecordKind, Map<string, string | null>>(RECORD_KINDS.map((kind) => [kind, new Map()]));
  for (const [kind, list] of lists) {
    for (const record of list) {
      keyRecords.set(record.key, { kind, name: record.name });
      const name = normaliseName(record.name);
      if (name === '') continue;
      const byName = names.get(kind)!;
      byName.set(name, byName.has(name) ? null : record.key);
    }
  }
  const keyOfName = (kind: RecordKind, name: string): string | null | undefined => {
    const normalised = normaliseName(name);
    return normalised === '' ? undefined : names.get(kind)!.get(normalised);
  };

  // The asset lists' sources by file, and each scanner row's alias with its `sameAs`.
  const sourceOfFile = new Map(folder.assetLists.map((list) => [list.file, list.source]));
  const aliasOf = (file: string, sourceId: string): string => `${sourceOfFile.get(file) ?? ''}:${sourceId}`;
  const scannerKeys = new Map<string, Set<string>>();
  for (const row of folder.duplicates) {
    const alias = aliasOf(row.file, row.sourceId);
    const keys = scannerKeys.get(alias) ?? new Set<string>();
    keys.add(row.sameAs);
    scannerKeys.set(alias, keys);
  }

  const decide = (keys: Set<string>, rule: 1 | 2): RecordMatch => {
    if (keys.size === 1) return { key: [...keys][0]!, rule, unmatched: null };
    return { key: null, rule, unmatched: 'two_keys' };
  };
  /** A record's match by the three rules, leaving out one alias (a scanner row's own). */
  const matchOf = (record: OrgRecordRow, without: string | null = null): RecordMatch => {
    const ofKind = (key: string): boolean => keyRecords.get(key)?.kind === record.kind;
    const rule1 = new Set<string>();
    for (const sourceId of record.sourceIds) {
      if (!sourceId.startsWith(ANSWER_KEY_PREFIX)) continue;
      const key = sourceId.slice(ANSWER_KEY_PREFIX.length);
      if (ofKind(key)) rule1.add(key);
    }
    if (rule1.size > 0) return decide(rule1, 1);
    const rule2 = new Set<string>();
    for (const sourceId of record.sourceIds) {
      if (sourceId === without) continue;
      for (const key of scannerKeys.get(sourceId) ?? []) if (ofKind(key)) rule2.add(key);
    }
    if (rule2.size > 0) return decide(rule2, 2);
    const byName = keyOfName(record.kind, record.name);
    if (byName === undefined) return { key: null, rule: null, unmatched: 'none' };
    if (byName === null) return { key: null, rule: 3, unmatched: 'two_keys' };
    return { key: byName, rule: 3, unmatched: null };
  };

  const recordsById = new Map(org.records.map((r) => [r.id, r]));
  const matches = new Map(org.records.map((r) => [r.id, matchOf(r)]));
  const keyOf = (id: string): string | null => matches.get(id)?.key ?? null;
  const refOf = (record: OrgRecordRow): RecordRef => ({
    number: record.number,
    name: record.name,
    status: record.status,
    key: keyOf(record.id),
  });
  const refOfId = (id: string): RecordRef => {
    const record = recordsById.get(id);
    return record ? refOf(record) : { number: '', name: '', status: '', key: null };
  };

  // Records read, and the unmatched active ones.
  const read = countsOf(RECORD_KINDS);
  const active = countsOf(RECORD_KINDS);
  const unmatched = countsOf(RECORD_KINDS);
  const unmatchedItems: UnmatchedItem[] = [];
  for (const record of [...org.records].sort((a, b) => compareText(a.number, b.number) || compareText(a.id, b.id))) {
    read[record.kind] += 1;
    if (record.status !== 'active') continue;
    active[record.kind] += 1;
    const match = matches.get(record.id)!;
    if (match.key !== null) continue;
    unmatched[record.kind] += 1;
    unmatchedItems.push({ kind: record.kind, ...refOf(record), reason: match.unmatched ?? 'none' });
  }

  // Identities.
  const recordEnd = (id: string): string => {
    const key = keyOf(id);
    return key !== null ? `key:${key}` : `record:${id}`;
  };
  const nameEnd = (kind: RecordKind, name: string): string => {
    const key = keyOfName(kind, name);
    return typeof key === 'string' ? `key:${key}` : `name:${kind}:${normaliseName(name)}`;
  };
  const findingEnd = (end: LinkFindingEnd): string =>
    end.recordId !== null ? recordEnd(end.recordId) : nameEnd(end.kind, end.name);
  const identityOfFinding = (f: LinkFinding): string =>
    f.outcome !== null
      ? `${f.outcome.type}|${recordEnd(f.outcome.fromId)}|${recordEnd(f.outcome.toId)}`
      : `${f.type}|${findingEnd(f.from)}|${findingEnd(f.to)}`;
  const identityOfLink = (link: OrgLink): string => `${link.type}|${recordEnd(link.fromId)}|${recordEnd(link.toId)}`;
  const identityOfFact = (type: string, fromKey: string, toKey: string): string =>
    `${type}|key:${fromKey}|key:${toKey}`;

  const liveByIdentity = new Map<string, OrgLink[]>();
  for (const link of org.links) push(liveByIdentity, identityOfLink(link), link);
  const pendingByIdentity = new Map<string, LinkFinding[]>();
  const findingCounts = countsOf(REVIEW_FINDING_STATUSES);
  for (const f of org.findings) {
    findingCounts[f.status] += 1;
    if (f.status === 'pending') push(pendingByIdentity, identityOfFinding(f), f);
  }

  // Facts.
  const provenanceOrigin = new Map(
    folder.provenanceLinks.map((l) => [identityOfFact(l.type, l.fromKey, l.toKey), l.origin]),
  );
  const byState = countsOf(FACT_STATES);
  const byType = Object.fromEntries(LINK_TYPE_NAMES.map((t) => [t, countsOf(FACT_STATES)])) as Record<
    LinkType,
    Counts<FactState>
  >;
  const byOrigin = Object.fromEntries(DATASET_LINK_ORIGINS.map((o) => [o, countsOf(FACT_STATES)])) as Record<
    DatasetLinkOrigin,
    Counts<FactState>
  >;
  const foundByLinkOrigin = countsOf(LIVE_LINK_ORIGINS);
  const factIdentities = new Set<string>();
  const factItems: FactItem[] = folder.facts.map((fact) => {
    const identity = identityOfFact(fact.type, fact.fromKey, fact.toKey);
    factIdentities.add(identity);
    const live = liveByIdentity.get(identity) ?? [];
    const pending = pendingByIdentity.get(identity) ?? [];
    const state: FactState = live.length > 0 ? 'found' : pending.length > 0 ? 'waiting' : 'missed';
    const linkOrigins = [...new Set(live.map((l) => liveOrigin(l.origin)))].sort(
      (a, b) => LIVE_LINK_ORIGINS.indexOf(a) - LIVE_LINK_ORIGINS.indexOf(b),
    );
    const origin = provenanceOrigin.get(identity) ?? fact.origin;
    byState[state] += 1;
    byType[fact.type][state] += 1;
    byOrigin[origin][state] += 1;
    for (const o of linkOrigins) foundByLinkOrigin[o] += 1;
    return {
      type: fact.type,
      fromKey: fact.fromKey,
      toKey: fact.toKey,
      from: keyRecords.get(fact.fromKey)?.name ?? '',
      to: keyRecords.get(fact.toKey)?.name ?? '',
      origin,
      state,
      linkOrigins,
      findingIds: state === 'waiting' ? pending.map((f) => f.id).sort(compareText) : [],
      statedIn: fact.statedIn.map((s) => ({ file: s.file, sentence: s.sentence })),
    };
  });

  // Extra links: live identities no fact has, each once.
  const extraByType = Object.fromEntries(LINK_TYPE_NAMES.map((t) => [t, 0])) as Record<LinkType, number>;
  const extraItems: ExtraLinkItem[] = [];
  for (const [identity, links] of [...liveByIdentity.entries()].sort(([a], [b]) => compareText(a, b))) {
    if (factIdentities.has(identity)) continue;
    const first = links[0]!;
    extraByType[first.type] += 1;
    extraItems.push({
      type: first.type,
      from: refOfId(first.fromId),
      to: refOfId(first.toId),
      origins: [...new Set(links.map((l) => liveOrigin(l.origin)))].sort(
        (a, b) => LIVE_LINK_ORIGINS.indexOf(a) - LIVE_LINK_ORIGINS.indexOf(b),
      ),
    });
  }
  const extra = extraItems.length;

  // Duplicates and normalisation: only on an org holding the asset lists' aliases.
  const sources = [...new Set(folder.assetLists.map((l) => l.source))];
  const hasAliases = org.records.some((r) => r.sourceIds.some((sid) => sources.some((s) => sid.startsWith(`${s}:`))));
  const holdersOf = new Map<string, OrgRecordRow[]>();
  for (const record of org.records) for (const sid of record.sourceIds) push(holdersOf, sid, record);
  for (const list of holdersOf.values()) list.sort(byActiveThenNumber);

  let duplicates: DatasetScore['duplicates'] = null;
  const duplicateItems: DuplicateItem[] = [];
  if (hasAliases) {
    const dupByState = countsOf(DUPLICATE_STATES);
    const flaggedByStatus = countsOf(REVIEW_FINDING_STATUSES);
    const dupFindings = countsOf(REVIEW_FINDING_STATUSES);
    const findingsByPair = new Map<string, DuplicateFindingRow[]>();
    const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
    for (const f of org.duplicateFindings) {
      dupFindings[f.status] += 1;
      if (f.keptId !== null && f.otherId !== null) push(findingsByPair, pairKey(f.keptId, f.otherId), f);
    }
    for (const row of folder.duplicates) {
      const source = sourceOfFile.get(row.file) ?? '';
      const alias = aliasOf(row.file, row.sourceId);
      const base = {
        file: row.file,
        source,
        sourceId: row.sourceId,
        sameAs: row.sameAs,
        sameAsName: keyRecords.get(row.sameAs)?.name ?? '',
      };
      const record = holdersOf.get(alias)?.[0];
      let state: DuplicateState;
      let finding: DuplicateFindingRow | null = null;
      if (record === undefined) {
        state = 'not_imported';
      } else {
        const own = matchOf(record, alias);
        const otherOfKeyByRule13 = org.records.some((x) => {
          if (x.id === record.id || x.status !== 'active') return false;
          const m = matches.get(x.id)!;
          return m.key === row.sameAs && (m.rule === 1 || m.rule === 3);
        });
        if (own.key !== null && own.key !== row.sameAs) {
          state = 'wrong_merge';
        } else if (record.status === 'active' && own.key === row.sameAs && !otherOfKeyByRule13) {
          state = 'merged';
        } else {
          const partners = org.records.filter((x) => x.id !== record.id && keyOf(x.id) === row.sameAs);
          const named = partners
            .flatMap((x) => findingsByPair.get(pairKey(record.id, x.id)) ?? [])
            .sort(
              (a, b) =>
                REVIEW_FINDING_STATUSES.indexOf(a.status) - REVIEW_FINDING_STATUSES.indexOf(b.status) ||
                compareText(a.id, b.id),
            );
          finding = named[0] ?? null;
          state = finding !== null ? 'flagged' : 'missed';
          if (finding !== null) flaggedByStatus[finding.status] += 1;
        }
      }
      dupByState[state] += 1;
      duplicateItems.push({
        ...base,
        state,
        record: record === undefined ? null : refOf(record),
        findingId: finding?.id ?? null,
        findingStatus: finding?.status ?? null,
      });
    }
    duplicates = { rows: folder.duplicates.length, byState: dupByState, flaggedByStatus, findings: dupFindings };
  }

  let normalisation: DatasetScore['normalisation'] = null;
  const normalisationItems: NormalisationItem[] = [];
  if (hasAliases) {
    const normByState = countsOf(NORMALISATION_STATES);
    const byField: Record<string, Counts<NormalisationState>> = {};
    for (const row of folder.normalisation) {
      const record = holdersOf.get(aliasOf(row.file, row.sourceId))?.[0];
      let stored: string | number | null = null;
      let state: NormalisationState = 'not_imported';
      if (record !== undefined) {
        stored = row.field === 'name' ? record.name : (record.fields?.[row.field] ?? null);
        state = stored !== null && String(stored) === row.expected ? 'match' : 'differs';
      }
      normByState[state] += 1;
      byField[row.field] ??= countsOf(NORMALISATION_STATES);
      byField[row.field]![state] += 1;
      normalisationItems.push({
        file: row.file,
        source: sourceOfFile.get(row.file) ?? '',
        sourceId: row.sourceId,
        field: row.field,
        expected: row.expected,
        stored,
        state,
        record: record === undefined ? null : refOf(record),
      });
    }
    normalisation = { rows: folder.normalisation.length, byState: normByState, byField };
  }

  return {
    records: { read, active, unmatched },
    links: {
      live: org.links.length,
      facts: folder.facts.length,
      byState,
      byType,
      byOrigin,
      foundByLinkOrigin,
      findings: findingCounts,
      extra,
      extraByType,
    },
    duplicates,
    normalisation,
    items: {
      facts: factItems,
      extraLinks: extraItems,
      duplicates: duplicateItems,
      normalisation: normalisationItems,
      unmatched: unmatchedItems,
    },
  };
}
