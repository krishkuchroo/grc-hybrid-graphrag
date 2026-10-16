// The name matcher (S4-007; D43, D51, D70; S4 shared notes, "Duplicate matching" and "Whose view"):
// ties a name as written in a document to the record it means, with no Gemma. For each name it
// tries, in order:
//   1. exact: the same name after `normaliseName`, or the record's number, or one of its source IDs;
//   2. close spelling: the `record_names` full-text index finds candidates, `editSimilarity` scores them;
//   3. close meaning: bge-m3's vector of the name against the label's `<label>_name_embedding` index.
// The answer is a clear match, an uncertain one (up to 3 candidates) or none (./match-rules.ts).
// Names whose digits differ never match by spelling or meaning.
//
// Only active records of the kind asked count, and only those the person behind the work could
// see: a role that views the record type, a label at or below the clearance (D51, S3-024's
// precedent). The reads run as that role x clearance's read-only account (`readAs`), so Neo4j
// hides everything else a second time (D45.3); for an "own" cell (a Control Owner's controls) they
// run as the writer, limited to the person's own records, because no shared account knows who owns
// what (S1 shared notes). A view of `null` (an uploader who can't be found) sees nothing, so every
// name is unmatched (fail safe). Records the person couldn't see never appear, not even as
// candidates. Nothing here logs a name or a vector (D163).
import type { ManagedTransaction } from 'neo4j-driver';
import {
  ROLE_TABLE,
  isLabel,
  isRecordKind,
  isRole,
  normaliseName,
  type Label,
  type RecordKind,
  type Role,
} from '@grc/shared';
import type { Embedder } from '../../ai/embedder.js';
import type { GraphService } from '../../graph/graph.service.js';
import { visibleLabels } from '../../records/record-queries.js';
import {
  NO_MATCH,
  decideExact,
  decideMeaning,
  decideSpelling,
  exactMatches,
  fullTextQuery,
  keyed,
  meaningScores,
  spellingScores,
  type KeyedName,
  type NameMatch,
  type RankedCandidate,
  type ScoredName,
  type StoredName,
} from './match-rules.js';
import {
  fullTextQueryOf,
  scanQuery,
  toScoredName,
  toStoredName,
  vectorQueryOf,
  type BuiltQuery,
  type KindScope,
} from './match-queries.js';

/** Neo4j stops a matcher read after this long (D48). */
export const MATCH_READ_TIMEOUT_MS = 10_000;

/** Whose view a match is made in: a role and clearance in the org, and for an "own" cell the
 * person's user ID. */
export interface MatchView {
  role: Role;
  clearance: Label;
  userId?: string;
}

/** The view of the system's own housekeeping: Admin at Restricted (S4 shared notes). */
export const SYSTEM_MATCH_VIEW: MatchView = Object.freeze({ role: 'admin', clearance: 'restricted' });

/** One name to match: the kind of record it names and the name as written. */
export interface NameToMatch {
  kind: RecordKind;
  name: string;
}

export interface NameMatcherDeps {
  graph: Pick<GraphService, 'read' | 'readAs'>;
  embedder: Pick<Embedder, 'embed'>;
}

/** How a view reads one kind: the scope its queries carry, and whether it must read as the writer. */
export interface KindRead {
  scope: KindScope;
  asWriter: boolean;
}

/**
 * How `view` reads records of `kind`, or null when it sees none of them: a `view` or `edit` cell
 * reads through the role x clearance account; an `edit_own` cell reads as the writer limited to the
 * person's own records (none when the view has no user ID); any other cell sees nothing.
 */
export function kindRead(view: MatchView | null, kind: RecordKind, excludeId?: string): KindRead | null {
  if (view === null || !isRole(view.role) || !isLabel(view.clearance) || !isRecordKind(kind)) return null;
  const cell = ROLE_TABLE[kind][view.role];
  const visible = visibleLabels(view.clearance);
  if (cell === 'view' || cell === 'edit') return { scope: { kind, visible, excludeId }, asWriter: false };
  if (cell === 'edit_own' && typeof view.userId === 'string' && view.userId !== '') {
    return { scope: { kind, visible, ownerOnly: view.userId, excludeId }, asWriter: true };
  }
  return null;
}

/** Runs `fn` in one read transaction in the org's database, the way `read` says. */
export function readFor<T>(
  graph: NameMatcherDeps['graph'],
  orgId: string,
  view: MatchView,
  read: KindRead,
  fn: (tx: ManagedTransaction) => Promise<T>,
): Promise<T> {
  if (read.asWriter) return graph.read(orgId, fn);
  return graph.readAs(orgId, view.role, view.clearance, fn, { timeoutMs: MATCH_READ_TIMEOUT_MS });
}

async function storedRows(tx: ManagedTransaction, q: BuiltQuery): Promise<StoredName[]> {
  const res = await tx.run(q.text, q.params);
  return res.records.map(toStoredName).filter((r): r is StoredName => r !== null);
}

/** Every record of the scope, keyed for the exact step. */
export async function readScan(tx: ManagedTransaction, scope: KindScope): Promise<KeyedName[]> {
  return keyed(await storedRows(tx, scanQuery(scope)));
}

/** The spelling step's scores for a name: the full-text index's hits in the scope, scored. */
export async function readSpelling(tx: ManagedTransaction, scope: KindScope, name: string): Promise<RankedCandidate[]> {
  const lucene = fullTextQuery(name);
  if (lucene === null) return [];
  return spellingScores(name, await storedRows(tx, fullTextQueryOf(scope, lucene)));
}

/** The meaning step's scores for a name with its vector: the vector index's hits in the scope. */
export async function readMeaning(
  tx: ManagedTransaction,
  scope: KindScope,
  name: string,
  vector: readonly number[],
): Promise<RankedCandidate[]> {
  const q = vectorQueryOf(scope, vector);
  const res = await tx.run(q.text, q.params);
  return meaningScores(
    name,
    res.records.map(toScoredName).filter((h): h is ScoredName => h !== null),
  );
}

// A name waiting for the meaning step, with its spelling scores.
interface Pending {
  key: string;
  kind: RecordKind;
  name: string;
  spelling: RankedCandidate[];
}

export class NameMatcher {
  private readonly graph: NameMatcherDeps['graph'];
  private readonly embedder: NameMatcherDeps['embedder'];

  constructor(deps: NameMatcherDeps) {
    this.graph = deps.graph;
    this.embedder = deps.embedder;
  }

  /** What one name means, in `view` (null: sees nothing). See `matchAll`. */
  async match(orgId: string, kind: RecordKind, name: string, view: MatchView | null): Promise<NameMatch> {
    const [result] = await this.matchAll(orgId, view, [{ kind, name }]);
    return result ?? NO_MATCH;
  }

  /**
   * What each name means, in `view` (null: sees nothing), in the same order as `names`. Each kind's
   * records are read once for the exact and spelling steps; the names that reach the meaning step
   * are embedded together in one call. An unknown kind, or a name with nothing left after
   * `normaliseName`, is none. Throws the embedder's `AiFailure` when Ollama can't embed the names
   * (the caller's job waits and tries again, D45.7), and any graph error as it is.
   */
  async matchAll(orgId: string, view: MatchView | null, names: readonly NameToMatch[]): Promise<NameMatch[]> {
    const results: NameMatch[] = names.map(() => NO_MATCH);
    if (view === null) return results;

    // The same kind and name are matched once.
    const decided = new Map<string, NameMatch>();
    const byKind = new Map<RecordKind, Map<string, string>>();
    const keyOf = (n: NameToMatch): string => `${n.kind}\u0000${n.name}`;
    for (const n of names) {
      if (!isRecordKind(n.kind) || typeof n.name !== 'string' || normaliseName(n.name) === '') continue;
      const group = byKind.get(n.kind) ?? new Map<string, string>();
      group.set(keyOf(n), n.name);
      byKind.set(n.kind, group);
    }

    // Steps 1 and 2, one read per kind.
    const pending: Pending[] = [];
    for (const [kind, group] of byKind) {
      const read = kindRead(view, kind);
      if (!read) continue;
      const waiting = await readFor(this.graph, orgId, view, read, async (tx) => {
        const all = await readScan(tx, read.scope);
        const out: Pending[] = [];
        for (const [key, name] of group) {
          const exact = decideExact(exactMatches(all, name));
          if (exact) {
            decided.set(key, exact);
            continue;
          }
          const spelling = await readSpelling(tx, read.scope, name);
          const bySpelling = decideSpelling(spelling);
          if (bySpelling) {
            decided.set(key, bySpelling);
            continue;
          }
          out.push({ key, kind, name, spelling });
        }
        return out;
      });
      pending.push(...waiting);
    }

    // Step 3: the remaining names' vectors in one call, then one read per kind.
    if (pending.length > 0) {
      const texts = [...new Set(pending.map((p) => p.name.trim()))];
      const answer = await this.embedder.embed(texts);
      const vectors = new Map(texts.map((t, i) => [t, answer.vectors[i]] as const));
      for (const [kind] of byKind) {
        const mine = pending.filter((p) => p.kind === kind);
        const read = kindRead(view, kind);
        if (mine.length === 0 || !read) continue;
        await readFor(this.graph, orgId, view, read, async (tx) => {
          for (const p of mine) {
            const vector = vectors.get(p.name.trim());
            const meaning = vector ? await readMeaning(tx, read.scope, p.name, vector) : [];
            decided.set(p.key, decideMeaning(p.spelling, meaning));
          }
        });
      }
    }

    names.forEach((n, i) => {
      const found = decided.get(keyOf(n));
      if (found) results[i] = found;
    });
    return results;
  }
}
