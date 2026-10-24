// `node --experimental-transform-types --disable-warning=ExperimentalWarning packages/infra/scripts/train-data-t2c.ts
// --export <text2cypher-rows.jsonl> [--name <name>] [--max-rows <n>]`: `graph_query` training rows for the text
// model, converted from the Hugging Face dataset neo4j/text2cypher-2024v1 (Apache-2.0) to our graph.
// - Input: the dataset's two parquet files, exported by a Python step (pyarrow) to one JSON Lines file, `--export`:
//   a first line `{"sources": [{file, sha256, rows}]}`, then one row per line (file, question, cypher,
//   data_source, instance_id, database_reference_alias). Each parquet file's SHA-256 is checked against the export's,
//   so a stale export is refused. Real GRC names come from data/generated/public-sources/ (ATT&CK, CTID's 800-53,
//   KEV and VERIS mappings, CISA KEV, VCDB), named as Company X names its records.
// - The conversion is not a label swap: each text2cypher query is parsed (one MATCH path of 0 to 2 hops, AND-ed
//   simple conditions, plain or counted or averaged returns, ORDER BY, LIMIT; anything else is dropped, by reason),
//   and its structure (which node is named, filtered, ordered, counted, grouped or returned) is mapped onto a GRC path
//   whose kinds can carry it. The question and the query are then both written from that one plan, so they agree;
//   the source question gives only its style (its opening word, "top" or "first" N, "distinct").
// - Names: a named node gets a real record name, and when a query names one node or more the path is a real one in a
//   small public graph (KEV product EXPOSED_TO technique, technique MITIGATED_BY control, control GOVERNED_BY its
//   family's policy, VCDB incident EXPOSES technique and IMPACTS an exposed asset). Host names and HOSTS/RUNS are
//   synthetic. Company X is the test set: its record names (answer-key.json, read only for this) are taken out of
//   the name pools, and a row that still holds one, as a whole word in any case, is dropped (`company_x_name`).
// - Rows: rowOf/rowLine (./training/rows.ts), job `graph_query`; system + user are `graphQueryRequest(role,
//   question)`, the role picked with rolesSeeing + pickRole so it sees every kind and link the query uses; the
//   assistant text is `JSON.stringify({query})`. Every row passes checkGraphQueryAnswerValue and a check that the
//   query names only labels, link types and properties the role's graph description shows; one row goes through
//   selfCheck before anything is written. Any failure there is a bug (exit 1, nothing written).
// - Split by instance_id, about 10% validation; one row per identical input (`duplicate_input`), so no input is in
//   both splits. Then about `--max-rows` rows, sampled per query shape so the multi-hop and counting shapes aren't
//   swamped by the many one-node lookups. Each row's `seed` is the number in its instance_id.
// - Writes data/generated/training/<name>/train.jsonl and manifest.json (counts, drops by reason, each source file's
//   SHA-256 and licence). Same inputs, byte-identical files: seeded choices only, a fixed order, no clock.
// - Exit 2 for a refused argument or input, exit 1 for a bug in the rows; nothing is written in either case. The
//   output holds counts and paths only, never a row's text (D164).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The api's, the generators' and the shared sources import each other as `./x.js`, which are `./x.ts` files: plain
// `node` loads them with this hook (as train-data.ts does).
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

// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path.
type Rows = typeof import('./training/rows.js');
const { rowLine, rowOf, TrainingDataBug } = (await import(new URL('./training/rows.ts', import.meta.url).href)) as Rows;
type GraphQuery = typeof import('./training/graph-query.js');
const { checkGraphQueryAnswerValue, cypherText, graphQueryBuilder, pickRole, rolesSeeing } = (await import(
  new URL('./training/graph-query.ts', import.meta.url).href
)) as GraphQuery;
type SelfCheck = typeof import('./training/self-check.js');
const { selfCheck } = (await import(new URL('./training/self-check.ts', import.meta.url).href)) as SelfCheck;
type SplitModule = typeof import('./training/split.js');
const { sampleBySplit } = (await import(new URL('./training/split.ts', import.meta.url).href)) as SplitModule;
type Prompt = typeof import('../../api/src/search/graph/prompt.js');
const { GRAPH_QUERY_PROMPT_VERSION, graphQueryRequest } = (await import(
  new URL('../../api/src/search/graph/prompt.ts', import.meta.url).href
)) as Prompt;
type Description = typeof import('../../api/src/search/graph/graph-description.js');
const { GRAPH_KIND_FIELDS, viewedKinds, viewedLinkRows } = (await import(
  new URL('../../api/src/search/graph/graph-description.ts', import.meta.url).href
)) as Description;
type Shared = typeof import('../../shared/src/index.js');
const shared = (await import(new URL('../../shared/src/index.ts', import.meta.url).href)) as Shared;

type TrainingExample = import('./training/rows.js').TrainingExample;
type Split = import('./training/jobs.js').Split;
type ShapePath = import('./training/graph-query.js').ShapePath;
type PathLink = import('./training/graph-query.js').PathLink;
type Role = import('../../shared/src/index.js').Role;
type LinkType = import('../../shared/src/index.js').LinkType;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TRAINING_DIR = 'data/generated/training';
const PUBLIC = 'data/generated/public-sources';
const ANSWER_KEY = 'docs/datasets/company-x/answer-key.json';
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_NAME = 'train-t2c';
const DEFAULT_MAX_ROWS = 1000;
/** The seed of every seeded choice: the same inputs always give the same rows. */
const SEED = 1;
/** About one instance in VALIDATION_ONE_IN is `validation`. */
const VALIDATION_ONE_IN = 10;
/** VCDB incidents kept in the public graph, a seeded choice among the usable ones. */
const INCIDENTS = 400;

const USAGE =
  'usage: node --experimental-transform-types --disable-warning=ExperimentalWarning packages/infra/scripts/train-data-t2c.ts ' +
  `--export <text2cypher-rows.jsonl> [--name <a-z, 0-9 and -, default ${DEFAULT_NAME}>] ` +
  `[--max-rows <whole number from 10, default ${DEFAULT_MAX_ROWS}>]`;

function refuse(problems: string[], usage = true): never {
  for (const p of problems) console.error(`train-data-t2c: ${p}`);
  if (usage) console.error(USAGE);
  process.exit(2);
}

function fail(problems: string[]): never {
  for (const p of problems) console.error(`train-data-t2c: ${p}`);
  console.error('train-data-t2c: nothing was written');
  process.exit(1);
}

// ---------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------

interface Args {
  exportPath: string;
  name: string;
  maxRows: number;
}

function parseArgs(argv: string[]): Args {
  const flags = ['--export', '--name', '--max-rows'] as const;
  const values: Partial<Record<(typeof flags)[number], string>> = {};
  const problems: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    const eq = arg.indexOf('=');
    const flag = (eq > 0 ? arg.slice(0, eq) : arg) as (typeof flags)[number];
    if (!flags.includes(flag)) {
      problems.push(`unknown argument ${JSON.stringify(arg)}`);
      continue;
    }
    if (values[flag] !== undefined) problems.push(`${flag} is given twice`);
    if (eq > 0) values[flag] = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) values[flag] = argv[++i]!;
    else values[flag] = '';
  }
  const exportText = values['--export']?.trim();
  if (exportText === undefined || exportText === '')
    problems.push('--export is missing (the exported JSON Lines file)');
  const name = values['--name'] ?? DEFAULT_NAME;
  if (!NAME.test(name)) problems.push('--name must be 1 to 64 of a-z, 0-9 and -, starting with a letter or digit');
  if (/company-?x/i.test(name)) problems.push('--name names company-x: training data never comes from Company X');
  let maxRows = DEFAULT_MAX_ROWS;
  const maxText = values['--max-rows'];
  if (maxText !== undefined) {
    maxRows = /^[1-9][0-9]*$/.test(maxText.trim()) ? Number(maxText.trim()) : Number.NaN;
    if (!Number.isSafeInteger(maxRows) || maxRows < 10) problems.push('--max-rows must be a whole number from 10');
  }
  if (problems.length > 0) refuse(problems);
  return { exportPath: resolve(process.cwd(), exportText!), name, maxRows };
}

// ---------------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------------

interface SourceFile {
  path: string;
  title: string;
  licence: string;
  use: string;
}

const T2C_FILES = ['train-00000-of-00001.parquet', 'test-00000-of-00001.parquet'] as const;

const SOURCE_FILES: readonly SourceFile[] = [
  ...T2C_FILES.map((file) => ({
    path: `${PUBLIC}/text2cypher/${file}`,
    title: `neo4j/text2cypher-2024v1 (Hugging Face), ${file.split('-')[0]} split`,
    licence: 'Apache-2.0 (Neo4j)',
    use: 'the query shapes converted, and each question style',
  })),
  {
    path: `${PUBLIC}/attack/enterprise-attack.json`,
    title: 'MITRE ATT&CK Enterprise (STIX bundle)',
    licence: 'ATT&CK Terms of Use: free to use, with this notice: © The MITRE Corporation.',
    use: 'risk names (techniques; a sub-technique reads "Parent: Sub")',
  },
  {
    path: `${PUBLIC}/ctid-800-53.json`,
    title: 'CTID Mappings Explorer: NIST SP 800-53 Rev. 5 to ATT&CK 16.1 Enterprise',
    licence: 'Apache-2.0 (Center for Threat-Informed Defense). ATT&CK names: © The MITRE Corporation.',
    use: 'control codes and titles; MITIGATED_BY (mapping type "mitigates")',
  },
  {
    path: `${PUBLIC}/ctid-kev.json`,
    title: 'CTID Mappings Explorer: KEV (07/28/2025) to ATT&CK 16.1 Enterprise',
    licence: 'Apache-2.0 (Center for Threat-Informed Defense). ATT&CK names: © The MITRE Corporation.',
    use: 'EXPOSED_TO (a KEV product to the techniques of its exploited vulnerabilities)',
  },
  {
    path: `${PUBLIC}/cisa-kev.json`,
    title: 'CISA Known Exploited Vulnerabilities catalog',
    licence: 'A work of the US Government (CISA); see cisa.gov for its terms of use.',
    use: 'asset names (vendor + product)',
  },
  {
    path: `${PUBLIC}/ctid-veris.json`,
    title: 'CTID Mappings Explorer: VERIS 1.4.0 to ATT&CK 16.1 Enterprise',
    licence: 'Apache-2.0 (Center for Threat-Informed Defense). ATT&CK names: © The MITRE Corporation.',
    use: 'EXPOSES (a VCDB incident to the techniques of its coded attack types)',
  },
  {
    path: `${PUBLIC}/vcdb.json.zip`,
    title: 'VERIS Community Database (joined export)',
    licence: 'CC BY-SA 4.0 (VERIS Community Database contributors). Adapted material must keep this licence.',
    use: 'incident names ("<action> on <asset> (YYYY-MM)")',
  },
  {
    path: ANSWER_KEY,
    title: 'Company X answer key (the test set)',
    licence: "The project's own.",
    use: 'read only for the record names and control codes no row may hold',
  },
];

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

function readSource(path: string): Buffer {
  try {
    return readFileSync(join(REPO_ROOT, path));
  } catch {
    refuse([`${path} could not be read: it must be there already (this command downloads nothing)`], false);
  }
}

// ---------------------------------------------------------------------------------------------------
// Seeded choices (D45.8): one stream per purpose and row.
// ---------------------------------------------------------------------------------------------------

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

class Rng {
  private s: number;
  constructor(purpose: string) {
    this.s = hash32(`${SEED}:${purpose}`) || 1;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new TrainingDataBug('a seeded pick from an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------
// Company X: the names no row may hold
// ---------------------------------------------------------------------------------------------------

interface Exclusion {
  /** Each Company X record name and control code, as a whole-word, any-case pattern. */
  patterns: RegExp[];
  names: number;
  codes: Set<string>;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function companyXExclusion(buf: Buffer): Exclusion {
  type Named = { name: string }[];
  const key = JSON.parse(buf.toString('utf8')) as {
    orgs: {
      assets: Named;
      risks: Named;
      controls: { name: string; code?: string }[];
      policies: Named;
      incidents: Named;
    }[];
  };
  const names = new Set<string>();
  const codes = new Set<string>();
  for (const org of key.orgs) {
    for (const record of [...org.assets, ...org.risks, ...org.controls, ...org.policies, ...org.incidents]) {
      names.add(record.name.toLowerCase());
    }
    for (const control of org.controls) if (control.code) codes.add(control.code);
  }
  const patterns = [...names, ...[...codes].map((c) => c.toLowerCase())]
    .sort()
    .map((text) => new RegExp(`(?<![a-z0-9])${escapeRegExp(text)}(?![a-z0-9])`, 'u'));
  return { patterns, names: names.size, codes };
}

function holdsCompanyX(text: string, exclusion: Exclusion): boolean {
  const lower = text.toLowerCase();
  return exclusion.patterns.some((pattern) => pattern.test(lower));
}

// ---------------------------------------------------------------------------------------------------
// The public graph: real names and links, named as Company X names its records
// ---------------------------------------------------------------------------------------------------

type Kind = 'asset' | 'risk' | 'control' | 'policy' | 'incident';
const KINDS: readonly Kind[] = ['asset', 'risk', 'control', 'policy', 'incident'];

interface PublicRecord {
  key: string;
  kind: Kind;
  name: string;
  /** Whether a question may name it: no other record of its kind holds its name (a CONTAINS match finds it alone). */
  nameable: boolean;
  /** A control's 800-53 code. */
  code?: string;
}

interface PublicGraph {
  records: Map<string, PublicRecord>;
  ofKind: Record<Kind, PublicRecord[]>;
  /** `${type}|out|${key}`: the records the link leads to; `${type}|in|${key}`: the ones it comes from. */
  next: Map<string, string[]>;
  links: Record<LinkType, number>;
  counts: Record<string, number>;
}

/** 800-53's control families, for the policies (one per family, 800-53's own "-1 Policy" rule, as Company X). */
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

/** CTID mapping types that make an asset exposed to a technique's risk (as Company X). */
const EXPOSURE_TYPES = new Set(['exploitation_technique', 'primary_impact']);

/** Synthetic hosts (none of Company X's): hypervisors host servers, and servers run KEV products. */
const HYPERVISORS = ['hv01', 'hv02', 'hv03', 'hv04', 'hv05', 'hv06'];
const SERVER_PREFIXES = ['app', 'web', 'db', 'dc', 'fs', 'erp', 'crm', 'git', 'ci', 'log', 'mon', 'jump', 'nas'];

/** CTID writes 800-53 IDs zero-padded (`AC-02`); the catalog's code is `AC-2`. */
function controlCode(ctidId: string): string {
  return ctidId.replace(/-0*(\d+)/, '-$1').replace(/\(0*(\d+)\)/g, '($1)');
}

interface MappingObject {
  capability_id: string | null;
  capability_description: string | null;
  mapping_type: string | null;
  attack_object_id: string;
}

interface VcdbIncident {
  incident_id: string;
  summary?: string;
  security_incident?: string;
  timeline?: { incident?: { year?: number; month?: number } };
  action?: Record<string, { variety?: string[]; vector?: string[] }>;
  attribute?: {
    confidentiality?: { data_disclosure?: string };
    integrity?: { variety?: string[] };
    availability?: { variety?: string[] };
  };
}

/** VCDB's coded attack types, in CTID's VERIS IDs (as Company X). */
function verisEnums(i: VcdbIncident): string[] {
  const out: string[] = [];
  for (const [category, body] of Object.entries(i.action ?? {})) {
    for (const field of ['variety', 'vector'] as const) {
      for (const v of body[field] ?? []) out.push(`action.${category}.${field}.${v}`);
    }
  }
  const disclosure = i.attribute?.confidentiality?.data_disclosure;
  if (disclosure) out.push(`attribute.confidentiality.data_disclosure.${disclosure}`);
  for (const v of i.attribute?.integrity?.variety ?? []) out.push(`attribute.integrity.variety.${v}`);
  for (const v of i.attribute?.availability?.variety ?? []) out.push(`attribute.availability.variety.${v}`);
  return out;
}

/** The incident's main attack, for its name (as Company X). */
function primaryVariety(i: VcdbIncident): string | null {
  for (const category of ['malware', 'hacking', 'social']) {
    const v = (i.action?.[category]?.variety ?? []).find((x) => x !== 'Unknown' && x !== 'Other');
    if (v) return v;
  }
  return null;
}

/** Names that would read badly in a question or a Cypher string. */
const AWKWARD_NAME = /[<>{}`\\"\n]/;

function buildPublicGraph(files: Map<string, Buffer>, exclusion: Exclusion): PublicGraph {
  const records = new Map<string, PublicRecord>();
  const counts: Record<string, number> = {};
  const count = (what: string): void => {
    counts[what] = (counts[what] ?? 0) + 1;
  };
  const add = (record: Omit<PublicRecord, 'nameable'>): boolean => {
    if (records.has(record.key)) return true;
    if (AWKWARD_NAME.test(record.name)) {
      count(`${record.kind}_awkward_name`);
      return false;
    }
    if (holdsCompanyX(record.name, exclusion) || (record.code !== undefined && exclusion.codes.has(record.code))) {
      count(`${record.kind}_company_x`);
      return false;
    }
    records.set(record.key, { ...record, nameable: false });
    return true;
  };
  const linkList: { type: LinkType; from: string; to: string }[] = [];
  const link = (type: LinkType, from: string, to: string): void => {
    if (records.has(from) && records.has(to) && from !== to) linkList.push({ type, from, to });
  };
  const json = (path: string): unknown => JSON.parse(files.get(path)!.toString('utf8'));
  const mappings = (path: string): MappingObject[] =>
    (json(path) as { mapping_objects: MappingObject[] }).mapping_objects;

  // ---- risks: ATT&CK techniques ------------------------------------------------------------------
  const bundle = json(`${PUBLIC}/attack/enterprise-attack.json`) as {
    objects: {
      type: string;
      name?: string;
      revoked?: boolean;
      x_mitre_deprecated?: boolean;
      x_mitre_domains?: string[];
      external_references?: { source_name?: string; external_id?: string }[];
    }[];
  };
  const techniqueName = new Map<string, string>();
  for (const o of bundle.objects) {
    if (o.type !== 'attack-pattern' || o.revoked || o.x_mitre_deprecated || !o.name) continue;
    if (!(o.x_mitre_domains ?? []).includes('enterprise-attack')) continue;
    const id = o.external_references?.find((r) => r.source_name === 'mitre-attack')?.external_id;
    if (id) techniqueName.set(id, o.name);
  }
  for (const [id, own] of [...techniqueName].sort((x, y) => x[0].localeCompare(y[0]))) {
    const parent = id.includes('.') ? techniqueName.get(id.split('.')[0]!) : undefined;
    add({ key: `risk:${id}`, kind: 'risk', name: parent ? `${parent}: ${own}` : own });
  }

  // ---- controls: CTID's 800-53 mitigations ----------------------------------------------------------
  const mitigations = mappings(`${PUBLIC}/ctid-800-53.json`).filter(
    (o) => o.mapping_type === 'mitigates' && o.capability_id && o.capability_description,
  );
  const titleOf = new Map<string, string>();
  for (const o of mitigations) titleOf.set(controlCode(o.capability_id!), o.capability_description!.trim());
  const titleCount = new Map<string, number>();
  for (const title of titleOf.values()) titleCount.set(title, (titleCount.get(title) ?? 0) + 1);
  const codes = [...titleOf.keys()].sort((x, y) => x.localeCompare(y, 'en', { numeric: true }));
  for (const code of codes) {
    const title = titleOf.get(code)!;
    // Two controls with one title read "<title> (<code>)", as Company X names them.
    const name = (titleCount.get(title) ?? 0) > 1 ? `${title} (${code})` : title;
    add({ key: `control:${code}`, kind: 'control', name, code });
  }
  for (const o of mitigations)
    link('MITIGATED_BY', `risk:${o.attack_object_id}`, `control:${controlCode(o.capability_id!)}`);

  // ---- policies: one per 800-53 family, each governing its family's controls -----------------------
  for (const [family, title] of Object.entries(FAMILIES).sort((x, y) => x[0].localeCompare(y[0]))) {
    add({ key: `policy:${family}`, kind: 'policy', name: `${title} Policy` });
  }
  for (const code of codes) link('GOVERNED_BY', `control:${code}`, `policy:${code.split('-')[0]!}`);

  // ---- assets: KEV products, exposed to their vulnerabilities' techniques ---------------------------
  const kev = json(`${PUBLIC}/cisa-kev.json`) as {
    vulnerabilities: { cveID: string; vendorProject: string; product: string }[];
  };
  const productOfCve = new Map<string, string>();
  for (const v of [...kev.vulnerabilities].sort((x, y) => x.cveID.localeCompare(y.cveID))) {
    const name = `${v.vendorProject} ${v.product}`.replace(/\s+/g, ' ').trim();
    const key = `asset:${name.toLowerCase()}`;
    if (add({ key, kind: 'asset', name })) productOfCve.set(v.cveID, key);
  }
  for (const o of mappings(`${PUBLIC}/ctid-kev.json`)) {
    if (!EXPOSURE_TYPES.has(o.mapping_type ?? '')) continue;
    const asset = productOfCve.get(o.capability_id ?? '');
    if (asset) link('EXPOSED_TO', asset, `risk:${o.attack_object_id}`);
  }

  // ---- hosts (synthetic): hypervisors host servers, servers run exposed products ---------------------
  const exposedProducts = [...new Set(linkList.filter((l) => l.type === 'EXPOSED_TO').map((l) => l.from))].sort();
  const servers: string[] = [];
  for (const prefix of SERVER_PREFIXES) for (const n of ['02', '03', '04']) servers.push(`${prefix}${n}`);
  const hostRng = new Rng('hosts');
  for (const name of [...HYPERVISORS, ...servers]) add({ key: `asset:${name}`, kind: 'asset', name });
  for (const [i, server] of servers.entries()) {
    link('HOSTS', `asset:${HYPERVISORS[i % HYPERVISORS.length]!}`, `asset:${server}`);
    for (const product of hostRng.shuffle(exposedProducts).slice(0, hostRng.int(1, 3))) {
      link('RUNS', `asset:${server}`, product);
    }
  }

  // ---- incidents: real VCDB records whose attack types reach the risks --------------------------------
  const verisToTechniques = new Map<string, Set<string>>();
  for (const o of mappings(`${PUBLIC}/ctid-veris.json`)) {
    if (!o.capability_id) continue;
    const set = verisToTechniques.get(o.capability_id) ?? new Set<string>();
    set.add(o.attack_object_id);
    verisToTechniques.set(o.capability_id, set);
  }
  const exposedTo = new Map<string, string[]>();
  for (const l of linkList) if (l.type === 'EXPOSED_TO') exposedTo.set(l.to, [...(exposedTo.get(l.to) ?? []), l.from]);
  let vcdb: VcdbIncident[];
  try {
    const text = execFileSync('unzip', ['-p', join(REPO_ROOT, PUBLIC, 'vcdb.json.zip')], {
      maxBuffer: 512 * 1024 * 1024,
    });
    vcdb = JSON.parse(text.toString('utf8')) as VcdbIncident[];
  } catch {
    refuse([`${PUBLIC}/vcdb.json.zip could not be read with unzip`], false);
  }
  interface Candidate {
    incident: VcdbIncident;
    variety: string;
    risks: string[];
  }
  const candidates: Candidate[] = [];
  for (const incident of [...vcdb].sort((x, y) => x.incident_id.localeCompare(y.incident_id))) {
    const year = incident.timeline?.incident?.year;
    if (incident.security_incident !== 'Confirmed' || typeof year !== 'number' || year < 2012) continue;
    const variety = primaryVariety(incident);
    if (!variety) continue;
    const reached = new Set<string>();
    for (const e of verisEnums(incident)) {
      for (const t of verisToTechniques.get(e) ?? []) if (records.has(`risk:${t}`)) reached.add(`risk:${t}`);
    }
    const risks = [...reached].sort();
    if (risks.length < 1 || risks.length > 6) continue;
    candidates.push({ incident, variety, risks });
  }
  const incidentRng = new Rng('incidents');
  const allAssets = [...records.values()].filter((r) => r.kind === 'asset').map((r) => r.key);
  const picked = incidentRng
    .shuffle(candidates)
    .slice(0, INCIDENTS)
    .sort((x, y) => x.incident.incident_id.localeCompare(y.incident.incident_id));
  const incidentNames = new Set<string>();
  for (const c of picked) {
    // The asset it hit: one exposed to one of its risks, else any (synthetic, as Company X places its incidents).
    const exposed = [...new Set(c.risks.flatMap((r) => exposedTo.get(r) ?? []))].filter((a) => records.has(a)).sort();
    const asset = incidentRng.pick(exposed.length > 0 ? exposed : allAssets);
    const t = c.incident.timeline?.incident ?? {};
    const month = `${String(t.year).padStart(4, '0')}-${String(t.month ?? 1).padStart(2, '0')}`;
    const label = `${c.variety[0]!.toUpperCase()}${c.variety.slice(1)}`;
    let name = `${label} on ${records.get(asset)!.name} (${month})`;
    for (let n = 2; incidentNames.has(name); n++) name = `${label} on ${records.get(asset)!.name} (${month}, ${n})`;
    const key = `incident:${c.incident.incident_id}`;
    if (!add({ key, kind: 'incident', name })) continue;
    incidentNames.add(name);
    link('IMPACTS', key, asset);
    for (const r of c.risks) link('EXPOSES', key, r);
  }

  // ---- what may be named, and the links both ways ---------------------------------------------------
  const ofKind: Record<Kind, PublicRecord[]> = { asset: [], risk: [], control: [], policy: [], incident: [] };
  for (const record of records.values()) ofKind[record.kind].push(record);
  for (const kind of KINDS) {
    const lower = ofKind[kind].map((r) => r.name.toLowerCase());
    for (const [i, record] of ofKind[kind].entries()) {
      const needle = lower[i]!;
      record.nameable = !lower.some((other, j) => j !== i && other.includes(needle));
    }
  }
  const next = new Map<string, string[]>();
  const links = Object.fromEntries(shared.LINK_TYPES.map((row) => [row.type, 0])) as Record<LinkType, number>;
  const seen = new Set<string>();
  for (const l of linkList) {
    const id = `${l.type}|${l.from}|${l.to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    links[l.type] += 1;
    for (const [dir, from, to] of [
      ['out', l.from, l.to],
      ['in', l.to, l.from],
    ] as const) {
      const k = `${l.type}|${dir}|${from}`;
      next.set(k, [...(next.get(k) ?? []), to]);
    }
  }
  for (const kind of KINDS) counts[kind] = ofKind[kind].length;
  for (const kind of KINDS) counts[`${kind}_nameable`] = ofKind[kind].filter((r) => r.nameable).length;
  return { records, ofKind, next, links, counts };
}

// ---------------------------------------------------------------------------------------------------
// The text2cypher queries: a small Cypher grammar
// ---------------------------------------------------------------------------------------------------

/** Why a text2cypher row is left out, in the order they are reported. */
const DROP_REASONS = [
  'source_marked_incorrect',
  'unreadable',
  'not_a_single_match',
  'unsupported_pattern',
  'too_many_hops',
  'variable_length',
  'relationship_property',
  'or_condition',
  'unsupported_condition',
  'null_check',
  'unsupported_function',
  'unsupported_clause',
  'unsupported_return',
  'unsupported_count',
  'unsupported_stat',
  'unsupported_group',
  'nothing_to_ask',
  'no_grc_path',
  'no_real_path',
  'company_x_name',
  'duplicate_input',
] as const;
type DropReason = (typeof DROP_REASONS)[number];

class Drop extends Error {
  constructor(readonly reason: DropReason) {
    super(reason);
  }
}

interface Tok {
  t: 'id' | 'str' | 'num' | 'op';
  v: string;
  /** An identifier in backticks: a name, never a keyword. */
  quoted?: boolean;
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) throw new Drop('unsupported_clause');
    if (ch === "'" || ch === '"') {
      let value = '';
      let j = i + 1;
      for (; j < text.length && text[j] !== ch; j++) {
        if (text[j] === '\\') {
          j++;
          if (j >= text.length) break;
        }
        value += text[j];
      }
      if (j >= text.length) throw new Drop('unreadable');
      out.push({ t: 'str', v: value });
      i = j + 1;
      continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end < 0) throw new Drop('unreadable');
      out.push({ t: 'id', v: text.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }
    const num = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (num) {
      out.push({ t: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0] });
      i += id[0].length;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (['<>', '>=', '<=', '->', '<-', '!=', '=~', '..'].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('()[]{}:,.|*;=<>-+/%$^'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    throw new Drop('unreadable');
  }
  return out;
}

type Literal = { t: 'str'; v: string } | { t: 'num'; v: number } | { t: 'bool'; v: boolean };

interface SNode {
  label: string | null;
}
interface SHop {
  types: string[];
  dir: 'out' | 'in' | 'both';
}
type CondOp = '=' | '<>' | '>' | '>=' | '<' | '<=' | 'contains' | 'starts' | 'ends' | 'notnull';
interface SCond {
  slot: number;
  prop: string;
  op: CondOp;
  value: Literal | null;
}
type AggFn = 'count' | 'avg' | 'sum' | 'min' | 'max';
type SExpr =
  | { k: 'var'; slot: number }
  | { k: 'prop'; slot: number; prop: string }
  | { k: 'agg'; fn: AggFn; distinct: boolean; arg: SExpr | null };
interface SOrder {
  expr: SExpr;
  desc: boolean;
}
interface SourceQuery {
  nodes: SNode[];
  hops: SHop[];
  conds: SCond[];
  returns: SExpr[];
  distinct: boolean;
  order: SOrder | null;
  limit: number | null;
  /** Whether the grouping was written with WITH. */
  usedWith: boolean;
}

const AGGREGATES = new Set(['count', 'avg', 'sum', 'min', 'max']);
const STOP_AFTER_RETURN = new Set(['MATCH', 'OPTIONAL', 'UNWIND', 'UNION', 'CALL', 'WITH']);

class CypherParser {
  private pos = 0;
  private readonly nodeVars = new Map<string, number>();
  private readonly relVars = new Set<string>();
  private readonly aliases = new Map<string, SExpr>();
  private readonly nodes: SNode[] = [];
  private readonly hops: SHop[] = [];
  /** Conditions written inside a node pattern, `{name: 'x'}`. */
  readonly inlineConds: SCond[] = [];
  constructor(private readonly toks: Tok[]) {}

  private peek(offset = 0): Tok | undefined {
    return this.toks[this.pos + offset];
  }
  private isKw(word: string, offset = 0): boolean {
    const tok = this.peek(offset);
    return tok?.t === 'id' && !tok.quoted && tok.v.toUpperCase() === word;
  }
  private isOp(op: string, offset = 0): boolean {
    const tok = this.peek(offset);
    return tok?.t === 'op' && tok.v === op;
  }
  private acceptKw(word: string): boolean {
    if (!this.isKw(word)) return false;
    this.pos++;
    return true;
  }
  private acceptOp(op: string): boolean {
    if (!this.isOp(op)) return false;
    this.pos++;
    return true;
  }
  private expectOp(op: string, reason: DropReason): void {
    if (!this.acceptOp(op)) throw new Drop(reason);
  }
  private ident(reason: DropReason): string {
    const tok = this.peek();
    if (tok?.t !== 'id') throw new Drop(reason);
    this.pos++;
    return tok.v;
  }

  parse(): SourceQuery {
    if (!this.acceptKw('MATCH')) throw new Drop('not_a_single_match');
    this.pattern();
    const conds: SCond[] = this.acceptKw('WHERE') ? this.conditions() : [];
    let usedWith = false;
    let distinct = false;
    let order: SOrder | null = null;
    let limit: number | null = null;
    if (this.acceptKw('WITH')) {
      usedWith = true;
      distinct = this.acceptKw('DISTINCT');
      // WITH's items are used through their names (aliases) by RETURN and ORDER BY.
      this.items();
      order = this.orderBy();
      limit = this.limit();
      if (this.isKw('WHERE')) throw new Drop('unsupported_clause');
    }
    if (!this.acceptKw('RETURN')) {
      throw new Drop(
        STOP_AFTER_RETURN.has(this.peek()?.v.toUpperCase() ?? '') ? 'not_a_single_match' : 'unsupported_clause',
      );
    }
    if (this.acceptKw('DISTINCT')) distinct = true;
    const returns = this.items();
    const lastOrder = this.orderBy();
    if (lastOrder !== null) {
      if (order !== null) throw new Drop('unsupported_clause');
      order = lastOrder;
    }
    if (this.isKw('SKIP')) throw new Drop('unsupported_clause');
    const lastLimit = this.limit();
    if (lastLimit !== null) {
      if (limit !== null) throw new Drop('unsupported_clause');
      limit = lastLimit;
    }
    this.acceptOp(';');
    if (this.pos < this.toks.length) {
      throw new Drop(
        STOP_AFTER_RETURN.has(this.peek()?.v.toUpperCase() ?? '') ? 'not_a_single_match' : 'unsupported_clause',
      );
    }
    return { nodes: this.nodes, hops: this.hops, conds, returns, distinct, order, limit, usedWith };
  }

  private pattern(): void {
    // An optional path variable: `p = (...)`.
    if (this.peek()?.t === 'id' && this.isOp('=', 1)) this.pos += 2;
    this.node();
    while (this.isOp('-') || this.isOp('<-')) {
      if (this.hops.length === 2) throw new Drop('too_many_hops');
      const left = this.isOp('<-') ? 'in' : 'out';
      this.pos++;
      if (!this.acceptOp('[')) throw new Drop('unsupported_pattern');
      if (this.peek()?.t === 'id') {
        const v = this.ident('unsupported_pattern');
        if (this.nodeVars.has(v) || this.relVars.has(v)) throw new Drop('unsupported_pattern');
        this.relVars.add(v);
      }
      const types: string[] = [];
      if (this.acceptOp(':')) {
        types.push(this.ident('unsupported_pattern'));
        while (this.acceptOp('|')) {
          this.acceptOp(':');
          types.push(this.ident('unsupported_pattern'));
        }
      }
      if (this.isOp('*')) throw new Drop('variable_length');
      if (this.isOp('{')) throw new Drop('relationship_property');
      this.expectOp(']', 'unsupported_pattern');
      let dir: SHop['dir'];
      if (this.acceptOp('->')) {
        if (left === 'in') throw new Drop('unsupported_pattern');
        dir = 'out';
      } else if (this.acceptOp('-')) {
        dir = left === 'in' ? 'in' : 'both';
      } else throw new Drop('unsupported_pattern');
      if (types.length === 0) throw new Drop('unsupported_pattern');
      this.hops.push({ types, dir });
      this.node();
    }
    if (this.isOp(',')) throw new Drop('not_a_single_match');
  }

  private node(): void {
    this.expectOp('(', 'unsupported_pattern');
    const slot = this.nodes.length;
    if (this.peek()?.t === 'id') {
      const v = this.ident('unsupported_pattern');
      if (this.nodeVars.has(v) || this.relVars.has(v)) throw new Drop('unsupported_pattern');
      this.nodeVars.set(v, slot);
    }
    let label: string | null = null;
    if (this.acceptOp(':')) {
      label = this.ident('unsupported_pattern');
      if (this.isOp(':')) throw new Drop('unsupported_pattern');
    }
    this.nodes.push({ label });
    if (this.acceptOp('{')) {
      do {
        const prop = this.ident('unsupported_pattern');
        this.expectOp(':', 'unsupported_pattern');
        this.inlineConds.push({ slot, prop, op: '=', value: this.literal() });
      } while (this.acceptOp(','));
      this.expectOp('}', 'unsupported_pattern');
    }
    this.expectOp(')', 'unsupported_pattern');
  }

  private literal(): Literal {
    const tok = this.peek();
    if (tok?.t === 'str') {
      this.pos++;
      return { t: 'str', v: tok.v };
    }
    if (tok?.t === 'num') {
      this.pos++;
      return { t: 'num', v: Number(tok.v) };
    }
    if (this.isOp('-') && this.peek(1)?.t === 'num') {
      this.pos += 2;
      return { t: 'num', v: -Number(this.toks[this.pos - 1]!.v) };
    }
    if (this.isKw('TRUE') || this.isKw('FALSE')) {
      this.pos++;
      return { t: 'bool', v: tok!.v.toUpperCase() === 'TRUE' };
    }
    // date('2020-01-01') and the like: the text it holds.
    if (tok?.t === 'id' && ['DATE', 'DATETIME'].includes(tok.v.toUpperCase()) && this.isOp('(', 1)) {
      this.pos += 2;
      const inner = this.peek();
      if (inner?.t !== 'str') throw new Drop('unsupported_condition');
      this.pos++;
      this.expectOp(')', 'unsupported_condition');
      return { t: 'str', v: inner.v };
    }
    throw new Drop('unsupported_condition');
  }

  /** `var.prop` of a node variable. */
  private propRef(): { slot: number; prop: string } {
    const v = this.ident('unsupported_condition');
    if (this.relVars.has(v)) throw new Drop('relationship_property');
    const slot = this.nodeVars.get(v);
    if (slot === undefined) throw new Drop('unsupported_condition');
    this.expectOp('.', 'unsupported_condition');
    return { slot, prop: this.ident('unsupported_condition') };
  }

  private conditions(): SCond[] {
    const out: SCond[] = [this.condition()];
    for (;;) {
      if (this.acceptKw('AND')) out.push(this.condition());
      else if (this.isKw('OR') || this.isKw('XOR')) throw new Drop('or_condition');
      else return out;
    }
  }

  private condition(): SCond {
    if (this.isKw('NOT') || this.isOp('(') || this.isKw('EXISTS')) throw new Drop('unsupported_condition');
    let lowered = false;
    const tok = this.peek();
    if (tok?.t === 'id' && ['TOLOWER', 'TOUPPER'].includes(tok.v.toUpperCase()) && this.isOp('(', 1)) {
      this.pos += 2;
      lowered = true;
    } else if (tok?.t === 'id' && this.isOp('(', 1)) throw new Drop('unsupported_function');
    const ref = this.propRef();
    if (lowered) this.expectOp(')', 'unsupported_condition');
    if (this.acceptKw('CONTAINS')) return { ...ref, op: 'contains', value: this.text() };
    if (this.acceptKw('STARTS')) {
      if (!this.acceptKw('WITH')) throw new Drop('unsupported_condition');
      return { ...ref, op: 'starts', value: this.text() };
    }
    if (this.acceptKw('ENDS')) {
      if (!this.acceptKw('WITH')) throw new Drop('unsupported_condition');
      return { ...ref, op: 'ends', value: this.text() };
    }
    if (this.acceptKw('IS')) {
      const not = this.acceptKw('NOT');
      if (!this.acceptKw('NULL')) throw new Drop('unsupported_condition');
      if (!not) throw new Drop('null_check');
      return { ...ref, op: 'notnull', value: null };
    }
    const op = this.peek();
    if (op?.t === 'op' && ['=', '<>', '!=', '>', '>=', '<', '<='].includes(op.v)) {
      this.pos++;
      const value = this.literal();
      if (lowered && value.t !== 'str') throw new Drop('unsupported_condition');
      return { ...ref, op: op.v === '!=' ? '<>' : (op.v as CondOp), value };
    }
    throw new Drop('unsupported_condition');
  }

  private text(): Literal {
    const value = this.literal();
    if (value.t !== 'str') throw new Drop('unsupported_condition');
    return value;
  }

  private items(): SExpr[] {
    if (this.isOp('*')) throw new Drop('unsupported_return');
    const out: SExpr[] = [];
    do {
      const expr = this.expr();
      if (this.acceptKw('AS')) {
        const alias = this.ident('unsupported_return');
        this.aliases.set(alias, expr);
      }
      const next = this.peek();
      if (next?.t === 'op' && '+-*/%^'.includes(next.v)) throw new Drop('unsupported_return');
      out.push(expr);
    } while (this.acceptOp(','));
    return out;
  }

  private expr(): SExpr {
    const tok = this.peek();
    if (tok?.t !== 'id') throw new Drop('unsupported_return');
    if (!tok.quoted && this.isOp('(', 1)) {
      const fn = tok.v.toLowerCase();
      if (!AGGREGATES.has(fn)) throw new Drop('unsupported_function');
      this.pos += 2;
      const distinct = this.acceptKw('DISTINCT');
      let arg: SExpr | null = null;
      if (!this.acceptOp('*')) {
        arg = this.expr();
        if (arg.k === 'agg') throw new Drop('unsupported_return');
      }
      this.expectOp(')', 'unsupported_return');
      return { k: 'agg', fn: fn as AggFn, distinct, arg };
    }
    this.pos++;
    if (this.acceptOp('.')) {
      if (this.relVars.has(tok.v)) throw new Drop('relationship_property');
      const slot = this.nodeVars.get(tok.v);
      if (slot === undefined) throw new Drop('unsupported_return');
      return { k: 'prop', slot, prop: this.ident('unsupported_return') };
    }
    const alias = this.aliases.get(tok.v);
    if (alias !== undefined) return alias;
    if (this.relVars.has(tok.v)) throw new Drop('relationship_property');
    const slot = this.nodeVars.get(tok.v);
    if (slot === undefined) throw new Drop('unsupported_return');
    return { k: 'var', slot };
  }

  private orderBy(): SOrder | null {
    if (!this.isKw('ORDER')) return null;
    this.pos++;
    if (!this.acceptKw('BY')) throw new Drop('unsupported_clause');
    let first: SOrder | null = null;
    do {
      const expr = this.expr();
      let desc = false;
      if (this.acceptKw('DESC') || this.acceptKw('DESCENDING')) desc = true;
      else if (!this.acceptKw('ASC')) this.acceptKw('ASCENDING');
      // The first key decides the order the question asks for.
      first ??= { expr, desc };
    } while (this.acceptOp(','));
    return first;
  }

  private limit(): number | null {
    if (!this.acceptKw('LIMIT')) return null;
    const tok = this.peek();
    if (tok?.t !== 'num' || !/^\d+$/.test(tok.v)) throw new Drop('unsupported_clause');
    this.pos++;
    const n = Number(tok.v);
    if (n < 1) throw new Drop('unsupported_clause');
    return n;
  }
}

function parseCypher(cypher: string): SourceQuery {
  const parser = new CypherParser(tokenize(cypher));
  const query = parser.parse();
  query.conds = [...parser.inlineConds, ...query.conds];
  return query;
}

// ---------------------------------------------------------------------------------------------------
// The plan: the query's structure on a GRC path
// ---------------------------------------------------------------------------------------------------

type Need = 'name' | 'code' | 'keyword' | 'enum' | 'number' | 'date';

const NAME_LIKE =
  /^(?:name|title|fullname|full_name|username|user_name|login|displayname|display_name|screen_name)$|name$|title$/i;
const ID_LIKE = /^(?:id|uuid|code|number|key)$|_id$|Id$|_code$|_number$/;
// `runtime` and the like are numbers, not times.
const DATE_LIKE = /[Dd]ate|[Yy]ear|released|born|[Cc]reated|[Uu]pdated|since|[Mm]onth|^time|_time|_at$|At$/;

/** Each kind's fields, by need: from GRAPH_KIND_FIELDS (Asset, Risk, Control, Policy, Incident) plus every node's own. */
const FIELDS: Readonly<Record<Kind, { enum: readonly string[]; number: readonly string[]; date: readonly string[] }>> =
  {
    asset: { enum: ['criticality', 'assetType', 'dataClassification', 'status', 'sensitivity'], number: [], date: [] },
    risk: { enum: ['status', 'sensitivity'], number: ['impact', 'likelihood', 'financialExposure'], date: [] },
    control: { enum: ['controlStatus', 'status', 'sensitivity'], number: [], date: ['lastTestedDate'] },
    policy: { enum: ['status', 'sensitivity'], number: [], date: ['effectiveDate'] },
    incident: { enum: ['severity', 'incidentStatus', 'status', 'sensitivity'], number: [], date: ['occurredAt'] },
  };

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  criticality: shared.CRITICALITIES,
  assetType: shared.ASSET_TYPES,
  dataClassification: shared.LABELS,
  controlStatus: shared.CONTROL_STATUSES,
  severity: shared.INCIDENT_SEVERITIES,
  incidentStatus: shared.INCIDENT_STATUSES,
  status: shared.RECORD_STATUSES,
  sensitivity: shared.LABELS,
};

const DATE_VALUES: Readonly<Record<string, readonly string[]>> = {
  lastTestedDate: ['2025-10-01', '2026-01-01', '2026-03-01', '2026-06-01'],
  effectiveDate: ['2024-01-01', '2025-01-01', '2025-07-01', '2026-01-01'],
  occurredAt: ['2015-01-01', '2018-01-01', '2020-01-01', '2023-01-01'],
};

type NumberOp = '=' | '<>' | '>' | '>=' | '<' | '<=';

type Filter =
  | { t: 'named'; name: string }
  | { t: 'code'; code: string }
  | { t: 'keyword'; op: 'contains' | 'starts' | 'ends'; word: string }
  | { t: 'enum'; field: string; value: string; neg: boolean }
  | { t: 'number'; field: string; op: NumberOp; value: number }
  | { t: 'date'; field: string; op: '>' | '>=' | '<' | '<='; value: string };

interface Hop {
  types: LinkType[];
  /** True when the step goes the links' own way, from their `from` kind to their `to` kind. */
  forward: boolean;
  /** Written without a direction, as the source wrote it. */
  undirected: boolean;
}

interface Order {
  slot: number;
  /** `name`, or a number or date field. */
  field: string;
  need: 'name' | 'number' | 'date';
  desc: boolean;
}

type Ask =
  | {
      f: 'list';
      target: number;
      form: 'node' | 'distinct' | 'path';
      order: Order | null;
      limit: number;
      shown: boolean;
    }
  | { f: 'count'; target: number; distinct: boolean }
  | { f: 'stat'; target: number; fn: 'avg' | 'sum' | 'min' | 'max'; field: string; need: 'number' | 'date' }
  | {
      f: 'group';
      group: number;
      counted: number;
      by: string | null;
      order: 'desc' | 'asc' | null;
      limit: number;
      shown: boolean;
      distinct: boolean;
      usedWith: boolean;
    };

interface Style {
  opener: 'verb' | 'which' | 'what' | 'how' | 'count' | 'calc' | 'other';
  verb: string;
  top: boolean;
  first: boolean;
  distinct: boolean;
}

interface Plan {
  kinds: Kind[];
  hops: Hop[];
  filters: Filter[][];
  ask: Ask;
  style: Style;
}

const LIST_VERBS: Readonly<Record<string, string>> = {
  list: 'List',
  find: 'Find',
  finds: 'Find',
  identify: 'Identify',
  fetch: 'Fetch',
  retrieve: 'Retrieve',
  show: 'Show',
  return: 'Return',
  name: 'Name',
  enumerate: 'Enumerate',
  display: 'Display',
  get: 'Get',
  give: 'Give me',
};

function styleOf(question: string): Style {
  const words = question
    .trim()
    .replace(/^[^A-Za-z]+/, '')
    .split(/\s+/);
  const first = (words[0] ?? '').toLowerCase();
  const second = (words[1] ?? '').toLowerCase();
  const style: Style = {
    opener: 'other',
    verb: 'List',
    top: /\btop\b/i.test(question),
    first: /\bfirst\b/i.test(question),
    distinct: /\b(?:distinct|unique|different)\b/i.test(question),
  };
  if (LIST_VERBS[first] !== undefined) {
    style.opener = 'verb';
    style.verb = LIST_VERBS[first];
  } else if ((first === 'look' || first === 'search') && second === 'for') {
    style.opener = 'verb';
    style.verb = `${first === 'look' ? 'Look' : 'Search'} for`;
  } else if (first === 'which' || first === 'who') style.opener = 'which';
  else if (first === 'what') style.opener = 'what';
  else if (first === 'how') style.opener = 'how';
  else if (first === 'count') style.opener = 'count';
  else if (first === 'calculate') style.opener = 'calc';
  return style;
}

/** One way a step can go on our graph: from a kind, by one link type or HOSTS|RUNS, to the next kind. */
interface HopOption {
  types: LinkType[];
  from: Kind;
  to: Kind;
  forward: boolean;
}

const HOP_OPTIONS: readonly HopOption[] = [
  ...shared.LINK_TYPES.flatMap((row) => [
    { types: [row.type], from: row.from as Kind, to: row.to as Kind, forward: true },
    { types: [row.type], from: row.to as Kind, to: row.from as Kind, forward: false },
  ]),
  { types: ['HOSTS', 'RUNS'], from: 'asset', to: 'asset', forward: true },
  { types: ['HOSTS', 'RUNS'], from: 'asset', to: 'asset', forward: false },
];

/** Every walk of `hops` steps, as its kinds and the options of each step. */
function walksOf(hops: number): { kinds: Kind[]; options: HopOption[] }[] {
  const out: { kinds: Kind[]; options: HopOption[] }[] = [];
  const extend = (kinds: Kind[], options: HopOption[]): void => {
    if (options.length === hops) {
      out.push({ kinds, options });
      return;
    }
    for (const option of HOP_OPTIONS) {
      if (option.from === kinds[kinds.length - 1]) extend([...kinds, option.to], [...options, option]);
    }
  };
  for (const kind of KINDS) extend([kind], []);
  return out;
}
const WALKS = [walksOf(0), walksOf(1), walksOf(2)] as const;

/** What a slot's conditions and returns ask of its kind: its source properties, by need. */
interface SlotNeeds {
  props: Map<string, Need>;
}

function needOfCond(cond: SCond): Need | null {
  const { prop, op, value } = cond;
  if (op === 'notnull') return null;
  if (op === 'contains' || op === 'starts' || op === 'ends') return 'keyword';
  if (op === '=' && NAME_LIKE.test(prop) && value?.t === 'str') return 'name';
  if (op === '=' && ID_LIKE.test(prop) && value?.t !== 'bool') return 'code';
  if ((op === '=' || op === '<>') && (value?.t === 'str' || value?.t === 'bool')) {
    if (NAME_LIKE.test(prop)) throw new Drop('unsupported_condition');
    return 'enum';
  }
  if (value?.t === 'bool') throw new Drop('unsupported_condition');
  if (value?.t === 'str') return DATE_LIKE.test(prop) ? 'date' : 'enum';
  return DATE_LIKE.test(prop) && op !== '=' && op !== '<>' ? 'date' : 'number';
}

function kindFits(kind: Kind, needs: SlotNeeds): boolean {
  const byNeed = (need: Need): number => [...needs.props.values()].filter((n) => n === need).length;
  if (byNeed('code') > 0 && kind !== 'control') return false;
  if (byNeed('number') > FIELDS[kind].number.length) return false;
  if (byNeed('date') > FIELDS[kind].date.length) return false;
  return byNeed('enum') <= FIELDS[kind].enum.length;
}

/** The plan of one text2cypher row, with its record names still to come. */
interface Skeleton {
  kinds: Kind[];
  hops: Hop[];
  needs: SlotNeeds[];
  conds: SCond[];
  ask: Ask;
  /** The source property each slot's field stands for: `${slot}|${prop}` → field. */
  fieldOf: Map<string, string>;
}

function skeletonOf(source: SourceQuery, rng: Rng): Skeleton {
  const k = source.hops.length;
  const needs: SlotNeeds[] = source.nodes.map(() => ({ props: new Map<string, Need>() }));
  const use = (slot: number, prop: string, need: Need): void => {
    const was = needs[slot]!.props.get(prop);
    // One property used two ways (a name filter and a name order) needs one field that does both.
    if (was !== undefined && was !== need && !(isNameNeed(was) && isNameNeed(need))) {
      throw new Drop('unsupported_condition');
    }
    if (was === undefined || need === 'name' || need === 'code') needs[slot]!.props.set(prop, need);
  };
  const conds = source.conds.filter((c) => c.op !== 'notnull');
  for (const cond of conds) use(cond.slot, cond.prop, needOfCond(cond)!);
  for (const slot of needs.keys()) {
    const strong = [...needs[slot]!.props.values()].filter((n) => n === 'name' || n === 'code').length;
    if (strong > 1) throw new Drop('unsupported_condition');
  }
  const named = (slot: number): boolean => [...needs[slot]!.props.values()].some((n) => n === 'name' || n === 'code');
  const unnamed = [...source.nodes.keys()].filter((slot) => !named(slot));
  const aggs = source.returns.filter((e) => e.k === 'agg');
  const plain = source.returns.filter((e) => e.k !== 'agg');
  const slotOf = (e: SExpr): number | null => (e.k === 'agg' ? null : e.slot);
  const shownLimit = (fallback: number): { limit: number; shown: boolean } =>
    source.limit === null
      ? { limit: fallback, shown: false }
      : {
          limit: Math.min(source.limit, shared.SEARCH_LIMITS.graphRows),
          shown: source.limit <= shared.SEARCH_LIMITS.graphRows,
        };

  let ask: Ask;
  if (aggs.length === 0) {
    const returned = [...new Set(plain.map((e) => slotOf(e)!))];
    const target = returned.find((slot) => !named(slot)) ?? unnamed[unnamed.length - 1];
    if (target === undefined) throw new Drop('nothing_to_ask');
    let form: 'node' | 'distinct' | 'path' =
      k === 0 ? 'node' : source.distinct && returned.length === 1 ? 'distinct' : 'path';
    let order: Order | null = null;
    if (source.order !== null) {
      const e = source.order.expr;
      if (e.k !== 'prop') throw new Drop('unsupported_return');
      const need: Order['need'] = NAME_LIKE.test(e.prop) ? 'name' : DATE_LIKE.test(e.prop) ? 'date' : 'number';
      // A name order needs no field of its own: every node has a name.
      if (need !== 'name') use(e.slot, e.prop, need);
      order = { slot: e.slot, field: e.prop, need, desc: source.order.desc };
      // DISTINCT sorts only on what it returns.
      if (form === 'distinct' && e.slot !== target) form = 'path';
    }
    const { limit, shown } = shownLimit(shared.SEARCH_LIMITS.graphRows);
    ask = { f: 'list', target, form, order, limit, shown };
  } else if (aggs.length === 1 && plain.length === 0) {
    const agg = aggs[0]!;
    if (agg.k !== 'agg') throw new TrainingDataBug('an aggregate that is not one');
    if (agg.fn === 'count') {
      const target = agg.arg === null ? unnamed[unnamed.length - 1] : slotOf(agg.arg);
      if (target === undefined || target === null || named(target)) throw new Drop('unsupported_count');
      // Over a path a record can come back once per path: count each once.
      ask = { f: 'count', target, distinct: agg.distinct || k > 0 };
    } else {
      if (agg.arg === null || agg.arg.k !== 'prop') throw new Drop('unsupported_stat');
      const { slot, prop } = agg.arg;
      if (named(slot) || NAME_LIKE.test(prop)) throw new Drop('unsupported_stat');
      const need: 'number' | 'date' =
        (agg.fn === 'min' || agg.fn === 'max') && DATE_LIKE.test(prop) ? 'date' : 'number';
      use(slot, prop, need);
      ask = { f: 'stat', target: slot, fn: agg.fn, field: prop, need };
    }
  } else if (aggs.length === 1) {
    const agg = aggs[0]!;
    if (agg.k !== 'agg' || agg.fn !== 'count') throw new Drop('unsupported_group');
    const groupSlots = [...new Set(plain.map((e) => slotOf(e)!))];
    if (groupSlots.length !== 1) throw new Drop('unsupported_group');
    const group = groupSlots[0]!;
    let counted: number;
    if (agg.arg === null) counted = k === 0 ? group : group === 0 ? k : 0;
    else counted = slotOf(agg.arg) ?? -1;
    let by: string | null = null;
    if (k === 0) {
      const key = plain[0]!;
      if (
        counted !== group ||
        plain.length !== 1 ||
        key.k !== 'prop' ||
        NAME_LIKE.test(key.prop) ||
        ID_LIKE.test(key.prop)
      ) {
        throw new Drop('unsupported_group');
      }
      use(group, key.prop, 'enum');
      by = key.prop;
    } else if (!((group === 0 && counted === k) || (group === k && counted === 0))) {
      throw new Drop('unsupported_group');
    }
    if (named(group) || named(counted)) throw new Drop('unsupported_group');
    let order: 'desc' | 'asc' | null = null;
    if (source.order !== null && source.order.expr.k === 'agg') order = source.order.desc ? 'desc' : 'asc';
    const { limit, shown } = shownLimit(shared.SEARCH_LIMITS.graphRows);
    ask = {
      f: 'group',
      group,
      counted,
      by,
      order,
      limit,
      shown: shown && order !== null,
      distinct: agg.distinct || k === 2,
      usedWith: source.usedWith,
    };
  } else throw new Drop('unsupported_return');

  // The GRC path: a walk whose kinds can carry every slot's needs, a seeded pick by kinds, then by step.
  const fits = WALKS[k]!.filter(
    (walk) =>
      walk.kinds.every((kind, slot) => kindFits(kind, needs[slot]!)) &&
      walk.options.every((option, i) => source.hops[i]!.types.length > 1 === option.types.length > 1),
  );
  if (fits.length === 0) throw new Drop('no_grc_path');
  const kindKeys = [...new Set(fits.map((walk) => walk.kinds.join('>')))];
  const kindKey = rng.pick(kindKeys);
  const walk = rng.pick(fits.filter((w) => w.kinds.join('>') === kindKey));
  const hops: Hop[] = walk.options.map((option, i) => ({
    types: option.types,
    forward: option.forward,
    // Two assets need a direction to say which one hosts the other.
    undirected: source.hops[i]!.dir === 'both' && !(option.from === 'asset' && option.to === 'asset'),
  }));

  // The fields the source properties stand for, a seeded pick among the kind's fields of that need.
  const fieldOf = new Map<string, string>();
  for (const [slot, slotNeeds] of needs.entries()) {
    const kind = walk.kinds[slot]!;
    const free = {
      enum: rng.shuffle(FIELDS[kind].enum),
      number: rng.shuffle(FIELDS[kind].number),
      date: [...FIELDS[kind].date],
    };
    // A total reads well only of money: `sum` takes the financial exposure first.
    if (ask.f === 'stat' && ask.fn === 'sum' && ask.target === slot) {
      free.number = ['financialExposure', ...free.number.filter((f) => f !== 'financialExposure')];
    }
    for (const [prop, need] of slotNeeds.props) {
      let field: string;
      if (need === 'name' || need === 'keyword') field = 'name';
      else if (need === 'code') field = 'code';
      else {
        const next = free[need].shift();
        if (next === undefined) throw new Drop('no_grc_path');
        field = next;
      }
      fieldOf.set(`${slot}|${prop}`, field);
    }
  }
  return { kinds: walk.kinds, hops, needs, conds, ask, fieldOf };
}

function isNameNeed(need: Need): boolean {
  return need === 'name' || need === 'keyword';
}

// ---------------------------------------------------------------------------------------------------
// Real names: a real path when a node is named
// ---------------------------------------------------------------------------------------------------

/** A real walk of the skeleton's kinds and steps in the public graph, its named slots nameable; null when none. */
function realWalk(graph: PublicGraph, skeleton: Skeleton, rng: Rng): PublicRecord[] | null {
  const named = skeleton.needs.map((n) => [...n.props.values()].some((need) => need === 'name' || need === 'code'));
  const usable = (record: PublicRecord, slot: number): boolean =>
    record.kind === skeleton.kinds[slot] &&
    (!named[slot] || record.nameable || [...skeleton.needs[slot]!.props.values()].includes('code'));
  let budget = 4000;
  const extend = (path: PublicRecord[]): PublicRecord[] | null => {
    if (path.length === skeleton.kinds.length) return path;
    if (--budget < 0) return null;
    const hop = skeleton.hops[path.length - 1]!;
    const here = path[path.length - 1]!.key;
    const keys = new Set(
      hop.types.flatMap((type) => graph.next.get(`${type}|${hop.forward ? 'out' : 'in'}|${here}`) ?? []),
    );
    for (const key of rng.shuffle([...keys].sort())) {
      const record = graph.records.get(key)!;
      if (!usable(record, path.length) || path.includes(record)) continue;
      const found = extend([...path, record]);
      if (found) return found;
    }
    return null;
  };
  const starts = rng.shuffle(graph.ofKind[skeleton.kinds[0]!].filter((r) => usable(r, 0)));
  for (const start of starts.slice(0, 300)) {
    const found = extend([start]);
    if (found) return found;
    if (budget < 0) break;
  }
  return null;
}

const STOP_WORDS = new Set([
  'with',
  'from',
  'over',
  'under',
  'into',
  'that',
  'this',
  'their',
  'other',
  'and',
  'for',
  'the',
]);

/** A word of a name, lower case, for a keyword filter: its first, last or any word of four letters or more. */
function keywordOf(name: string, op: 'contains' | 'starts' | 'ends', rng: Rng): string | null {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && /^[a-z]/.test(w) && !STOP_WORDS.has(w));
  if (words.length === 0) return null;
  const all = name.toLowerCase().split(/\s+/);
  if (op === 'starts') return words.includes(all[0]!) ? all[0]! : null;
  if (op === 'ends') return words.includes(all[all.length - 1]!) ? all[all.length - 1]! : null;
  return rng.pick(words);
}

function numberValue(field: string, op: NumberOp, rng: Rng): number {
  if (field === 'financialExposure') return rng.pick([100_000, 250_000, 500_000, 1_000_000]);
  if (op === '>=') return rng.int(3, 5);
  if (op === '>' || op === '<') return rng.int(2, 4);
  if (op === '<=') return rng.int(1, 3);
  return rng.int(1, 5);
}

function planOf(graph: PublicGraph, skeleton: Skeleton, style: Style, rng: Rng): Plan {
  const anyNamed = skeleton.needs.some((n) =>
    [...n.props.values()].some((need) => need !== 'enum' && need !== 'number' && need !== 'date'),
  );
  const walk = anyNamed ? realWalk(graph, skeleton, rng) : null;
  if (anyNamed && walk === null) throw new Drop('no_real_path');
  const filters: Filter[][] = skeleton.kinds.map(() => []);
  const seenProps = new Set<string>();
  for (const cond of skeleton.conds) {
    const slotProp = `${cond.slot}|${cond.prop}`;
    const field = skeleton.fieldOf.get(slotProp)!;
    const need = skeleton.needs[cond.slot]!.props.get(cond.prop)!;
    const record = walk?.[cond.slot];
    const out = filters[cond.slot]!;
    // A name or code given twice (inline and in WHERE) is one filter.
    if (need === 'name' || need === 'code') {
      if (seenProps.has(slotProp)) continue;
      if (need === 'name') out.push({ t: 'named', name: record!.name });
      else out.push({ t: 'code', code: record!.code! });
    } else if (need === 'keyword') {
      const op = cond.op === 'starts' || cond.op === 'ends' ? cond.op : 'contains';
      const from = record ?? rng.pick(graph.ofKind[skeleton.kinds[cond.slot]!]);
      const word = keywordOf(from.name, op, rng);
      if (word === null) throw new Drop('no_real_path');
      out.push({ t: 'keyword', op, word });
    } else if (need === 'enum') {
      out.push({ t: 'enum', field, value: rng.pick(ENUM_VALUES[field]!), neg: cond.op === '<>' });
    } else if (need === 'number') {
      const op = (cond.op === 'contains' || cond.op === 'starts' || cond.op === 'ends' ? '=' : cond.op) as NumberOp;
      out.push({ t: 'number', field, op, value: numberValue(field, op, rng) });
    } else {
      const op = cond.op === '>' || cond.op === '>=' || cond.op === '<' || cond.op === '<=' ? cond.op : '>=';
      out.push({ t: 'date', field, op, value: rng.pick(DATE_VALUES[field]!) });
    }
    seenProps.add(slotProp);
  }
  // One field filtered twice (a range, `x >= 1 AND x <= 5`) is left out: its two bounds could contradict.
  for (const slotFilters of filters) {
    const numbers = slotFilters.filter((f): f is Extract<Filter, { t: 'number' }> => f.t === 'number');
    for (const f of numbers) {
      const others = numbers.filter((g) => g !== f && g.field === f.field);
      if (others.length > 0) throw new Drop('unsupported_condition');
    }
    const dates = slotFilters.filter((f) => f.t === 'date');
    if (dates.length > 1) throw new Drop('unsupported_condition');
    const enums = slotFilters.filter((f): f is Extract<Filter, { t: 'enum' }> => f.t === 'enum');
    if (new Set(enums.map((f) => f.field)).size !== enums.length) throw new Drop('unsupported_condition');
  }
  let ask = skeleton.ask;
  if (ask.f === 'list' && ask.order !== null && ask.order.need !== 'name') {
    ask = { ...ask, order: { ...ask.order, field: skeleton.fieldOf.get(`${ask.order.slot}|${ask.order.field}`)! } };
  } else if (ask.f === 'list' && ask.order !== null) {
    ask = { ...ask, order: { ...ask.order, field: 'name' } };
  } else if (ask.f === 'stat') ask = { ...ask, field: skeleton.fieldOf.get(`${ask.target}|${ask.field}`)! };
  else if (ask.f === 'group' && ask.by !== null) ask = { ...ask, by: skeleton.fieldOf.get(`${ask.group}|${ask.by}`)! };
  return { kinds: skeleton.kinds, hops: skeleton.hops, filters, ask, style };
}

// ---------------------------------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------------------------------

const VAR_BASE: Readonly<Record<Kind, string>> = { asset: 'a', risk: 'r', control: 'c', policy: 'po', incident: 'i' };

function variablesOf(kinds: readonly Kind[]): string[] {
  const used = new Map<string, number>();
  return kinds.map((kind) => {
    const n = (used.get(kind) ?? 0) + 1;
    used.set(kind, n);
    return n === 1 ? VAR_BASE[kind] : `${VAR_BASE[kind]}${n}`;
  });
}

function conditionText(v: string, f: Filter): string {
  switch (f.t) {
    case 'named':
      return `toLower(${v}.name) CONTAINS '${cypherText(f.name.toLowerCase())}'`;
    case 'code':
      return `${v}.code = '${cypherText(f.code)}'`;
    case 'keyword':
      return `toLower(${v}.name) ${f.op === 'contains' ? 'CONTAINS' : f.op === 'starts' ? 'STARTS WITH' : 'ENDS WITH'} '${cypherText(f.word)}'`;
    case 'enum':
      return `${v}.${f.field} ${f.neg ? '<>' : '='} '${cypherText(f.value)}'`;
    case 'number':
      return `${v}.${f.field} ${f.op} ${f.value}`;
    case 'date':
      return `${v}.${f.field} ${f.op} '${f.value}'`;
  }
}

const PLURAL: Readonly<Record<Kind, string>> = {
  asset: 'assets',
  risk: 'risks',
  control: 'controls',
  policy: 'policies',
  incident: 'incidents',
};

const camel = (words: string): string =>
  words
    .split(' ')
    .map((w, i) => (i === 0 ? w : `${w[0]!.toUpperCase()}${w.slice(1)}`))
    .join('');

function queryOf(plan: Plan): string {
  const vars = variablesOf(plan.kinds);
  const { ask } = plan;
  let pattern = `(${vars[0]!}:${shared.SEARCH_NODE_LABELS[plan.kinds[0]!]})`;
  plan.hops.forEach((hop, i) => {
    const rel = `[:${hop.types.join('|')}]`;
    pattern += hop.undirected ? `-${rel}-` : hop.forward ? `-${rel}->` : `<-${rel}-`;
    pattern += `(${vars[i + 1]!}:${shared.SEARCH_NODE_LABELS[plan.kinds[i + 1]!]})`;
  });
  const usesPath = ask.f === 'list' && ask.form === 'path';
  const conds = plan.filters.flatMap((slotFilters, slot) => slotFilters.map((f) => conditionText(vars[slot]!, f)));
  let query = `MATCH ${usesPath ? 'p = ' : ''}${pattern}`;
  if (conds.length > 0) query += ` WHERE ${conds.join(' AND ')}`;
  switch (ask.f) {
    case 'list': {
      const v = vars[ask.target]!;
      query += ask.form === 'path' ? ' RETURN p' : ask.form === 'distinct' ? ` RETURN DISTINCT ${v}` : ` RETURN ${v}`;
      if (ask.order !== null)
        query += ` ORDER BY ${vars[ask.order.slot]!}.${ask.order.field}${ask.order.desc ? ' DESC' : ''}`;
      query += ` LIMIT ${ask.limit}`;
      break;
    }
    case 'count': {
      const v = vars[ask.target]!;
      query += ` RETURN count(${ask.distinct ? 'DISTINCT ' : ''}${v}) AS ${PLURAL[plan.kinds[ask.target]!]}`;
      break;
    }
    case 'stat': {
      const v = vars[ask.target]!;
      if (plan.hops.length > 0) query += ` WITH DISTINCT ${v}`;
      query += ` RETURN ${ask.fn}(${v}.${ask.field}) AS ${statAlias(ask)}`;
      break;
    }
    case 'group': {
      const g = vars[ask.group]!;
      const q = vars[ask.counted]!;
      const alias = PLURAL[plan.kinds[ask.counted]!];
      const tail = `${ask.order === null ? '' : ` ORDER BY ${alias}${ask.order === 'desc' ? ' DESC' : ''}`} LIMIT ${ask.limit}`;
      if (ask.by !== null) {
        query += ` RETURN ${g}.${ask.by} AS ${ask.by}, count(${q}) AS ${alias}${tail}`;
      } else {
        const counted = `count(${ask.distinct ? 'DISTINCT ' : ''}${q}) AS ${alias}`;
        query += ask.usedWith
          ? ` WITH ${g}, ${counted}${tail} RETURN ${g}, ${alias}`
          : ` RETURN ${g}, ${counted}${tail}`;
      }
      break;
    }
  }
  return query;
}

// ---------------------------------------------------------------------------------------------------
// The question
// ---------------------------------------------------------------------------------------------------

const SINGULAR: Readonly<Record<Kind, string>> = {
  asset: 'asset',
  risk: 'risk',
  control: 'control',
  policy: 'policy',
  incident: 'incident',
};

/** Each step from one record to the next in words: `part` after a noun, `fin` as the verb of a plural subject. */
const STEP_WORDS: Readonly<Record<string, { part: string; fin: string }>> = {
  'HOSTS:out': { part: 'hosting', fin: 'host' },
  'HOSTS:in': { part: 'hosted on', fin: 'are hosted on' },
  'RUNS:out': { part: 'running', fin: 'run' },
  'RUNS:in': { part: 'running on', fin: 'run on' },
  'HOSTS|RUNS:out': { part: 'hosting or running', fin: 'host or run' },
  'HOSTS|RUNS:in': { part: 'hosted on or running on', fin: 'are hosted on or run on' },
  'EXPOSED_TO:out': { part: 'exposed to', fin: 'are exposed to' },
  'EXPOSED_TO:in': { part: 'affecting', fin: 'affect' },
  'MITIGATED_BY:out': { part: 'mitigated by', fin: 'are mitigated by' },
  'MITIGATED_BY:in': { part: 'mitigating', fin: 'mitigate' },
  'GOVERNED_BY:out': { part: 'governed by', fin: 'are governed by' },
  'GOVERNED_BY:in': { part: 'governing', fin: 'govern' },
  'IMPACTS:out': { part: 'that impacted', fin: 'impacted' },
  'IMPACTS:in': { part: 'impacted by', fin: 'were impacted by' },
  'EXPOSES:out': { part: 'that exposed', fin: 'exposed' },
  'EXPOSES:in': { part: 'exposed by', fin: 'were exposed by' },
};

const FIELD_WORDS: Readonly<Record<string, string>> = {
  impact: 'impact',
  likelihood: 'likelihood',
  financialExposure: 'financial exposure',
  lastTestedDate: 'last tested date',
  effectiveDate: 'effective date',
  occurredAt: 'occurrence date',
  criticality: 'criticality',
  assetType: 'asset type',
  dataClassification: 'data classification',
  controlStatus: 'control status',
  severity: 'severity',
  incidentStatus: 'incident status',
  status: 'status',
  sensitivity: 'sensitivity label',
};

const money = (n: number): string => `$${n.toLocaleString('en-US')}`;

/** The step from slot `from` to its neighbour `to`, in words. */
function stepWords(plan: Plan, from: number, to: number): { part: string; fin: string } {
  const hop = plan.hops[Math.min(from, to)]!;
  // Read from the lower slot to the higher one, the step goes its own way when `forward`.
  const own = to > from ? hop.forward : !hop.forward;
  const words = STEP_WORDS[`${hop.types.join('|')}:${own ? 'out' : 'in'}`];
  if (words === undefined) throw new TrainingDataBug(`no words for the step ${hop.types.join('|')}`);
  return words;
}

/** A filter after a noun ("with an impact of 4 or more") and as a plural verb phrase ("have an impact of 4 or more"). */
function filterWords(f: Filter): { mod: string; pred: string } {
  switch (f.t) {
    case 'named':
    case 'code':
      throw new TrainingDataBug('a naming filter has no words of its own');
    case 'keyword': {
      const w = `'${f.word}'`;
      if (f.op === 'starts') return { mod: `whose name starts with ${w}`, pred: `have a name starting with ${w}` };
      if (f.op === 'ends') return { mod: `whose name ends with ${w}`, pred: `have a name ending with ${w}` };
      return { mod: `whose name contains ${w}`, pred: `have ${w} in their name` };
    }
    case 'enum': {
      const field = FIELD_WORDS[f.field]!;
      return f.neg
        ? { mod: `whose ${field} is not '${f.value}'`, pred: `do not have ${field} '${f.value}'` }
        : { mod: `with ${field} '${f.value}'`, pred: `have ${field} '${f.value}'` };
    }
    case 'number': {
      const field = FIELD_WORDS[f.field]!;
      const value = f.field === 'financialExposure' ? money(f.value) : String(f.value);
      const bound = {
        '=': `of ${value}`,
        '<>': `other than ${value}`,
        '>': `above ${value}`,
        '>=': `of ${value} or more`,
        '<': `below ${value}`,
        '<=': `of ${value} or less`,
      }[f.op];
      const article = /^[aeiou]/.test(field) ? 'an' : 'a';
      return { mod: `with ${article} ${field} ${bound}`, pred: `have ${article} ${field} ${bound}` };
    }
    case 'date': {
      const when = { '>': 'after', '>=': 'on or after', '<': 'before', '<=': 'on or before' }[f.op];
      if (f.field === 'lastTestedDate')
        return { mod: `last tested ${when} ${f.value}`, pred: `were last tested ${when} ${f.value}` };
      if (f.field === 'occurredAt')
        return { mod: `that occurred ${when} ${f.value}`, pred: `occurred ${when} ${f.value}` };
      return { mod: `with an effective date ${when} ${f.value}`, pred: `have an effective date ${when} ${f.value}` };
    }
  }
}

function named(plan: Plan, slot: number): Filter | undefined {
  return plan.filters[slot]!.find((f) => f.t === 'named' || f.t === 'code');
}

/** The slot's own filters, after its noun. */
function modsOf(plan: Plan, slot: number): string {
  const mods = plan.filters[slot]!.filter((f) => f.t !== 'named' && f.t !== 'code').map((f) => filterWords(f).mod);
  return mods.length === 0 ? '' : ` ${mods.join(' and ')}`;
}

/** The neighbours of a slot on the path, but `except`. */
const neighbours = (plan: Plan, slot: number, except: number | null): number[] =>
  [slot - 1, slot + 1].filter((n) => n >= 0 && n < plan.kinds.length && n !== except);

/** The slot as a noun phrase, read from `from` (or from nowhere), with the path beyond it. */
function phrase(plan: Plan, slot: number, from: number | null, number: 'pl' | 'sg', adjective = ''): string {
  const kind = plan.kinds[slot]!;
  const naming = named(plan, slot);
  let text: string;
  if (naming?.t === 'named') text = `the ${SINGULAR[kind]} '${naming.name}'`;
  else if (naming?.t === 'code') text = `the ${SINGULAR[kind]} with code '${naming.code}'`;
  else text = `${adjective}${number === 'pl' ? PLURAL[kind] : SINGULAR[kind]}`;
  text += modsOf(plan, slot);
  const rest = neighbours(plan, slot, from).map(
    (n) => `${stepWords(plan, slot, n).part} ${phrase(plan, n, slot, 'pl')}`,
  );
  return rest.length === 0 ? text : `${text} ${rest.join(' and ')}`;
}

/** The target as the plural subject of a clause: "risks with ... affect the asset 'X'" or "risks have ...". */
function clause(plan: Plan, slot: number, adjective = ''): string {
  const kind = plan.kinds[slot]!;
  const rest = neighbours(plan, slot, null);
  if (rest.length === 0) {
    const preds = plan.filters[slot]!.filter((f) => f.t !== 'named' && f.t !== 'code').map((f) => filterWords(f).pred);
    return `${adjective}${PLURAL[kind]} ${preds.length === 0 ? 'are there' : preds.join(' and ')}`;
  }
  const verbs = rest.map((n) => `${stepWords(plan, slot, n).fin} ${phrase(plan, n, slot, 'pl')}`);
  return `${adjective}${PLURAL[kind]}${modsOf(plan, slot)} ${verbs.join(' and ')}`;
}

function orderWords(plan: Plan, order: Order, ofTarget: boolean): { sup: string; field: string } {
  const field = order.need === 'name' ? 'name' : FIELD_WORDS[order.field]!;
  const sup =
    order.need === 'date'
      ? order.desc
        ? 'latest'
        : 'earliest'
      : order.field === 'financialExposure'
        ? order.desc
          ? 'largest'
          : 'smallest'
        : order.desc
          ? 'highest'
          : 'lowest';
  return { sup, field: ofTarget ? field : `${SINGULAR[plan.kinds[order.slot]!]} ${field}` };
}

function amount(style: Style, limit: number): string {
  return style.top ? `top ${limit} ` : style.first ? `first ${limit} ` : `${limit} `;
}

function listQuestion(plan: Plan, ask: Extract<Ask, { f: 'list' }>): string {
  const { style } = plan;
  const t = ask.target;
  const adjective = ask.form === 'distinct' && style.distinct ? 'distinct ' : '';
  const single = ask.shown && ask.limit === 1;
  const n = ask.shown && !single ? amount(style, ask.limit) : '';
  const lonely = plan.hops.length === 0;
  let orderMod = '';
  let orderPlain = '';
  if (ask.order !== null) {
    const ofTarget = ask.order.slot === t;
    const { sup, field } = orderWords(plan, ask.order, ofTarget);
    if (ask.order.need === 'name') {
      orderMod = ask.order.desc ? `, in reverse ${field} order` : `, sorted by ${field}`;
      orderPlain = orderMod;
    } else if (single || (lonely && ofTarget && ask.shown)) {
      orderMod = ` with the ${sup} ${field}`;
      orderPlain = `, ${sup} ${field} first`;
    } else {
      orderMod = `, ${sup} ${field} first`;
      orderPlain = orderMod;
    }
  }
  if (single) {
    const np = phrase(plan, t, null, 'sg', adjective);
    if (ask.order === null || ask.order.need === 'name') {
      return style.opener === 'verb' ? `${style.verb} one ${np}${orderPlain}.` : `Name one ${np}${orderPlain}.`;
    }
    return style.opener === 'verb' ? `${style.verb} the ${np}${orderMod}.` : `What is the ${np}${orderMod}?`;
  }
  if (style.opener === 'which') {
    if (lonely && ask.shown && ask.order !== null && ask.order.need !== 'name') {
      const { sup, field } = orderWords(plan, ask.order, true);
      return `Which ${n}${adjective}${PLURAL[plan.kinds[t]!]}${modsOf(plan, t)} have the ${sup} ${field}?`;
    }
    return `Which ${n}${clause(plan, t, adjective)}${orderPlain}?`;
  }
  const np = phrase(plan, t, null, 'pl', adjective);
  if (style.opener === 'what' || style.opener === 'how') return `What are the ${n}${np}${orderMod}?`;
  const verb = style.opener === 'verb' ? style.verb : style.opener === 'calc' ? 'Find' : 'List';
  return `${verb} the ${n}${np}${orderMod}.`;
}

function countQuestion(plan: Plan, ask: Extract<Ask, { f: 'count' }>): string {
  const { style } = plan;
  const adjective = ask.distinct && style.distinct ? 'distinct ' : '';
  const np = phrase(plan, ask.target, null, 'pl', adjective);
  switch (style.opener) {
    case 'count':
      return `Count the ${np}.`;
    case 'calc':
      return `Calculate the number of ${np}.`;
    case 'what':
      return `What is the number of ${np}?`;
    case 'verb':
      return `${style.verb} the number of ${np}.`;
    default:
      return `How many ${clause(plan, ask.target, adjective)}?`;
  }
}

function statAlias(ask: Extract<Ask, { f: 'stat' }>): string {
  return camel(`${statWord(ask)} ${FIELD_WORDS[ask.field]!}`);
}

function statWord(ask: Extract<Ask, { f: 'stat' }>): string {
  if (ask.fn === 'avg') return 'average';
  if (ask.fn === 'sum') return 'total';
  if (ask.need === 'date') return ask.fn === 'max' ? 'latest' : 'earliest';
  return ask.fn === 'max' ? 'highest' : 'lowest';
}

function statQuestion(plan: Plan, ask: Extract<Ask, { f: 'stat' }>): string {
  const { style } = plan;
  const plain = plan.hops.length === 0 && plan.filters[ask.target]!.length === 0;
  const np = plain ? `all ${PLURAL[plan.kinds[ask.target]!]}` : phrase(plan, ask.target, null, 'pl');
  const link = ask.fn === 'avg' || ask.fn === 'sum' ? 'of' : 'among';
  const body = `the ${statWord(ask)} ${FIELD_WORDS[ask.field]!} ${link} ${np}`;
  if (style.opener === 'verb' || style.opener === 'calc')
    return `${style.opener === 'calc' ? 'Calculate' : style.verb} ${body}.`;
  return `What is ${body}?`;
}

function groupQuestion(plan: Plan, ask: Extract<Ask, { f: 'group' }>): string {
  const { style } = plan;
  const g = ask.group;
  const q = ask.counted;
  const verb = style.opener === 'verb' ? style.verb : 'List';
  const most = ask.order === 'asc' ? 'fewest' : 'most';
  if (ask.by !== null) {
    const field = FIELD_WORDS[ask.by]!;
    const np = phrase(plan, q, null, 'pl');
    if (ask.shown && ask.limit === 1) return `Which ${field} has the ${most} ${np}?`;
    if (ask.shown) return `${verb} the ${amount(style, ask.limit)}${field} values with the ${most} ${np}.`;
    const order = ask.order === null ? '' : `, ${most} first`;
    if (style.opener === 'how' || style.opener === 'what' || style.opener === 'which') {
      return `How many ${PLURAL[plan.kinds[q]!]}${modsOf(plan, q)} are there for each ${field}${order}?`;
    }
    return `${style.opener === 'count' ? 'Count the' : `${verb} the number of`} ${np} for each ${field}${order}.`;
  }
  // The counted records, read toward the group record, which the words call `them` (or `it`, or `each ...`).
  const chain = (end: string): string => {
    let text = `${PLURAL[plan.kinds[q]!]}${modsOf(plan, q)}`;
    let at = q;
    while (at !== g) {
      const nextSlot = at < g ? at + 1 : at - 1;
      text += ` ${stepWords(plan, at, nextSlot).part} `;
      text += nextSlot === g ? end : `${PLURAL[plan.kinds[nextSlot]!]}${modsOf(plan, nextSlot)}`;
      at = nextSlot;
    }
    return text;
  };
  const groupNoun = (number: 'pl' | 'sg'): string =>
    `${number === 'pl' ? PLURAL[plan.kinds[g]!] : SINGULAR[plan.kinds[g]!]}${modsOf(plan, g)}`;
  if (ask.order !== null && ask.shown) {
    if (ask.limit === 1) {
      return style.opener === 'which'
        ? `Which ${groupNoun('sg')} has the ${most} ${chain('it')}?`
        : style.opener === 'verb'
          ? `${verb} the ${groupNoun('sg')} with the ${most} ${chain('it')}.`
          : `What is the ${groupNoun('sg')} with the ${most} ${chain('it')}?`;
    }
    const n = amount(style, ask.limit);
    return style.opener === 'which'
      ? `Which ${n}${groupNoun('pl')} have the ${most} ${chain('them')}?`
      : style.opener === 'what' || style.opener === 'how'
        ? `What are the ${n}${groupNoun('pl')} with the ${most} ${chain('them')}?`
        : `${verb} the ${n}${groupNoun('pl')} with the ${most} ${chain('them')}.`;
  }
  if (ask.order !== null) {
    const ranked = ask.order === 'desc' ? 'ranked by the number of' : 'ranked from the fewest';
    return `${verb} the ${groupNoun('pl')}, ${ranked} ${chain('them')}.`;
  }
  const each = `each ${groupNoun('sg')}`;
  if (style.opener === 'how' || style.opener === 'which' || style.opener === 'what') {
    // The first step as a plural verb: "How many risks affect each asset?"
    const nextSlot = q < g ? q + 1 : q - 1;
    let text = `How many ${PLURAL[plan.kinds[q]!]}${modsOf(plan, q)} ${stepWords(plan, q, nextSlot).fin} `;
    let at = nextSlot;
    while (at !== g) {
      const after = at < g ? at + 1 : at - 1;
      text += `${PLURAL[plan.kinds[at]!]}${modsOf(plan, at)} ${stepWords(plan, at, after).part} `;
      at = after;
    }
    return `${text}${each}?`;
  }
  return `${style.opener === 'count' ? 'Count the' : `${verb} the number of`} ${chain(each)}.`;
}

function questionOf(plan: Plan): string {
  const { ask } = plan;
  const text =
    ask.f === 'list'
      ? listQuestion(plan, ask)
      : ask.f === 'count'
        ? countQuestion(plan, ask)
        : ask.f === 'stat'
          ? statQuestion(plan, ask)
          : groupQuestion(plan, ask);
  return text.replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------------------------------
// The checks on every row
// ---------------------------------------------------------------------------------------------------

/** Every node's own properties (graph-description.ts: "Every node has these properties"). */
const NODE_PROPERTIES = new Set(['id', 'number', 'name', 'status', 'sensitivity', 'origin']);

/** The path as rolesSeeing reads it: its kinds and every link type it follows, in the links' own direction. */
function shapePathOf(plan: Plan): ShapePath {
  const links: PathLink[] = [];
  plan.hops.forEach((hop, i) => {
    for (const type of hop.types) {
      const row = shared.LINK_TYPES.find((r) => r.type === type)!;
      const link = { type, from: row.from, to: row.to };
      const a = plan.kinds[i]!;
      const b = plan.kinds[i + 1]!;
      const fits = hop.forward ? row.from === a && row.to === b : row.from === b && row.to === a;
      if (!fits) throw new TrainingDataBug(`a step of ${type} between a ${a} and a ${b}`);
      if (!links.some((l) => l.type === type && l.from === row.from && l.to === row.to)) links.push(link);
    }
  });
  return { kinds: plan.kinds, links };
}

/**
 * Null when the query names only labels, link types and properties `role`'s graph description shows, read from the
 * query's text (strings left out); else what is wrong.
 */
function vocabularyProblem(query: string, plan: Plan, role: Role): string | null {
  const code = query.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const kinds = new Set<string>(viewedKinds(role));
  const labels = new Set(viewedKinds(role).map((kind) => shared.SEARCH_NODE_LABELS[kind]));
  const vars = variablesOf(plan.kinds);
  const kindOfVar = new Map(vars.map((v, i) => [v, plan.kinds[i]!]));
  for (const kind of plan.kinds) if (!kinds.has(kind)) return `the role does not view ${kind}`;
  for (const m of code.matchAll(/\(\s*\w+\s*:\s*(\w+)\s*\)/g)) {
    if (!labels.has(m[1] as never)) return `the label ${m[1]!} is not in the role's graph`;
  }
  const rows = viewedLinkRows(role);
  for (const m of code.matchAll(/\[:([A-Z_|]+)\]/g)) {
    for (const type of m[1]!.split('|')) {
      if (!rows.some((r) => r.type === type)) return `the link type ${type} is not in the role's graph`;
    }
  }
  for (const m of code.matchAll(/\b([a-z][a-z0-9]*)\.([A-Za-z]+)\b/g)) {
    const kind = kindOfVar.get(m[1]!);
    if (kind === undefined) return `the variable ${m[1]!} is no node of the path`;
    const own = GRAPH_KIND_FIELDS[kind].map((f) => f.name);
    if (!NODE_PROPERTIES.has(m[2]!) && !own.includes(m[2]!)) return `the property ${m[2]!} is not one of a ${kind}'s`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------

interface ExportRow {
  file: string;
  question: string;
  cypher: string;
  data_source: string;
  instance_id: string;
  database_reference_alias: string | null;
}

interface Converted {
  example: TrainingExample;
  instance: string;
  split: Split;
  stratum: string;
  role: Role;
  namesIncident: boolean;
}

const args = parseArgs(process.argv.slice(2));
const relativeOut = `${TRAINING_DIR}/${args.name}`;
const outDir = join(REPO_ROOT, TRAINING_DIR, args.name);
if (existsSync(outDir)) refuse([`${relativeOut}/ already exists: pick another --name or delete the folder`], false);

// Every source file, and the export checked against the parquet files it came from.
const files = new Map<string, Buffer>();
for (const source of SOURCE_FILES) files.set(source.path, readSource(source.path));
let exportText: string;
try {
  exportText = readFileSync(args.exportPath, 'utf8');
} catch {
  refuse([`--export: ${args.exportPath} could not be read`], false);
}
const exportLines = exportText.split('\n').filter((line) => line !== '');
const header = JSON.parse(exportLines[0] ?? '{}') as { sources?: { file: string; sha256: string; rows: number }[] };
for (const file of T2C_FILES) {
  const listed = header.sources?.find((s) => s.file === file);
  const actual = sha256(files.get(`${PUBLIC}/text2cypher/${file}`)!);
  if (listed?.sha256 !== actual)
    refuse([`--export: it was not made from ${PUBLIC}/text2cypher/${file} as it is now; export again`], false);
}
const sourceRows = exportLines.slice(1).map((line) => JSON.parse(line) as ExportRow);
for (const s of header.sources ?? []) {
  if (sourceRows.filter((r) => r.file === s.file).length !== s.rows)
    refuse([`--export: ${s.file} lost rows; export again`], false);
}

const exclusion = companyXExclusion(files.get(ANSWER_KEY)!);
const graph = buildPublicGraph(files, exclusion);
console.log(
  `train-data-t2c: ${sourceRows.length} text2cypher rows; public graph ${KINDS.map((k) => `${graph.counts[k]} ${PLURAL[k]}`).join(', ')}`,
);

const dropped = Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as Record<DropReason, number>;
const converted: Converted[] = [];
const seenInputs = new Set<string>();
const ordered = [...sourceRows].sort((x, y) => instanceNumber(x.instance_id) - instanceNumber(y.instance_id));

function instanceNumber(id: string): number {
  const m = /(\d+)$/.exec(id);
  if (!m) throw new TrainingDataBug('an instance_id without a number');
  return Number(m[1]);
}

function splitOfInstance(id: string): Split {
  const h = createHash('sha256').update(`t2c-split|${id}`).digest('hex');
  return Number.parseInt(h.slice(0, 8), 16) % VALIDATION_ONE_IN === 0 ? 'validation' : 'train';
}

try {
  for (const row of ordered) {
    try {
      if (/incorrect/i.test(row.data_source)) throw new Drop('source_marked_incorrect');
      const source = parseCypher(row.cypher.trim());
      const style = styleOf(row.question);
      const rng = new Rng(`row|${row.instance_id}`);
      const skeleton = skeletonOf(source, rng);
      const plan = planOf(graph, skeleton, style, rng);
      const question = questionOf(plan);
      const query = queryOf(plan);
      const path = shapePathOf(plan);
      const roles = rolesSeeing(path);
      if (roles.length === 0)
        throw new TrainingDataBug(`${row.instance_id}: no role sees the path ${plan.kinds.join('>')}`);
      const role = pickRole(roles, ['t2c', row.instance_id]);
      const answer = { query };
      const problem = checkGraphQueryAnswerValue(answer, query) ?? vocabularyProblem(query, plan, role);
      if (problem !== null) throw new TrainingDataBug(`${row.instance_id}: ${problem}`);
      if (holdsCompanyX(`${question}\n${query}`, exclusion)) throw new Drop('company_x_name');
      const request = graphQueryRequest(role, question);
      const input = `${request.instructions}\n\u0000\n${request.data}`;
      if (seenInputs.has(input)) throw new Drop('duplicate_input');
      seenInputs.add(input);
      const example: TrainingExample = {
        job: 'graph_query',
        seed: instanceNumber(row.instance_id),
        system: request.instructions,
        user: request.data,
        assistant: JSON.stringify(answer),
        request,
      };
      converted.push({
        example,
        instance: row.instance_id,
        split: splitOfInstance(row.instance_id),
        stratum: `${plan.ask.f}${plan.hops.length}`,
        role,
        namesIncident: plan.filters.some(
          (slotFilters, slot) => plan.kinds[slot] === 'incident' && slotFilters.some((f) => f.t === 'named'),
        ),
      });
    } catch (err) {
      if (err instanceof Drop) dropped[err.reason] += 1;
      else throw err;
    }
  }
} catch (err) {
  if (err instanceof TrainingDataBug) fail([`a bug in the rows: ${err.message}`]);
  throw err;
}

// No row may hold a Company X name in any of its texts, the instructions too.
for (const c of converted) {
  if (holdsCompanyX(`${c.example.system}\n${c.example.user}\n${c.example.assistant}`, exclusion)) {
    fail([`a bug in the rows: ${c.instance} holds a Company X name outside its question and query`]);
  }
}

// About `--max-rows` rows, a share per query shape (list, count, stat or group × hops), each sampled by split.
const WEIGHTS: Readonly<Record<string, number>> = {
  list0: 2,
  list1: 3,
  list2: 2,
  count0: 1,
  count1: 1,
  count2: 0.7,
  stat0: 0.5,
  stat1: 0.5,
  stat2: 0.3,
  group0: 0.4,
  group1: 1,
  group2: 0.6,
};
const strata = [...new Set(converted.map((c) => c.stratum))].sort();
const available = new Map(strata.map((s) => [s, converted.filter((c) => c.stratum === s).length]));
const quota = new Map(strata.map((s) => [s, 0]));
let left = Math.min(args.maxRows, converted.length);
while (left > 0) {
  const open = strata.filter((s) => quota.get(s)! < available.get(s)!);
  if (open.length === 0) break;
  const total = open.reduce((sum, s) => sum + (WEIGHTS[s] ?? 0.5), 0);
  let given = 0;
  for (const s of open) {
    const share = Math.max(1, Math.floor((left * (WEIGHTS[s] ?? 0.5)) / total));
    const add = Math.min(share, available.get(s)! - quota.get(s)!, left - given);
    quota.set(s, quota.get(s)! + add);
    given += add;
    if (given >= left) break;
  }
  left -= given;
}
const kept: Converted[] = [];
for (const s of strata) {
  const ofStratum = converted.filter((c) => c.stratum === s);
  kept.push(...sampleBySplit(ofStratum, (c) => c.split, quota.get(s)!, SEED, `t2c|${s}`).kept);
}
kept.sort((x, y) => x.example.seed - y.example.seed);

// No identical input in both splits (one row per input already), checked again on what is kept.
const inputSplit = new Map<string, Split>();
for (const c of kept) {
  const input = `${c.example.system}\n\u0000\n${c.example.user}`;
  const was = inputSplit.get(input);
  if (was !== undefined && was !== c.split) fail(['a bug in the rows: one input is in both splits']);
  inputSplit.set(input, c.split);
}
if (kept.length === 0) fail(['no row was converted']);

const problems = await selfCheck(graphQueryBuilder, kept[0]!.example);
if (problems.length > 0) fail(['the self-check failed: the rows are not what the app sends', ...problems]);
console.log('train-data-t2c: self-check passed (graph_query)');

const jsonl = kept.map((c) => rowLine(rowOf(c.example, c.split))).join('');
const tally = (pick: (c: Converted) => string, items: readonly Converted[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const c of items) out[pick(c)] = (out[pick(c)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((x, y) => x[0].localeCompare(y[0])));
};
const splitCount = (items: readonly Converted[]): Record<Split, number> => ({
  train: items.filter((c) => c.split === 'train').length,
  validation: items.filter((c) => c.split === 'validation').length,
});

const manifest = {
  arguments: { export: basename(args.exportPath), name: args.name, maxRows: args.maxRows },
  job: 'graph_query',
  promptVersion: GRAPH_QUERY_PROMPT_VERSION,
  sources: SOURCE_FILES.map((s) => ({
    path: s.path,
    title: s.title,
    licence: s.licence,
    use: s.use,
    bytes: files.get(s.path)!.length,
    sha256: sha256(files.get(s.path)!),
  })),
  export: { file: basename(args.exportPath), sha256: sha256(exportText), rows: sourceRows.length },
  sourceRows: Object.fromEntries(T2C_FILES.map((f) => [f, sourceRows.filter((r) => r.file === f).length])),
  companyX: {
    namesLeftOut: exclusion.names,
    controlCodesLeftOut: exclusion.codes.size,
    poolRecordsLeftOut: Object.fromEntries(KINDS.map((k) => [k, graph.counts[`${k}_company_x`] ?? 0])),
    rule: 'no row holds a Company X record name or control code as a whole word, in any case',
  },
  publicGraph: {
    records: Object.fromEntries(KINDS.map((k) => [k, graph.counts[k] ?? 0])),
    nameable: Object.fromEntries(KINDS.map((k) => [k, graph.counts[`${k}_nameable`] ?? 0])),
    links: graph.links,
    synthetic: [
      `the host names (${HYPERVISORS.length} hypervisors, ${SERVER_PREFIXES.length * 3} servers) and every HOSTS and RUNS link`,
      'which asset an incident impacted: a seeded pick among the assets exposed to one of its risks, else among all',
      'every value a filter compares with (criticality, impact, dates and the like): a seeded pick of a valid value',
    ],
  },
  conversion: {
    sourceRows: sourceRows.length,
    converted: converted.length,
    dropped,
    shapes: Object.fromEntries(strata.map((s) => [s, { converted: available.get(s)!, kept: quota.get(s)! }])),
  },
  split: {
    rule: `by instance_id: validation when the first 8 hex digits of sha256("t2c-split|<instance_id>") are a multiple of ${VALIDATION_ONE_IN}`,
    rowsBeforeCap: splitCount(converted),
    rows: splitCount(kept),
  },
  roles: tally((c) => c.role, kept),
  rowsNamingAnIncident: kept.filter((c) => c.namesIncident).length,
  seed: "each row's seed is the number in its text2cypher instance_id",
  files: {
    'train.jsonl': { rows: kept.length, bytes: Buffer.byteLength(jsonl), sha256: sha256(jsonl) },
  },
};

try {
  mkdirSync(join(REPO_ROOT, TRAINING_DIR), { recursive: true });
  // Not recursive: a folder made since the check above is refused, never written into.
  mkdirSync(outDir);
} catch (err) {
  if ((err as { code?: unknown } | null)?.code === 'EEXIST') {
    refuse([`${relativeOut}/ already exists: pick another --name or delete the folder`], false);
  }
  fail([`${relativeOut}/ could not be made`]);
}
try {
  writeFileSync(join(outDir, 'train.jsonl'), jsonl);
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
} catch {
  rmSync(outDir, { recursive: true, force: true });
  fail([`${relativeOut}/ could not be written`]);
}

const rows = splitCount(kept);
console.log(`train-data-t2c: wrote ${relativeOut}/ (train.jsonl, manifest.json)`);
console.log(`  graph_query (${GRAPH_QUERY_PROMPT_VERSION}): train ${rows.train}, validation ${rows.validation}`);
console.log(
  `  converted ${converted.length} of ${sourceRows.length}; kept by shape: ${strata.map((s) => `${s} ${quota.get(s)!}`).join(', ')}`,
);
console.log(
  `  dropped: ${DROP_REASONS.filter((r) => dropped[r] > 0)
    .map((r) => `${r} ${dropped[r]}`)
    .join(', ')}`,
);
