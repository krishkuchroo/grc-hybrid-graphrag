// The org as the run's API key sees it, for the extraction part (S8-006; D24, D38, D45.3, D50, D51,
// D57, D69): read-only, through the public API only, so nothing in the org changes.
// - Every record of the five kinds, retired ones too (`status=all`): an earlier decision may name a
//   record that has been retired since (a merge), and it still says which answer-key record it was.
// - The links of every active record whose other end is an active record of the five kinds, of the
//   ontology's types, each once (each link is listed from both of its ends).
// - Every link finding of every status, and for the approved and removed ones what the decision
//   wrote (its outcome: the two records the link was settled between).
// The run's key is an Admin at Restricted (D230): it sees every record, label and finding of the org.
// Progress lines hold counts only.
import { LINK_TYPES, RECORD_KINDS, type LinkType, type RecordKind } from '@grc/shared';
import type {
  BenchApi,
  CallOptions,
  LinkFindingOutcome,
  LinkFindingRow,
  OrgRecordRow,
  RecordLinkRow,
} from '../run/api-client.js';
import type { DocumentCountApi } from '../run/wait.js';

/** What the extraction run reads and writes through the API (`BenchApiClient` has all of it). */
export interface ExtractionApi extends DocumentCountApi, Pick<BenchApi, 'startRun' | 'addResults' | 'finishRun'> {
  recordRows(kind: RecordKind, options?: CallOptions): Promise<OrgRecordRow[]>;
  recordLinks(kind: RecordKind, id: string, options?: CallOptions): Promise<RecordLinkRow[]>;
  linkFindings(options?: CallOptions): Promise<LinkFindingRow[]>;
  linkFindingOutcome(id: string, options?: CallOptions): Promise<LinkFindingOutcome | null>;
}

/** A link between two active records, as the graph holds it. */
export interface OrgLink {
  type: LinkType;
  fromId: string;
  toId: string;
  /** `ai` for the extraction's links (found by Gemma or approved by the Analyst); `import` or
   * `manual` for the others. */
  origin: string;
}

/** A link finding with its decision's outcome (approved and removed findings), else null. */
export interface LinkFinding extends LinkFindingRow {
  outcome: LinkFindingOutcome | null;
}

export interface OrgSnapshot {
  records: OrgRecordRow[];
  links: OrgLink[];
  findings: LinkFinding[];
}

const ONTOLOGY_TYPES: ReadonlySet<string> = new Set(LINK_TYPES.map((row) => row.type));

/** How often the links' progress is printed, in records. */
const PROGRESS_EVERY = 100;

function compareRecords(a: OrgRecordRow, b: OrgRecordRow): number {
  return (
    RECORD_KINDS.indexOf(a.kind) - RECORD_KINDS.indexOf(b.kind) ||
    (a.number < b.number ? -1 : a.number > b.number ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Reads the org's records, links and link findings. */
export async function readOrgSnapshot(
  api: ExtractionApi,
  log: (line: string) => void = () => undefined,
): Promise<OrgSnapshot> {
  const records: OrgRecordRow[] = [];
  for (const kind of RECORD_KINDS) records.push(...(await api.recordRows(kind)));
  records.sort(compareRecords);
  const active = records.filter((r) => r.status === 'active');
  log(`  records read: ${records.length} (${active.length} active)`);

  const links = new Map<string, OrgLink>();
  for (const [i, record] of active.entries()) {
    for (const row of await api.recordLinks(record.kind, record.id)) {
      if (!ONTOLOGY_TYPES.has(row.type) || row.other.status !== 'active') continue;
      const fromId = row.direction === 'out' ? record.id : row.other.id;
      const toId = row.direction === 'out' ? row.other.id : record.id;
      const identity = `${row.type}|${fromId}|${toId}`;
      if (!links.has(identity)) links.set(identity, { type: row.type as LinkType, fromId, toId, origin: row.origin });
    }
    if ((i + 1) % PROGRESS_EVERY === 0 && i + 1 < active.length) {
      log(`  links read for ${i + 1} of ${active.length} active records`);
    }
  }
  const sortedLinks = [...links.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, link]) => link);
  log(`  links read: ${sortedLinks.length} between active records`);

  const findings: LinkFinding[] = [];
  const seen = new Set<string>();
  for (const row of await api.linkFindings()) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const decided = row.status === 'approved' || row.status === 'removed';
    findings.push({ ...row, outcome: decided ? await api.linkFindingOutcome(row.id) : null });
  }
  findings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  log(`  link findings read: ${findings.length}`);

  return { records, links: sortedLinks, findings };
}
