// The CMDB exports (D18, D40, D44): an org's assets as the asset lists real source systems deliver,
// each system with its own column layout, value spelling and ID style, plus the mapping
// (`importMappingSchema`) a connector saves for it. Parents are named by their source ID in the same
// source (S3-007 finds them by that source's alias), so every row's parents sit in its own source,
// in the same file or an earlier one.
import type { Faker } from '@faker-js/faker';
import { importMappingSchema, type AssetType, type Criticality, type ImportMapping, type Label } from '@grc/shared';
import type { WorldRecord } from '../world/index.js';
import {
  REFERENCE_MS,
  capitalise,
  emailDomain,
  misspellName,
  pickIndices,
  plantCount,
  spellingVariant,
  titleCase,
  workEmail,
  type OrgWorld,
} from './mess.js';
import type { DuplicatePlant, Plants, SourceFile, TypoPlant } from './render-sources.js';

/** Asset lists are split into files of at most this many rows (D48's stress size). */
export const MAX_ASSET_ROWS_PER_FILE = 2000;

/**
 * Separates the parents in one cell. Only an application can have more than one: it runs on one or
 * two servers, so its `runsOn` cell can hold two source IDs, for example `vm-0a1b…;vm-9f8e…`.
 */
export const PARENT_SEPARATOR = ';';

export type DuplicateVariant = 'spelling' | 'second_source';

export interface CmdbSource {
  /** The source name the mapping is saved under (`sourceNameSchema`). */
  source: string;
  /** What kind of system the export comes from. */
  system: string;
  format: 'csv' | 'json';
  /** Every column (CSV header or JSON key), in file order. Columns the mapping leaves out are just carried. */
  columns: readonly string[];
  mapping: ImportMapping;
}

/** One asset row before it is styled for its source. */
interface CmdbRow {
  recordKey: string;
  sourceId: string;
  name: string;
  assetType: AssetType;
  criticality: Criticality;
  classification: Label;
  hostedOn: string[];
  runsOn: string[];
  /** Set when the row is a planted duplicate. */
  duplicateOf?: { variant: DuplicateVariant; row: CmdbRow; source: string };
  /** Set when the row's name is a planted misspelling. */
  typoOf?: string;
}

type Cell = string | null;

interface SourceStyle {
  spec: CmdbSource;
  lineEnding: '\n' | '\r\n';
  newId(faker: Faker, assetType: AssetType): string;
  cells(row: CmdbRow, faker: Faker, domain: string): Cell[];
}

const CITIES = ['London', 'Manchester', 'Dublin', 'Frankfurt', 'Amsterdam', 'New York', 'Chicago', 'Austin', 'Toronto'];
const REGIONS = ['eu-west-1', 'eu-central-1', 'us-east-1', 'us-west-2', 'ca-central-1', 'ap-southeast-2'];
const TEAMS = ['platform', 'finance-it', 'data', 'workplace', 'security', 'integration', 'web'];
const NOTES = [
  '',
  '',
  '',
  'Refreshed in 2025, warranty ends 2028',
  'Shared with the finance team',
  'Decommission planned; check with owner first',
  'Label on the chassis says "spare"',
  'Moved racks during the last data centre visit',
  'Licence renewal due next quarter',
];

const CLOUD_ID_PREFIX: Readonly<Record<AssetType, string>> = {
  server: 'vm',
  application: 'app',
  database: 'db',
  network_device: 'net',
  cloud_service: 'svc',
  endpoint: 'ws',
};

function hex(faker: Faker, length: number): string {
  return faker.string.hexadecimal({ length, casing: 'lower', prefix: '' });
}

function joinParents(parents: readonly string[]): Cell {
  return parents.length === 0 ? null : parents.join(PARENT_SEPARATOR);
}

function pastMs(faker: Faker, maxDays: number): number {
  return REFERENCE_MS - faker.number.int({ min: 0, max: maxDays * 24 * 60 * 60 }) * 1000;
}

function mappingOf(source: string, fields: ImportMapping['fields']): ImportMapping {
  return importMappingSchema.parse({ source, fields });
}

const SERVICENOW: SourceStyle = {
  spec: {
    source: 'servicenow-cmdb',
    system: 'ServiceNow-style CMDB export (CSV)',
    format: 'csv',
    columns: [
      'sys_id',
      'name',
      'sys_class_name',
      'u_criticality',
      'data_classification',
      'managed_by',
      'hosted_on',
      'runs_on',
      'location',
      'sys_updated_on',
    ],
    mapping: mappingOf('servicenow-cmdb', {
      sourceId: 'sys_id',
      name: 'name',
      assetType: 'sys_class_name',
      criticality: 'u_criticality',
      dataClassification: 'data_classification',
      hostedOn: 'hosted_on',
      runsOn: 'runs_on',
    }),
  },
  lineEnding: '\n',
  newId: (faker) => hex(faker, 32),
  cells: (row, faker, domain) => [
    row.sourceId,
    row.name,
    row.assetType,
    capitalise(row.criticality),
    row.classification,
    workEmail(faker, domain),
    joinParents(row.hostedOn),
    joinParents(row.runsOn),
    faker.helpers.arrayElement(CITIES),
    new Date(pastMs(faker, 180)).toISOString().slice(0, 19).replace('T', ' '),
  ],
};

const CLOUD_INVENTORY: SourceStyle = {
  spec: {
    source: 'cloud-inventory',
    system: 'Cloud asset inventory (flat JSON)',
    format: 'json',
    columns: [
      'resourceId',
      'displayName',
      'kind',
      'tier',
      'classification',
      'owner',
      'region',
      'hostedOn',
      'runsOn',
      'tags',
      'lastSeen',
    ],
    mapping: mappingOf('cloud-inventory', {
      sourceId: 'resourceId',
      name: 'displayName',
      assetType: 'kind',
      criticality: 'tier',
      dataClassification: 'classification',
      hostedOn: 'hostedOn',
      runsOn: 'runsOn',
    }),
  },
  lineEnding: '\n',
  newId: (faker, assetType) => `${CLOUD_ID_PREFIX[assetType]}-${hex(faker, 17)}`,
  cells: (row, faker, domain) => [
    row.sourceId,
    row.name,
    row.assetType.replace(/_/g, '-'),
    row.criticality.toUpperCase(),
    capitalise(row.classification),
    workEmail(faker, domain),
    faker.helpers.arrayElement(REGIONS),
    joinParents(row.hostedOn),
    joinParents(row.runsOn),
    `env=${faker.helpers.arrayElement(['prod', 'prod', 'staging', 'dev'])};team=${faker.helpers.arrayElement(TEAMS)}`,
    new Date(pastMs(faker, 30)).toISOString(),
  ],
};

const ASSET_REGISTER: SourceStyle = {
  spec: {
    source: 'it-asset-register',
    system: 'IT asset register spreadsheet (CSV, spaces in headers)',
    format: 'csv',
    columns: [
      'Asset ID',
      'Asset Name',
      'Asset Type',
      'Business Criticality',
      'Data Classification',
      'Owner Email',
      'Hosted On',
      'Runs On',
      'Location',
      'Purchase Date',
      'Notes',
    ],
    mapping: mappingOf('it-asset-register', {
      sourceId: 'Asset ID',
      name: 'Asset Name',
      assetType: 'Asset Type',
      criticality: 'Business Criticality',
      dataClassification: 'Data Classification',
      hostedOn: 'Hosted On',
      runsOn: 'Runs On',
    }),
  },
  lineEnding: '\r\n',
  newId: (faker) => `AR-${faker.string.numeric({ length: 6, allowLeadingZeros: true })}`,
  cells: (row, faker, domain) => {
    const bought = new Date(pastMs(faker, 2000));
    const day = String(bought.getUTCDate()).padStart(2, '0');
    const month = String(bought.getUTCMonth() + 1).padStart(2, '0');
    return [
      row.sourceId,
      row.name,
      titleCase(row.assetType),
      capitalise(row.criticality),
      capitalise(row.classification),
      workEmail(faker, domain),
      joinParents(row.hostedOn),
      joinParents(row.runsOn),
      faker.helpers.arrayElement(CITIES),
      `${day}/${month}/${bought.getUTCFullYear()}`,
      faker.helpers.arrayElement(NOTES),
    ];
  },
};

const STYLES: readonly SourceStyle[] = [SERVICENOW, CLOUD_INVENTORY, ASSET_REGISTER];

/** The source systems the generators export from, each with its own layout and its mapping. */
export const CMDB_SOURCES: readonly CmdbSource[] = Object.freeze(STYLES.map((style) => style.spec));

/** An org's main CMDB, by its place in the world: ServiceNow-style and cloud inventory take turns. */
const PRIMARY_STYLES: readonly SourceStyle[] = [SERVICENOW, CLOUD_INVENTORY];
/** Assets with no HOSTS or RUNS link live in a spreadsheet register, as loose kit often does. */
const SECONDARY_STYLE = ASSET_REGISTER;

function csvCell(value: Cell): string {
  if (value === null) return '';
  return /[",\r\n]/.test(value) || value !== value.trim() ? `"${value.replace(/"/g, '""')}"` : value;
}

function renderCsv(style: SourceStyle, rows: readonly Cell[][]): string {
  const lines = [style.spec.columns.map(csvCell).join(','), ...rows.map((cells) => cells.map(csvCell).join(','))];
  return lines.join(style.lineEnding) + style.lineEnding;
}

function renderJson(style: SourceStyle, rows: readonly Cell[][]): string {
  const objects = rows.map((cells) =>
    Object.fromEntries(style.spec.columns.map((column, i) => [column, cells[i] ?? null])),
  );
  return `${JSON.stringify(objects, null, 2)}\n`;
}

/** The assets in an order where every parent comes before its children (HOSTS and RUNS). */
function parentsFirst(
  faker: Faker,
  assets: readonly WorldRecord<'asset'>[],
  parentsOf: (key: string) => string[],
): WorldRecord<'asset'>[] {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return 0; // never in a valid world (no cycles); kept finite all the same
    visiting.add(key);
    const parents = parentsOf(key);
    const d = parents.length === 0 ? 0 : 1 + Math.max(...parents.map(depthOf));
    visiting.delete(key);
    depth.set(key, d);
    return d;
  };
  const layers: WorldRecord<'asset'>[][] = [];
  for (const asset of assets) {
    const d = depthOf(asset.key);
    (layers[d] ??= []).push(asset);
  }
  return layers.flatMap((layer) => faker.helpers.shuffle(layer ?? []));
}

function uniqueId(faker: Faker, style: SourceStyle, assetType: AssetType, taken: Set<string>): string {
  let id = style.newId(faker, assetType);
  while (taken.has(id)) id = style.newId(faker, assetType);
  taken.add(id);
  return id;
}

export interface AssetListOptions {
  faker: Faker;
  duplicateFaker: Faker;
  typoFaker: Faker;
  duplicateRate: number;
  typoRate: number;
  plants: Plants;
}

/**
 * The org's asset lists: its linked estate in its main CMDB (parents first), its loose assets in the
 * spreadsheet register, planted typos and duplicates, each source split into files of at most
 * `MAX_ASSET_ROWS_PER_FILE` rows.
 */
export function renderAssetLists(world: OrgWorld, opts: AssetListOptions): SourceFile[] {
  const { faker, duplicateFaker, typoFaker, plants } = opts;
  const assets = world.org.assets;
  const primary = PRIMARY_STYLES[world.index % PRIMARY_STYLES.length]!;
  const secondary = SECONDARY_STYLE;
  const domain = emailDomain(world.org.name);

  const linked = new Set<string>();
  for (const link of world.org.links) {
    if (link.type === 'HOSTS' || link.type === 'RUNS') {
      linked.add(link.fromKey);
      linked.add(link.toKey);
    }
  }
  const parentsOf = (key: string) => [...world.sources('HOSTS', key), ...world.sources('RUNS', key)];

  // Where each asset lives and its source ID there.
  const styleOf = new Map<string, SourceStyle>();
  const takenIds = new Map<SourceStyle, Set<string>>([
    [primary, new Set()],
    [secondary, new Set()],
  ]);
  const idOf = new Map<string, string>();
  for (const asset of assets) {
    const style = linked.has(asset.key) ? primary : secondary;
    styleOf.set(asset.key, style);
    idOf.set(asset.key, uniqueId(faker, style, asset.assetType, takenIds.get(style)!));
  }

  const rowOf = (asset: WorldRecord<'asset'>): CmdbRow => ({
    recordKey: asset.key,
    sourceId: idOf.get(asset.key)!,
    name: asset.name,
    assetType: asset.assetType,
    criticality: asset.criticality,
    classification: asset.dataClassification,
    hostedOn: world.sources('HOSTS', asset.key).map((k) => idOf.get(k)!),
    runsOn: world.sources('RUNS', asset.key).map((k) => idOf.get(k)!),
  });
  const rowsBySource = new Map<SourceStyle, CmdbRow[]>([
    [
      primary,
      parentsFirst(
        faker,
        assets.filter((a) => styleOf.get(a.key) === primary),
        parentsOf,
      ).map(rowOf),
    ],
    [secondary, faker.helpers.shuffle(assets.filter((a) => styleOf.get(a.key) === secondary)).map(rowOf)],
  ]);
  const originalRow = new Map<string, CmdbRow>();
  for (const rows of rowsBySource.values()) for (const row of rows) originalRow.set(row.recordKey, row);

  // Every name an asset row carries, so no misspelling or variant lands on another asset's name.
  const takenNames = new Set(assets.map((a) => a.name));

  // Typos: misspelt names on the assets' own rows.
  for (const i of pickIndices(typoFaker, assets.length, plantCount(opts.typoRate, assets.length))) {
    const row = originalRow.get(assets[i]!.key)!;
    let typo = misspellName(typoFaker, row.name);
    for (let tries = 0; takenNames.has(typo) && tries < 10; tries++) typo = misspellName(typoFaker, row.name);
    if (takenNames.has(typo)) continue;
    takenNames.add(typo);
    row.typoOf = row.name;
    row.name = typo;
  }

  // Duplicates: the same asset again, under a spelling variant in its own source or as it is in the
  // other source, with a new source ID and no parents (nothing points at a duplicate).
  for (const i of pickIndices(duplicateFaker, assets.length, plantCount(opts.duplicateRate, assets.length))) {
    const asset = assets[i]!;
    const original = originalRow.get(asset.key)!;
    const home = styleOf.get(asset.key)!;
    const variant: DuplicateVariant = duplicateFaker.helpers.arrayElement(['spelling', 'second_source'] as const);
    const target = variant === 'spelling' ? home : home === primary ? secondary : primary;
    let name = asset.name;
    if (variant === 'spelling') {
      name = spellingVariant(duplicateFaker, asset.name);
      for (let tries = 0; takenNames.has(name) && tries < 10; tries++)
        name = spellingVariant(duplicateFaker, asset.name);
      if (takenNames.has(name)) name = `${asset.name}.corp.local`;
      if (takenNames.has(name)) continue;
      takenNames.add(name);
    }
    const row: CmdbRow = {
      recordKey: asset.key,
      sourceId: uniqueId(duplicateFaker, target, asset.assetType, takenIds.get(target)!),
      name,
      assetType: asset.assetType,
      criticality: asset.criticality,
      classification: asset.dataClassification,
      hostedOn: [],
      runsOn: [],
      duplicateOf: { variant, row: original, source: home.spec.source },
    };
    const rows = rowsBySource.get(target)!;
    rows.splice(duplicateFaker.number.int({ min: 0, max: rows.length }), 0, row);
  }

  // Write each source out, in parts of at most MAX_ASSET_ROWS_PER_FILE rows.
  const files: SourceFile[] = [];
  const fileOf = new Map<CmdbRow, string>();
  const duplicates: DuplicatePlant[] = [];
  const typos: TypoPlant[] = [];
  for (const style of [primary, secondary]) {
    const rows = rowsBySource.get(style)!;
    for (let start = 0, part = 1; start < rows.length; start += MAX_ASSET_ROWS_PER_FILE, part++) {
      const chunk = rows.slice(start, start + MAX_ASSET_ROWS_PER_FILE);
      const fileName = `${style.spec.source}-export-${String(part).padStart(3, '0')}.${style.spec.format}`;
      const cells = chunk.map((row) => style.cells(row, faker, domain));
      const body = style.spec.format === 'csv' ? renderCsv(style, cells) : renderJson(style, cells);
      files.push({
        source: style.spec.source,
        kind: 'asset_list',
        fileName,
        format: style.spec.format,
        body,
        mentions: [],
      });
      for (const row of chunk) fileOf.set(row, fileName);
    }
  }
  for (const style of [primary, secondary]) {
    for (const row of rowsBySource.get(style)!) {
      if (row.typoOf !== undefined) {
        typos.push({
          orgKey: world.orgKey,
          fileName: fileOf.get(row)!,
          where: 'asset_name',
          recordKey: row.recordKey,
          source: style.spec.source,
          sourceId: row.sourceId,
          original: row.typoOf,
          typo: row.name,
        });
      }
      if (row.duplicateOf) {
        const original = row.duplicateOf.row;
        duplicates.push({
          orgKey: world.orgKey,
          recordKey: row.recordKey,
          variant: row.duplicateOf.variant,
          source: style.spec.source,
          fileName: fileOf.get(row)!,
          sourceId: row.sourceId,
          name: row.name,
          original: {
            source: row.duplicateOf.source,
            fileName: fileOf.get(original)!,
            sourceId: original.sourceId,
            name: original.name,
          },
        });
      }
    }
  }
  plants.duplicates.push(...duplicates);
  plants.typos.push(...typos);
  return files;
}
