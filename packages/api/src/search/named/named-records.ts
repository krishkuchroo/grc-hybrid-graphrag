// The records a question names (FX-003; D43, D45.3, D50, D51, D73, D163, D263 items 4 and 10): found
// by our code, never by the model, so "brute forse" still finds Brute Force and "A and B" is two
// names. In hybrid mode they join Path B's records (../hybrid/retrieval.service.ts).
// - The view is the asker's: their role and clearance, and their user ID for a person (an API key
//   has no records of its own). Each record kind the role views is read the way the extraction
//   matcher reads it (`kindRead`, `readFor` in ../../processing/match/name-matcher.ts): through the
//   role x clearance read-only account (`readAs`, with the matcher's time limit), or, for an
//   `edit_own` cell (a Control Owner's controls), as the writer limited to the person's own records.
//   Never as the admin account. A kind the role can't view is never read.
// - Candidates per kind: the `record_names` full-text hits for the question's words (the joining
//   words left out), and the records whose number the question holds; only active records with a
//   label at or below the clearance (the matcher's scope).
// - Each hit is scored by `nameScoreInQuestion` (./name-in-question.ts); a number scores 1. Best
//   first (score, then the longer name, then the number), at most `SEARCH_LIMITS.namedRecords`.
// - The kept records are read once more through the same account or accounts with one fixed query
//   and turned into Path B's record shape by `readGraphRows`, which checks each against the asker's
//   access again. Any not returned are dropped.
// - Fail safe: a Neo4j error or timeout is logged by code and gives none. A named record is extra
//   help, never required.
// Logs (D163): counts, kinds, times and codes only; never the question or a name.
import type { ManagedTransaction } from 'neo4j-driver';
import { NODE_LABELS, RECORD_KINDS, SEARCH_LIMITS, normaliseName, parseNumber, type RecordKind } from '@grc/shared';
import type { Logger } from 'pino';
import { createLogger } from '../../common/logger.js';
import type { GraphService } from '../../graph/graph.service.js';
import {
  FIELDS,
  fullTextQueryOf,
  scopeWhere,
  toStoredName,
  type BuiltQuery,
  type KindScope,
} from '../../processing/match/match-queries.js';
import { byNumber, fullTextQuery, type StoredName } from '../../processing/match/match-rules.js';
import { kindRead, readFor, type KindRead, type MatchView } from '../../processing/match/name-matcher.js';
import { readGraphRows, type GraphRow } from '../graph/graph-results.js';
import type { GraphRecord, SearchCaller } from '../retrieval.js';
import { isJoiningWord, nameScoreInQuestion, questionWords } from './name-in-question.js';

/** A record the question names: the record as Path B gives it, its score and how it was found. */
export interface NamedRecord {
  record: GraphRecord;
  score: number;
  how: 'exact' | 'spelling' | 'number';
}

/** What the retrieval calls to find them (wired in ../hybrid/hybrid-search.module.ts). */
export interface NamedRecordFinder {
  find(caller: SearchCaller, question: string): Promise<NamedRecord[]>;
}

export interface NamedRecordsDeps {
  graph: Pick<GraphService, 'read' | 'readAs'>;
  log?: Logger;
  /** The clock, in milliseconds. */
  now?: () => number;
}

/** The second read: the kept records by ID, as whole nodes, for `readGraphRows`. */
export const NAMED_RECORDS_QUERY = 'MATCH (n) WHERE n.id IN $ids RETURN n';

// Two scores this close count as equal (floating-point noise).
const EPSILON = 1e-9;

/** A candidate: the stored record, its kind, its score and how it was read. */
interface Candidate {
  stored: StoredName;
  kind: RecordKind;
  score: number;
  how: NamedRecord['how'];
  read: KindRead;
}

let defaultLog: Logger | undefined;

/** The scope's records whose number is one of `numbers`. */
function numberQueryOf(scope: KindScope, numbers: readonly string[]): BuiltQuery {
  const params: Record<string, unknown> = { numbers: [...numbers] };
  const where = scopeWhere('n', scope, params);
  return {
    text: `MATCH (n:${NODE_LABELS[scope.kind]}) WHERE n.number IN $numbers AND ${where} RETURN ${FIELDS('n')}`,
    params,
  };
}

async function storedRows(tx: ManagedTransaction, q: BuiltQuery): Promise<StoredName[]> {
  const res = await tx.run(q.text, q.params);
  return res.records.map(toStoredName).filter((r): r is StoredName => r !== null);
}

/** A failure's code, never its message (a driver message can quote the query). */
function codeOf(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_.]{1,120}$/.test(code)) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(name)) return name;
  }
  return 'error';
}

/** The record numbers the question holds, by kind (`RSK0001014`, any case). */
function numbersByKind(words: readonly string[]): Map<RecordKind, Set<string>> {
  const found = new Map<RecordKind, Set<string>>();
  for (const word of words) {
    const text = word.toUpperCase();
    const parsed = parseNumber(text);
    if (!parsed) continue;
    const set = found.get(parsed.kind) ?? new Set<string>();
    set.add(text);
    found.set(parsed.kind, set);
  }
  return found;
}

/** Score high to low, then the longer name, then the lower number. */
function bestFirst(a: Candidate, b: Candidate): number {
  const score = b.score - a.score;
  if (Math.abs(score) > EPSILON) return score;
  const length = Array.from(normaliseName(b.stored.name)).length - Array.from(normaliseName(a.stored.name)).length;
  return length !== 0 ? length : byNumber(a.stored, b.stored);
}

/**
 * The records `question` names that `caller` may see, best first, at most
 * `SEARCH_LIMITS.namedRecords`, each in Path B's record shape (see the top of the file). Never
 * rejects: any failure gives [].
 */
export async function findNamedRecords(
  deps: NamedRecordsDeps,
  caller: SearchCaller,
  question: string,
): Promise<NamedRecord[]> {
  const log = deps.log ?? (defaultLog ??= createLogger().child({ context: 'NamedRecords' }));
  const now = deps.now ?? (() => performance.now());
  const started = now();
  try {
    const words = questionWords(question);
    if (words.length === 0) return [];
    const view: MatchView =
      caller.kind === 'person'
        ? { role: caller.role, clearance: caller.clearance, userId: caller.userId }
        : { role: caller.role, clearance: caller.clearance };
    const lucene = fullTextQuery(words.filter((w) => !isJoiningWord(w)).join(' '));
    const numbers = numbersByKind(words);

    // Each kind the role views, read the matcher's way, side by side.
    const reads = RECORD_KINDS.flatMap((kind) => {
      const read = kindRead(view, kind);
      if (read === null) return [];
      const kindNumbers = [...(numbers.get(kind) ?? [])];
      if (lucene === null && kindNumbers.length === 0) return [];
      return [{ kind, read, kindNumbers }];
    });
    const found = await Promise.all(
      reads.map(({ kind, read, kindNumbers }) =>
        readFor(deps.graph, caller.orgId, view, read, async (tx) => ({
          kind,
          read,
          hits: lucene !== null ? await storedRows(tx, fullTextQueryOf(read.scope, lucene)) : [],
          byNumber: kindNumbers.length > 0 ? await storedRows(tx, numberQueryOf(read.scope, kindNumbers)) : [],
        })),
      ),
    );

    // Scored, each record once (its best).
    const candidates = new Map<string, Candidate>();
    const offer = (c: Candidate): void => {
      const seen = candidates.get(c.stored.id);
      if (!seen || c.score > seen.score + EPSILON) candidates.set(c.stored.id, c);
    };
    for (const { kind, read, hits, byNumber: numbered } of found) {
      for (const stored of hits) {
        const scored = nameScoreInQuestion(words, stored.name);
        if (scored) offer({ stored, kind, score: scored.score, how: scored.how, read });
      }
      for (const stored of numbered) offer({ stored, kind, score: 1, how: 'number', read });
    }
    const kept = [...candidates.values()].sort(bestFirst).slice(0, SEARCH_LIMITS.namedRecords);

    // Path B's shape: the kept records read once more, through the same account or accounts.
    const groups = new Map<boolean, { read: KindRead; ids: string[] }>();
    for (const c of kept) {
      const group = groups.get(c.read.asWriter) ?? { read: c.read, ids: [] };
      group.ids.push(c.stored.id);
      groups.set(c.read.asWriter, group);
    }
    const viewer = { userId: caller.userId, role: caller.role, clearance: caller.clearance };
    const shaped = await Promise.all(
      [...groups.values()].map(({ read, ids }) =>
        readFor(deps.graph, caller.orgId, view, read, async (tx) => {
          const res = await tx.run(NAMED_RECORDS_QUERY, { ids });
          const rows: GraphRow[] = res.records.map((record) => ({
            keys: [...record.keys].map(String),
            values: record.keys.map((key) => record.get(key) as unknown),
          }));
          return readGraphRows(rows, viewer).records;
        }),
      ),
    );
    const byId = new Map(shaped.flat().map((r) => [r.id, r] as const));
    const named = kept.flatMap((c): NamedRecord[] => {
      const record = byId.get(c.stored.id);
      return record !== undefined && record.kind === c.kind ? [{ record, score: c.score, how: c.how }] : [];
    });

    log.info(
      {
        orgId: caller.orgId,
        found: {
          exact: named.filter((n) => n.how === 'exact').length,
          spelling: named.filter((n) => n.how === 'spelling').length,
          number: named.filter((n) => n.how === 'number').length,
        },
        kinds: reads.map((r) => r.kind),
        ms: Math.max(0, Math.round(now() - started)),
      },
      'named records found',
    );
    return named;
  } catch (err) {
    log.warn({ orgId: caller.orgId, code: codeOf(err) }, 'named records: the read failed');
    return [];
  }
}
