// A question's expected records, found in the org through the API (S8-005): the record lists of the
// kinds the questions expect, read once each, whole (retired records too, as search finds them).
// - A record the question names with the answer key's key is the org's record whose source IDs hold
//   `answer-key:<key>` (fast-loaded records carry it, S3-019); any other is the org's record whose
//   name is the same after `normaliseName`.
// - None found, or more than one, and the question can't be scored: it is stored `skipped`
//   (`expected_record_not_found`) in every part and mode, and nothing is asked.
// The lists: the five record kinds (`GET /api/v1/<risks|controls|assets|policies|incidents>`),
// evidence (`/evidence`), audit findings (`/audit-findings`), frameworks (`/frameworks`) and their
// requirements (`/frameworks/:id/requirements`). Pure apart from the client.
import {
  RECORD_KINDS,
  RECORD_PATHS,
  normaliseName,
  type BenchmarkExpectedDetail,
  type BenchmarkQuestion,
  type ExpectedRecord,
  type RecordKind,
  type SearchRecordKind,
} from '@grc/shared';
import type { ResolvedExpectedRecord } from '../score/common.js';
import { storableText } from '../score/text.js';
import type { BenchApi, CallOptions, ListedRecord } from './api-client.js';

/** The source ID fast-loaded records carry for their answer-key record. */
export function answerKeySourceId(key: string): string {
  return `answer-key:${key}`;
}

/** The list path of each kind that has one of its own. */
const LIST_PATHS: Readonly<Partial<Record<SearchRecordKind, string>>> = Object.freeze({
  ...Object.fromEntries(RECORD_KINDS.map((kind: RecordKind) => [kind, `/${RECORD_PATHS[kind]}`])),
  evidence: '/evidence',
  audit_finding: '/audit-findings',
});

/** Every list is read with retired records too. */
const ALL_STATUSES = Object.freeze({ status: 'all' });

/** The org's records by kind, as the lists give them. */
export type OrgRecords = ReadonlyMap<SearchRecordKind, readonly ListedRecord[]>;

/** The kinds the questions expect, each once, in the order first expected. */
export function expectedKinds(questions: readonly BenchmarkQuestion[]): SearchRecordKind[] {
  const kinds: SearchRecordKind[] = [];
  for (const question of questions) {
    for (const expected of question.expected) if (!kinds.includes(expected.kind)) kinds.push(expected.kind);
  }
  return kinds;
}

/** Reads the org's records of the kinds given, each list once and whole. */
export async function readOrgRecords(
  api: BenchApi,
  kinds: readonly SearchRecordKind[],
  options?: CallOptions,
): Promise<Map<SearchRecordKind, ListedRecord[]>> {
  const out = new Map<SearchRecordKind, ListedRecord[]>();
  let frameworks: ListedRecord[] | null = null;
  for (const kind of kinds) {
    if (out.has(kind)) continue;
    if (kind === 'framework' || kind === 'requirement') {
      frameworks ??= await api.frameworkIds(options);
      if (kind === 'framework') {
        out.set(kind, frameworks);
        continue;
      }
      const requirements: ListedRecord[] = [];
      for (const framework of frameworks) {
        const path = `/frameworks/${encodeURIComponent(framework.id)}/requirements`;
        requirements.push(...(await api.listRecords(path, ALL_STATUSES, options)));
      }
      out.set(kind, requirements);
      continue;
    }
    const path = LIST_PATHS[kind];
    out.set(kind, path === undefined ? [] : await api.listRecords(path, ALL_STATUSES, options));
  }
  return out;
}

/** The org's records an expected record could be: by source ID with a key, else by normalised name. */
export function candidatesFor(expected: ExpectedRecord, records: OrgRecords): ListedRecord[] {
  const ofKind = records.get(expected.kind) ?? [];
  if (expected.key !== undefined) {
    const sourceId = answerKeySourceId(expected.key);
    return ofKind.filter((r) => r.sourceIds.includes(sourceId));
  }
  const name = normaliseName(expected.name);
  if (name === '') return [];
  return ofKind.filter((r) => normaliseName(r.name) === name);
}

/** A question's expected records in the org: all found once each, or not (`resolved: null`). */
export interface QuestionResolution {
  /** The org's records, in the question's order; null when one wasn't found, or was found twice. */
  resolved: ResolvedExpectedRecord[] | null;
  /** The expected records as an item's details list them (the number null where none was found). */
  expected: BenchmarkExpectedDetail[];
  /** How many expected records weren't found once. */
  notFound: number;
}

export function resolveQuestion(question: BenchmarkQuestion, records: OrgRecords): QuestionResolution {
  const resolved: ResolvedExpectedRecord[] = [];
  const expected: BenchmarkExpectedDetail[] = [];
  let notFound = 0;
  for (const e of question.expected) {
    const found = candidatesFor(e, records);
    const only = found.length === 1 ? found[0]! : null;
    if (only === null) {
      notFound += 1;
      expected.push({ number: null, name: storableText(e.name), kind: e.kind });
      continue;
    }
    resolved.push({ id: only.id, number: only.number, name: only.name, kind: e.kind });
    expected.push({ number: only.number, name: storableText(only.name), kind: e.kind });
  }
  return { resolved: notFound === 0 ? resolved : null, expected, notFound };
}
