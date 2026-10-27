// The pending link findings that match a chat question (D260, Q-ASK-1 and Q-ASK-5): the "Not
// reviewed yet" list Ask shows beside its answer. Built by our code from `review_findings`, never by
// the model (CLAUDE.md principle 6, D52), and never put in the model's context (SF-049). Ask never
// changes a finding.
// - Who: only a role that can open the review queue (`canViewReviewQueue`: Admin and Analyst, D50).
//   Any other role gets `null` and nothing is read.
// - Candidates: the queue's own visibility (the reader's org and the labels at or below their
//   clearance, with row security on top, D51, D73), kind `link`, status `pending`, newest first, at
//   most 5,000. When the graph query names link types (`:TYPE` of the 7 extraction types;
//   `HOSTS|RUNS` names both), only those types.
// - A candidate matches when either end (a) is matched to a record the search found (its results
//   and sources); or (b) has a normalised name that contains, or is contained in, a found record's
//   normalised name, as whole words; or (c) has a normalised name that appears in the normalised
//   question, as whole words. Normalising: lower case, a trailing `(…)` removed, every run of
//   characters that aren't letters or digits one space, trimmed; each end is also tried without a
//   trailing kind word (`asset`, `risk`, `control`, `policy`, `incident`). A form under 4 characters,
//   or one that is only a kind word, matches nothing.
// - Dropped: a finding with an end of a kind the role can't view, or an end the queue shows as
//   hidden (`endSummary`: its matched record isn't found by the reader's own graph read, or its
//   proposed record's finding isn't visible). A link shows only when both its ends do (D50).
// - The answer: the first 50 matches in the queue's order, the number of matches in all, and the one
//   document every match comes from when the reader may read it. Each item's ends are as the
//   queue's list shows them; its sentence and document only as the queue's detail would show them
//   (a chunk and a document the reader may read), with the chunks read in one batch.
// - `pendingLinksByIds` reads the IDs saved with a message again under the same rules, at any status,
//   dropping any the reader can't see now; the total stays as saved.
// Logs (D163): IDs, counts and codes only; never a name, a sentence or the question.
import {
  EXTRACTION_LINK_TYPES,
  SEARCH_LIMITS,
  can,
  canViewReviewQueue,
  isVisible,
  linkProposalSchema,
  type AnswerSource,
  type ChatPendingLink,
  type ChatPendingLinks,
  type Label,
  type LinkProposal,
  type LinkType,
  type ReviewFindingStatus,
  type SearchResult,
} from '@grc/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type Tx } from '../../db/org-context.js';
import type { GraphService } from '../../graph/graph.service.js';
import { chunks, reviewFindings } from '../../processing/processing.schema.js';
import type { Caller } from '../../records/records.service.js';
import { RecordLookup, RecordWants, readNamedRecords } from './queue-graph.js';
import {
  contextOf,
  endSummary,
  findingVisibility,
  readVisibleDocuments,
  viewerOf,
  visibleLabels,
  type DocumentInfo,
  type PageFacts,
} from './queue.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a message saves of its list (`chat_messages.pending_links`): IDs and counts only, never a
 * name or a sentence. */
export const storedPendingLinksSchema = z.strictObject({
  findingIds: z.array(z.uuid()).max(SEARCH_LIMITS.pendingLinks),
  total: z.int().min(0),
  documentId: z.uuid().nullable(),
});
export type StoredPendingLinks = z.infer<typeof storedPendingLinksSchema>;

/** What a list saves with its message. */
export function storedPendingLinks(list: ChatPendingLinks): StoredPendingLinks {
  return {
    findingIds: list.items.map((item) => item.findingId),
    total: list.total,
    documentId: list.documentId,
  };
}

/** What of a search the matching reads: the records it found and the graph query. */
export interface PendingLinkSearch {
  results: readonly SearchResult[];
  sources: readonly AnswerSource[];
  graph: { query: string | null };
}

// ---- Matching (pure) -----------------------------------------------------------------------------

/** The kind words an end's name may end with ("Separation of Duties control"). */
const KIND_WORDS: readonly string[] = ['asset', 'risk', 'control', 'policy', 'incident'];

/** The shortest form that can match. */
const MIN_FORM_LENGTH = 4;

/** A name normalised for matching: lower case, a trailing `(…)` removed, every run of characters
 * that aren't letters or digits one space, trimmed. */
export function normaliseName(name: string): string {
  let text = typeof name === 'string' ? name.toLowerCase() : '';
  for (;;) {
    const cut = text.replace(/\s*\([^()]*\)\s*$/u, '');
    if (cut === text) break;
    text = cut;
  }
  return text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Whether a form can match: at least 4 characters, and not only a kind word. */
function usableForm(form: string): boolean {
  return form.length >= MIN_FORM_LENGTH && !KIND_WORDS.includes(form);
}

/** An end's forms: its normalised name, and that without a trailing kind word; only usable ones. */
export function endNameForms(name: string): string[] {
  const full = normaliseName(name);
  const forms = [full];
  const words = full.split(' ');
  const last = words[words.length - 1];
  if (words.length > 1 && last !== undefined && KIND_WORDS.includes(last)) forms.push(words.slice(0, -1).join(' '));
  return [...new Set(forms)].filter(usableForm);
}

/** Whether `needle` appears in `hay` as whole words (both normalised). */
function hasWords(hay: string, needle: string): boolean {
  return ` ${hay} `.includes(` ${needle} `);
}

/** The extraction link types a graph query names (`:TYPE`, `|TYPE`); `HOSTS|RUNS` names both. */
export function linkTypesOfQuery(query: string | null | undefined): Set<LinkType> {
  const found = new Set<LinkType>();
  if (typeof query !== 'string') return found;
  const known = EXTRACTION_LINK_TYPES as readonly string[];
  for (const m of query.matchAll(/[:|]\s*`?([A-Z][A-Z_]*)`?/g)) {
    const type = m[1];
    if (type !== undefined && known.includes(type)) found.add(type as LinkType);
  }
  return found;
}

/** What a candidate is matched against: the search's records and the question. */
export interface MatchTarget {
  recordIds: ReadonlySet<string>;
  /** The found records' normalised names, usable ones only. */
  recordNames: readonly string[];
  /** The normalised question. */
  question: string;
}

export function matchTargetOf(question: string, search: PendingLinkSearch | null): MatchTarget {
  const recordIds = new Set<string>();
  const names = new Set<string>();
  const add = (id: string, name: string): void => {
    recordIds.add(id);
    const form = normaliseName(name);
    if (usableForm(form)) names.add(form);
  };
  for (const result of search?.results ?? []) {
    if (result.type === 'record') add(result.record.id, result.record.name);
  }
  for (const source of search?.sources ?? []) {
    if (source.type === 'record') add(source.record.id, source.record.name);
  }
  return { recordIds, recordNames: [...names], question: normaliseName(question) };
}

/** Whether one end matches: (a) its record was found, (b) its name meets a found record's name, or
 * (c) its name is in the question. */
function endMatches(end: LinkProposal['from'], target: MatchTarget): boolean {
  if (end.match !== null && target.recordIds.has(end.match.recordId)) return true;
  const forms = endNameForms(end.name);
  for (const form of forms) {
    if (target.recordNames.some((name) => hasWords(name, form) || hasWords(form, name))) return true;
    if (hasWords(target.question, form)) return true;
  }
  return false;
}

/** Whether a proposed link matches the question (either end). */
export function proposalMatches(proposal: LinkProposal, target: MatchTarget): boolean {
  return endMatches(proposal.from, target) || endMatches(proposal.to, target);
}

// ---- Reading -----------------------------------------------------------------------------------

/** A link finding row, with its proposal read in the link shape. */
interface LinkFinding {
  id: string;
  status: ReviewFindingStatus;
  proposal: LinkProposal;
  documentId: string | null;
  chunkId: string | null;
  sentence: string | null;
}

type FindingRow = {
  id: string;
  status: ReviewFindingStatus;
  proposal: unknown;
  documentId: string | null;
  chunkId: string | null;
  sentence: string | null;
};

const FINDING_COLUMNS = {
  id: reviewFindings.id,
  status: reviewFindings.status,
  proposal: reviewFindings.proposal,
  documentId: reviewFindings.documentId,
  chunkId: reviewFindings.chunkId,
  sentence: reviewFindings.sentence,
};

/** A finding shown with both ends, before its sentence and document are added. */
interface ShownFinding {
  finding: LinkFinding;
  from: ChatPendingLink['from'];
  to: ChatPendingLink['to'];
}

export interface PendingLinksDeps {
  db: Db;
  graph: Pick<GraphService, 'readAs'>;
  log?: Logger;
}

export class PendingLinks {
  private readonly db: Db;
  private readonly graph: Pick<GraphService, 'readAs'>;
  private readonly log: Logger;

  constructor(deps: PendingLinksDeps) {
    this.db = deps.db;
    this.graph = deps.graph;
    this.log = deps.log ?? createLogger().child({ context: 'PendingLinks' });
  }

  /** The pending link findings that match the question, for a role that can open the queue; null
   * for any other role. `search` is the answer's search (null when it never ran). */
  async pendingLinksFor(
    caller: Caller,
    question: string,
    search: PendingLinkSearch | null,
  ): Promise<ChatPendingLinks | null> {
    if (!canViewReviewQueue(caller.role)) return null;
    const labels = visibleLabels(caller);
    if (labels.length === 0) return { items: [], total: 0, documentId: null };
    const types = [...linkTypesOfQuery(search?.graph.query)];
    const target = matchTargetOf(question, search);
    const cap = SEARCH_LIMITS.pendingLinkCandidates;

    const read = await withOrgContext(this.db, contextOf(caller), async (tx) => {
      const rows = await tx
        .select(FINDING_COLUMNS)
        .from(reviewFindings)
        .where(
          and(
            findingVisibility(caller, labels),
            eq(reviewFindings.kind, 'link'),
            eq(reviewFindings.status, 'pending'),
            types.length > 0 ? inArray(sql`${reviewFindings.proposal} ->> 'type'`, types) : undefined,
          ),
        )
        .orderBy(desc(reviewFindings.createdAt), desc(reviewFindings.id))
        .limit(cap);
      const candidates = this.parseRows(caller, rows);
      const matched = candidates.filter(
        (f) => this.kindsViewable(caller, f.proposal) && proposalMatches(f.proposal, target),
      );
      const facts = await this.factsOf(tx, caller, labels, matched);
      return { rows: rows.length, matched, facts };
    });
    if (read.rows >= cap) {
      this.log.warn(
        { orgId: caller.orgId, candidates: read.rows, code: 'pending_link_cap' },
        'pending links: cap reached',
      );
    }

    const shown = await this.shownEnds(caller, read.matched, read.facts);
    const listed = shown.slice(0, SEARCH_LIMITS.pendingLinks);
    const items = await this.itemsOf(caller, labels, listed, read.facts.documents);
    const documentId = oneDocument(shown, read.facts.documents);
    this.log.info(
      {
        orgId: caller.orgId,
        candidates: read.rows,
        types: types.length,
        matched: read.matched.length,
        total: shown.length,
        listed: items.length,
      },
      'pending links found',
    );
    return { items, total: shown.length, documentId };
  }

  /** A message's saved list read again with the reader's access now; null for a role that can't open
   * the queue, or when nothing was saved. */
  async pendingLinksByIds(caller: Caller, stored: unknown): Promise<ChatPendingLinks | null> {
    const [list] = await this.pendingLinksByIdsMany(caller, [stored]);
    return list ?? null;
  }

  /** `pendingLinksByIds` for several messages at once (a conversation), in one batch of reads. */
  async pendingLinksByIdsMany(caller: Caller, stored: readonly unknown[]): Promise<(ChatPendingLinks | null)[]> {
    if (!canViewReviewQueue(caller.role)) return stored.map(() => null);
    const saved = stored.map((s) => {
      if (s === null || s === undefined) return null;
      const parsed = storedPendingLinksSchema.safeParse(s);
      if (!parsed.success) {
        this.log.warn({ orgId: caller.orgId, code: 'pending_links_unreadable' }, 'saved pending links unreadable');
        return null;
      }
      return parsed.data;
    });
    if (saved.every((s) => s === null)) return saved.map(() => null);

    const labels = visibleLabels(caller);
    const ids = [...new Set(saved.flatMap((s) => s?.findingIds ?? []))].filter((id) => UUID.test(id));
    const documentIds = [...new Set(saved.flatMap((s) => (s?.documentId ? [s.documentId] : [])))];

    const read = await withOrgContext(this.db, contextOf(caller), async (tx) => {
      const rows =
        labels.length === 0 || ids.length === 0
          ? []
          : await tx
              .select(FINDING_COLUMNS)
              .from(reviewFindings)
              .where(
                and(
                  findingVisibility(caller, labels),
                  eq(reviewFindings.kind, 'link'),
                  inArray(reviewFindings.id, ids),
                ),
              );
      const findings = this.parseRows(caller, rows).filter((f) => this.kindsViewable(caller, f.proposal));
      const facts = await this.factsOf(tx, caller, labels, findings, documentIds);
      return { findings, facts };
    });

    const shown = await this.shownEnds(caller, read.findings, read.facts);
    const byId = new Map(shown.map((s) => [s.finding.id, s]));
    const wanted = [
      ...new Set(saved.flatMap((s) => (s?.findingIds ?? []).map((id) => byId.get(id)).filter((s) => s !== undefined))),
    ];
    const items = await this.itemsOf(caller, labels, wanted, read.facts.documents);
    const itemById = new Map(items.map((item) => [item.findingId, item]));

    return saved.map((s) => {
      if (s === null) return null;
      const listed = s.findingIds.flatMap((id) => {
        const item = itemById.get(id);
        return item ? [item] : [];
      });
      const documentId = s.documentId !== null && read.facts.documents.has(s.documentId) ? s.documentId : null;
      return { items: listed, total: Math.max(s.total, listed.length), documentId };
    });
  }

  // ---- Helpers ----------------------------------------------------------------------------------

  /** The rows read in the link shape; one that doesn't fit is left out (never shown, never guessed). */
  private parseRows(caller: Caller, rows: readonly FindingRow[]): LinkFinding[] {
    const out: LinkFinding[] = [];
    let unreadable = 0;
    for (const row of rows) {
      const parsed = linkProposalSchema.safeParse(row.proposal);
      if (!parsed.success) {
        unreadable += 1;
        continue;
      }
      out.push({
        id: row.id,
        status: row.status,
        proposal: parsed.data,
        documentId: row.documentId,
        chunkId: row.chunkId,
        sentence: row.sentence,
      });
    }
    if (unreadable > 0) {
      this.log.warn(
        { orgId: caller.orgId, unreadable, code: 'review_finding_unreadable' },
        'pending links: findings that do not fit the link shape were left out',
      );
    }
    return out;
  }

  /** Whether the role views both ends' kinds (D50). */
  private kindsViewable(caller: Caller, proposal: LinkProposal): boolean {
    return can(caller.role, proposal.from.kind, 'view') && can(caller.role, proposal.to.kind, 'view');
  }

  /** The Postgres facts the ends and items need: the proposed records' finding statuses and the
   * documents (the findings' own, and any extra asked for), as the reader may see them. */
  private async factsOf(
    tx: Tx,
    caller: Caller,
    labels: readonly Label[],
    findings: readonly LinkFinding[],
    extraDocuments: readonly string[] = [],
  ): Promise<PageFacts> {
    const recordFindings = new Map<string, ReviewFindingStatus>();
    const documents = new Map<string, DocumentInfo>();
    const facts: PageFacts = { documents, recordFindings, pointing: new Map(), people: new Map() };
    if (labels.length === 0) return facts;

    const proposedIds = [
      ...new Set(findings.flatMap((f) => [f.proposal.from.recordFindingId, f.proposal.to.recordFindingId])),
    ].filter((id): id is string => typeof id === 'string' && UUID.test(id));
    if (proposedIds.length > 0) {
      const rows = await tx
        .select({ id: reviewFindings.id, status: reviewFindings.status })
        .from(reviewFindings)
        .where(
          and(
            findingVisibility(caller, labels),
            eq(reviewFindings.kind, 'record'),
            inArray(reviewFindings.id, proposedIds),
          ),
        );
      for (const r of rows) recordFindings.set(r.id, r.status);
    }

    const documentIds = [
      ...new Set([...findings.map((f) => f.documentId), ...extraDocuments].filter((id) => id !== null)),
    ].filter((id) => UUID.test(id));
    for (const [id, doc] of await readVisibleDocuments(tx, caller, labels, documentIds)) documents.set(id, doc);
    return facts;
  }

  /** The findings whose two ends the queue would show (neither hidden), in the order given. Matched
   * ends are read in one batch, as the reader's own role x clearance account. */
  private async shownEnds(caller: Caller, findings: readonly LinkFinding[], facts: PageFacts): Promise<ShownFinding[]> {
    if (findings.length === 0) return [];
    const wants = new RecordWants();
    for (const f of findings) {
      wants.add(f.proposal.from.kind, f.proposal.from.match?.recordId);
      wants.add(f.proposal.to.kind, f.proposal.to.match?.recordId);
    }
    let records: RecordLookup;
    try {
      records = await readNamedRecords(this.graph, viewerOf(caller), wants);
    } catch (err) {
      this.log.error({ ...errorKind(err), orgId: caller.orgId }, 'pending links could not read the graph');
      throw err;
    }
    const out: ShownFinding[] = [];
    for (const finding of findings) {
      const from = endSummary(finding.proposal.from, records, facts);
      const to = endSummary(finding.proposal.to, records, facts);
      if (from.state === 'hidden' || to.state === 'hidden') continue;
      out.push({ finding, from, to });
    }
    return out;
  }

  /** The items, with each sentence only where its chunk may be read (read in one batch) and each
   * document only where it may be read. */
  private async itemsOf(
    caller: Caller,
    labels: readonly Label[],
    shown: readonly ShownFinding[],
    documents: ReadonlyMap<string, DocumentInfo>,
  ): Promise<ChatPendingLink[]> {
    if (shown.length === 0) return [];
    const chunkIds = [...new Set(shown.map((s) => s.finding.chunkId).filter((id) => id !== null))].filter((id) =>
      UUID.test(id),
    );
    const readable = new Set<string>();
    if (chunkIds.length > 0 && labels.length > 0) {
      const rows = await withOrgContext(this.db, contextOf(caller), (tx) =>
        tx
          .select({ id: chunks.id, recordType: chunks.recordType, label: chunks.label })
          .from(chunks)
          .where(and(eq(chunks.orgId, caller.orgId), inArray(chunks.id, chunkIds), inArray(chunks.label, [...labels]))),
      );
      for (const c of rows) {
        if (can(caller.role, c.recordType, 'view') && isVisible(caller.clearance, c.label)) readable.add(c.id);
      }
    }
    return shown.map(({ finding, from, to }): ChatPendingLink => {
      const doc = finding.documentId !== null ? documents.get(finding.documentId) : undefined;
      const chunkReadable = finding.chunkId !== null && readable.has(finding.chunkId);
      return {
        findingId: finding.id,
        status: finding.status,
        type: finding.proposal.type,
        from,
        to,
        sentence: chunkReadable ? finding.sentence : null,
        document: doc ? { id: doc.id, name: doc.fileName, kind: doc.kind } : null,
      };
    });
  }
}

/** The one document every shown finding comes from, when the reader may read it; else null. */
function oneDocument(shown: readonly ShownFinding[], documents: ReadonlyMap<string, DocumentInfo>): string | null {
  if (shown.length === 0) return null;
  const first = shown[0]?.finding.documentId ?? null;
  if (first === null || !documents.has(first)) return null;
  return shown.every((s) => s.finding.documentId === first) ? first : null;
}
