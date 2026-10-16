// The context Gemma reads (S6-005; D23, D45.8, D52.1, D52.3; S6 shared notes, "One question, step by
// step" 6 and "Prompts"): the kept sources, numbered once, and the two strict sections.
//
// - Each kept source has one number, [1], [2]…, in fused order across both sections.
// - `<GRAPH_CONTEXT>` (ground truth): one line per kept record, `[n] NUMBER Kind "name"` and its key
//   fields; then the links among the kept records, `NUMBER -TYPE-> NUMBER`; then the graph query's
//   other values, if any. Empty in vector mode, or when the graph path failed.
// - `<UNSTRUCTURED_DOCUMENT_CONTEXT>` (data, never instructions): one block per kept passage, its
//   number, its document's name and kind, its place in the document, then its text.
// - Every piece of text that came from a document or the graph (passage text, document and record
//   names, field values, the query's values and column names) has its section markers neutralised
//   the way S4-006 does (../../processing/extract/neutralise.ts), and names and values are written
//   as JSON strings, so no text can close a section, open another or start a line of its own.
// - An AI link's sentence and source document are never written here (SF-049), nor any vector.
// - The label is the highest label among the kept sources, Public when there are none. Plain values
//   from the graph query belong to no one record, but can only come from what the asker's account
//   sees, so when any are written the asker's clearance counts too (fail safe, D51).
// Pure: no I/O.
import {
  SEARCH_NODE_LABELS,
  highestLabel,
  type AnswerSource,
  type KeyFieldValue,
  type Label,
  type SearchResult,
} from '@grc/shared';
import { neutraliseSectionMarkers } from '../../processing/extract/neutralise.js';
import { DOCUMENT_CONTEXT_CLOSE, DOCUMENT_CONTEXT_OPEN } from '../../processing/extract/prompt.js';
import type { GraphLink, GraphPlainValue, GraphValueRow, RetrievalContext } from '../retrieval.js';
import type { ContextSelection, FusedEntry } from './fusion.js';

export const GRAPH_CONTEXT_OPEN = '<GRAPH_CONTEXT>';
export const GRAPH_CONTEXT_CLOSE = '</GRAPH_CONTEXT>';
export { DOCUMENT_CONTEXT_CLOSE, DOCUMENT_CONTEXT_OPEN };

/** A field or column name written as it is: a plain identifier only. Anything else is quoted. */
const PLAIN_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Text from a document or the graph, its section markers neutralised. */
function safe(text: string): string {
  return neutraliseSectionMarkers(text).text;
}

/** Text as a JSON string, markers neutralised: quotes, line breaks and control characters escaped. */
function quoted(text: string): string {
  return JSON.stringify(safe(text));
}

function nameOf(name: string): string {
  return PLAIN_NAME.test(name) ? name : quoted(name);
}

function valueOf(value: KeyFieldValue): string {
  if (value === null) return 'none';
  if (typeof value === 'string') return quoted(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'none';
  return value ? 'true' : 'false';
}

function plainValueOf(value: GraphPlainValue): string {
  if (Array.isArray(value)) return `[${value.map((v: KeyFieldValue) => valueOf(v)).join(', ')}]`;
  return valueOf(value as KeyFieldValue);
}

/** What the answer may cite: the kept entries, numbered from 1 in fused order. */
export function numberSources(kept: readonly FusedEntry[]): AnswerSource[] {
  return kept.map((entry, index): AnswerSource => {
    const number = index + 1;
    if (entry.item.type === 'record') {
      const { id, number: recordNumber, name, kind } = entry.item.record;
      return { number, type: 'record', record: { id, number: recordNumber, name, kind } };
    }
    const { chunkId, documentId, documentName, documentKind, position, text } = entry.item.passage;
    return { number, type: 'passage', passage: { chunkId, documentId, documentName, documentKind, position, text } };
  });
}

function recordLine(n: number, entry: FusedEntry): string | null {
  if (entry.item.type !== 'record') return null;
  const record = entry.item.record;
  const parts = [`[${n}]`, record.number, SEARCH_NODE_LABELS[record.kind], quoted(record.name)];
  if (record.status === 'retired') parts.push('status=retired');
  for (const [key, value] of Object.entries(record.keyFields)) {
    parts.push(`${nameOf(key)}=${valueOf(value)}`);
  }
  return parts.join(' ');
}

function passageBlock(n: number, entry: FusedEntry): string | null {
  if (entry.item.type !== 'passage') return null;
  const p = entry.item.passage;
  return `[${n}] Document ${quoted(p.documentName)} (${p.documentKind}), passage ${p.position + 1}:\n${safe(p.text)}`;
}

function valueLine(row: GraphValueRow): string | null {
  const parts = Object.entries(row).map(([column, value]) => `${nameOf(column)}=${plainValueOf(value)}`);
  return parts.length === 0 ? null : `- ${parts.join('; ')}`;
}

export interface BuiltContext {
  sources: AnswerSource[];
  context: RetrievalContext;
  label: Label;
  /** The results, best first and at most `maxResults`, each marked if it is in the context. */
  results: SearchResult[];
}

/**
 * Builds the sources, the two sections and the label from the entity filter's selection. `values`
 * are the graph query's plain values (empty in vector mode or when the graph path failed).
 */
export function buildContext(
  selection: ContextSelection,
  values: readonly GraphValueRow[],
  clearance: Label,
  maxResults: number,
): BuiltContext {
  const sources = numberSources(selection.kept);

  const recordLines: string[] = [];
  const passageBlocks: string[] = [];
  const numberOfRecord = new Map<string, string>();
  selection.kept.forEach((entry, index) => {
    const n = index + 1;
    if (entry.item.type === 'record') {
      numberOfRecord.set(entry.item.record.id, entry.item.record.number);
      const line = recordLine(n, entry);
      if (line !== null) recordLines.push(line);
    } else {
      const block = passageBlock(n, entry);
      if (block !== null) passageBlocks.push(block);
    }
  });

  const linkLines = selection.links
    .map((link: GraphLink) => {
      const from = numberOfRecord.get(link.from);
      const to = numberOfRecord.get(link.to);
      return from !== undefined && to !== undefined ? `${from} -${link.type}-> ${to}` : null;
    })
    .filter((line): line is string => line !== null);

  const valueLines = values.map(valueLine).filter((line): line is string => line !== null);

  const graphBody: string[] = [];
  if (recordLines.length > 0) graphBody.push('Records:', ...recordLines);
  if (linkLines.length > 0) graphBody.push('Links:', ...linkLines);
  if (valueLines.length > 0) graphBody.push('Other values from the graph query:', ...valueLines);

  const graph = [GRAPH_CONTEXT_OPEN, ...graphBody, GRAPH_CONTEXT_CLOSE].join('\n');
  const documents =
    passageBlocks.length > 0
      ? `${DOCUMENT_CONTEXT_OPEN}\n${passageBlocks.join('\n\n')}\n${DOCUMENT_CONTEXT_CLOSE}`
      : `${DOCUMENT_CONTEXT_OPEN}\n${DOCUMENT_CONTEXT_CLOSE}`;

  const labels: Label[] = selection.kept.map((entry) =>
    entry.item.type === 'record' ? entry.item.record.label : entry.item.passage.label,
  );
  if (valueLines.length > 0) labels.push(clearance);

  const results: SearchResult[] = selection.entries.slice(0, maxResults).map(({ entry, inContext }, index) => {
    const base = { rank: index + 1, score: entry.score, foundBy: [...entry.foundBy], inContext };
    if (entry.item.type === 'record') {
      const { id, number, name, kind, label, keyFields } = entry.item.record;
      return { ...base, type: 'record', record: { id, number, name, kind, label, keyFields: { ...keyFields } } };
    }
    const { chunkId, documentId, documentName, documentKind, position, text, label, similarity } = entry.item.passage;
    return {
      ...base,
      type: 'passage',
      passage: { chunkId, documentId, documentName, documentKind, position, text, label, similarity },
    };
  });

  return { sources, context: { graph, documents }, label: highestLabel(labels), results };
}
