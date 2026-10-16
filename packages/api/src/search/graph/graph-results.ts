// What Path B's rows become (S6-004, behaviours 5 and 6; D23, D45.3, D51, SF-049): records, links and
// plain values, each checked again against the asker's own access.
// - Every node in the rows, inside paths, lists and maps too, becomes a record: its ID, number,
//   name, kind, label, status and its kind's key fields only (./graph-description.ts). Never its
//   `nameEmbedding`, `sourceIds`, owner or audit fields. Records are listed in the order they first
//   appear in the rows (columns left to right, a path from its start).
// - Checked again: a node of a kind the role doesn't view (D50, with ownership), with a label above
//   the clearance (D51), of no known kind, or not well formed (no UUID ID, record number, name,
//   label or status) is dropped, with its links.
// - Every relationship becomes a link: its type, the record IDs of its two ends and its origin. It
//   is kept only if both ends are among the kept records, and only once. An AI link's source (its
//   document, chunk and sentence) is kept only when the asker's clearance is at or above the link's
//   `sourceLabel`; a missing or unknown `sourceLabel` hides it (fail safe, SF-049).
// - Any other value the query returned (a count, a name, a date) is kept under its column's name,
//   or `column.key` inside a map; lists of them as lists. Dates and times become text, and texts
//   and lists are cut at a fixed length so one row can't flood the context. Bytes, vectors and
//   unknown values are left out, and so are nulls.
// Pure: no I/O.
import neo4j, { type Node, type Path, type Relationship } from 'neo4j-driver';
import {
  RECORD_ORIGINS,
  RECORD_STATUSES,
  SEARCH_RECORD_TYPE,
  isLabel,
  isRecordVisible,
  isSearchLinkType,
  isVisible,
  searchKindOfLabel,
  searchRecordNumberSchema,
  type KeyFieldValue,
  type Label,
  type RecordOrigin,
  type RecordStatus,
  type Role,
} from '@grc/shared';
import { z } from 'zod';
import type { GraphLink, GraphPlainValue, GraphRecord, GraphValueRow } from '../retrieval.js';
import { GRAPH_KIND_FIELDS } from './graph-description.js';

/** One row as read: its column names and values, in order. */
export interface GraphRow {
  keys: readonly string[];
  values: readonly unknown[];
}

/** Who the results are checked against. */
export interface GraphResultViewer {
  userId: string;
  role: Role;
  clearance: Label;
}

export interface GraphRowsRead {
  records: GraphRecord[];
  links: GraphLink[];
  values: GraphValueRow[];
  /** Nodes left out by the checks, and links left out for a dropped or missing end. */
  droppedRecords: number;
  droppedLinks: number;
}

/** The longest text kept as a plain value, in characters. */
export const PLAIN_TEXT_MAX = 1_000;
/** The most items kept of a plain list. */
export const PLAIN_LIST_MAX = 100;

const uuid = z.uuid();

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && uuid.safeParse(v).success;
}

function isStatus(v: unknown): v is RecordStatus {
  return typeof v === 'string' && (RECORD_STATUSES as readonly string[]).includes(v);
}

function isOrigin(v: unknown): v is RecordOrigin {
  return typeof v === 'string' && (RECORD_ORIGINS as readonly string[]).includes(v);
}

function isTemporalOrSpatial(v: unknown): boolean {
  return (
    neo4j.isDate(v) ||
    neo4j.isDateTime(v) ||
    neo4j.isLocalDateTime(v) ||
    neo4j.isLocalTime(v) ||
    neo4j.isTime(v) ||
    neo4j.isDuration(v) ||
    neo4j.isPoint(v)
  );
}

/** A stored value as a plain scalar, or undefined when it isn't one (lists, maps, bytes, vectors). */
function scalar(v: unknown): KeyFieldValue | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > PLAIN_TEXT_MAX ? v.slice(0, PLAIN_TEXT_MAX) : v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (neo4j.isInt(v)) return neo4j.integer.inSafeRange(v) ? neo4j.integer.toNumber(v) : neo4j.integer.toString(v);
  if (isTemporalOrSpatial(v)) return String(v);
  return undefined;
}

function isPlainMap(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/** One column's plain values while a row is read. */
interface PlainColumn {
  list: boolean;
  items: KeyFieldValue[];
  /** The nodes, links and paths its list held. */
  graphItems: number;
}

class RowReader {
  private readonly viewer: GraphResultViewer;
  /** Each node seen, by element ID: its record, or null when it was dropped. */
  private readonly nodes = new Map<string, GraphRecord | null>();
  private readonly records: GraphRecord[] = [];
  private readonly relationships = new Map<string, Relationship>();
  private droppedRecords = 0;

  constructor(viewer: GraphResultViewer) {
    this.viewer = viewer;
  }

  read(rows: readonly GraphRow[]): GraphRowsRead {
    const values: GraphValueRow[] = [];
    for (const row of rows) {
      const columns = new Map<string, PlainColumn>();
      row.keys.forEach((key, i) => this.take(row.values[i], key, columns, false));
      const plain: Record<string, GraphPlainValue> = {};
      for (const [name, column] of columns) {
        if (column.list) {
          // A list of nodes, links or paths only is not a plain value; an empty list is.
          if (column.items.length > 0 || column.graphItems === 0) plain[name] = column.items;
        } else if (column.items[0] !== undefined) {
          plain[name] = column.items[0];
        }
      }
      if (Object.keys(plain).length > 0) values.push(plain);
    }
    const { links, dropped } = this.links();
    return { records: this.records, links, values, droppedRecords: this.droppedRecords, droppedLinks: dropped };
  }

  /** Takes the nodes, links and paths in `v`, and its plain values under `name` (in a list or not). */
  private take(v: unknown, name: string, columns: Map<string, PlainColumn>, inList: boolean): void {
    const column = (): PlainColumn => {
      let c = columns.get(name);
      if (!c) {
        c = { list: inList, items: [], graphItems: 0 };
        columns.set(name, c);
      }
      return c;
    };
    if (Array.isArray(v)) {
      column().list = true;
      for (const item of v) this.take(item, name, columns, true);
      return;
    }
    if (this.graphValue(v)) {
      if (inList) column().graphItems += 1;
      return;
    }
    if (isPlainMap(v)) {
      for (const [key, value] of Object.entries(v)) this.take(value, `${name}.${key}`, columns, inList);
      return;
    }
    const s = scalar(v);
    if (s === undefined || s === null) return;
    const c = column();
    if (c.list) {
      if (c.items.length < PLAIN_LIST_MAX) c.items.push(s);
    } else {
      c.items = [s];
    }
  }

  /** Takes a node, link or path; false for anything else. */
  private graphValue(v: unknown): boolean {
    if (neo4j.isNode(v)) {
      this.node(v);
      return true;
    }
    if (neo4j.isRelationship(v)) {
      this.relationship(v);
      return true;
    }
    if (neo4j.isPath(v)) {
      const path = v as Path;
      this.node(path.start);
      for (const segment of path.segments) {
        this.relationship(segment.relationship);
        this.node(segment.end);
      }
      return true;
    }
    // A relationship without its ends (inside a path's own parts only) or an unsupported type.
    return neo4j.isUnboundRelationship(v) || neo4j.isPathSegment(v) || neo4j.isVector(v) || neo4j.isUnsupportedType(v);
  }

  private node(node: Node): void {
    if (this.nodes.has(node.elementId)) return;
    const record = this.toRecord(node);
    this.nodes.set(node.elementId, record);
    if (record) this.records.push(record);
    else this.droppedRecords += 1;
  }

  private relationship(rel: Relationship): void {
    if (!this.relationships.has(rel.elementId)) this.relationships.set(rel.elementId, rel);
  }

  /** The record a node becomes, or null when it is dropped (the checks of behaviour 6). */
  private toRecord(node: Node): GraphRecord | null {
    const kind = node.labels.map(searchKindOfLabel).find((k) => k !== null) ?? null;
    if (kind === null) return null;
    const p = node.properties as Record<string, unknown>;
    const { id, number, name, sensitivity: label, status, owner } = p;
    if (!isUuid(id) || !searchRecordNumberSchema.safeParse(number).success || typeof name !== 'string') return null;
    if (!isLabel(label) || !isStatus(status)) return null;
    const isOwner = typeof owner === 'string' && owner !== '' && owner === this.viewer.userId;
    const visible = isRecordVisible(
      { role: this.viewer.role, clearance: this.viewer.clearance },
      { recordType: SEARCH_RECORD_TYPE[kind], label, isOwner },
    );
    if (!visible) return null;
    const keyFields: Record<string, KeyFieldValue> = {};
    for (const field of GRAPH_KIND_FIELDS[kind]) {
      const value = scalar(p[field.name]);
      if (value !== undefined && value !== null) keyFields[field.name] = value;
    }
    return { id, number: number as string, name, kind, label, status, keyFields };
  }

  /** The links whose two ends are both kept records, each once, in the order first seen. */
  private links(): { links: GraphLink[]; dropped: number } {
    const links: GraphLink[] = [];
    const seen = new Set<string>();
    let dropped = 0;
    for (const rel of this.relationships.values()) {
      const from = this.nodes.get(rel.startNodeElementId);
      const to = this.nodes.get(rel.endNodeElementId);
      const p = rel.properties as Record<string, unknown>;
      const origin = p['origin'];
      if (!from || !to || !isSearchLinkType(rel.type) || !isOrigin(origin)) {
        dropped += 1;
        continue;
      }
      const key = `${rel.type}:${from.id}:${to.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ type: rel.type, from: from.id, to: to.id, origin, source: this.source(origin, p) });
    }
    return { links, dropped };
  }

  /** An AI link's source, only for an asker cleared for its source label (SF-049). */
  private source(origin: RecordOrigin, p: Record<string, unknown>): GraphLink['source'] {
    if (origin !== 'ai') return null;
    const { sourceLabel, sourceDocId, chunkId, sentence } = p;
    if (!isLabel(sourceLabel) || !isVisible(this.viewer.clearance, sourceLabel)) return null;
    if (!isUuid(sourceDocId) || !isUuid(chunkId) || typeof sentence !== 'string' || sentence === '') return null;
    return { documentId: sourceDocId, chunkId, sentence };
  }
}

/** Reads the rows into records, links and plain values, checked against `viewer` (see the file comment). */
export function readGraphRows(rows: readonly GraphRow[], viewer: GraphResultViewer): GraphRowsRead {
  return new RowReader(viewer).read(rows);
}
