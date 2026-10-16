// Filling in a proposed record's approval form from what the extraction read (S5-006): the name, and
// each of Gemma's details that fits one of the kind's fields. Gemma writes its details as the
// document does (`{ severity: "High", status: "Contained", opened: "2026-05-03 14:22 UTC" }`), so a
// detail is used only when its key names the field (the field's own name, or a usual word for it)
// and its value is one the field allows: a listed choice (`High` is `high`, `Not implemented` is
// `not_implemented`), a whole number in range, a day, a moment, or plain text. Anything else is left
// for the Analyst. Nothing here decides: the form checks every value with the shared schema, and the
// API checks it again (D7).
import { createSchemas, type ProposedRecordKind } from '@grc/shared';
import { toLocalDateTime, type FormFieldDef, type FormValues } from '@/features/records/RecordForm';

/** A detail's key or a choice, compared without case, spaces or punctuation: `Incident Status`,
 * `incident_status` and `incidentStatus` are all `incidentstatus`. */
function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The other words a document uses for each field, as squashed keys. The field's own name always
 * counts. Keyed by field name, which is unique across the four kinds a proposal can be. */
const KEY_WORDS: Readonly<Record<string, readonly string[]>> = {
  // Risk
  impact: ['impact', 'severity'],
  likelihood: ['likelihood', 'probability'],
  financialExposure: ['exposure', 'financialimpact', 'estimatedloss', 'potentialloss', 'cost'],
  // Control
  code: ['controlcode', 'controlid', 'reference', 'ref'],
  framework: ['source', 'standard', 'frameworkname', 'catalog'],
  controlStatus: ['status', 'state', 'implementationstatus', 'implementation'],
  lastTestedDate: ['lasttested', 'tested', 'testeddate', 'lasttest', 'lasttestdate', 'testdate'],
  // Policy
  policyVersion: ['version', 'revision', 'policyrevision'],
  effectiveDate: ['effective', 'effectivefrom', 'dateeffective', 'effectiveon', 'date'],
  // Incident
  severity: ['severity', 'priority', 'level'],
  incidentStatus: ['status', 'state', 'incidentstate'],
  occurredAt: [
    'occurred',
    'occurredon',
    'opened',
    'openedat',
    'openedon',
    'createdat',
    'created',
    'detected',
    'detectedat',
    'reported',
    'reportedat',
    'date',
    'time',
    'timestamp',
    'when',
  ],
};

const pad = (n: number) => String(n).padStart(2, '0');

/** A select's choice for the value: one of its stored values or their words, ignoring case,
 * spaces and punctuation. For a whole-number select (risk impact and likelihood), `4`, `4/5` and
 * `4 out of 5` are 4. */
function fitChoice(def: FormFieldDef, value: string): string | undefined {
  const options = def.options ?? [];
  if (def.integer) {
    const n = /^(\d+)(?:\s*(?:\/|out of|of)\s*\d+)?$/i.exec(value.trim())?.[1];
    return n !== undefined ? options.find((o) => o.value === String(Number(n)))?.value : undefined;
  }
  const wanted = squash(value);
  if (wanted === '') return undefined;
  return options.find((o) => squash(o.value) === wanted || squash(o.label) === wanted)?.value;
}

/** Whole dollars: `250000`, `$250,000`, `250,000 USD` or `250000.00`; nothing with cents. */
function fitDollars(value: string): string | undefined {
  const plain = value
    .trim()
    .replace(/^(?:usd|us\$|\$)\s*/i, '')
    .replace(/\s*(?:usd|dollars)$/i, '')
    .replace(/[,\s]/g, '');
  const match = /^(\d+)(?:\.0+)?$/.exec(plain);
  if (!match) return undefined;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? String(n) : undefined;
}

/** A day written as `2026-06-30` at the start of the text (perhaps with a time after it), if that
 * day exists: the browser would read `2026-02-30` as March 2, so it is checked here. */
function isoDay(text: string): { day: string } | 'invalid' | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(text);
  if (!iso) return null;
  const [, y, m, d] = iso;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const real =
    date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d);
  return real ? { day: `${y}-${m}-${d}` } : 'invalid';
}

/** A date in words the browser reads (`June 30, 2026`), if the day it read is the one written: the
 * browser would read `February 30, 2026` as March 2. */
function wordsDate(text: string): Date | undefined {
  if (!/[a-z]/i.test(text) || !/\d{4}/.test(text)) return undefined;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return undefined;
  const days = (text.match(/\b\d{1,2}\b/g) ?? []).map(Number);
  return days.includes(date.getDate()) ? date : undefined;
}

/** A day as `2026-06-30`: written that way (perhaps with a time after it), or as a date in words,
 * such as `June 30, 2026` (taken as that day). */
function fitDay(value: string): string | undefined {
  const text = value.trim();
  const iso = isoDay(text);
  if (iso === 'invalid') return undefined;
  if (iso) return iso.day;
  const date = wordsDate(text);
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : undefined;
}

/** A moment, as the form's date-and-time input holds it (the person's own time). `2026-05-03
 * 14:22 UTC` and `2026-05-03T14:22:00Z` are read in UTC; a moment with no zone is taken as written,
 * in the person's own time; a bare day is that day at midnight. */
function fitMoment(value: string): string | undefined {
  let text = value.trim();
  const iso = isoDay(text);
  if (iso === 'invalid') return undefined;
  let date: Date | undefined;
  if (iso) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text = `${text}T00:00`;
    text = text.replace(/^(\d{4}-\d{2}-\d{2})\s+(?=\d)/, '$1T').replace(/\s*(?:UTC|GMT)$/i, 'Z');
    date = new Date(text);
  } else {
    date = wordsDate(text.replace(/\s*(?:UTC|GMT)$/i, ' UTC'));
  }
  if (!date || Number.isNaN(date.getTime())) return undefined;
  const local = toLocalDateTime(date.toISOString());
  return local === '' ? undefined : local;
}

/** The value the field takes for a detail, or undefined when it doesn't fit. */
export function fitValue(def: FormFieldDef, value: string): string | undefined {
  if (value.trim() === '') return undefined;
  if (def.control === 'select') return fitChoice(def, value);
  if (def.control === 'integer') return fitDollars(value);
  if (def.control === 'date') return fitDay(value);
  if (def.control === 'datetime') return fitMoment(value);
  return value.trim();
}

export interface Prefill {
  /** The form's starting values for the kind's own fields and the name. */
  values: FormValues;
  /** The fields filled in from a detail, by their labels, in the form's order. */
  filled: string[];
  /** The details that fit no field, as written. */
  unused: Array<{ key: string; value: string }>;
}

/** Whether a detail's key names this field. */
function keyNames(def: FormFieldDef, key: string): boolean {
  const k = squash(key);
  return k === squash(def.name) || (KEY_WORDS[def.name] ?? []).includes(k);
}

/**
 * The approval form's starting values for a proposed record of `kind`: its name as the document
 * wrote it, and each field filled from the first detail whose key names it and whose value fits.
 * A detail fills one field at most; a field's own name is tried before its other words, so
 * `{ status, incidentStatus }` fills the incident status from `incidentStatus`.
 */
export function prefillProposal(
  kind: ProposedRecordKind,
  fields: readonly FormFieldDef[],
  name: string,
  details: Readonly<Record<string, unknown>> | null | undefined,
): Prefill {
  const entries = Object.entries(details ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string');
  const used = new Set<string>();
  const values: FormValues = { name: name.trim() };
  const filled: string[] = [];
  const own = createSchemas[kind].shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;

  for (const def of fields) {
    values[def.name] = '';
    const ranked = [
      ...entries.filter(([key]) => squash(key) === squash(def.name)),
      ...entries.filter(([key]) => squash(key) !== squash(def.name) && keyNames(def, key)),
    ];
    for (const [key, value] of ranked) {
      if (used.has(key)) continue;
      const fit = fitValue(def, value);
      if (fit === undefined) continue;
      // The value as the API will take it must pass the shared schema's own check for the field.
      const sent =
        def.control === 'integer' || def.integer
          ? Number(fit)
          : def.control === 'datetime'
            ? new Date(fit).toISOString()
            : fit;
      if (own[def.name] && !own[def.name]!.safeParse(sent).success) continue;
      values[def.name] = fit;
      used.add(key);
      filled.push(def.label);
      break;
    }
  }

  const unused = entries.filter(([key]) => !used.has(key)).map(([key, value]) => ({ key, value }));
  return { values, filled, unused };
}
