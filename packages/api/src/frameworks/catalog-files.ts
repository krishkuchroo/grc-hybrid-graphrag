// The framework catalogs and NIST's cross-framework mappings as committed JSON (S2-002, D20, D66,
// D212 (1), D212 (4)). Nothing here reads the network (D63): the six files sit beside this module
// under `catalogs/`, so the API image carries them, and the converter in
// `packages/infra/scripts/build-framework-catalogs.ts` (never imported by the API) is the only code
// that reads NIST's downloads. `readCatalogFiles` checks every file with S2-001's schemas plus the
// rules below, and throws an error naming the file and the entry on anything wrong (fail safe,
// D45.7). The entries are public reference data, not org records, so naming them is fine (D163).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  catalogMappingSchema,
  catalogRequirementSchema,
  FRAMEWORK_KEYS,
  FRAMEWORKS,
  groupOf,
  isRequirementCode,
  parentCodeOf,
  sortKeyOf,
  type CatalogMapping,
  type CatalogRequirement,
  type FrameworkKey,
} from '@grc/shared';
import { z } from 'zod';

/** Where the committed files sit. */
export const CATALOG_DIR = fileURLToPath(new URL('./catalogs/', import.meta.url));

/** Each framework's catalog file. */
export const CATALOG_FILE_NAMES: Readonly<Record<FrameworkKey, string>> = Object.freeze({
  nist_800_53: 'nist-800-53.json',
  nist_csf_2: 'nist-csf-2.json',
  iso_27001: 'iso-27001.json',
  soc_2: 'soc-2.json',
});

/** The NIST-authored mapping files: the citing framework to the cited one. No SOC 2 links in S2
 * (D212 (4)): Gemma suggests them in S4 and the Analyst approves them in S5. */
export const MAPPING_FILE_SPECS: readonly Readonly<{ file: string; from: FrameworkKey; to: FrameworkKey }>[] =
  Object.freeze([
    Object.freeze({ file: 'map-csf-2-to-800-53.json', from: 'nist_csf_2', to: 'nist_800_53' } as const),
    Object.freeze({ file: 'map-800-53-to-iso-27001.json', from: 'nist_800_53', to: 'iso_27001' } as const),
  ]);

/** The frameworks whose catalog is built from NIST's own files. */
export const NIST_FRAMEWORKS: readonly FrameworkKey[] = Object.freeze(['nist_800_53', 'nist_csf_2'] as const);

/** The catalogs we write by hand: IDs and titles from the standard, descriptions our own (D20). */
export const HAND_WRITTEN_PUBLISHERS: Readonly<Partial<Record<FrameworkKey, string>>> = Object.freeze({
  iso_27001: 'ISO/IEC',
  soc_2: 'AICPA',
});

/** The longest one-line description we write for ISO and SOC 2 entries. */
export const OWN_DESCRIPTION_MAX = 160;

/** NIST's own sites, the only places a NIST file may come from (D212 (1)). */
export const NIST_HOSTS: readonly string[] = Object.freeze([
  'csrc.nist.gov',
  'nvlpubs.nist.gov',
  'www.nist.gov',
  'github.com',
  'raw.githubusercontent.com',
]);

/** Hosts that serve many owners: only NIST's own `usnistgov` account counts. */
const SHARED_HOSTS: readonly string[] = ['github.com', 'raw.githubusercontent.com'];

/** True when `url` is an https address on one of NIST's own sites (on GitHub, under `usnistgov`). */
export function isNistSourceUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
  const host = parsed.hostname.toLowerCase();
  if (!NIST_HOSTS.includes(host)) return false;
  return !SHARED_HOSTS.includes(host) || parsed.pathname.toLowerCase().startsWith('/usnistgov/');
}

const text = z.string().regex(/\S/, 'must not be blank');

/** Where a file's content came from, kept beside its data (D212 (1)). For NIST's files: the exact
 * download address, NIST's release string, the download date and the SHA-256 of the original. For
 * the hand-written ISO and SOC 2 files: the standard's page, with no date and no hash. */
export const catalogSourceSchema = z
  .strictObject({
    publisher: text,
    author: text,
    documentTitle: text,
    url: z.url({ protocol: /^https$/ }),
    release: text,
    downloadedOn: z.iso.date().nullable(),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex characters')
      .nullable(),
  })
  .refine((source) => (source.downloadedOn === null) === (source.sha256 === null), {
    message: 'downloadedOn and sha256 are both set (a download) or both null (written by hand)',
    path: ['sha256'],
  });

export type CatalogSource = z.infer<typeof catalogSourceSchema>;

const catalogFileSchema = z.strictObject({
  key: z.enum(FRAMEWORK_KEYS),
  frameworkVersion: text,
  source: catalogSourceSchema,
  requirements: z.array(z.unknown()),
});

const mappingFileSchema = z.strictObject({
  source: catalogSourceSchema,
  mappings: z.array(z.unknown()),
});

export interface CatalogFile {
  key: FrameworkKey;
  frameworkVersion: string;
  source: CatalogSource;
  requirements: CatalogRequirement[];
}

export interface MappingFile {
  source: CatalogSource;
  mappings: CatalogMapping[];
}

export interface CatalogFiles {
  catalogs: Record<FrameworkKey, CatalogFile>;
  mappings: MappingFile[];
}

/** A catalog file that fails a check. `file` and `entry` name what is wrong. */
export class CatalogFileError extends Error {
  constructor(
    readonly file: string,
    readonly entry: string,
    problem: string,
  ) {
    super(`framework catalogs: ${file}: ${entry}: ${problem}`);
    this.name = 'CatalogFileError';
  }
}

function zodProblem(error: z.ZodError): { path: string; message: string } {
  const issue = error.issues[0];
  return {
    path: issue && issue.path.length > 0 ? issue.path.map(String).join('.') : '',
    message: issue?.message ?? 'invalid',
  };
}

function hasOuterSpace(value: string): boolean {
  return value !== value.trim();
}

/** The checks every NIST-authored file's `source` must pass (D212 (1)). */
function checkNistSource(file: string, source: CatalogSource): void {
  const fail = (problem: string) => {
    throw new CatalogFileError(file, 'source', problem);
  };
  if (source.author !== 'NIST') fail('the author must be NIST: only NIST-authored files are imported');
  if (source.publisher !== 'NIST') fail('the publisher must be NIST');
  if (!isNistSourceUrl(source.url)) fail("the url must be on one of NIST's own sites");
  if (source.downloadedOn === null || source.sha256 === null) {
    fail("a NIST file must carry its download date and the original's SHA-256");
  }
}

/** The checks a hand-written ISO or SOC 2 file's `source` must pass (D20). */
function checkHandWrittenSource(file: string, key: FrameworkKey, source: CatalogSource): void {
  const fail = (problem: string) => {
    throw new CatalogFileError(file, 'source', problem);
  };
  if (source.publisher !== HAND_WRITTEN_PUBLISHERS[key]) fail(`the publisher must be ${HAND_WRITTEN_PUBLISHERS[key]}`);
  if (source.author !== 'project') fail('the author must be project: the descriptions are our own');
  if (source.release !== FRAMEWORKS[key].frameworkVersion)
    fail(`the release must be ${FRAMEWORKS[key].frameworkVersion}`);
  if (source.downloadedOn !== null || source.sha256 !== null)
    fail('nothing was downloaded: downloadedOn and sha256 are null');
}

function checkCatalog(file: string, key: FrameworkKey, raw: unknown): CatalogFile {
  const parsed = catalogFileSchema.safeParse(raw);
  if (!parsed.success) {
    const { path, message } = zodProblem(parsed.error);
    throw new CatalogFileError(file, path || 'file', message);
  }
  const value = parsed.data;
  if (value.key !== key) throw new CatalogFileError(file, 'key', `must be ${key}`);
  if (value.frameworkVersion !== FRAMEWORKS[key].frameworkVersion) {
    throw new CatalogFileError(file, 'frameworkVersion', `must be ${FRAMEWORKS[key].frameworkVersion}`);
  }
  if (NIST_FRAMEWORKS.includes(key)) checkNistSource(file, value.source);
  else checkHandWrittenSource(file, key, value.source);

  const requirements: CatalogRequirement[] = [];
  const seen = new Set<string>();
  let previousSortKey = '';
  value.requirements.forEach((rawEntry, index) => {
    const code =
      rawEntry && typeof rawEntry === 'object' && typeof (rawEntry as { code?: unknown }).code === 'string'
        ? (rawEntry as { code: string }).code
        : null;
    const entry = code === null ? `requirements[${index}]` : `requirements[${index}] (${code})`;
    const fail = (problem: string): never => {
      throw new CatalogFileError(file, entry, problem);
    };
    const checked = catalogRequirementSchema.safeParse(rawEntry);
    if (!checked.success) {
      const { path, message } = zodProblem(checked.error);
      fail(path ? `${path}: ${message}` : message);
      return;
    }
    const requirement = checked.data;
    if (!isRequirementCode(key, requirement.code)) fail(`the code is not a ${key} requirement code`);
    for (const field of ['code', 'title', 'description', 'group'] as const) {
      if (hasOuterSpace(requirement[field])) fail(`${field} has leading or trailing spaces`);
    }
    if (!Object.hasOwn(FRAMEWORKS[key].groupNames, requirement.group)) fail(`the group is not a group of ${key}`);
    if (requirement.group !== groupOf(key, requirement.code)) fail("the group is not the code's own group");
    if (key in HAND_WRITTEN_PUBLISHERS) {
      if (/[\r\n]/.test(requirement.description)) fail('the description must be one line');
      if (requirement.description.length > OWN_DESCRIPTION_MAX) {
        fail(`the description is longer than ${OWN_DESCRIPTION_MAX} characters`);
      }
    }
    if (seen.has(requirement.code)) fail('the code appears twice');
    const sortKey = sortKeyOf(key, requirement.code);
    if (sortKey <= previousSortKey) fail('the requirements are not in natural code order');
    seen.add(requirement.code);
    previousSortKey = sortKey;
    requirements.push(requirement);
  });

  if (requirements.length === 0) throw new CatalogFileError(file, 'requirements', 'the catalog is empty');
  requirements.forEach((requirement, index) => {
    const parent = parentCodeOf(key, requirement.code);
    if (parent !== null && !seen.has(parent)) {
      throw new CatalogFileError(
        file,
        `requirements[${index}] (${requirement.code})`,
        'the base control of this enhancement is missing',
      );
    }
  });
  return { key: value.key, frameworkVersion: value.frameworkVersion, source: value.source, requirements };
}

function checkMappings(
  file: string,
  spec: { from: FrameworkKey; to: FrameworkKey },
  raw: unknown,
  catalogs: Record<FrameworkKey, CatalogFile>,
): MappingFile {
  const parsed = mappingFileSchema.safeParse(raw);
  if (!parsed.success) {
    const { path, message } = zodProblem(parsed.error);
    throw new CatalogFileError(file, path || 'file', message);
  }
  checkNistSource(file, parsed.data.source);

  const known = (key: FrameworkKey) => new Set(catalogs[key].requirements.map((r) => r.code));
  const fromCodes = known(spec.from);
  const toCodes = known(spec.to);
  const mappings: CatalogMapping[] = [];
  const seen = new Set<string>();
  parsed.data.mappings.forEach((rawEntry, index) => {
    const ends =
      rawEntry && typeof rawEntry === 'object'
        ? (rawEntry as { from?: { code?: unknown }; to?: { code?: unknown } })
        : {};
    const label =
      typeof ends.from?.code === 'string' && typeof ends.to?.code === 'string'
        ? ` (${ends.from.code} -> ${ends.to.code})`
        : '';
    const fail = (problem: string): never => {
      throw new CatalogFileError(file, `mappings[${index}]${label}`, problem);
    };
    const checked = catalogMappingSchema.safeParse(rawEntry);
    if (!checked.success) {
      const { path, message } = zodProblem(checked.error);
      fail(path ? `${path}: ${message}` : message);
      return;
    }
    const mapping = checked.data;
    if (mapping.from.framework === 'soc_2' || mapping.to.framework === 'soc_2') {
      fail('no SOC 2 mappings are imported (D212 (4))');
    }
    if (mapping.from.framework !== spec.from || mapping.to.framework !== spec.to) {
      fail(`every mapping in this file goes from ${spec.from} to ${spec.to}`);
    }
    if (!fromCodes.has(mapping.from.code)) fail(`${mapping.from.code} is not in the ${spec.from} catalog`);
    if (!toCodes.has(mapping.to.code)) fail(`${mapping.to.code} is not in the ${spec.to} catalog`);
    const pair = `${mapping.from.code}\u0000${mapping.to.code}`;
    if (seen.has(pair)) fail('the mapping appears twice');
    seen.add(pair);
    mappings.push(mapping);
  });
  if (mappings.length === 0) throw new CatalogFileError(file, 'mappings', 'the file has no mappings');
  return { source: parsed.data.source, mappings };
}

/** Checks parsed catalog files, keyed by file name (all six must be there), and returns them. */
export function checkCatalogFiles(files: Readonly<Record<string, unknown>>): CatalogFiles {
  const take = (file: string): unknown => {
    if (!Object.hasOwn(files, file) || files[file] === undefined) {
      throw new CatalogFileError(file, 'file', 'the file is missing');
    }
    return files[file];
  };
  const catalogs = {} as Record<FrameworkKey, CatalogFile>;
  for (const key of FRAMEWORK_KEYS) {
    const file = CATALOG_FILE_NAMES[key];
    catalogs[key] = checkCatalog(file, key, take(file));
  }
  const mappings = MAPPING_FILE_SPECS.map((spec) => checkMappings(spec.file, spec, take(spec.file), catalogs));
  return { catalogs, mappings };
}

/** Every file name `readCatalogFiles` reads. */
export function catalogFileNames(): string[] {
  return [...FRAMEWORK_KEYS.map((key) => CATALOG_FILE_NAMES[key]), ...MAPPING_FILE_SPECS.map((spec) => spec.file)];
}

/** Reads and checks the six committed files (or the ones in `dir`, for a copy). Throws a
 * CatalogFileError naming the file and the entry on anything wrong. */
export function readCatalogFiles(dir: string = CATALOG_DIR): CatalogFiles {
  const files: Record<string, unknown> = {};
  for (const file of catalogFileNames()) {
    let body: string;
    try {
      body = readFileSync(join(dir, file), 'utf8');
    } catch {
      throw new CatalogFileError(file, 'file', 'the file cannot be read');
    }
    try {
      files[file] = JSON.parse(body) as unknown;
    } catch {
      throw new CatalogFileError(file, 'file', 'the file is not valid JSON');
    }
  }
  return checkCatalogFiles(files);
}
