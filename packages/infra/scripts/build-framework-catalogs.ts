// Builds the NIST framework catalogs and NIST's own cross-framework mappings (S2-002, D20, D66,
// D212 (1), D212 (4)) from files downloaded once, by hand, into a folder outside the repo:
//
//   pnpm --filter infra exec tsx scripts/build-framework-catalogs.ts --sources <dir> [--out <dir>]
//
// - What to download is listed in `framework-sources.json` beside this script. Only NIST-authored
//   files from NIST's own sites are accepted: any entry whose author isn't NIST or whose address
//   isn't on csrc.nist.gov, nvlpubs.nist.gov, www.nist.gov or NIST's `usnistgov` GitHub account
//   is refused. Third-party OLIR submissions are never listed.
// - It writes `nist-800-53.json`, `nist-csf-2.json`, `map-csf-2-to-800-53.json`,
//   `map-800-53-to-iso-27001.json` and `SOURCES.md` into `packages/api/src/frameworks/catalogs/`
//   (or `--out`). The ISO 27001 and SOC 2 catalogs there are written by hand (D20) and only read.
//   Every file carries its `source` (address, release, download date, SHA-256 of the original).
// - NIST IDs are kept exactly as published, never re-cased, re-padded or rewritten. An 800-53
//   control's code is its published label (`AC-2(1)`). NIST's mapping spreadsheets cite controls
//   by their zero-padded label (`AC-02(01)`), which the OSCAL catalog publishes on the same control,
//   so a mapping end is found through the catalog's own labels, not by changing the text.
// - A mapping pair is left out, and counted in SOURCES.md, when an end is withdrawn, isn't in our
//   catalogs, or names something that isn't a requirement (an 800-53 family, a CSF function or
//   category, a clause of ISO 27001's main body). Any other ID that doesn't fit our code pattern
//   stops the build with an error naming it.
// - The same downloads give byte-identical output (D45.8). Nothing here runs in the app, and the
//   API never imports this file (D63): the app only reads the committed JSON.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import {
  CODE_PATTERNS,
  FRAMEWORKS,
  groupOf,
  parentCodeOf,
  sortKeyOf,
  type CatalogMapping,
  type CatalogRequirement,
  type FrameworkKey,
} from '../../shared/src/frameworks/index.js';
import {
  CATALOG_DIR,
  CATALOG_FILE_NAMES,
  checkCatalogFiles,
  isNistSourceUrl,
  MAPPING_FILE_SPECS,
  NIST_HOSTS,
  type CatalogFile,
  type CatalogSource,
  type MappingFile,
} from '../../api/src/frameworks/catalog-files.js';

// ---------------------------------------------------------------------------------------------
// Hashes and the sources list
// ---------------------------------------------------------------------------------------------

/** The lowercase hex SHA-256 of `bytes`. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The files the converter writes from NIST's downloads, in build order. */
export const NIST_OUTPUTS = [
  'nist-800-53.json',
  'nist-csf-2.json',
  'map-csf-2-to-800-53.json',
  'map-800-53-to-iso-27001.json',
] as const;

export type NistOutput = (typeof NIST_OUTPUTS)[number];

/** One NIST file to download: where it comes from and which output it builds. */
export interface SourceEntry {
  /** The file written under `packages/api/src/frameworks/catalogs/`. */
  output: NistOutput;
  /** The downloaded original's name in the `--sources` folder. */
  file: string;
  publisher: string;
  author: string;
  documentTitle: string;
  /** The exact download address. */
  url: string;
  /** NIST's release or version string, as published. */
  release: string;
  /** The day the original was downloaded (YYYY-MM-DD). */
  downloadedOn: string;
}

const ENTRY_FIELDS = ['output', 'file', 'publisher', 'author', 'documentTitle', 'url', 'release', 'downloadedOn'];

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Checks the parsed `framework-sources.json`. Refuses an entry whose author or publisher isn't
 * NIST or whose address isn't on one of NIST's own sites, and anything malformed. */
export function checkSourceEntries(list: unknown): SourceEntry[] {
  const files = list && typeof list === 'object' && !Array.isArray(list) ? (list as { files?: unknown }).files : null;
  if (!Array.isArray(files)) throw new Error('framework sources: expected { "files": [ ... ] }');
  const extra = Object.keys(list as object).filter((key) => key !== 'files');
  if (extra.length > 0) throw new Error(`framework sources: unknown field ${extra[0]}`);
  const seen = new Set<string>();
  return files.map((raw, index): SourceEntry => {
    const at = `framework sources: files[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${at}: not an object`);
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!ENTRY_FIELDS.includes(key)) throw new Error(`${at}: unknown field ${key}`);
    }
    for (const key of ENTRY_FIELDS) {
      const value = entry[key];
      if (typeof value !== 'string' || !/\S/.test(value) || value !== value.trim()) {
        throw new Error(`${at}: ${key} must be a non-blank string with no outer spaces`);
      }
    }
    const value = entry as unknown as SourceEntry;
    const name = `${at} (${value.output})`;
    if (!(NIST_OUTPUTS as readonly string[]).includes(value.output)) {
      throw new Error(`${name}: unknown output; expected one of ${NIST_OUTPUTS.join(', ')}`);
    }
    if (seen.has(value.output)) throw new Error(`${name}: the output is listed twice`);
    seen.add(value.output);
    if (value.author !== 'NIST') throw new Error(`${name}: refused: the author must be NIST (D212 (1))`);
    if (value.publisher !== 'NIST') throw new Error(`${name}: refused: the publisher must be NIST`);
    if (!isNistSourceUrl(value.url)) {
      throw new Error(`${name}: refused: ${value.url} is not on one of NIST's sites (${NIST_HOSTS.join(', ')})`);
    }
    if (value.file.includes('/') || value.file.includes('\\') || value.file.startsWith('.')) {
      throw new Error(`${name}: file must be a plain file name inside the sources folder`);
    }
    if (!isIsoDate(value.downloadedOn)) throw new Error(`${name}: downloadedOn must be a date (YYYY-MM-DD)`);
    return {
      output: value.output,
      file: value.file,
      publisher: value.publisher,
      author: value.author,
      documentTitle: value.documentTitle,
      url: value.url,
      release: value.release,
      downloadedOn: value.downloadedOn,
    };
  });
}

/** The `source` written beside a NIST file's data: the entry plus the original's SHA-256. */
export function sourceFor(entry: SourceEntry, bytes: Uint8Array): CatalogSource {
  return {
    publisher: entry.publisher,
    author: entry.author,
    documentTitle: entry.documentTitle,
    url: entry.url,
    release: entry.release,
    downloadedOn: entry.downloadedOn,
    sha256: sha256Hex(bytes),
  };
}

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

/** Collapses runs of white space to one space and trims. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function byNaturalOrder(key: FrameworkKey) {
  return (a: CatalogRequirement, b: CatalogRequirement): number => {
    const x = sortKeyOf(key, a.code);
    const y = sortKeyOf(key, b.code);
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

/** Sorts a converted catalog, refusing duplicate codes and enhancements without their base. */
function finishCatalog(key: FrameworkKey, source: CatalogSource, requirements: CatalogRequirement[]): CatalogFile {
  requirements.sort(byNaturalOrder(key));
  const codes = new Set<string>();
  for (const requirement of requirements) {
    if (codes.has(requirement.code)) throw new Error(`${key}: ${requirement.code} is published twice`);
    codes.add(requirement.code);
  }
  for (const requirement of requirements) {
    const parent = parentCodeOf(key, requirement.code);
    if (parent !== null && !codes.has(parent)) {
      throw new Error(`${key}: ${requirement.code} is an enhancement of ${parent}, which isn't in the catalog`);
    }
  }
  if (requirements.length === 0) throw new Error(`${key}: no requirements found`);
  return { key, frameworkVersion: FRAMEWORKS[key].frameworkVersion, source, requirements };
}

function checkGroup(key: FrameworkKey, code: string): string {
  const group = groupOf(key, code);
  if (!Object.hasOwn(FRAMEWORKS[key].groupNames, group)) {
    throw new Error(`${key}: ${code} is in group ${group}, which isn't one of the framework's groups`);
  }
  return group;
}

// ---------------------------------------------------------------------------------------------
// NIST SP 800-53 Rev 5 (OSCAL catalog JSON)
// ---------------------------------------------------------------------------------------------

interface OscalProp {
  name?: unknown;
  value?: unknown;
  class?: unknown;
}

interface OscalPart {
  id?: unknown;
  name?: unknown;
  props?: unknown;
  prose?: unknown;
  parts?: unknown;
}

interface OscalParam {
  id?: unknown;
  label?: unknown;
  props?: unknown;
  select?: { 'how-many'?: unknown; choice?: unknown };
}

interface OscalControl {
  id?: unknown;
  title?: unknown;
  props?: unknown;
  params?: unknown;
  parts?: unknown;
  controls?: unknown;
}

interface OscalGroup {
  id?: unknown;
  groups?: unknown;
  controls?: unknown;
}

function list<T>(value: unknown, what: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`800-53 OSCAL: ${what} is not a list`);
  return value as T[];
}

function idOf(item: { id?: unknown }, what: string): string {
  if (typeof item.id !== 'string' || !item.id) throw new Error(`800-53 OSCAL: a ${what} has no id`);
  return item.id;
}

function propsOf(item: { props?: unknown }, id: string): OscalProp[] {
  return list<OscalProp>(item.props, `the props of ${id}`);
}

/** The OSCAL catalog object, after checking its release against the sources list. */
function oscalCatalog(oscal: unknown, release: string | null): { groups: OscalGroup[]; controls: OscalControl[] } {
  const catalog =
    oscal && typeof oscal === 'object' ? (oscal as { catalog?: Record<string, unknown> }).catalog : undefined;
  if (!catalog || typeof catalog !== 'object') throw new Error('800-53 OSCAL: no catalog object');
  const metadata = catalog.metadata as { version?: unknown } | undefined;
  if (release !== null && metadata?.version !== release) {
    throw new Error(`800-53 OSCAL: the catalog's version is ${String(metadata?.version)}, not the listed ${release}`);
  }
  return {
    groups: list<OscalGroup>(catalog.groups, 'the catalog groups'),
    controls: list<OscalControl>(catalog.controls, 'the catalog controls'),
  };
}

interface FoundControl {
  control: OscalControl;
  id: string;
  /** The family the control sits in, from its OSCAL group (for a cross-check only). */
  family: string | null;
}

/** Every control and enhancement, depth first, in the catalog's own order. */
function allControls(oscal: unknown, release: string | null): FoundControl[] {
  const { groups, controls } = oscalCatalog(oscal, release);
  const found: FoundControl[] = [];
  const walkControls = (items: OscalControl[], family: string | null) => {
    for (const control of items) {
      found.push({ control, id: idOf(control, 'control'), family });
      walkControls(list<OscalControl>(control.controls, `the enhancements of ${String(control.id)}`), family);
    }
  };
  const walkGroups = (items: OscalGroup[]) => {
    for (const group of items) {
      const family = idOf(group, 'group').toUpperCase();
      walkControls(list<OscalControl>(group.controls, `the controls of group ${family}`), family);
      walkGroups(list<OscalGroup>(group.groups, `the groups of ${family}`));
    }
  };
  walkGroups(groups);
  walkControls(controls, null);
  return found;
}

/** The control's published label: the `label` prop with no class (`AC-2(1)`), exactly as written. */
function publishedLabel(control: OscalControl, id: string): string {
  const labels = propsOf(control, id).filter((prop) => prop.name === 'label' && prop.class === undefined);
  if (labels.length !== 1 || typeof labels[0]!.value !== 'string') {
    throw new Error(`800-53 OSCAL: control ${id} must have exactly one published label`);
  }
  return labels[0]!.value;
}

function isWithdrawn(control: OscalControl, id: string): boolean {
  return propsOf(control, id).some(
    (prop) => prop.name === 'status' && typeof prop.value === 'string' && prop.value.toLowerCase() === 'withdrawn',
  );
}

const INSERT = /\{\{\s*insert:\s*([\w-]+)\s*,\s*([^\s}]+)\s*\}\}/g;
const MAX_PARAM_DEPTH = 5;

/** Writes a parameter the way NIST prints the controls: `[Assignment: organization-defined …]` or
 * `[Selection (one or more): a; b]`. */
function renderParam(params: Map<string, OscalParam>, paramId: string, controlId: string, depth: number): string {
  const param = params.get(paramId);
  if (!param) throw new Error(`800-53 OSCAL: control ${controlId} uses parameter ${paramId}, which isn't defined`);
  if (depth > MAX_PARAM_DEPTH) throw new Error(`800-53 OSCAL: parameter ${paramId} nests too deeply`);
  if (param.select !== undefined) {
    const choices = list<unknown>(param.select.choice, `the choices of ${paramId}`).map((choice) => {
      if (typeof choice !== 'string')
        throw new Error(`800-53 OSCAL: parameter ${paramId} has a choice that isn't text`);
      return renderProse(params, choice, controlId, depth + 1);
    });
    if (choices.length === 0) throw new Error(`800-53 OSCAL: parameter ${paramId} has no choices`);
    const howMany = param.select['how-many'];
    let head: string;
    if (howMany === 'one-or-more') head = 'Selection (one or more)';
    else if (howMany === undefined || howMany === 'one') head = 'Selection';
    else throw new Error(`800-53 OSCAL: parameter ${paramId} has an unknown how-many`);
    return `[${head}: ${choices.join('; ')}]`;
  }
  const altLabel = list<OscalProp>(param.props, `the props of ${paramId}`).find(
    (prop) => prop.name === 'alt-label' && prop.class === 'sp800-53',
  )?.value;
  const label = typeof altLabel === 'string' ? altLabel : param.label;
  if (typeof label !== 'string' || !/\S/.test(label)) {
    throw new Error(`800-53 OSCAL: parameter ${paramId} has neither a label nor a selection`);
  }
  const text = squash(label);
  return `[Assignment: ${/^organization-defined\b/.test(text) ? text : `organization-defined ${text}`}]`;
}

function renderProse(params: Map<string, OscalParam>, prose: string, controlId: string, depth = 0): string {
  // OSCAL sometimes leaves a space between an insert and the punctuation after it (`}} ; and`);
  // NIST's printed text has none (`]; and`).
  const tight = prose.replace(/(\}\})\s+(?=[;,.:)])/g, '$1');
  return squash(
    tight.replace(INSERT, (_match, kind: string, target: string) => {
      if (kind !== 'param') throw new Error(`800-53 OSCAL: control ${controlId} has an unknown insert (${kind})`);
      return renderParam(params, target, controlId, depth);
    }),
  );
}

function partLabel(part: OscalPart, controlId: string): string {
  const label = list<OscalProp>(part.props, `the props of a part of ${controlId}`).find(
    (prop) => prop.name === 'label' && prop.class === undefined,
  )?.value;
  return typeof label === 'string' ? squash(label) : '';
}

/** The statement as plain text: one line per item, each starting with its own label (`a.`, `1.`). */
function statementLines(params: Map<string, OscalParam>, part: OscalPart, controlId: string): string[] {
  const lines: string[] = [];
  const prose = typeof part.prose === 'string' ? renderProse(params, part.prose, controlId) : '';
  const line = [partLabel(part, controlId), prose].filter(Boolean).join(' ');
  if (line) lines.push(line);
  for (const child of list<OscalPart>(part.parts, `the parts of ${controlId}`)) {
    if (child.name !== 'item') {
      throw new Error(`800-53 OSCAL: the statement of ${controlId} has a part that isn't an item`);
    }
    lines.push(...statementLines(params, child, controlId));
  }
  return lines;
}

function paramIndex(controls: FoundControl[]): Map<string, OscalParam> {
  const params = new Map<string, OscalParam>();
  for (const { control, id } of controls) {
    for (const param of list<OscalParam>(control.params, `the params of ${id}`)) {
      const paramId = idOf(param, `parameter of ${id}`);
      if (params.has(paramId)) throw new Error(`800-53 OSCAL: parameter ${paramId} is defined twice`);
      params.set(paramId, param);
    }
  }
  return params;
}

/** NIST SP 800-53 Rev 5 from NIST's OSCAL catalog: every control and enhancement not withdrawn.
 * `code` is the published label unchanged, `title` the OSCAL title, `description` the statement as
 * plain text, `group` the family. Throws, naming the control, on a label that doesn't fit our code
 * pattern, and when the catalog's version isn't `source.release`. */
export function convert80053(oscal: unknown, source: CatalogSource): CatalogFile {
  const controls = allControls(oscal, source.release);
  const params = paramIndex(controls);
  const requirements: CatalogRequirement[] = [];
  for (const { control, id, family } of controls) {
    const label = publishedLabel(control, id);
    if (isWithdrawn(control, id)) continue;
    if (!CODE_PATTERNS.nist_800_53.test(label)) {
      throw new Error(`800-53 OSCAL: control ${id} has the label "${label}", which isn't an 800-53 code we know`);
    }
    const group = checkGroup('nist_800_53', label);
    if (family !== null && family !== group) {
      throw new Error(`800-53 OSCAL: control ${label} sits in family ${family}, not ${group}`);
    }
    const title = typeof control.title === 'string' ? squash(control.title) : '';
    if (!title) throw new Error(`800-53 OSCAL: control ${label} has no title`);
    const statement = list<OscalPart>(control.parts, `the parts of ${id}`).find((part) => part.name === 'statement');
    if (!statement) throw new Error(`800-53 OSCAL: control ${label} has no statement`);
    const description = statementLines(params, statement, id).join('\n');
    if (!description) throw new Error(`800-53 OSCAL: control ${label} has an empty statement`);
    requirements.push({ code: label, title, description, group });
  }
  return finishCatalog('nist_800_53', source, requirements);
}

/** Every label the OSCAL catalog publishes for a control (`AC-2(1)`, and the zero-padded
 * `AC-02(01)` NIST's spreadsheets use) to our code, or to `null` for a withdrawn control. */
export function oscalLabelIndex(oscal: unknown): CodeIndex {
  const ids = new Map<string, string | null>();
  for (const { control, id } of allControls(oscal, null)) {
    const code = isWithdrawn(control, id) ? null : publishedLabel(control, id);
    for (const prop of propsOf(control, id)) {
      if (prop.name !== 'label' || typeof prop.value !== 'string') continue;
      const known = ids.get(prop.value);
      if (known !== undefined && known !== code) {
        throw new Error(`800-53 OSCAL: the label ${prop.value} names two different controls`);
      }
      ids.set(prop.value, code);
    }
  }
  return { framework: 'nist_800_53', ids };
}

// ---------------------------------------------------------------------------------------------
// NIST CSF 2.0 (JSON export of NIST's Cybersecurity and Privacy Reference Tool)
// ---------------------------------------------------------------------------------------------

interface CprtElement {
  element_type?: unknown;
  element_identifier?: unknown;
  title?: unknown;
  text?: unknown;
  doc_identifier?: unknown;
}

interface CprtRelationship {
  source_element_identifier?: unknown;
  dest_element_identifier?: unknown;
  relationship_identifier?: unknown;
}

interface CsfContent {
  subcategories: CprtElement[];
  categories: Set<string>;
  withdrawn: Set<string>;
}

const CSF_DOCUMENT = 'CSF_2_0_0';

function csfContent(csf: unknown, release: string | null): CsfContent {
  const elements =
    csf && typeof csf === 'object'
      ? (csf as { response?: { elements?: Record<string, unknown> } }).response?.elements
      : undefined;
  if (!elements || typeof elements !== 'object') throw new Error('CSF 2.0: expected { response: { elements } }');
  const documents = Array.isArray(elements.documents) ? (elements.documents as Record<string, unknown>[]) : [];
  const document = documents.find((doc) => doc.doc_identifier === CSF_DOCUMENT);
  if (!document) throw new Error(`CSF 2.0: the export has no ${CSF_DOCUMENT} document`);
  const version = typeof document.version === 'string' ? squash(document.version).replace(/^version\s+/i, '') : '';
  if (release !== null && version !== release) {
    throw new Error(`CSF 2.0: the document's version is ${version || 'missing'}, not the listed ${release}`);
  }
  if (!Array.isArray(elements.elements) || !Array.isArray(elements.relationships)) {
    throw new Error('CSF 2.0: the export has no elements or relationships list');
  }
  const own = (elements.elements as CprtElement[]).filter((element) => element.doc_identifier === CSF_DOCUMENT);
  const reasons = new Set(
    own.filter((element) => element.element_type === 'withdraw_reason').map((element) => element.element_identifier),
  );
  // An element is withdrawn when it points at a withdrawal reason (`ID.BE-02` -> `WR-ID.BE-02`).
  const withdrawn = new Set<string>();
  for (const link of elements.relationships as CprtRelationship[]) {
    if (typeof link.source_element_identifier === 'string' && reasons.has(link.dest_element_identifier)) {
      withdrawn.add(link.source_element_identifier);
    }
  }
  const categories = new Set<string>();
  for (const element of own) {
    if (element.element_type === 'category' && typeof element.element_identifier === 'string') {
      if (!withdrawn.has(element.element_identifier)) categories.add(element.element_identifier);
    }
  }
  return {
    subcategories: own.filter((element) => element.element_type === 'subcategory'),
    categories,
    withdrawn,
  };
}

const TITLE_MAX = 80;
const MIN_CLAUSE = 20;
const CLAUSE_BREAKS = [', and ', ', including ', ' - ', '; ', ': '];
const JOINING_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'to',
  'which',
  'with',
]);

/** A short title for a CSF subcategory, which has none of its own: the outcome when it's short,
 * else its first clause (the text before the first clause break, when that text is one simple
 * clause: it has its verb and no comma, so a list such as `established, communicated, and
 * maintained` is never cut), else the outcome cut at a word boundary with an ellipsis. Never longer
 * than 80 characters. */
export function csfShortTitle(outcome: string): string {
  const text = squash(outcome);
  if (text.length <= TITLE_MAX) return text;
  let clauseEnd = -1;
  for (const mark of CLAUSE_BREAKS) {
    const at = text.indexOf(mark);
    if (at >= MIN_CLAUSE && at <= TITLE_MAX && (clauseEnd < 0 || at < clauseEnd)) {
      const clause = text.slice(0, at);
      if (/ (is|are) /.test(clause) && !clause.includes(',')) clauseEnd = at;
    }
  }
  if (clauseEnd > 0) return text.slice(0, clauseEnd).trim();
  // Leave room for the ellipsis.
  const words = text.slice(0, TITLE_MAX - 1).split(' ');
  if (text[TITLE_MAX - 1] !== ' ' && words.length > 1) words.pop();
  const strip = (word: string) => word.toLowerCase().replace(/[,;:-]+$/, '');
  while (words.length > 1 && (JOINING_WORDS.has(strip(words.at(-1)!)) || strip(words.at(-1)!) === '')) words.pop();
  return `${words.join(' ').replace(/[\s,;:-]+$/, '')}…`;
}

/** NIST CSF 2.0 from the Reference Tool's JSON export: the subcategories that aren't withdrawn.
 * `code` is NIST's identifier as published (`GV.OC-01`), `description` the outcome, `title` a short
 * form of it, `group` the category. Throws, naming it, on an identifier that doesn't fit our code
 * pattern, and when the document's version isn't `source.release`. */
export function convertCsf2(csf: unknown, source: CatalogSource): CatalogFile {
  const content = csfContent(csf, source.release);
  const requirements: CatalogRequirement[] = [];
  for (const element of content.subcategories) {
    const code = element.element_identifier;
    if (typeof code !== 'string') throw new Error('CSF 2.0: a subcategory has no identifier');
    if (content.withdrawn.has(code)) continue;
    if (!CODE_PATTERNS.nist_csf_2.test(code)) {
      throw new Error(`CSF 2.0: subcategory "${code}" doesn't fit the CSF 2.0 code pattern`);
    }
    const group = checkGroup('nist_csf_2', code);
    if (!content.categories.has(group))
      throw new Error(`CSF 2.0: ${code} belongs to category ${group}, which isn't live`);
    const description = typeof element.text === 'string' ? squash(element.text) : '';
    if (!description) throw new Error(`CSF 2.0: subcategory ${code} has no outcome text`);
    requirements.push({ code, title: csfShortTitle(description), description, group });
  }
  return finishCatalog('nist_csf_2', source, requirements);
}

/** Every CSF 2.0 subcategory identifier to our code, or to `null` for a withdrawn one. */
export function csfIndex(csf: unknown): CodeIndex {
  const content = csfContent(csf, null);
  const ids = new Map<string, string | null>();
  for (const element of content.subcategories) {
    const code = element.element_identifier;
    if (typeof code === 'string') ids.set(code, content.withdrawn.has(code) ? null : code);
  }
  return { framework: 'nist_csf_2', ids };
}

/** A hand-written catalog's codes, each to itself. */
export function catalogIndex(catalog: CatalogFile): CodeIndex {
  return { framework: catalog.key, ids: new Map(catalog.requirements.map((r) => [r.code, r.code])) };
}

// ---------------------------------------------------------------------------------------------
// NIST's mapping spreadsheets (OLIR relationship workbooks, .xlsx)
// ---------------------------------------------------------------------------------------------

export interface XlsxRow {
  /** The spreadsheet's own row number (1-based). */
  row: number;
  /** Cell text by column (0 = A); `undefined` for an empty cell. */
  cells: (string | undefined)[];
}

export interface XlsxSheet {
  name: string;
  hidden: boolean;
  rows: XlsxRow[];
}

/** The files inside a ZIP archive (an .xlsx is one), read with Node's own inflate. */
function unzip(bytes: Uint8Array): (name: string) => Buffer | null {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const EOCD = 0x06054b50;
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 0xffff); at--) {
    if (data.readUInt32LE(at) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('xlsx: not a ZIP archive');
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const entries = new Map<string, { method: number; size: number; offset: number; flags: number }>();
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error('xlsx: a broken ZIP directory');
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const size = data.readUInt32LE(at + 20);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const offset = data.readUInt32LE(at + 42);
    const name = data.toString('utf8', at + 46, at + 46 + nameLength);
    if (size === 0xffffffff || offset === 0xffffffff) throw new Error('xlsx: ZIP64 archives are not supported');
    entries.set(name, { method, size, offset, flags });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return (name) => {
    const entry = entries.get(name);
    if (!entry) return null;
    if (entry.flags & 1) throw new Error(`xlsx: ${name} is encrypted`);
    if (data.readUInt32LE(entry.offset) !== 0x04034b50) throw new Error(`xlsx: a broken ZIP entry (${name})`);
    const start = entry.offset + 30 + data.readUInt16LE(entry.offset + 26) + data.readUInt16LE(entry.offset + 28);
    const raw = data.subarray(start, start + entry.size);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`xlsx: ${name} uses an unsupported compression method`);
  };
}

function decodeXml(text: string): string {
  return text
    .replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (_match, entity: string) => {
      switch (entity) {
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        case 'amp':
          return '&';
        default:
          return String.fromCodePoint(
            entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10),
          );
      }
    })
    .replace(/_x([0-9a-fA-F]{4})_/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1]!) : undefined;
}

/** The text of an `<si>` or `<is>` element: its `<t>` runs, without phonetic hints. */
function runText(xml: string): string {
  const body = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const match of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(match[1]!);
  return out;
}

function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1];
  if (!letters) return -1;
  let n = 0;
  for (const letter of letters) n = n * 26 + (letter.charCodeAt(0) - 64);
  return n - 1;
}

function cellText(attrs: string, body: string, shared: string[]): string | undefined {
  const type = attribute(attrs, 't');
  if (type === 'inlineStr') return runText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
  const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
  if (value === undefined) return undefined;
  if (type === 's') {
    const text = shared[Number(value)];
    if (text === undefined) throw new Error('xlsx: a cell points at a missing shared string');
    return text;
  }
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  if (type === 'str' || type === 'e') return decodeXml(value);
  const number = Number(value);
  // A number cell shows its shortest form, as Excel does (`9.2`, not `9.1999999999999993`).
  return Number.isFinite(number) ? String(number) : decodeXml(value);
}

/** Every sheet of an .xlsx workbook with its cell text, read without any package. */
export function readXlsx(bytes: Uint8Array): XlsxSheet[] {
  const read = unzip(bytes);
  const text = (name: string) => read(name)?.toString('utf8') ?? null;
  const workbook = text('xl/workbook.xml');
  const rels = text('xl/_rels/workbook.xml.rels');
  if (workbook === null || rels === null) throw new Error('xlsx: not a spreadsheet (no workbook)');
  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attribute(match[1]!, 'Id');
    const target = attribute(match[1]!, 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const sharedXml = text('xl/sharedStrings.xml');
  const shared = sharedXml === null ? [] : [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runText(m[1]!));
  const sheets: XlsxSheet[] = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attribute(match[1]!, 'name') ?? '';
    const target = targets.get(attribute(match[1]!, 'r:id') ?? '');
    const xml = target ? text(target) : null;
    if (xml === null) throw new Error(`xlsx: sheet "${name}" is missing`);
    const rows: XlsxRow[] = [];
    let lastRow = 0;
    for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const number = Number(attribute(row[1]!, 'r') ?? lastRow + 1);
      lastRow = number;
      const cells: (string | undefined)[] = [];
      let lastColumn = -1;
      for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attribute(cell[1]!, 'r');
        const column = ref ? columnIndex(ref) : lastColumn + 1;
        lastColumn = column;
        cells[column] = cellText(cell[1]!, cell[2] ?? '', shared);
      }
      rows.push({ row: number, cells });
    }
    sheets.push({
      name,
      hidden: attribute(match[1]!, 'state') !== undefined && attribute(match[1]!, 'state') !== 'visible',
      rows,
    });
  }
  return sheets;
}

/** One relationship as NIST's spreadsheet gives it: the two IDs as written, and where it sits. */
export interface MappingRow {
  from: string;
  to: string;
  where: string;
}

const FOCAL_HEADER = 'focal document element';
const REFERENCE_HEADER = 'reference document element';

/** The relationship rows of an OLIR workbook: on every visible sheet whose header row has the
 * "Focal Document Element" and "Reference Document Element" columns, each row with both cells. */
export function olirMappingRows(sheets: readonly XlsxSheet[]): MappingRow[] {
  const rows: MappingRow[] = [];
  let found = false;
  for (const sheet of sheets) {
    if (sheet.hidden) continue;
    const [header, ...body] = sheet.rows.filter((row) =>
      row.cells.some((cell) => cell !== undefined && /\S/.test(cell)),
    );
    if (!header) continue;
    const names = header.cells.map((cell) => (cell === undefined ? '' : squash(cell).toLowerCase()));
    const fromColumn = names.indexOf(FOCAL_HEADER);
    const toColumn = names.indexOf(REFERENCE_HEADER);
    if (fromColumn < 0 || toColumn < 0) continue;
    found = true;
    for (const row of body) {
      const from = row.cells[fromColumn]?.trim() ?? '';
      const to = row.cells[toColumn]?.trim() ?? '';
      const where = `sheet "${sheet.name}" row ${row.row}`;
      if (!to) continue;
      if (!from) throw new Error(`OLIR workbook: ${where} has a reference but no focal element`);
      rows.push({ from, to, where });
    }
  }
  if (!found)
    throw new Error('OLIR workbook: no sheet has Focal Document Element and Reference Document Element columns');
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------------------------

/** The IDs NIST may cite for a framework, as published, each to our code (`null`: withdrawn). */
export interface CodeIndex {
  framework: FrameworkKey;
  ids: ReadonlyMap<string, string | null>;
}

/** Element IDs that are real parts of the framework but not requirements in our catalogs: an
 * 800-53 family, a CSF function or category, a clause of ISO 27001's main body (4 to 10). */
const NOT_A_REQUIREMENT: Readonly<Record<FrameworkKey, (id: string) => boolean>> = {
  nist_800_53: (id) => /^[A-Z]{2}$/.test(id) && Object.hasOwn(FRAMEWORKS.nist_800_53.groupNames, id),
  nist_csf_2: (id) => /^(GV|ID|PR|DE|RS|RC)(\.[A-Z]{2})?$/.test(id),
  iso_27001: (id) => /^([4-9]|10)(\.\d{1,2}){0,3}$/.test(id),
  soc_2: () => false,
};

export type LeftOutReason = 'withdrawn' | 'notInCatalog' | 'notARequirement';

export interface LeftOut {
  /** Pairs with an end NIST has withdrawn. */
  withdrawn: number;
  /** Pairs with an end that fits our code pattern but isn't in our catalog. */
  notInCatalog: number;
  /** Pairs with an end that isn't a requirement (a family, function, category or main-body clause). */
  notARequirement: number;
  /** Rows that repeat a pair already kept. */
  duplicates: number;
  /** The IDs, as NIST wrote them, that caused each kind of left-out pair (sorted, each once). */
  ids: Record<LeftOutReason, string[]>;
}

type EndResult = { code: string } | { leftOut: LeftOutReason };

function resolveEnd(index: CodeIndex, id: string, where: string): EndResult {
  if (!CODE_PATTERNS[index.framework].test(id)) {
    if (NOT_A_REQUIREMENT[index.framework](id)) return { leftOut: 'notARequirement' };
    throw new Error(`${where}: "${id}" isn't a ${index.framework} code we know, and IDs are never rewritten to fit`);
  }
  const code = index.ids.get(id);
  if (code === undefined) return { leftOut: 'notInCatalog' };
  if (code === null) return { leftOut: 'withdrawn' };
  return { code };
}

/** NIST's mapping rows as `from -> to` pairs between our catalogs' codes, sorted, with no repeats.
 * A pair is kept only when both ends are in the catalogs; the rest are counted in `leftOut`. An ID
 * that fits neither our code pattern nor a known non-requirement form stops it with an error. */
export function convertMappings(
  rows: readonly MappingRow[],
  source: CatalogSource,
  ends: { from: CodeIndex; to: CodeIndex },
): { file: MappingFile; leftOut: LeftOut } {
  if (ends.from.framework === 'soc_2' || ends.to.framework === 'soc_2') {
    throw new Error('mappings: no SOC 2 mappings are imported (D212 (4))');
  }
  const leftOut: LeftOut = {
    withdrawn: 0,
    notInCatalog: 0,
    notARequirement: 0,
    duplicates: 0,
    ids: { withdrawn: [], notInCatalog: [], notARequirement: [] },
  };
  const leftOutIds: Record<LeftOutReason, Set<string>> = {
    withdrawn: new Set(),
    notInCatalog: new Set(),
    notARequirement: new Set(),
  };
  const pairs = new Map<string, CatalogMapping>();
  for (const row of rows) {
    const from = resolveEnd(ends.from, row.from, row.where);
    const to = resolveEnd(ends.to, row.to, row.where);
    if ('leftOut' in from) {
      leftOut[from.leftOut] += 1;
      leftOutIds[from.leftOut].add(row.from);
      continue;
    }
    if ('leftOut' in to) {
      leftOut[to.leftOut] += 1;
      leftOutIds[to.leftOut].add(row.to);
      continue;
    }
    const key = `${from.code}\u0000${to.code}`;
    if (pairs.has(key)) {
      leftOut.duplicates += 1;
      continue;
    }
    pairs.set(key, {
      from: { framework: ends.from.framework, code: from.code },
      to: { framework: ends.to.framework, code: to.code },
    });
  }
  const order = (m: CatalogMapping) =>
    `${sortKeyOf(m.from.framework, m.from.code)}|${sortKeyOf(m.to.framework, m.to.code)}`;
  const mappings = [...pairs.values()].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  // Natural order without locale rules, so every machine sorts the same way (D45.8).
  const natural = (id: string) => `${id.replace(/\d+/g, (digits) => digits.padStart(6, '0'))}\u0000${id}`;
  const naturalIds = (ids: Set<string>) =>
    [...ids].sort((a, b) => (natural(a) < natural(b) ? -1 : natural(a) > natural(b) ? 1 : 0));
  leftOut.ids = {
    withdrawn: naturalIds(leftOutIds.withdrawn),
    notInCatalog: naturalIds(leftOutIds.notInCatalog),
    notARequirement: naturalIds(leftOutIds.notARequirement),
  };
  return { file: { source, mappings }, leftOut };
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

/** A catalog file as committed: two-space JSON, ending in a newline (Prettier leaves it as is). */
export function catalogJson(file: CatalogFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** A mapping file as committed: one mapping per block, each end on one line. */
export function mappingJson(file: MappingFile): string {
  const end = (value: { framework: string; code: string }) =>
    `{ "framework": ${JSON.stringify(value.framework)}, "code": ${JSON.stringify(value.code)} }`;
  const source = JSON.stringify(file.source, null, 2).replace(/\n/g, '\n  ');
  const mappings = file.mappings
    .map((m) => `    {\n      "from": ${end(m.from)},\n      "to": ${end(m.to)}\n    }`)
    .join(',\n');
  return `{\n  "source": ${source},\n  "mappings": [\n${mappings}\n  ]\n}\n`;
}

export interface BuildResult {
  /** Output file name to its JSON text. */
  files: Map<NistOutput, string>;
  catalogs: Partial<Record<FrameworkKey, CatalogFile>>;
  mappings: Map<NistOutput, { file: MappingFile; leftOut: LeftOut; rows: number }>;
}

const MAPPING_ENDS: Readonly<Record<string, { from: FrameworkKey; to: FrameworkKey }>> = Object.fromEntries(
  MAPPING_FILE_SPECS.map((spec) => [spec.file, { from: spec.from, to: spec.to }]),
);

/** Converts the listed downloads in `sourcesDir`. `handWritten` gives the catalogs no download
 * builds (ISO 27001), which a mapping may cite. Pure apart from reading the downloads. */
export function buildCatalogs(
  sourcesDir: string,
  entries: readonly SourceEntry[],
  handWritten: Partial<Record<FrameworkKey, CatalogFile>> = {},
): BuildResult {
  const result: BuildResult = { files: new Map(), catalogs: {}, mappings: new Map() };
  const indexes: Partial<Record<FrameworkKey, CodeIndex>> = {};
  for (const [key, catalog] of Object.entries(handWritten) as [FrameworkKey, CatalogFile][]) {
    indexes[key] = catalogIndex(catalog);
  }
  const ordered = [...entries].sort((a, b) => NIST_OUTPUTS.indexOf(a.output) - NIST_OUTPUTS.indexOf(b.output));
  for (const entry of ordered) {
    const bytes = readFileSync(join(sourcesDir, entry.file));
    const source = sourceFor(entry, bytes);
    const parseJson = (): unknown => {
      try {
        return JSON.parse(bytes.toString('utf8')) as unknown;
      } catch {
        throw new Error(`${entry.file}: not valid JSON`);
      }
    };
    if (entry.output === 'nist-800-53.json') {
      const oscal = parseJson();
      const catalog = convert80053(oscal, source);
      result.catalogs.nist_800_53 = catalog;
      indexes.nist_800_53 = oscalLabelIndex(oscal);
      result.files.set(entry.output, catalogJson(catalog));
    } else if (entry.output === 'nist-csf-2.json') {
      const csf = parseJson();
      const catalog = convertCsf2(csf, source);
      result.catalogs.nist_csf_2 = catalog;
      indexes.nist_csf_2 = csfIndex(csf);
      result.files.set(entry.output, catalogJson(catalog));
    } else {
      const spec = MAPPING_ENDS[entry.output]!;
      const from = indexes[spec.from];
      const to = indexes[spec.to];
      if (!from || !to) {
        throw new Error(`${entry.output}: needs the ${spec.from} and ${spec.to} catalogs in the same build`);
      }
      const rows = olirMappingRows(readXlsx(bytes));
      const converted = convertMappings(rows, source, { from, to });
      result.mappings.set(entry.output, { ...converted, rows: rows.length });
      result.files.set(entry.output, mappingJson(converted.file));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// SOURCES.md
// ---------------------------------------------------------------------------------------------

const LICENCES: Readonly<Record<FrameworkKey, string>> = {
  nist_800_53:
    'A work of the US Government (NIST): public domain in the United States. Control IDs, titles and statements are kept as NIST publishes them.',
  nist_csf_2:
    'A work of the US Government (NIST): public domain in the United States. Subcategory IDs and outcomes are kept as NIST publishes them; the short titles are ours, cut from the outcome.',
  iso_27001:
    'Copyright ISO/IEC. Only the Annex A control IDs and titles are used; every description is written by us. No text of the standard is copied.',
  soc_2:
    'Copyright AICPA, all rights reserved. Only the criterion IDs are used; every title and description is written by us. No AICPA text is copied.',
};

const MAPPING_LICENCE =
  'A NIST-authored mapping (a work of the US Government: public domain in the United States). No third-party OLIR submission is used.';

export interface SourcesSummary {
  catalogs: Record<FrameworkKey, CatalogFile>;
  mappings: { file: string; mapping: MappingFile; leftOut: LeftOut; rows: number }[];
  /** The downloaded original's name for each NIST output. */
  downloads: Partial<Record<string, string>>;
}

function sourceLines(source: CatalogSource, download: string | undefined): string[] {
  return [
    `- Publisher: ${source.publisher}`,
    `- Author: ${source.author}`,
    `- Document: ${source.documentTitle}`,
    `- URL: <${source.url}>`,
    `- Release: ${source.release}`,
    `- Downloaded on: ${source.downloadedOn ?? 'not downloaded (written by hand)'}`,
    `- SHA-256: ${source.sha256 === null ? 'none (written by hand)' : `\`${source.sha256}\``}`,
    ...(download ? [`- Saved as: \`${download}\``] : []),
  ];
}

/** SOURCES.md: every file's `source`, the licence notes, how to rebuild and what was left out. */
export function sourcesMarkdown(summary: SourcesSummary): string {
  const lines: string[] = [
    '# Framework catalog sources',
    '',
    'Written by `packages/infra/scripts/build-framework-catalogs.ts` (S2-002, D20, D212). Rebuild it rather than editing it by hand.',
    '',
    'These six files are the whole framework content the app has. The app never downloads anything (D63): the loader copies them into every org’s graph. Each file keeps its `source` beside its data.',
    '',
    '## Licences',
    '',
    ...(['nist_800_53', 'nist_csf_2', 'iso_27001', 'soc_2'] as const).map(
      (key) => `- ${FRAMEWORKS[key].name} ${FRAMEWORKS[key].frameworkVersion}: ${LICENCES[key]}`,
    ),
    `- NIST's mappings: ${MAPPING_LICENCE}`,
    '- No SCF content is used (D20).',
    '',
    '## How to rebuild',
    '',
    '1. Download each NIST file listed in `packages/infra/scripts/framework-sources.json` into a folder outside the repo, under its `file` name, for example `curl -fsSL -o <dir>/<file> <url>`. Never commit the originals.',
    '2. Update `downloadedOn` (and `release`, if NIST published a new one) in `framework-sources.json`.',
    '3. Run `pnpm --filter infra exec tsx scripts/build-framework-catalogs.ts --sources <dir>`. It checks every source, writes the four NIST files and this page, and checks all six files with `readCatalogFiles`. The same downloads give byte-identical files.',
    '4. The ISO 27001 and SOC 2 files are written by hand: edit them directly, then rebuild to refresh this page.',
    '',
    '## Catalogs',
  ];
  for (const key of ['nist_800_53', 'nist_csf_2', 'iso_27001', 'soc_2'] as const) {
    const catalog = summary.catalogs[key];
    const file = CATALOG_FILE_NAMES[key];
    lines.push(
      '',
      `### ${file}`,
      '',
      `- Framework: ${FRAMEWORKS[key].name} ${FRAMEWORKS[key].frameworkVersion} (\`${key}\`)`,
      `- Requirements: ${catalog.requirements.length}`,
      ...sourceLines(catalog.source, summary.downloads[file]),
    );
  }
  lines.push(
    '',
    '## Mappings',
    '',
    'Only NIST-authored mappings are imported (D212 (1)). NIST’s spreadsheets cite 800-53 controls by the zero-padded label (`AC-02(01)`) that the OSCAL catalog publishes on the same control as its plain label (`AC-2(1)`, our code), so each end is found through the catalog’s own labels; no ID is rewritten. A pair is left out, and counted here, when an end is withdrawn, isn’t in our catalogs, or names something that isn’t a requirement in them (an 800-53 family, a CSF function or category, or a clause of ISO 27001’s main body, 4 to 10, as our ISO catalog is Annex A only).',
  );
  const idList = (ids: string[]) => (ids.length === 0 ? 'none' : ids.map((id) => `\`${id}\``).join(', '));
  for (const { file, mapping, leftOut, rows } of summary.mappings) {
    const first = mapping.mappings[0];
    const total = leftOut.withdrawn + leftOut.notInCatalog + leftOut.notARequirement;
    lines.push(
      '',
      `### ${file}`,
      '',
      `- Direction: \`${first?.from.framework ?? '?'}\` to \`${first?.to.framework ?? '?'}\` (the citing framework to the cited one)`,
      `- Mappings kept: ${mapping.mappings.length}, from ${rows} relationship rows`,
      `- Pairs left out because an end isn't in our catalogs: ${total}`,
      `  - An end withdrawn: ${leftOut.withdrawn} (${idList(leftOut.ids.withdrawn)})`,
      `  - An end not in the catalog: ${leftOut.notInCatalog} (${idList(leftOut.ids.notInCatalog)})`,
      `  - An end that isn't a requirement: ${leftOut.notARequirement} (${idList(leftOut.ids.notARequirement)})`,
      `- Repeated rows merged: ${leftOut.duplicates}`,
      ...sourceLines(mapping.source, summary.downloads[file]),
    );
  }
  lines.push(
    '',
    '## No SOC 2 mappings',
    '',
    'No SOC 2 cross-framework links are imported (D212 (4)). Gemma suggests them in S4 and the Analyst approves them in S5; S2 loads the SOC 2 criteria for hand mapping only.',
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SOURCES_LIST = fileURLToPath(new URL('./framework-sources.json', import.meta.url));

function argument(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a folder`);
  return value;
}

function isInside(folder: string, parent: string): boolean {
  const path = relative(parent, folder);
  return path === '' || (!path.startsWith('..') && !path.startsWith(sep) && !/^[a-zA-Z]:/.test(path));
}

function readHandWritten(key: FrameworkKey): CatalogFile {
  const file = join(CATALOG_DIR, CATALOG_FILE_NAMES[key]);
  return JSON.parse(readFileSync(file, 'utf8')) as CatalogFile;
}

function main(args: string[]): void {
  const sourcesArg = argument(args, '--sources');
  if (!sourcesArg) {
    throw new Error('usage: build-framework-catalogs.ts --sources <folder of NIST downloads> [--out <folder>]');
  }
  const sourcesDir = resolve(sourcesArg);
  if (isInside(sourcesDir, REPO_ROOT)) {
    throw new Error('the NIST downloads must sit in a folder outside the repo (they are never committed)');
  }
  const outDir = resolve(argument(args, '--out') ?? CATALOG_DIR);
  const entries = checkSourceEntries(JSON.parse(readFileSync(SOURCES_LIST, 'utf8')) as unknown);
  const missing = NIST_OUTPUTS.filter((output) => !entries.some((entry) => entry.output === output));
  if (missing.length > 0) throw new Error(`framework sources: nothing listed for ${missing.join(', ')}`);

  const handWritten = { iso_27001: readHandWritten('iso_27001'), soc_2: readHandWritten('soc_2') };
  const built = buildCatalogs(sourcesDir, entries, handWritten);

  // Check all six together before writing anything (fail safe, D45.7).
  const parsed: Record<string, unknown> = {
    [CATALOG_FILE_NAMES.iso_27001]: handWritten.iso_27001,
    [CATALOG_FILE_NAMES.soc_2]: handWritten.soc_2,
  };
  for (const [name, body] of built.files) parsed[name] = JSON.parse(body) as unknown;
  const checked = checkCatalogFiles(parsed);

  const markdown = sourcesMarkdown({
    catalogs: checked.catalogs,
    mappings: MAPPING_FILE_SPECS.map((spec) => {
      const mapping = built.mappings.get(spec.file as NistOutput);
      if (!mapping) throw new Error(`${spec.file}: not built`);
      return { file: spec.file, mapping: mapping.file, leftOut: mapping.leftOut, rows: mapping.rows };
    }),
    downloads: Object.fromEntries(entries.map((entry) => [entry.output, entry.file])),
  });

  mkdirSync(outDir, { recursive: true });
  for (const [name, body] of built.files) writeFileSync(join(outDir, name), body);
  writeFileSync(join(outDir, 'SOURCES.md'), markdown);

  for (const [name, body] of built.files) {
    const mapping = built.mappings.get(name);
    const detail = mapping
      ? `${mapping.file.mappings.length} mappings; left out ${mapping.leftOut.withdrawn} withdrawn, ${mapping.leftOut.notInCatalog} not in catalog, ${mapping.leftOut.notARequirement} not a requirement; ${mapping.leftOut.duplicates} repeats merged`
      : `${(JSON.parse(body) as CatalogFile).requirements.length} requirements`;
    console.log(`${name}: ${detail}`);
  }
  console.log(`wrote ${built.files.size + 1} files to ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
