// The review queue's graph reads (S5-002; D15, D45.3, D51, D57, D73; S5 shared notes, "Who"): the
// records a page of findings names, read in one batch per page, in the reader's own view.
// - Every read runs through `GraphService.readAs` as the reader's role x clearance read-only
//   account, with a time limit, in the org's own database, so Neo4j itself hides every record type
//   the role can't view and every node above the clearance (and every link with a hidden end, which
//   keeps a record's link count to the links the reader may see). Each query also keeps to
//   `sensitivity IN <labels at or below the clearance>`, and our code checks the label again.
// - A record is found active or retired. One the read doesn't find, or that is found without a
//   usable number, name, label or status, is not in the answer, so the caller shows it as hidden.
// - Every node label in the Cypher text comes from the fixed table below; every ID goes in as a
//   parameter. The name embedding is never read.
import {
  LABELS,
  NODE_LABELS,
  RECORD_STATUSES,
  isLabel,
  isVisible,
  type Label,
  type RecordStatus,
  type ReviewRecordKind,
  type Role,
  type ShownRecord,
} from '@grc/shared';
import type { ManagedTransaction } from 'neo4j-driver';
import type { GraphService } from '../../graph/graph.service.js';

/** Neo4j stops each batch of the queue's graph reads after this long (D15, D48). */
export const QUEUE_READ_TIMEOUT_MS = 5000;

/** The node label of each kind of record a finding can name. */
const KIND_NODE_LABELS: Readonly<Record<ReviewRecordKind, string>> = Object.freeze({
  ...NODE_LABELS,
  requirement: 'Requirement',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_NUMBER = /^[A-Z]{3}\d{7}$/;

/** Whose view the reads are made in. */
export interface QueueViewer {
  orgId: string;
  role: Role;
  clearance: Label;
}

/** A record as the reader's own read finds it. */
export interface GraphRecord {
  id: string;
  number: string;
  name: string;
  kind: ReviewRecordKind;
  label: Label;
  status: RecordStatus;
  owner: string | null;
  sourceIds: string[];
  /** A control's code, or a requirement's. */
  code: string | null;
  /** A control's framework as written on it, or a requirement's framework key. */
  framework: string | null;
  /** A requirement's title. */
  title: string | null;
  /** The links the reader may see on it, when asked for. */
  linkCount: number | null;
}

/** The records a page names, by kind and ID. */
export class RecordWants {
  private readonly byKind = new Map<ReviewRecordKind, Set<string>>();

  add(kind: ReviewRecordKind, id: string | null | undefined): void {
    if (typeof id !== 'string' || !UUID.test(id)) return;
    let ids = this.byKind.get(kind);
    if (!ids) {
      ids = new Set();
      this.byKind.set(kind, ids);
    }
    ids.add(id);
  }

  get size(): number {
    let n = 0;
    for (const ids of this.byKind.values()) n += ids.size;
    return n;
  }

  entries(): Array<[ReviewRecordKind, string[]]> {
    return [...this.byKind.entries()].map(([kind, ids]) => [kind, [...ids]]);
  }
}

/** The records the reader's read found, by kind and ID. Anything not here is hidden. */
export class RecordLookup {
  private readonly records = new Map<string, GraphRecord>();

  set(record: GraphRecord): void {
    this.records.set(`${record.kind}:${record.id}`, record);
  }

  get(kind: ReviewRecordKind, id: string): GraphRecord | undefined {
    return this.records.get(`${kind}:${id}`);
  }

  /** The record by ID, number, name and kind, or undefined when the reader may not see it. */
  shown(kind: ReviewRecordKind, id: string): ShownRecord | undefined {
    const r = this.get(kind, id);
    return r ? { recordId: r.id, number: r.number, name: r.name, kind: r.kind } : undefined;
  }

  /** Every record found. */
  all(): GraphRecord[] {
    return [...this.records.values()];
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function isRecordStatus(value: unknown): value is RecordStatus {
  return typeof value === 'string' && (RECORD_STATUSES as readonly string[]).includes(value);
}

// One kind's records by ID, at or below the clearance.
function query(kind: ReviewRecordKind, withLinkCount: boolean): string {
  const label = KIND_NODE_LABELS[kind];
  return [
    `MATCH (n:${label}) WHERE n.id IN $ids AND n.sensitivity IN $visible`,
    'RETURN n.id AS id, n.number AS number, n.name AS name, n.sensitivity AS label, n.status AS status,',
    '  n.owner AS owner, n.sourceIds AS sourceIds, n.code AS code, n.framework AS framework, n.title AS title',
    withLinkCount ? '  , COUNT { (n)--() } AS linkCount' : '',
  ].join('\n');
}

// A row the read returned, as a record, or null when it can't be shown as one.
function toRecord(
  kind: ReviewRecordKind,
  get: (key: string) => unknown,
  clearance: Label,
  withLinkCount: boolean,
): GraphRecord | null {
  const id = get('id');
  const number = get('number');
  const name = get('name');
  const label = get('label');
  const status = get('status');
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  if (typeof number !== 'string' || !RECORD_NUMBER.test(number)) return null;
  if (typeof name !== 'string') return null;
  if (!isLabel(label) || !isVisible(clearance, label)) return null;
  if (!isRecordStatus(status)) return null;
  const links = withLinkCount ? get('linkCount') : null;
  return {
    id,
    number,
    name,
    kind,
    label,
    status,
    owner: text(get('owner')),
    sourceIds: texts(get('sourceIds')),
    code: text(get('code')),
    framework: text(get('framework')),
    title: text(get('title')),
    linkCount: typeof links === 'number' && Number.isInteger(links) && links >= 0 ? links : null,
  };
}

/**
 * Reads the wanted records in one read transaction, as the reader's own read-only account. With
 * `withLinkCount`, each record also carries the number of links the reader may see on it.
 */
export async function readNamedRecords(
  graph: Pick<GraphService, 'readAs'>,
  viewer: QueueViewer,
  wants: RecordWants,
  options: { withLinkCount?: boolean } = {},
): Promise<RecordLookup> {
  const lookup = new RecordLookup();
  if (wants.size === 0) return lookup;
  const withLinkCount = options.withLinkCount === true;
  const visible = LABELS.filter((l) => isVisible(viewer.clearance, l));
  const groups = wants.entries();
  const work = async (tx: ManagedTransaction): Promise<void> => {
    for (const [kind, ids] of groups) {
      const result = await tx.run(query(kind, withLinkCount), { ids, visible });
      for (const row of result.records) {
        const record = toRecord(kind, (key) => row.get(key) as unknown, viewer.clearance, withLinkCount);
        if (record) lookup.set(record);
      }
    }
  };
  await graph.readAs(viewer.orgId, viewer.role, viewer.clearance, work, { timeoutMs: QUEUE_READ_TIMEOUT_MS });
  return lookup;
}

/** Whether the reader's own read finds a record of any kind a finding can name with this ID. */
export async function isRecordVisible(
  graph: Pick<GraphService, 'readAs'>,
  viewer: QueueViewer,
  recordId: string,
): Promise<boolean> {
  const wants = new RecordWants();
  for (const kind of Object.keys(KIND_NODE_LABELS) as ReviewRecordKind[]) wants.add(kind, recordId);
  const lookup = await readNamedRecords(graph, viewer, wants);
  return lookup.all().length > 0;
}
