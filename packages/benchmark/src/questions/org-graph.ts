// One org's records and links from the answer key (D18), indexed so a question's expected records can
// be followed link by link (S8-003). Built from all the org's links, or from only the links one
// document states (its `mentions`), so an injection-trap question can be checked against its document.
// Pure: no I/O.
import type { WorldLink, WorldOrg } from '@grc/generators';
import { normaliseName, type LinkType, type RecordKind } from '@grc/shared';

export interface GraphRecord {
  key: string;
  kind: RecordKind;
  name: string;
  /** The name after S4's `normaliseName`. */
  normalised: string;
}

/** One step along links: of these types, from a record to the far end (`out`) or back (`in`). */
export interface LinkStep {
  types: readonly LinkType[];
  direction: 'out' | 'in';
}

/** Compares two keys by their UTF-16 code units, the same on every machine and locale. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The records of an org, in the answer key's order: assets, risks, controls, policies, incidents. */
export function recordsOf(org: WorldOrg): GraphRecord[] {
  const lists: [RecordKind, readonly { key: string; name: string }[]][] = [
    ['asset', org.assets],
    ['risk', org.risks],
    ['control', org.controls],
    ['policy', org.policies],
    ['incident', org.incidents],
  ];
  return lists.flatMap(([kind, list]) =>
    list.map((r) => ({ key: r.key, kind, name: r.name, normalised: normaliseName(r.name) })),
  );
}

export class OrgGraph {
  private readonly byKey = new Map<string, GraphRecord>();
  private readonly outgoing = new Map<string, string[]>();
  private readonly incoming = new Map<string, string[]>();
  private readonly linkSet = new Set<string>();
  private readonly nameUses = new Map<string, number>();

  constructor(
    readonly records: readonly GraphRecord[],
    links: readonly WorldLink[],
  ) {
    for (const record of records) {
      this.byKey.set(record.key, record);
      this.nameUses.set(record.normalised, (this.nameUses.get(record.normalised) ?? 0) + 1);
    }
    for (const link of links) {
      const id = OrgGraph.linkId(link);
      if (this.linkSet.has(id)) continue;
      this.linkSet.add(id);
      const out = `${link.type}|${link.fromKey}`;
      const inc = `${link.type}|${link.toKey}`;
      this.outgoing.set(out, [...(this.outgoing.get(out) ?? []), link.toKey]);
      this.incoming.set(inc, [...(this.incoming.get(inc) ?? []), link.fromKey]);
    }
  }

  static ofOrg(org: WorldOrg): OrgGraph {
    return new OrgGraph(recordsOf(org), org.links);
  }

  /** The link as one string: `TYPE|fromKey|toKey`. */
  static linkId(link: WorldLink): string {
    return `${link.type}|${link.fromKey}|${link.toKey}`;
  }

  record(key: string): GraphRecord | undefined {
    return this.byKey.get(key);
  }

  ofKind(kind: RecordKind): GraphRecord[] {
    return this.records.filter((r) => r.kind === kind);
  }

  hasLink(link: WorldLink): boolean {
    return this.linkSet.has(OrgGraph.linkId(link));
  }

  /**
   * Whether the record's name tells it apart: not empty after normalising, and no other record of
   * the org has the same normalised name.
   */
  hasOwnName(key: string): boolean {
    const record = this.byKey.get(key);
    return record !== undefined && record.normalised !== '' && this.nameUses.get(record.normalised) === 1;
  }

  /** The records one step away from any of `keys`, each once, in the order first reached. */
  step(keys: readonly string[], step: LinkStep): string[] {
    const index = step.direction === 'out' ? this.outgoing : this.incoming;
    const found: string[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      for (const type of step.types) {
        for (const next of index.get(`${type}|${key}`) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          found.push(next);
        }
      }
    }
    return found;
  }

  /** The records at the end of the steps from `start`, sorted by key. */
  follow(start: string, steps: readonly LinkStep[]): string[] {
    let frontier = [start];
    for (const s of steps) frontier = this.step(frontier, s);
    return frontier.sort(compareKeys);
  }
}
