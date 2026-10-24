// `node --experimental-transform-types packages/infra/scripts/train-data-real.ts [--max-per-job <n>]
// [--name <name>]` (2026-10-23, the user: "use real dataset"): the training file of D248 built from
// real public data instead of the generators. The rows are the ones `pnpm train:data` makes (TR-001,
// TR-002): the app's own extraction and graph-query requests, its answer format, the worker's reading
// and chunking, and the same self-check. Only the records, the links and the document texts are real.
// - Sources, in git-ignored `data/generated/public-sources/` (nothing is downloaded here): MITRE
//   ATT&CK Enterprise (STIX 2.1), CTID's mappings (800-53, KEV, VERIS), CISA KEV, NVD's CVE 2.0
//   feeds and VCDB.
// - Records, named as Company X names them (D234): an ATT&CK technique is a Risk, an 800-53 control
//   (its title) a Control, "<800-53 family> Policy" a Policy, KEV's vendor and product an Asset, a
//   VCDB breach an Incident ("<action> on <asset> at <victim> (YYYY-MM)"). A name two records share
//   is left out.
// - Links: Risk MITIGATED_BY Control (CTID 800-53), Control GOVERNED_BY Policy (the control's
//   family), Asset EXPOSED_TO Risk (CTID KEV), Incident EXPOSES Risk (CTID VERIS).
// - Company X stays out, for the before/after test: no record is made under a Company X record's
//   name, and a chunk or question whose text holds one is dropped. Its answer key is read for the
//   names only.
// - extraction: one document per technique, per KEV vulnerability and per VCDB breach, made of the
//   source's own text (ATT&CK's description, NVD's and KEV's text, the CTID analysts' notes, VCDB's
//   summary) and one sentence per link that names both ends (the generators' fact sentences and a
//   few more). Each is read and chunked as the worker does and answered by TR-001's
//   `extractionAnswers`. The three kinds of document share the job's rows equally.
// - graph_query: the benchmark's question shapes over the real records, as TR-002 (no made-up
//   names). The shapes share the job's rows equally.
// - The split: about 10% of the source records give `validation` rows. An input seen before is
//   dropped, so no input is on both sides. Every row's `seed` is 0 (no generator seed made it).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import type { TextRequest } from '../../api/src/ai/text-model.js';
import type { GraphRecord } from '../../benchmark/src/index.js';
import type { Fact, Mention } from '../../generators/src/index.js';
import type { LinkType, RecordKind } from '../../shared/src/index.js';
import type { NamedRecord } from './training/extraction.js';
import type { Split, TrainingJob } from './training/jobs.js';
import type { JobBuilder, TrainingExample } from './training/rows.js';

// The api's, the generators' and the shared sources import each other as `./x.js`, which are
// `./x.ts` files: plain `node` loads them with this hook (as train-data.ts does).
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCES = join(REPO_ROOT, 'data/generated/public-sources');
const COMPANY_X_KEY = join(REPO_ROOT, 'docs/datasets/company-x/answer-key.json');
const TRAINING_DIR = 'data/generated/training';
const USAGE =
  'usage: node --experimental-transform-types packages/infra/scripts/train-data-real.ts ' +
  '[--max-per-job <whole number, default 1000>] [--name <a-z, 0-9 and -, default train-real>]';
/** The seed of the split and the samples (principle 8). */
const SEED = 1000;
/** About one source record in this many gives validation rows (D248: about 10%). */
const VALIDATION_ONE_IN = 10;
/** At most this many links of one kind per document, so no document is all link sentences. */
const LINKS_PER_DOCUMENT = 3;

// ---- arguments ------------------------------------------------------------------------------------
function parseArgs(argv: readonly string[]): { maxPerJob: number; name: string } {
  let maxPerJob = 1000;
  let name = 'train-real';
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--max-per-job' && value !== undefined && /^[1-9]\d{0,5}$/.test(value)) maxPerJob = Number(value);
    else if (flag === '--name' && value !== undefined && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) name = value;
    else {
      console.error(`train-data-real: ${flag ?? ''} is not understood\n${USAGE}`);
      process.exit(2);
    }
  }
  return { maxPerJob, name };
}

// ---- small helpers ---------------------------------------------------------------------------------
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const rankOf = (text: string): number => Number.parseInt(sha256(text).slice(0, 8), 16);
const pick = <T>(items: readonly T[], key: string): T => items[rankOf(key) % items.length]!;
const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
/** A pattern for a name as a whole word, with any run of white space where it has a space. */
const wholeName = (name: string): string =>
  `(?<![A-Za-z0-9])${name.trim().split(/\s+/).map(escapeRegExp).join('\\s+')}(?![A-Za-z0-9])`;

/** Source prose made plain: ATT&CK's citations and links taken out, white space made single. */
function cleanProse(text: string, maxWords: number): string {
  const flat = text
    .replace(/\(Citation:[^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?code>/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
  const words = flat.split(' ');
  if (words.length <= maxWords) return flat;
  const cut = words.slice(0, maxWords).join(' ');
  const stop = cut.lastIndexOf('. ');
  return stop > 60 ? cut.slice(0, stop + 1) : `${cut} …`;
}

// ---- the link sentences: each names both ends in one sentence (D39) ------------------------------
type RealLinkType = Extract<LinkType, 'EXPOSED_TO' | 'MITIGATED_BY' | 'GOVERNED_BY' | 'EXPOSES'>;
const FACT_SENTENCES: Readonly<Record<RealLinkType, readonly string[]>> = {
  EXPOSED_TO: [
    '{from} is exposed to the risk {to}.',
    'Testing confirmed that {from} is exposed to {to}.',
    'The risk {to} arises through {from}.',
    'Our review found that {from} is exposed to the risk {to}.',
  ],
  MITIGATED_BY: [
    'The risk {from} is mitigated by the {to} control.',
    'The {to} control is in place to mitigate the risk {from}.',
    'To reduce the risk {from}, the organisation relies on the {to} control.',
    'The risk {from} is reduced by the {to} control.',
  ],
  GOVERNED_BY: [
    'The {from} control is governed by the {to}.',
    'The {to} governs the {from} control.',
    'Responsibility for the {from} control is set out in the {to}.',
  ],
  EXPOSES: [
    'The incident {from} exposes the organisation to the risk {to}.',
    'Analysis of the incident {from} showed that it exposes the risk {to}.',
    'The incident {from} is linked to the risk {to}.',
  ],
};

// ---- the sources -----------------------------------------------------------------------------------
interface StixObject {
  type: string;
  name?: string;
  description?: string;
  revoked?: boolean;
  x_mitre_deprecated?: boolean;
  external_references?: { source_name?: string; external_id?: string }[];
}
interface CtidMapping {
  capability_id: string | null;
  capability_description: string | null;
  mapping_type: string | null;
  attack_object_id: string | null;
  comments?: string | null;
  status?: string | null;
}
interface KevVuln {
  cveID: string;
  vendorProject: string;
  product: string;
  shortDescription: string;
  requiredAction?: string;
}
interface VcdbIncident {
  incident_id?: string;
  summary?: string;
  action?: Record<string, { variety?: string[] }>;
  asset?: { assets?: { variety?: string }[] };
  timeline?: { incident?: { year?: number; month?: number } };
  victim?: { victim_id?: string };
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(SOURCES, file), 'utf8')) as T;

/** Where NVD's descriptions of KEV's CVEs are kept, so the yearly feeds (~120 MB) needn't stay. */
const NVD_KEV_FILE = 'nvd-kev-descriptions.json';

/**
 * NVD's English description of each of the CVEs asked for: from NVD_KEV_FILE when it is there, else
 * streamed from the yearly feeds in `nvd/` and written to NVD_KEV_FILE.
 */
async function nvdDescriptions(wanted: ReadonlySet<string>): Promise<Map<string, string>> {
  if (existsSync(join(SOURCES, NVD_KEV_FILE))) {
    return new Map(Object.entries(readJson<Record<string, string>>(NVD_KEV_FILE)));
  }
  const out = new Map<string, string>();
  const files = readdirSync(join(SOURCES, 'nvd'))
    .filter((f) => /^nvdcve-2\.0-\d{4}\.json\.gz$/.test(f))
    .sort();
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(join(SOURCES, 'nvd', file)).pipe(createGunzip()) });
    let cve: string | undefined;
    let english = false;
    for await (const line of lines) {
      const id = /^ {6}"id" : "(CVE-\d+-\d+)",?$/.exec(line);
      if (id !== null) {
        cve = wanted.has(id[1]!) && !out.has(id[1]!) ? id[1] : undefined;
        english = false;
        continue;
      }
      if (cve === undefined) continue;
      if (/^ {8}"lang" : "en",?$/.test(line)) {
        english = true;
        continue;
      }
      const value = /^ {8}"value" : (".*")$/.exec(line);
      if (value !== null && english) {
        out.set(cve, JSON.parse(value[1]!) as string);
        cve = undefined;
      }
    }
  }
  const sorted = Object.fromEntries([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(join(SOURCES, NVD_KEV_FILE), `${JSON.stringify(sorted, null, 1)}\n`);
  return out;
}

// ---- records and links -----------------------------------------------------------------------------
const FAMILIES: Readonly<Record<string, string>> = {
  AC: 'Access Control',
  AT: 'Awareness and Training',
  AU: 'Audit and Accountability',
  CA: 'Assessment, Authorization, and Monitoring',
  CM: 'Configuration Management',
  CP: 'Contingency Planning',
  IA: 'Identification and Authentication',
  IR: 'Incident Response',
  MA: 'Maintenance',
  MP: 'Media Protection',
  PE: 'Physical and Environmental Protection',
  PL: 'Planning',
  PM: 'Program Management',
  PS: 'Personnel Security',
  PT: 'PII Processing and Transparency',
  RA: 'Risk Assessment',
  SA: 'System and Services Acquisition',
  SC: 'System and Communications Protection',
  SI: 'System and Information Integrity',
  SR: 'Supply Chain Risk Management',
};

/** The records the sources give, keyed, before Company X's names and shared names are taken out. */
class Records {
  private readonly all = new Map<string, NamedRecord>();
  add(key: string, kind: RecordKind, name: string): void {
    if (!this.all.has(key) && name.trim() !== '') this.all.set(key, { key, kind, name: name.trim() });
  }
  /** Every record whose name is no Company X name and no other record's. */
  kept(companyX: ReadonlySet<string>): { records: Map<string, NamedRecord>; dropped: Record<string, number> } {
    const uses = new Map<string, number>();
    for (const r of this.all.values()) uses.set(r.name, (uses.get(r.name) ?? 0) + 1);
    const records = new Map<string, NamedRecord>();
    const dropped = { company_x_name: 0, shared_name: 0 };
    for (const r of this.all.values()) {
      if (companyX.has(r.name)) dropped.company_x_name += 1;
      else if (uses.get(r.name)! > 1) dropped.shared_name += 1;
      else records.set(r.key, r);
    }
    return { records, dropped };
  }
}

// ---- main ------------------------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const outDir = join(REPO_ROOT, TRAINING_DIR, args.name);
if (existsSync(outDir)) {
  console.error(`train-data-real: ${TRAINING_DIR}/${args.name}/ already exists: pick another --name or delete it`);
  process.exit(2);
}
const SOURCE_FILES = [
  'attack/enterprise-attack.json',
  'ctid-800-53.json',
  'ctid-kev.json',
  'ctid-veris.json',
  'cisa-kev.json',
  'vcdb.json.zip',
];
const missing = SOURCE_FILES.filter((f) => !existsSync(join(SOURCES, f)));
if (!existsSync(join(SOURCES, NVD_KEV_FILE)) && !existsSync(join(SOURCES, 'nvd')))
  missing.push(`${NVD_KEV_FILE} or nvd/`);
if (missing.length > 0) {
  console.error(`train-data-real: missing in data/generated/public-sources/: ${missing.join(', ')}`);
  process.exit(2);
}

const load = async <T>(path: string): Promise<T> => (await import(new URL(path, import.meta.url).href)) as T;
const tokenizer = await load<typeof import('../../api/src/processing/reader/tokenizer.js')>(
  '../../api/src/processing/reader/tokenizer.ts',
);
const tokenizerSource = await load<typeof import('../../api/src/processing/reader/tokenizer-source.js')>(
  '../../api/src/processing/reader/tokenizer-source.ts',
);
const { chunkText } = await load<typeof import('../../api/src/processing/reader/chunker.js')>(
  '../../api/src/processing/reader/chunker.ts',
);
const { readDocumentText } = await load<typeof import('../../api/src/processing/reader/document-text.js')>(
  '../../api/src/processing/reader/document-text.ts',
);
const { MAX_DOCUMENT_TEXT_LENGTH } = await load<typeof import('../../api/src/processing/reader/document-read.job.js')>(
  '../../api/src/processing/reader/document-read.job.ts',
);
const { extractionRequest, EXTRACTION_PROMPT_VERSION } = await load<
  typeof import('../../api/src/processing/extract/prompt.js')
>('../../api/src/processing/extract/prompt.ts');
const { graphQueryRequest, GRAPH_QUERY_PROMPT_VERSION } = await load<
  typeof import('../../api/src/search/graph/prompt.js')
>('../../api/src/search/graph/prompt.ts');
const { OrgGraph, QUESTION_SHAPES } =
  await load<typeof import('../../benchmark/src/index.js')>('../../benchmark/src/index.ts');
const { normaliseName } = await load<typeof import('../../shared/src/index.js')>('../../shared/src/index.ts');
const extraction = await load<typeof import('./training/extraction.js')>('./training/extraction.ts');
const graphQuery = await load<typeof import('./training/graph-query.js')>('./training/graph-query.ts');
const { rowLine, rowOf } = await load<typeof import('./training/rows.js')>('./training/rows.ts');
const { sampleBySplit } = await load<typeof import('./training/split.js')>('./training/split.ts');
const { selfCheck } = await load<typeof import('./training/self-check.js')>('./training/self-check.ts');

const counter = await tokenizer.loadTokenCounter(tokenizerSource.defaultTokenizerDir());

// Company X's names: kept out of every row.
const companyXKey = JSON.parse(readFileSync(COMPANY_X_KEY, 'utf8')) as {
  orgs: Record<'assets' | 'risks' | 'controls' | 'policies' | 'incidents', { name: string }[]>[];
};
const companyXNames = new Set(
  companyXKey.orgs.flatMap((org) =>
    (['assets', 'risks', 'controls', 'policies', 'incidents'] as const).flatMap((list) => org[list].map((r) => r.name)),
  ),
);
const companyXPattern = new RegExp([...companyXNames].map(wholeName).join('|'));

console.log('train-data-real: reading the sources');
const attack = readJson<{ objects: StixObject[] }>('attack/enterprise-attack.json');
const ctid80053 = readJson<{ mapping_objects: CtidMapping[] }>('ctid-800-53.json').mapping_objects;
const ctidKev = readJson<{ mapping_objects: CtidMapping[] }>('ctid-kev.json').mapping_objects;
const ctidVeris = readJson<{ mapping_objects: CtidMapping[] }>('ctid-veris.json').mapping_objects;
const kev = readJson<{ vulnerabilities: KevVuln[] }>('cisa-kev.json').vulnerabilities;
const vcdb = JSON.parse(
  execFileSync('unzip', ['-p', join(SOURCES, 'vcdb.json.zip')], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8'),
) as VcdbIncident[];
const nvd = await nvdDescriptions(new Set(kev.map((v) => v.cveID)));

// Techniques (Risks): a sub-technique whose name another technique also has is "<parent>: <name>".
const techniques = new Map<string, { name: string; description: string }>();
for (const o of attack.objects) {
  if (o.type !== 'attack-pattern' || o.revoked === true || o.x_mitre_deprecated === true) continue;
  const tid = o.external_references?.find((r) => r.source_name === 'mitre-attack')?.external_id;
  if (tid !== undefined && o.name !== undefined)
    techniques.set(tid, { name: o.name, description: o.description ?? '' });
}
const techniqueNameUses = new Map<string, number>();
for (const t of techniques.values()) techniqueNameUses.set(t.name, (techniqueNameUses.get(t.name) ?? 0) + 1);
const techniqueName = (tid: string): string | undefined => {
  const t = techniques.get(tid);
  if (t === undefined) return undefined;
  if (techniqueNameUses.get(t.name) === 1 || !tid.includes('.')) return t.name;
  const parent = techniques.get(tid.split('.')[0]!);
  return parent === undefined ? t.name : `${parent.name}: ${t.name}`;
};

const candidates = new Records();
const facts: { fact: Fact; note?: string }[] = [];
const riskKey = (tid: string): string => `RSK-${tid}`;
const addRisk = (tid: string): string | undefined => {
  const name = techniqueName(tid);
  if (name === undefined) return undefined;
  candidates.add(riskKey(tid), 'risk', name);
  return riskKey(tid);
};

// Controls (800-53, by title), their family Policies, and Risk MITIGATED_BY Control.
for (const m of ctid80053) {
  if (m.mapping_type !== 'mitigates' || m.status !== 'complete' || !m.capability_id || !m.attack_object_id) continue;
  const risk = addRisk(m.attack_object_id);
  if (risk === undefined || !m.capability_description) continue;
  const controlId = m.capability_id.replace(/-0(\d)/, '-$1');
  const controlKey = `CTL-${controlId}`;
  candidates.add(controlKey, 'control', m.capability_description);
  const family = FAMILIES[controlId.slice(0, 2)];
  if (family !== undefined) {
    candidates.add(`POL-${controlId.slice(0, 2)}`, 'policy', `${family} Policy`);
    facts.push({ fact: { type: 'GOVERNED_BY', fromKey: controlKey, toKey: `POL-${controlId.slice(0, 2)}` } });
  }
  facts.push({ fact: { type: 'MITIGATED_BY', fromKey: risk, toKey: controlKey }, note: m.comments ?? undefined });
}

// Assets (KEV vendor and product) and Asset EXPOSED_TO Risk, per CVE.
const assetName = (v: KevVuln): string =>
  v.product.toLowerCase().startsWith(v.vendorProject.toLowerCase()) ? v.product : `${v.vendorProject} ${v.product}`;
const assetKey = (v: KevVuln): string => `AST-${normaliseName(assetName(v)).replace(/[^a-z0-9]+/g, '-')}`;
const kevById = new Map(kev.map((v) => [v.cveID, v]));
const cveTechniques = new Map<string, { tid: string; note?: string }[]>();
for (const m of ctidKev) {
  if (!m.capability_id || !m.attack_object_id || kevById.get(m.capability_id) === undefined) continue;
  const list = cveTechniques.get(m.capability_id) ?? [];
  if (!list.some((t) => t.tid === m.attack_object_id))
    list.push({ tid: m.attack_object_id, note: m.comments ?? undefined });
  cveTechniques.set(m.capability_id, list);
}
for (const [cve, list] of cveTechniques) {
  const v = kevById.get(cve)!;
  candidates.add(assetKey(v), 'asset', assetName(v));
  for (const t of list) {
    const risk = addRisk(t.tid);
    if (risk !== undefined)
      facts.push({ fact: { type: 'EXPOSED_TO', fromKey: assetKey(v), toKey: risk }, note: t.note });
  }
}

// Incidents (VCDB) and Incident EXPOSES Risk, through the VERIS action varieties.
const verisTechniques = new Map<string, string[]>();
for (const m of ctidVeris) {
  if (!m.capability_id?.startsWith('action.') || !m.attack_object_id) continue;
  verisTechniques.set(m.capability_id, [...(verisTechniques.get(m.capability_id) ?? []), m.attack_object_id]);
}
interface Breach {
  key: string;
  summary: string;
  tids: string[];
}
const breaches: Breach[] = [];
for (const incident of vcdb) {
  const summary = incident.summary?.replace(/\s+/g, ' ').trim() ?? '';
  if (incident.incident_id === undefined || summary.length < 60) continue;
  const varieties = Object.entries(incident.action ?? {}).flatMap(([category, a]) =>
    (a.variety ?? []).filter((v) => v !== 'Unknown' && v !== 'Other').map((v) => ({ category, v })),
  );
  const tids = [
    ...new Set(varieties.flatMap(({ category, v }) => verisTechniques.get(`action.${category}.variety.${v}`) ?? [])),
  ];
  if (varieties.length === 0 || tids.length === 0) continue;
  const asset = incident.asset?.assets?.map((a) => a.variety ?? '').find((a) => a !== '' && !a.endsWith('Unknown'));
  const victim = incident.victim?.victim_id;
  const year = incident.timeline?.incident?.year;
  const month = incident.timeline?.incident?.month;
  if (year === undefined) continue;
  const when = month === undefined ? `${year}` : `${year}-${String(month).padStart(2, '0')}`;
  const name =
    `${varieties[0]!.v} on ${asset === undefined ? 'systems' : asset.replace(/^[A-Z] - /, '').toLowerCase()}` +
    `${victim === undefined || victim === 'Unknown' ? '' : ` at ${victim}`} (${when})`;
  const key = `INC-${incident.incident_id}`;
  candidates.add(key, 'incident', name);
  breaches.push({ key, summary, tids });
  for (const tid of tids) {
    const risk = addRisk(tid);
    if (risk !== undefined) facts.push({ fact: { type: 'EXPOSES', fromKey: key, toKey: risk } });
  }
}

const { records, dropped: recordDrops } = candidates.kept(companyXNames);
const keptFacts = new Map<string, { fact: Fact; note?: string }>();
for (const f of facts) {
  const id = `${f.fact.type}|${f.fact.fromKey}|${f.fact.toKey}`;
  if (records.has(f.fact.fromKey) && records.has(f.fact.toKey) && !keptFacts.has(id)) keptFacts.set(id, f);
}
const outgoing = (type: RealLinkType, fromKey: string): { fact: Fact; note?: string }[] =>
  [...keptFacts.values()].filter((f) => f.fact.type === type && f.fact.fromKey === fromKey);
const nameOf = (key: string): string => records.get(key)!.name;
const sentenceOf = (fact: Fact): string =>
  pick(FACT_SENTENCES[fact.type as RealLinkType], `sentence|${fact.type}|${fact.fromKey}|${fact.toKey}`)
    .replace('{from}', () => nameOf(fact.fromKey))
    .replace('{to}', () => nameOf(fact.toKey));
const linesOf = (links: { fact: Fact; note?: string }[], group: string): { lines: string[]; mentions: Mention[] } => {
  const chosen = [...links]
    .sort((a, b) => rankOf(`${group}|${a.fact.toKey}`) - rankOf(`${group}|${b.fact.toKey}`))
    .slice(0, LINKS_PER_DOCUMENT);
  const mentions = chosen.map((l) => ({ fact: l.fact, sentence: sentenceOf(l.fact) }));
  const lines = chosen.map((l, i) => {
    const note = l.note === undefined || l.note.length < 30 ? '' : ` ${cleanProse(l.note, 45)}`;
    return `${mentions[i]!.sentence}${note}`;
  });
  return { lines, mentions };
};

// ---- the documents ---------------------------------------------------------------------------------
/**
 * `no_link`: a technique's or a vulnerability's own text with no link sentence, so the model also
 * sees text that names records and states no link (at most NO_LINK_SHARE of the job's rows).
 */
type DocumentKind = 'technique' | 'vulnerability' | 'breach' | 'no_link';
const NO_LINK_SHARE = 0.1;
interface RealDocument {
  kind: DocumentKind;
  /** The source record it is about: its rows share a split. */
  group: string;
  text: string;
  mentions: Mention[];
}
const documents: RealDocument[] = [];
for (const [tid, t] of [...techniques].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const risk = riskKey(tid);
  if (!records.has(risk)) continue;
  const mitigations = linesOf(outgoing('MITIGATED_BY', risk), risk);
  if (mitigations.mentions.length === 0) continue;
  const parts = [`Threat profile: ${nameOf(risk)}`, cleanProse(t.description, 110), ...mitigations.lines];
  const mentions = [...mitigations.mentions];
  const governed = outgoing('GOVERNED_BY', mitigations.mentions[0]!.fact.toKey)[0];
  if (governed !== undefined) {
    const sentence = sentenceOf(governed.fact);
    parts.push(sentence);
    mentions.push({ fact: governed.fact, sentence });
  }
  documents.push({ kind: 'technique', group: risk, text: parts.join('\n\n'), mentions });
  documents.push({ kind: 'no_link', group: risk, text: parts.slice(0, 2).join('\n\n'), mentions: [] });
}
for (const v of [...kev].sort((a, b) => (a.cveID < b.cveID ? -1 : 1))) {
  const asset = assetKey(v);
  if (!records.has(asset) || !cveTechniques.has(v.cveID)) continue;
  const tids = new Set(cveTechniques.get(v.cveID)!.map((t) => riskKey(t.tid)));
  const notes = new Map(cveTechniques.get(v.cveID)!.map((t) => [riskKey(t.tid), t.note]));
  const links = outgoing('EXPOSED_TO', asset)
    .filter((f) => tids.has(f.fact.toKey))
    .map((f) => ({ fact: f.fact, note: notes.get(f.fact.toKey) }));
  const exposures = linesOf(links, v.cveID);
  if (exposures.mentions.length === 0) continue;
  const parts = [
    `Vulnerability advisory: ${v.cveID} in ${nameOf(asset)}`,
    cleanProse(nvd.get(v.cveID) ?? v.shortDescription, 110),
    ...(v.requiredAction ? [`Required action: ${cleanProse(v.requiredAction, 50)}`] : []),
    ...exposures.lines,
  ];
  documents.push({ kind: 'vulnerability', group: v.cveID, text: parts.join('\n\n'), mentions: exposures.mentions });
  documents.push({ kind: 'no_link', group: v.cveID, text: parts.slice(0, 2).join('\n\n'), mentions: [] });
}
for (const b of breaches) {
  if (!records.has(b.key)) continue;
  const exposures = linesOf(outgoing('EXPOSES', b.key), b.key);
  if (exposures.mentions.length === 0) continue;
  const parts = [`Incident report: ${nameOf(b.key)}`, cleanProse(b.summary, 130), ...exposures.lines];
  documents.push({ kind: 'breach', group: b.key, text: parts.join('\n\n'), mentions: exposures.mentions });
}

const splitOfGroup = (group: string): Split =>
  rankOf(`split|real|${SEED}|${group}`) % VALIDATION_ONE_IN === 0 ? 'validation' : 'train';

// Every record name, to report the records a document's own text names.
const universe = [...records.values()].map((r) => ({
  record: r,
  firstWord: r.name.split(/\s+/)[0]!,
  pattern: new RegExp(wholeName(r.name)),
}));
const namedIn = (text: string): NamedRecord[] =>
  universe.filter((u) => text.includes(u.firstWord) && u.pattern.test(text)).map((u) => u.record);

// ---- extraction rows -------------------------------------------------------------------------------
interface Built {
  example: TrainingExample;
  split: Split;
  part: string;
}
const extractionDrops: Record<string, number> = Object.fromEntries(
  [...extraction.EXTRACTION_DROP_REASONS, 'company_x_name', 'duplicate_input'].map((r) => [r, 0]),
);
const seenInputs = new Set<string>();
const extractionBuilt: Built[] = [];
console.log(`train-data-real: chunking ${documents.length} documents`);
for (const doc of documents) {
  const text = await readDocumentText(Buffer.from(doc.text, 'utf8'), 'txt', MAX_DOCUMENT_TEXT_LENGTH);
  const chunks = await chunkText(text, counter);
  const own = new Map<string, NamedRecord>();
  for (const m of doc.mentions) for (const key of [m.fact.fromKey, m.fact.toKey]) own.set(key, records.get(key)!);
  for (const r of namedIn(text)) own.set(r.key, r);
  const outcomes = extraction.extractionAnswers({
    text,
    chunks,
    records: [...own.values()],
    typoNames: [],
    mentions: doc.mentions,
    plantedLinks: [],
  });
  outcomes.forEach((outcome, i) => {
    if ('dropped' in outcome) {
      extractionDrops[outcome.dropped] = (extractionDrops[outcome.dropped] ?? 0) + 1;
      return;
    }
    const chunk = chunks[i]!.text;
    if (companyXPattern.test(chunk)) {
      extractionDrops.company_x_name! += 1;
      return;
    }
    const problem = extraction.checkExtractionAnswerValue(outcome.answer);
    if (problem !== null) throw new Error(`${doc.group}, chunk ${i + 1}: ${problem}`);
    const { neutralisedMarkers, ...request } = extractionRequest(chunk);
    void neutralisedMarkers;
    const input = `${request.instructions}\u0000${request.data}`;
    if (seenInputs.has(input)) {
      extractionDrops.duplicate_input! += 1;
      return;
    }
    seenInputs.add(input);
    extractionBuilt.push({
      example: {
        job: 'extraction',
        seed: 0,
        system: request.instructions,
        user: request.data,
        assistant: JSON.stringify(outcome.answer),
        request: request as TextRequest<unknown>,
      },
      split: splitOfGroup(doc.group),
      part: doc.kind,
    });
  });
}

// ---- graph_query rows ------------------------------------------------------------------------------
const graphRecords: GraphRecord[] = [...records.values()].map((r) => ({ ...r, normalised: normaliseName(r.name) }));
const graph = new OrgGraph(
  graphRecords,
  [...keptFacts.values()].map((f) => f.fact),
);
const graphDrops: Record<string, number> = { name_not_unique: 0, no_path: 0, company_x_name: 0, duplicate_input: 0 };
const graphBuilt: Built[] = [];
for (const shape of QUESTION_SHAPES) {
  const roles = graphQuery.rolesSeeing(graphQuery.shapePath(shape));
  if (roles.length === 0) continue;
  for (const start of graph.ofKind(shape.start).sort((a, b) => (a.key < b.key ? -1 : 1))) {
    if (graphQuery.startMatches(graph.records, shape.start, start.name).some((m) => m.key !== start.key)) {
      graphDrops.name_not_unique! += 1;
      continue;
    }
    if (graph.follow(start.key, shape.steps).length === 0) {
      graphDrops.no_path! += 1;
      continue;
    }
    const question = shape.text(start.name);
    if (companyXPattern.test(question)) {
      graphDrops.company_x_name! += 1;
      continue;
    }
    const query = graphQuery.graphQueryOf(shape, start.name);
    const problem = graphQuery.checkGraphQueryAnswerValue({ query }, query);
    if (problem !== null) throw new Error(`${shape.id}, ${start.key}: ${problem}`);
    const request = graphQueryRequest(graphQuery.pickRole(roles, ['real', shape.id, start.key]), question);
    const input = `${request.instructions}\u0000${request.data}`;
    if (seenInputs.has(input)) {
      graphDrops.duplicate_input! += 1;
      continue;
    }
    seenInputs.add(input);
    graphBuilt.push({
      example: {
        job: 'graph_query',
        seed: 0,
        system: request.instructions,
        user: request.data,
        assistant: JSON.stringify({ query }),
        request: request as TextRequest<unknown>,
      },
      split: splitOfGroup(start.key),
      part: shape.id,
    });
  }
}

// ---- the sample: the parts share each job's rows equally --------------------------------------------
function sampleParts(built: readonly Built[], max: number, label: string): Built[] {
  const keep = new Set<Built>();
  // `no_link` rows first, at most NO_LINK_SHARE of the job's rows.
  const noLink = built.filter((b) => b.part === 'no_link');
  for (const b of sampleBySplit(noLink, (x) => x.split, Math.floor(max * NO_LINK_SHARE), SEED, `${label}|no_link`)
    .kept) {
    keep.add(b);
  }
  const parts = [...new Set(built.filter((b) => b.part !== 'no_link').map((b) => b.part))].sort();
  let left = max - keep.size;
  // The smallest parts first, so the room they don't use goes to the others.
  const bySize = parts
    .map((part) => built.filter((b) => b.part === part))
    .sort((a, b) => a.length - b.length || (a[0]!.part < b[0]!.part ? -1 : 1));
  bySize.forEach((items, i) => {
    const quota = Math.floor(left / (bySize.length - i));
    const kept = sampleBySplit(items, (b) => b.split, quota, SEED, `${label}|${items[0]!.part}`).kept;
    for (const b of kept) keep.add(b);
    left -= kept.length;
  });
  return built.filter((b) => keep.has(b));
}
const jobs: { job: TrainingJob; builder: JobBuilder; kept: Built[]; built: number; promptVersion: string }[] = [
  {
    job: 'extraction',
    builder: extraction.extractionBuilder,
    kept: sampleParts(extractionBuilt, args.maxPerJob, 'extraction'),
    built: extractionBuilt.length,
    promptVersion: EXTRACTION_PROMPT_VERSION,
  },
  {
    job: 'graph_query',
    builder: graphQuery.graphQueryBuilder,
    kept: sampleParts(graphBuilt, args.maxPerJob, 'graph_query'),
    built: graphBuilt.length,
    promptVersion: GRAPH_QUERY_PROMPT_VERSION,
  },
];

// ---- the self-check, then the files ------------------------------------------------------------------
for (const { job, builder, kept } of jobs) {
  const longest = kept.reduce<Built | undefined>(
    (best, b) => (best === undefined || b.example.assistant.length > best.example.assistant.length ? b : best),
    undefined,
  );
  if (longest === undefined) {
    console.error(`train-data-real: ${job} gave no rows`);
    process.exit(1);
  }
  const problems = await selfCheck(builder, longest.example);
  if (problems.length > 0) {
    console.error(`train-data-real: the self-check failed for ${job}:\n${problems.join('\n')}`);
    process.exit(1);
  }
}
console.log('train-data-real: self-check passed (extraction, graph_query)');

let jsonl = '';
const summary: Record<string, unknown> = {};
for (const { job, kept, built, promptVersion } of jobs) {
  const rows: Record<Split, number> = { train: 0, validation: 0 };
  const parts: Record<string, number> = {};
  for (const b of kept) {
    rows[b.split] += 1;
    parts[b.part] = (parts[b.part] ?? 0) + 1;
    jsonl += rowLine(rowOf(b.example, b.split));
  }
  summary[job] = { promptVersion, built, rows, parts, dropped: job === 'extraction' ? extractionDrops : graphDrops };
}
const sources = Object.fromEntries(
  [...SOURCE_FILES, NVD_KEV_FILE].sort().map((file) => {
    const data = readFileSync(join(SOURCES, file));
    return [file, { bytes: data.length, sha256: sha256(data) }];
  }),
);
const manifest = {
  arguments: { maxPerJob: args.maxPerJob, name: args.name, seed: SEED },
  data: 'real public data (2026-10-23, the user); Company X names kept out',
  licences: {
    attack: 'MITRE ATT&CK terms of use (royalty-free, with attribution)',
    ctid: 'Apache-2.0 (Center for Threat-Informed Defense)',
    kevNvd: 'US government work (CISA, NIST NVD)',
    vcdb: "VERIS Community Database's own licence",
  },
  records: {
    kept: records.size,
    links: keptFacts.size,
    documents: Object.fromEntries(
      (['technique', 'vulnerability', 'breach', 'no_link'] as const).map((k) => [
        k,
        documents.filter((d) => d.kind === k).length,
      ]),
    ),
    dropped: recordDrops,
  },
  jobs: summary,
  sources,
  files: {
    'train.jsonl': { rows: jsonl.split('\n').length - 1, bytes: Buffer.byteLength(jsonl), sha256: sha256(jsonl) },
  },
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'train.jsonl'), jsonl);
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`train-data-real: wrote ${TRAINING_DIR}/${args.name}/ (train.jsonl, manifest.json)`);
console.log(JSON.stringify({ records: manifest.records, jobs: summary }, null, 2));
