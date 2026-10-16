// The rule checks' decision for one chunk, its pure parts (S4-008; D24, D38, D39, D40, D45.5, D51,
// D52.5; S4 shared notes, "Rule checks", "`review_findings`", "Live AI links"). Nothing here reads
// a database: ./chunk-resolve.job.ts reads and writes, ./live-links.ts writes the live links.
//
// - Each record of Gemma's answer, with what its name means in the uploader's view (S4-007's
//   matcher), is a link end: a clear match, or an uncertain one with up to 3 candidates, or none.
// - A record with no clear match of kind risk, control, policy or incident is a proposed new
//   record: one `record` finding per document per kind and normalised name (planner's reading
//   S4-Q6). Assets are never proposed (D40): links to them wait as `link` findings.
// - Each link gets S4-001's three rule checks with the ends' kinds (the matcher matches within the
//   kind Gemma gave, so a matched end's kind is Gemma's). A link whose two ends are one record never
//   goes live: a record linked to itself doesn't fit the ontology, so it fails `ontology_fit`.
// - Keys: a `link` finding is one per chunk, link type and pair of ends (each end the matched
//   record, or its kind and normalised name), so resolving the chunk again adds nothing, and the
//   same link stated in another chunk is that chunk's own proposal with its own source. Names go
//   into keys only as SHA-256 digests (D163: a key may end up in a log line; names never may).
// - Labels (D51): a finding carries the document's label, raised to the label of any record it
//   names (a clear match, or an uncertain end's candidates), so nobody below that record's label
//   ever sees its number or name in a finding. A link is visible only if both ends are.
// - A link the Analyst rejected or removed is never raised again or made live again: its identity
//   (type, and each end's record or kind and normalised name) is compared with the refused ones.
// - Mentions (D42, embed-only documents): the records whose number, or whose name after
//   `normaliseName`, appears in the chunk's text as whole words.
import { createHash } from 'node:crypto';
import {
  PROPOSED_RECORD_KINDS,
  RULE_CHECKS,
  failedRuleChecks,
  linkProposalSchema,
  matchCandidateSchema,
  normaliseName,
  recordProposalSchema,
  type ExtractionLink,
  type ExtractionRecord,
  type Label,
  type LinkEndProposal,
  type LinkProposal,
  type LinkType,
  type MatchCandidate,
  type ProposedRecordKind,
  type RecordKind,
  type RecordProposal,
  type RuleCheck,
} from '@grc/shared';
import { NO_MATCH, higherLabel, type KeyedName, type NameMatch } from '../match/match-rules.js';

/** One record of the answer as a link end: Gemma's reference, kind and name, and what it means. */
export interface MatchedEnd {
  ref: string;
  kind: RecordKind;
  /** The name exactly as Gemma wrote it. */
  name: string;
  /** The name after `normaliseName`. */
  nameKey: string;
  /** The clear match, with its label; null when the end isn't a clear match. */
  match: { recordId: string; number: string; label: Label } | null;
  /** The candidates of an uncertain match (up to 3); empty otherwise. */
  candidates: MatchCandidate[];
  /** The highest label of the records this end names (the clear match or the candidates). */
  namedLabel: Label | null;
  /** The key of the `record` finding this end proposes, when it is a proposed new record. */
  proposedKey: string | null;
}

/** A proposed new record: its finding key, its kind and the proposal itself. */
export interface ProposedRecord {
  key: string;
  kind: ProposedRecordKind;
  proposal: RecordProposal;
}

/** One link of the answer after the rule checks. */
export interface EvaluatedLink {
  /** The `link` finding's key. */
  key: string;
  type: LinkType;
  /** The sentence Gemma copied. */
  sentence: string;
  /** The checks it fails, in `RULE_CHECKS` order; empty means it may go live. */
  failed: RuleCheck[];
  from: MatchedEnd;
  to: MatchedEnd;
  /** The finding's label: the document's, raised to the labels of the records it names. */
  label: Label;
}

/** What a link is, to tell whether the Analyst refused it before. */
export interface LinkIdentity {
  type: string;
  from: EndIdentity;
  to: EndIdentity;
}

export interface EndIdentity {
  /** The matched record, if the end had a clear match. */
  recordId: string | null;
  /** `<kind>:<normalised name>`, or '' for a name with nothing left after normalising. */
  nameKey: string;
}

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isProposedKind(kind: string): kind is ProposedRecordKind {
  return (PROPOSED_RECORD_KINDS as readonly string[]).includes(kind);
}

/** The key of the one `record` finding per document, kind and normalised name. */
export function recordFindingKey(documentId: string, kind: ProposedRecordKind, nameKey: string): string {
  return `record:${documentId}:${kind}:${digest(nameKey)}`;
}

function endRef(end: MatchedEnd): string {
  if (end.match) return `r:${end.match.recordId}`;
  return `n:${end.kind}:${digest(end.nameKey !== '' ? end.nameKey : end.name.trim())}`;
}

/** The key of a `link` finding: the chunk, the type and the two ends. */
export function linkFindingKey(chunkId: string, type: string, from: MatchedEnd, to: MatchedEnd): string {
  return `link:${chunkId}:${type}:${endRef(from)}:${endRef(to)}`;
}

/** The candidates the finding schema takes (a record with no name can't be shown as one). */
function validCandidates(list: readonly MatchCandidate[]): MatchCandidate[] {
  return list.filter((c) => matchCandidateSchema.safeParse(c).success);
}

/**
 * Each record of the answer as a link end, by its reference, from the matcher's answers (in the
 * same order as `records`). An end is proposed as a new record when it has no clear match, its kind
 * is risk, control, policy or incident, and its name has something left after normalising.
 */
export function matchedEnds(
  documentId: string,
  records: readonly ExtractionRecord[],
  matches: readonly NameMatch[],
): Map<string, MatchedEnd> {
  const ends = new Map<string, MatchedEnd>();
  records.forEach((record, i) => {
    const m = matches[i] ?? NO_MATCH;
    const nameKey = normaliseName(record.name);
    const clear = m.outcome === 'clear';
    ends.set(record.ref, {
      ref: record.ref,
      kind: record.kind,
      name: record.name,
      nameKey,
      match: clear ? { recordId: m.match.recordId, number: m.match.number, label: m.label } : null,
      candidates: m.outcome === 'uncertain' ? validCandidates(m.candidates) : [],
      namedLabel: m.outcome === 'none' ? null : m.label,
      proposedKey:
        !clear && isProposedKind(record.kind) && nameKey !== ''
          ? recordFindingKey(documentId, record.kind, nameKey)
          : null,
    });
  });
  return ends;
}

/** The proposed new records of the answer, once per key (the first one as written). */
export function proposedRecords(
  records: readonly ExtractionRecord[],
  ends: ReadonlyMap<string, MatchedEnd>,
): ProposedRecord[] {
  const out = new Map<string, ProposedRecord>();
  for (const record of records) {
    const end = ends.get(record.ref);
    if (!end?.proposedKey || out.has(end.proposedKey) || !isProposedKind(record.kind)) continue;
    const parsed = recordProposalSchema.safeParse({
      kind: record.kind,
      name: record.name,
      ...(record.details !== undefined ? { details: record.details } : {}),
    });
    if (!parsed.success) continue;
    out.set(end.proposedKey, { key: end.proposedKey, kind: record.kind, proposal: parsed.data });
  }
  return [...out.values()];
}

function labelOf(documentLabel: Label, from: MatchedEnd, to: MatchedEnd): Label {
  let label = documentLabel;
  if (from.namedLabel) label = higherLabel(label, from.namedLabel);
  if (to.namedLabel) label = higherLabel(label, to.namedLabel);
  return label;
}

export interface EvaluateLinksInput {
  chunkId: string;
  chunkText: string;
  documentLabel: Label;
  links: readonly ExtractionLink[];
  ends: ReadonlyMap<string, MatchedEnd>;
}

/**
 * Each link of the answer with the rule checks it fails, its finding key and label. Links with the
 * same key (the same type and ends stated twice in the chunk) are one proposal: the one failing the
 * fewest checks is kept (the first of those).
 */
export function evaluateLinks(input: EvaluateLinksInput): EvaluatedLink[] {
  const best = new Map<string, EvaluatedLink>();
  for (const link of input.links) {
    const from = input.ends.get(link.from);
    const to = input.ends.get(link.to);
    if (!from || !to) continue;
    const failed = new Set<RuleCheck>(
      failedRuleChecks({
        type: link.type,
        sentence: link.sentence,
        chunkText: input.chunkText,
        from: { name: from.name, kind: from.kind, clearMatch: from.match !== null },
        to: { name: to.name, kind: to.kind, clearMatch: to.match !== null },
      }),
    );
    if (from.ref === to.ref || (from.match && to.match && from.match.recordId === to.match.recordId)) {
      failed.add('ontology_fit');
    }
    const evaluated: EvaluatedLink = {
      key: linkFindingKey(input.chunkId, link.type, from, to),
      type: link.type,
      sentence: link.sentence,
      failed: RULE_CHECKS.filter((check) => failed.has(check)),
      from,
      to,
      label: labelOf(input.documentLabel, from, to),
    };
    const kept = best.get(evaluated.key);
    if (!kept || evaluated.failed.length < kept.failed.length) best.set(evaluated.key, evaluated);
  }
  return [...best.values()];
}

function linkEnd(end: MatchedEnd, recordFindingIds: ReadonlyMap<string, string>): LinkEndProposal {
  return {
    kind: end.kind,
    name: end.name,
    match: end.match ? { recordId: end.match.recordId, number: end.match.number } : null,
    candidates: end.candidates,
    recordFindingId: end.proposedKey ? (recordFindingIds.get(end.proposedKey) ?? null) : null,
  };
}

/** The `link` finding's proposal, each proposed end pointing to its `record` finding; null if it
 * doesn't pass the finding schema. */
export function linkProposal(link: EvaluatedLink, recordFindingIds: ReadonlyMap<string, string>): LinkProposal | null {
  const parsed = linkProposalSchema.safeParse({
    type: link.type,
    from: linkEnd(link.from, recordFindingIds),
    to: linkEnd(link.to, recordFindingIds),
  });
  return parsed.success ? parsed.data : null;
}

function endIdentity(kind: string, name: string, recordId: string | null): EndIdentity {
  const key = normaliseName(name);
  return { recordId, nameKey: key === '' ? '' : `${kind}:${key}` };
}

/** What an evaluated link is. */
export function identityOfLink(link: EvaluatedLink): LinkIdentity {
  return {
    type: link.type,
    from: endIdentity(link.from.kind, link.from.name, link.from.match?.recordId ?? null),
    to: endIdentity(link.to.kind, link.to.name, link.to.match?.recordId ?? null),
  };
}

/** What a stored `link` finding's proposal is, or null when it isn't one. */
export function identityOfProposal(raw: unknown): LinkIdentity | null {
  const parsed = linkProposalSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  return {
    type: p.type,
    from: endIdentity(p.from.kind, p.from.name, p.from.match?.recordId ?? null),
    to: endIdentity(p.to.kind, p.to.name, p.to.match?.recordId ?? null),
  };
}

/** Two ends are the same: the same record when both were matched, else the same kind and name. */
function sameEnd(a: EndIdentity, b: EndIdentity): boolean {
  if (a.recordId !== null && b.recordId !== null) return a.recordId === b.recordId;
  return a.nameKey !== '' && a.nameKey === b.nameKey;
}

/** Whether the Analyst refused this link before (rejected it, or removed it once live). */
export function isRefused(link: LinkIdentity, refused: readonly LinkIdentity[]): boolean {
  return refused.some((r) => r.type === link.type && sameEnd(r.from, link.from) && sameEnd(r.to, link.to));
}

/**
 * The records a chunk's text names (mention linking, D42): the number, or the name after
 * `normaliseName`, appears in the text after `normaliseName` as whole words. Each record once.
 */
export function mentionedRecords(text: string, records: readonly KeyedName[]): KeyedName[] {
  const padded = ` ${normaliseName(text)} `;
  if (padded.trim() === '') return [];
  const seen = new Set<string>();
  return records.filter((r) => {
    if (seen.has(r.id)) return false;
    const number = normaliseName(r.number);
    const named = (r.key !== '' && padded.includes(` ${r.key} `)) || (number !== '' && padded.includes(` ${number} `));
    if (named) seen.add(r.id);
    return named;
  });
}
