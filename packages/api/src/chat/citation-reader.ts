// Reading a saved message's citations again, with the reader's access now (S6-006 behaviour 1;
// D23, D45.3, D50, D51, D57, D73): what someone could see when they asked may be hidden from them
// today (a lower clearance, another role, a raised label, a removed document).
// - A record is read through the reader's own role x clearance read-only account
//   (`GraphService.readAs`, stopped after 5 s), in the org's own database, so Neo4j itself hides a
//   type the role can't view and a node above the clearance. Our code checks the role's view cell
//   and the label again, and each query keeps to `sensitivity IN <labels at or below the
//   clearance>`.
// - A passage is read in the reader's own org context, so Postgres row security on `chunks` and
//   `documents` checks the org wall, the role and the label; our code checks them again, and a
//   passage of a removed document is hidden.
// - Anything not found, or found without a usable number, name or label, is "a source you can no
//   longer see". A graph read that fails hides its records too (fail safe), and is logged with its
//   error type only.
// Every node label in the Cypher text comes from the fixed table of kinds; every ID goes in as a
// parameter. The name embedding is never read.
import {
  DOCUMENT_KINDS,
  LABELS,
  SEARCH_NODE_LABELS,
  SEARCH_RECORD_KINDS,
  SEARCH_RECORD_TYPE,
  can,
  isVisible,
  type DocumentKind,
  type SearchRecordKind,
  type SourcePassage,
  type SourceRecord,
  type StoredCitation,
} from '@grc/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { errorKind } from '../common/errors.js';
import { createLogger } from '../common/logger.js';
import type { Db } from '../db/client.js';
import { withOrgContext } from '../db/org-context.js';
import type { GraphService } from '../graph/graph.service.js';
import { documents } from '../intake/intake.schema.js';
import { chunks } from '../processing/processing.schema.js';
import type { Caller } from '../records/records.service.js';

/** Neo4j stops each batch of citation reads after this long (D15, D48). */
export const CITATION_READ_TIMEOUT_MS = 5000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_NUMBER = /^[A-Z]{3}\d{7}$/;

/** What the reader may see of the cited sources now, by record and by chunk. */
export class CitedSourcesNow {
  constructor(
    private readonly records: ReadonlyMap<string, SourceRecord>,
    private readonly passages: ReadonlyMap<string, SourcePassage>,
  ) {}

  /** The record, or undefined when the reader can't see it now. */
  record(kind: SearchRecordKind, id: string): SourceRecord | undefined {
    const found = this.records.get(`${kind}:${id}`);
    return found?.kind === kind ? found : undefined;
  }

  /** The passage, or undefined when the reader can't see it now. */
  passage(chunkId: string, documentId: string): SourcePassage | undefined {
    const found = this.passages.get(chunkId);
    return found?.documentId === documentId ? found : undefined;
  }
}

function isSearchRecordKind(value: unknown): value is SearchRecordKind {
  return typeof value === 'string' && (SEARCH_RECORD_KINDS as readonly string[]).includes(value);
}

function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === 'string' && (DOCUMENT_KINDS as readonly string[]).includes(value);
}

export interface CitationReaderDeps {
  db: Db;
  graph: Pick<GraphService, 'readAs'>;
  log?: Logger;
}

export class CitationReader {
  private readonly db: Db;
  private readonly graph: Pick<GraphService, 'readAs'>;
  private readonly log: Logger;

  constructor(deps: CitationReaderDeps) {
    this.db = deps.db;
    this.graph = deps.graph;
    this.log = deps.log ?? createLogger().child({ context: 'ChatCitationReader' });
  }

  /** Reads every cited source of the citations once, as the reader. */
  async read(reader: Caller, citations: readonly StoredCitation[]): Promise<CitedSourcesNow> {
    const recordIds = new Map<SearchRecordKind, Set<string>>();
    const chunkIds = new Set<string>();
    for (const c of citations) {
      if (c.type === 'record') {
        if (!isSearchRecordKind(c.recordKind) || typeof c.recordId !== 'string' || !UUID.test(c.recordId)) continue;
        let ids = recordIds.get(c.recordKind);
        if (!ids) {
          ids = new Set();
          recordIds.set(c.recordKind, ids);
        }
        ids.add(c.recordId);
      } else if (c.type === 'passage' && typeof c.chunkId === 'string' && UUID.test(c.chunkId)) {
        chunkIds.add(c.chunkId);
      }
    }
    const [records, passages] = await Promise.all([
      this.readRecords(reader, recordIds),
      this.readPassages(reader, chunkIds),
    ]);
    return new CitedSourcesNow(records, passages);
  }

  private async readRecords(
    reader: Caller,
    wanted: ReadonlyMap<SearchRecordKind, Set<string>>,
  ): Promise<Map<string, SourceRecord>> {
    const found = new Map<string, SourceRecord>();
    const visible = LABELS.filter((label) => isVisible(reader.clearance, label));
    // Only the kinds the role views (D50; ownership cells see nothing here, as on Path B).
    const kinds = [...wanted.entries()].filter(([kind]) => can(reader.role, SEARCH_RECORD_TYPE[kind], 'view'));
    if (kinds.length === 0 || visible.length === 0) return found;
    try {
      await this.graph.readAs(
        reader.orgId,
        reader.role,
        reader.clearance,
        async (tx) => {
          for (const [kind, ids] of kinds) {
            const result = await tx.run(
              [
                `MATCH (n:${SEARCH_NODE_LABELS[kind]}) WHERE n.id IN $ids AND n.sensitivity IN $visible`,
                'RETURN n.id AS id, n.number AS number, n.name AS name, n.sensitivity AS label',
              ].join('\n'),
              { ids: [...ids], visible },
            );
            for (const row of result.records) {
              const id: unknown = row.get('id');
              const number: unknown = row.get('number');
              const name: unknown = row.get('name');
              const label: unknown = row.get('label');
              if (typeof id !== 'string' || !ids.has(id)) continue;
              if (typeof number !== 'string' || !RECORD_NUMBER.test(number)) continue;
              if (typeof name !== 'string' || typeof label !== 'string' || !isVisible(reader.clearance, label))
                continue;
              found.set(`${kind}:${id}`, { id, number, name, kind });
            }
          }
        },
        { timeoutMs: CITATION_READ_TIMEOUT_MS },
      );
    } catch (err) {
      this.log.warn({ ...errorKind(err), orgId: reader.orgId }, 'cited records could not be read; shown as hidden');
      found.clear();
    }
    return found;
  }

  private async readPassages(reader: Caller, wanted: ReadonlySet<string>): Promise<Map<string, SourcePassage>> {
    const found = new Map<string, SourcePassage>();
    if (wanted.size === 0) return found;
    const ctx = { orgId: reader.orgId, userId: reader.userId, role: reader.role, clearance: reader.clearance };
    const rows = await withOrgContext(this.db, ctx, (tx) =>
      tx
        .select({
          chunkId: chunks.id,
          documentId: chunks.documentId,
          position: chunks.position,
          text: chunks.text,
          recordType: chunks.recordType,
          label: chunks.label,
          documentName: documents.fileName,
          documentKind: documents.kind,
          documentLabel: documents.label,
          documentStatus: documents.status,
        })
        .from(chunks)
        .innerJoin(documents, and(eq(documents.orgId, chunks.orgId), eq(documents.id, chunks.documentId)))
        .where(and(eq(chunks.orgId, reader.orgId), inArray(chunks.id, [...wanted]))),
    );
    for (const row of rows) {
      if (row.documentStatus === 'removed') continue;
      if (!can(reader.role, row.recordType, 'view')) continue;
      if (!isVisible(reader.clearance, row.label) || !isVisible(reader.clearance, row.documentLabel)) continue;
      if (!isDocumentKind(row.documentKind)) continue;
      found.set(row.chunkId, {
        chunkId: row.chunkId,
        documentId: row.documentId,
        documentName: row.documentName,
        documentKind: row.documentKind,
        position: row.position,
        text: row.text,
      });
    }
    return found;
  }
}
