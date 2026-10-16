// Our checks on an AI-written graph query, before anything is sent (S6-004, behaviour 3; D15, D52.2,
// D131, D144, SF-049; planner's reading). The AI proposes, our code decides (D45.6): a query that
// fails any check is refused, and the graph path falls back with `graph_query_refused`.
//
// The checks read the query's code, outside strings and comments, as `graph/query-guard.ts` does,
// with one difference: a backtick-quoted name is a name, not text, so it is read as the name it
// quotes (`` n.`sentence` `` is `n.sentence`). Refused:
// - `database_reference`: anything `assertNoDatabaseReference` refuses (USE, SHOW; D131).
// - `write_clause`: a write or admin clause (CREATE, MERGE, SET, DELETE, DETACH, REMOVE, DROP,
//   LOAD CSV, FOREACH, IN TRANSACTIONS, and INSERT, ALTER, GRANT, DENY, REVOKE, RENAME, TERMINATE).
// - `procedure`: a procedure call other than `db.index.fulltext.queryNodes`, or a function from a
//   namespace other than the built-in date, time, duration and point ones (a plugin's functions can
//   reach outside the database, D52.2).
// - `hidden_property`: any mention of `nameEmbedding`, `sentence`, `sourceDocId`, `chunkId` or the
//   audit outbox. An AI link's source comes back only through our code, which checks the asker's
//   clearance against the link's `sourceLabel` (SF-049).
// - `property_map`: reading all of a node's or link's properties at once: `properties()`, `keys()`
//   or a `{.*}` projection.
// - `dynamic_property`: a property named at run time, `x[...]` with anything but a whole-number
//   index or slice inside (a string, a parameter, a variable, an expression).
// - `parameter`: a parameter (`$x`); the query is sent with none.
// - `several_statements`: more than one statement (a `;` before the end).
// - `unreadable`: a string, quoted name or comment left open, or a query that isn't text, is
//   empty or is over 2,000 characters (fail safe).
// Pure: no I/O. The query itself is never logged; only the reason code is.
import { SEARCH_LIMITS } from '@grc/shared';
import { GraphQueryRefused, assertNoDatabaseReference } from '../../graph/query-guard.js';

export const QUERY_REFUSAL_REASONS = [
  'database_reference',
  'write_clause',
  'procedure',
  'hidden_property',
  'property_map',
  'dynamic_property',
  'parameter',
  'several_statements',
  'unreadable',
] as const;

export type QueryRefusalReason = (typeof QUERY_REFUSAL_REASONS)[number];

export type QueryCheck = { ok: true } | { ok: false; reason: QueryRefusalReason };

/** The one procedure a query may call. */
export const ALLOWED_PROCEDURE = 'db.index.fulltext.queryNodes';

/** The built-in function namespaces a query may use: dates, times, durations and points. */
const ALLOWED_FUNCTION_NAMESPACES = new Set([
  'date',
  'datetime',
  'localdatetime',
  'localtime',
  'time',
  'duration',
  'point',
]);

const WRITE_WORDS =
  /\b(?:CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|FOREACH|LOAD|INSERT|ALTER|GRANT|DENY|REVOKE|RENAME|TERMINATE|TRANSACTIONS)\b/i;

// Matched on names: a property, label, variable or backtick-quoted name holding any of these.
const HIDDEN_NAMES = /\b(?:nameEmbedding|sentence|sourceDocId|chunkId)\b|outbox/i;

const PROPERTY_MAP_CALL = /\b(?:properties|keys)\s*\(/i;
const ALL_PROPERTIES_PROJECTION = /[{,]\s*\.\s*\*/;

// One dotted name followed by `(`: a namespaced function, or a procedure after CALL.
const DOTTED_CALL = /\b([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)+)\s*\(/g;
const CALL_KEYWORD = /\bCALL\b/gi;

// Words after which `[` opens a list, not a subscript.
const LIST_AFTER = new Set([
  'ALL',
  'AND',
  'ANY',
  'AS',
  'ASC',
  'BY',
  'CALL',
  'CASE',
  'CONTAINS',
  'DESC',
  'DISTINCT',
  'ELSE',
  'ENDS',
  'IN',
  'IS',
  'LIMIT',
  'MATCH',
  'NOT',
  'OPTIONAL',
  'OR',
  'RETURN',
  'SKIP',
  'STARTS',
  'THEN',
  'UNION',
  'UNWIND',
  'WHEN',
  'WHERE',
  'WITH',
  'XOR',
  'YIELD',
]);

const WHOLE_NUMBER_INDEX = /^\s*-?\d+\s*$/;
const WHOLE_NUMBER_SLICE = /^\s*(?:-?\d+)?\s*\.\.\s*(?:-?\d+)?\s*$/;

// Strings, backtick-quoted names and comments, in the order they start.
const NOT_CODE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`((?:[^`]|``)*)`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
/** What a string becomes in the code: a name that is never a whole number, so `x['a']` stays refused. */
const STRING_STAND_IN = ' __text__ ';

/**
 * The query's code: each string as `STRING_STAND_IN`, each comment as a space, and each
 * backtick-quoted name as the name it quotes (anything but letters, digits and `_` as `_`).
 * Null when a string, quoted name or comment is left open.
 */
export function queryCode(query: string): string | null {
  const code = query.replace(NOT_CODE, (match: string, quoted: string | undefined) => {
    if (quoted !== undefined) return ` ${quoted.replace(/``/g, '`').replace(/\W/g, '_')} `;
    if (match.startsWith("'") || match.startsWith('"')) return STRING_STAND_IN;
    return ' ';
  });
  if (/['"`]|\/\*/.test(code)) return null;
  return code;
}

/** True when `code` has a subscript (`x[...]`) with anything but a whole-number index or slice. */
function hasDynamicSubscript(code: string): boolean {
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '[') continue;
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j]!)) j--;
    if (j < 0) continue;
    const before = code[j]!;
    let subscript = before === ')' || before === ']' || before === '}';
    if (!subscript && /\w/.test(before)) {
      let k = j;
      while (k >= 0 && /\w/.test(code[k]!)) k--;
      const word = code.slice(k + 1, j + 1);
      subscript = !LIST_AFTER.has(word.toUpperCase());
    }
    if (!subscript) continue;
    // The subscript's contents, up to its matching `]`.
    let depth = 0;
    let end = -1;
    for (let m = i; m < code.length; m++) {
      if (code[m] === '[') depth++;
      else if (code[m] === ']') {
        depth--;
        if (depth === 0) {
          end = m;
          break;
        }
      }
    }
    if (end === -1) return true;
    const inside = code.slice(i + 1, end);
    if (!WHOLE_NUMBER_INDEX.test(inside) && !WHOLE_NUMBER_SLICE.test(inside)) return true;
  }
  return false;
}

/** True when `code` calls a procedure other than the allowed one, or a namespaced function outside
 * the built-in ones. */
function hasOtherRoutine(code: string): boolean {
  for (const match of code.matchAll(CALL_KEYWORD)) {
    const rest = code.slice(match.index + match[0].length);
    const next = /^\s*(\S)/.exec(rest)?.[1];
    // CALL { … } and CALL (x) { … } are subqueries.
    if (next === '{' || next === '(') continue;
    const name = /^\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)/.exec(rest)?.[1];
    if (name === undefined || name.replace(/\s+/g, '').toLowerCase() !== ALLOWED_PROCEDURE.toLowerCase()) return true;
  }
  for (const match of code.matchAll(DOTTED_CALL)) {
    // The procedure after CALL was checked above.
    if (/\bCALL\s*$/i.test(code.slice(0, match.index))) continue;
    const namespace = (match[1] ?? '').split('.')[0]!.trim().toLowerCase();
    if (!ALLOWED_FUNCTION_NAMESPACES.has(namespace)) return true;
  }
  return false;
}

/** Checks an AI-written query before it is sent. Pure; never throws. */
export function checkGraphQuery(query: unknown): QueryCheck {
  if (typeof query !== 'string') return { ok: false, reason: 'unreadable' };
  const text = query.trim();
  if (text === '' || text.length > SEARCH_LIMITS.graphQueryMaxLength) return { ok: false, reason: 'unreadable' };
  try {
    assertNoDatabaseReference(text);
  } catch (err) {
    if (err instanceof GraphQueryRefused) return { ok: false, reason: 'database_reference' };
    return { ok: false, reason: 'unreadable' };
  }
  const code = queryCode(text);
  if (code === null) return { ok: false, reason: 'unreadable' };
  const body = code.trimEnd().replace(/;$/, '');
  if (body.includes(';')) return { ok: false, reason: 'several_statements' };
  if (body.includes('$')) return { ok: false, reason: 'parameter' };
  if (WRITE_WORDS.test(body)) return { ok: false, reason: 'write_clause' };
  if (HIDDEN_NAMES.test(body)) return { ok: false, reason: 'hidden_property' };
  if (PROPERTY_MAP_CALL.test(body) || ALL_PROPERTIES_PROJECTION.test(body))
    return { ok: false, reason: 'property_map' };
  if (hasOtherRoutine(body)) return { ok: false, reason: 'procedure' };
  if (hasDynamicSubscript(body)) return { ok: false, reason: 'dynamic_property' };
  return { ok: true };
}
