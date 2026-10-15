// The asset import plan (S3-007, D40, D44, D51, D68, D197, D198): pure. Rows of an asset list, the
// mapping, and what the org's graph already holds go in; what to create, update and leave alone,
// the HOSTS and RUNS links to draw, and every row problem come out. No I/O, so the worker's job
// and the tests use the same rules.
//
// For each row (row 1 is the first after the header, or the first JSON object):
// - The source ID and name must be there (`missing_value`). The same source ID twice in one file:
//   the later row is skipped (`duplicate_source_id`).
// - List fields (asset type, criticality, data classification) are spelt the D197 way with
//   `normaliseValue` and must be in their lists (`bad_value`). The values must pass
//   `createSchemas.asset`: a new asset needs every field (`missing_value`); a known asset keeps what
//   the row leaves empty or unmapped.
// - The owner is an org member's email, looked up in `owners`; an unknown one is a note
//   (`unknown_owner`): a new asset is then owned by the person who ran the import, a known asset
//   keeps its owner.
// - The label is the data classification (else `defaultLabel('asset')`); a label above the
//   runner's clearance is refused (`label_above_clearance`, D198), and so is a change to a known
//   asset labelled above it (the runner can't see it). A known asset's label follows its data
//   classification when that changes, but only an Admin lowers a label (`canChangeLabel`): for
//   anyone else the higher label stays.
// - A row whose `<source>:<source ID>` is in a known asset's `sourceIds` updates only the fields
//   that changed (none: unchanged). Other rows create an asset. A retired asset stays retired.
// - `hostedOn` X gives `(X)-[:HOSTS]->(this)` and `runsOn` X gives `(X)-[:RUNS]->(this)`, X found
//   by the same source's alias among the known assets and this file's imported rows; a cell may
//   name several, separated by `;` or `,`. An X found nowhere is a note (`unknown_parent`); a row
//   naming itself is a note (`bad_value`) and draws nothing.
// A row problem holds the row number, our field name and a code, never a cell value (D163).
import {
  ASSET_TYPES,
  CRITICALITIES,
  LABELS,
  canChangeLabel,
  createSchemas,
  defaultLabel,
  isLabel,
  isVisible,
  normaliseValue,
  type AssetImportField,
  type AssetType,
  type Criticality,
  type ImportMapping,
  type Label,
} from '@grc/shared';

/** A cell as the reader gives it (CSV cells are strings; flat JSON also has numbers and booleans). */
export type ImportCell = string | number | boolean | null;

/** Codes that skip the row. */
export const IMPORT_ROW_ERROR_CODES = [
  'missing_value',
  'bad_value',
  'label_above_clearance',
  'duplicate_source_id',
] as const;
/** Codes that note something about a row that is still imported. */
export const IMPORT_ROW_NOTE_CODES = ['unknown_owner', 'unknown_parent'] as const;
export type ImportRowCode = (typeof IMPORT_ROW_ERROR_CODES)[number] | (typeof IMPORT_ROW_NOTE_CODES)[number];

/** A row problem: the row, our field (null for the whole row) and a code. */
export interface ImportRowProblem {
  row: number;
  field: AssetImportField | null;
  code: ImportRowCode;
}

/** A source ID longer than this is refused (`bad_value`). */
export const MAX_SOURCE_ID_LENGTH = 200;

/** What separates several parents in one `hostedOn` or `runsOn` cell. */
export const PARENT_SEPARATORS = /[;,]/;

/** The alias an imported asset carries in `sourceIds` (D68). */
export function sourceAlias(source: string, sourceId: string): string {
  return `${source}:${sourceId}`;
}

/** A known asset, as read from the graph: the fields an import compares. */
export interface StoredAsset {
  id: string;
  number: string;
  sourceIds: readonly string[];
  name: string;
  assetType?: string | null;
  criticality?: string | null;
  dataClassification?: string | null;
  sensitivity: string;
  owner: string;
  version: number;
  status: string;
  importId?: string | null;
}

/** An asset's own values as an import writes them (stored property names; `sensitivity` is the label). */
export interface AssetValues {
  name: string;
  assetType: AssetType;
  criticality: Criticality;
  dataClassification: Label;
  owner: string;
  sensitivity: Label;
}
export type AssetProp = keyof AssetValues;

/** What a row gives, checked field by field; absent fields are left out. */
export interface RowCandidate {
  row: number;
  sourceId: string;
  alias: string;
  given: Partial<Omit<AssetValues, 'sensitivity'>>;
  /** The owner's email named no member: a new asset goes to the runner, a known one keeps its owner. */
  unknownOwner: boolean;
  parents: { hostedOn: string[]; runsOn: string[] };
}

/** Who runs the import: their role and clearance, and the owner of new assets with no known owner. */
export interface ImportRunner {
  role: string;
  clearance: Label;
  /** The person who ran the import (for an API key, the person the key belongs to). */
  ownerId: string;
}

export interface PlannedCreate {
  row: number;
  sourceId: string;
  alias: string;
  values: AssetValues;
}

export interface PlannedUpdate {
  row: number;
  alias: string;
  stored: StoredAsset;
  /** The changed properties only, by stored name. */
  changes: Partial<AssetValues>;
  /** The changed fields by API name (`label` for `sensitivity`), as they were and as they become. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  /** The higher of the old and new labels, for the audit entry (D186). */
  label: Label;
}

export interface PlannedUnchanged {
  row: number;
  alias: string;
  stored: StoredAsset;
}

export type LinkField = 'hostedOn' | 'runsOn';
export const LINK_FIELD_TYPES = { hostedOn: 'HOSTS', runsOn: 'RUNS' } as const;

/** `(parent)-[:type]->(child)`, both found by alias. */
export interface PlannedLink {
  row: number;
  field: LinkField;
  type: (typeof LINK_FIELD_TYPES)[LinkField];
  parentAlias: string;
  childAlias: string;
}

export interface ImportPlan {
  create: PlannedCreate[];
  update: PlannedUpdate[];
  unchanged: PlannedUnchanged[];
  links: PlannedLink[];
  /** Every row problem, by row (errors and notes). */
  errors: ImportRowProblem[];
  /** The rows skipped, in order. */
  failed: number[];
  /** The rows imported (created, updated or unchanged), in file order. */
  accepted: RowCandidate[];
}

export interface ImportPlanInput {
  source: string;
  /** Our field -> the file's column. */
  mapping: ImportMapping['fields'];
  /** The rows in file order. */
  rows: ReadonlyArray<Readonly<Record<string, ImportCell | undefined>>>;
  /** The number of the first row (1 by default). */
  firstRow?: number;
  /** The known assets by alias (`<source>:<source ID>`). */
  stored: ReadonlyMap<string, StoredAsset>;
  /** Org members by lowercase email -> user ID. */
  owners: ReadonlyMap<string, string>;
  runner: ImportRunner;
}

/** The decision for one row against what the graph holds. */
export type RowDecision =
  | { kind: 'create'; create: PlannedCreate }
  | { kind: 'update'; update: PlannedUpdate }
  | { kind: 'unchanged'; unchanged: PlannedUnchanged }
  | { kind: 'error'; errors: ImportRowProblem[] };

const LIST_FIELDS = {
  assetType: ASSET_TYPES,
  criticality: CRITICALITIES,
  dataClassification: LABELS,
} as const;

function cellText(value: ImportCell | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function rankOf(label: string): number {
  return (LABELS as readonly string[]).indexOf(label);
}

function higher(a: string, b: string): Label {
  const l = rankOf(a) >= rankOf(b) ? a : b;
  return isLabel(l) ? l : 'restricted';
}

/** The parents a cell names, trimmed, without blanks or repeats. */
export function splitParents(text: string): string[] {
  return [
    ...new Set(
      text
        .split(PARENT_SEPARATORS)
        .map((p) => p.trim())
        .filter((p) => p !== ''),
    ),
  ];
}

function apiName(prop: string): string {
  return prop === 'sensitivity' ? 'label' : prop;
}

/**
 * Reads one row: its source ID and alias, each mapped field checked on its own, the owner looked up,
 * and its parents. Answers the candidate, or the row's errors. `unknown_owner` is noted by the
 * caller from `unknownOwner`.
 */
export function readRow(
  input: Pick<ImportPlanInput, 'source' | 'mapping' | 'owners'>,
  row: number,
  cells: Readonly<Record<string, ImportCell | undefined>>,
): { candidate: RowCandidate } | { errors: ImportRowProblem[] } {
  const { mapping } = input;
  const read = (field: AssetImportField): string => {
    const column = mapping[field];
    return column === undefined ? '' : cellText(cells[column]);
  };
  const errors: ImportRowProblem[] = [];
  const sourceId = read('sourceId');
  if (sourceId === '') errors.push({ row, field: 'sourceId', code: 'missing_value' });
  else if (sourceId.length > MAX_SOURCE_ID_LENGTH) errors.push({ row, field: 'sourceId', code: 'bad_value' });

  const given: RowCandidate['given'] = {};
  const name = read('name');
  if (name === '') errors.push({ row, field: 'name', code: 'missing_value' });
  else given.name = name;

  for (const field of ['assetType', 'criticality', 'dataClassification'] as const) {
    const text = read(field);
    if (text === '') continue;
    const value = normaliseValue(text);
    if (!(LIST_FIELDS[field] as readonly string[]).includes(value)) {
      errors.push({ row, field, code: 'bad_value' });
      continue;
    }
    (given as Record<string, string>)[field] = value;
  }

  let unknownOwner = false;
  const email = read('owner').toLowerCase();
  if (email !== '') {
    const userId = input.owners.get(email);
    if (userId !== undefined) given.owner = userId;
    else unknownOwner = true;
  }

  if (errors.length > 0) return { errors };
  return {
    candidate: {
      row,
      sourceId,
      alias: sourceAlias(input.source, sourceId),
      given,
      unknownOwner,
      parents: { hostedOn: splitParents(read('hostedOn')), runsOn: splitParents(read('runsOn')) },
    },
  };
}

// Checks the values against `createSchemas.asset`: an absent value is `missing_value`, any other
// refusal `bad_value`.
function schemaErrors(row: number, values: Partial<Omit<AssetValues, 'sensitivity'>>): ImportRowProblem[] {
  const parsed = createSchemas.asset.safeParse(values);
  if (parsed.success) return [];
  const errors: ImportRowProblem[] = [];
  const seen = new Set<string>();
  for (const issue of parsed.error.issues) {
    const field = String(issue.path[0] ?? '');
    if (seen.has(field)) continue;
    seen.add(field);
    const known = (['name', 'assetType', 'criticality', 'dataClassification', 'owner'] as const).find(
      (f) => f === field,
    );
    const value = known ? values[known] : undefined;
    errors.push({ row, field: known ?? null, code: value === undefined ? 'missing_value' : 'bad_value' });
  }
  return errors;
}

/**
 * Decides one read row against the asset its alias names (if any): create, update (changed fields
 * only), unchanged, or the row's errors. The worker runs this again inside each batch's transaction
 * against what the graph holds then.
 */
export function decideRow(candidate: RowCandidate, stored: StoredAsset | undefined, runner: ImportRunner): RowDecision {
  const { row, given } = candidate;
  if (!stored) {
    const classification = given.dataClassification ?? defaultLabel('asset');
    const values = {
      name: given.name,
      assetType: given.assetType,
      criticality: given.criticality,
      dataClassification: classification,
      owner: given.owner ?? runner.ownerId,
    };
    const errors = schemaErrors(row, values);
    if (errors.length > 0) return { kind: 'error', errors };
    const label = isLabel(classification) ? classification : defaultLabel('asset');
    if (!isVisible(runner.clearance, label)) {
      return { kind: 'error', errors: [{ row, field: 'dataClassification', code: 'label_above_clearance' }] };
    }
    return {
      kind: 'create',
      create: {
        row,
        sourceId: candidate.sourceId,
        alias: candidate.alias,
        values: { ...(values as Omit<AssetValues, 'sensitivity'>), sensitivity: label },
      },
    };
  }

  // A known asset labelled above the runner's clearance is hidden from them: they can't change it.
  if (!isVisible(runner.clearance, stored.sensitivity)) {
    return { kind: 'error', errors: [{ row, field: 'dataClassification', code: 'label_above_clearance' }] };
  }
  const merged = {
    name: given.name ?? stored.name,
    assetType: given.assetType ?? stored.assetType ?? undefined,
    criticality: given.criticality ?? stored.criticality ?? undefined,
    dataClassification: given.dataClassification ?? stored.dataClassification ?? undefined,
    owner: given.owner ?? stored.owner,
  };
  const errors = schemaErrors(row, merged as Partial<Omit<AssetValues, 'sensitivity'>>);
  if (errors.length > 0) return { kind: 'error', errors };

  let label = stored.sensitivity;
  const classificationChanged =
    given.dataClassification !== undefined && given.dataClassification !== stored.dataClassification;
  if (classificationChanged) {
    const to = given.dataClassification!;
    if (!isVisible(runner.clearance, to)) {
      return { kind: 'error', errors: [{ row, field: 'dataClassification', code: 'label_above_clearance' }] };
    }
    if (to === stored.sensitivity || canChangeLabel(runner.role, stored.sensitivity, to)) label = to;
  }

  const next: Partial<AssetValues> = { ...(given as Partial<AssetValues>), sensitivity: label as Label };
  const storedValues = stored as unknown as Record<string, unknown>;
  const changes: Partial<AssetValues> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(next) as Array<[AssetProp, string | undefined]>) {
    if (value === undefined || storedValues[prop] === value) continue;
    (changes as Record<string, string>)[prop] = value;
    before[apiName(prop)] = storedValues[prop] ?? null;
    after[apiName(prop)] = value;
  }
  if (Object.keys(changes).length === 0) {
    return { kind: 'unchanged', unchanged: { row, alias: candidate.alias, stored } };
  }
  return {
    kind: 'update',
    update: { row, alias: candidate.alias, stored, changes, before, after, label: higher(stored.sensitivity, label) },
  };
}

/** The links a candidate's row asks for, and its notes about parents that can't be linked. */
export function rowLinks(
  candidate: RowCandidate,
  source: string,
  isKnown: (alias: string) => boolean,
): { links: PlannedLink[]; notes: ImportRowProblem[] } {
  const links: PlannedLink[] = [];
  const notes: ImportRowProblem[] = [];
  for (const field of ['hostedOn', 'runsOn'] as const) {
    let unknown = false;
    let self = false;
    for (const parentId of candidate.parents[field]) {
      const parentAlias = sourceAlias(source, parentId);
      if (parentAlias === candidate.alias) self = true;
      else if (parentId.length <= MAX_SOURCE_ID_LENGTH && isKnown(parentAlias)) {
        links.push({
          row: candidate.row,
          field,
          type: LINK_FIELD_TYPES[field],
          parentAlias,
          childAlias: candidate.alias,
        });
      } else unknown = true;
    }
    if (self) notes.push({ row: candidate.row, field, code: 'bad_value' });
    if (unknown) notes.push({ row: candidate.row, field, code: 'unknown_parent' });
  }
  return { links, notes };
}

/** The whole plan for a file (see the top of the file). */
export function planImport(input: ImportPlanInput): ImportPlan {
  const first = input.firstRow ?? 1;
  const plan: ImportPlan = { create: [], update: [], unchanged: [], links: [], errors: [], failed: [], accepted: [] };
  const problems = new Map<number, ImportRowProblem[]>();
  const note = (p: ImportRowProblem): void => {
    const list = problems.get(p.row);
    if (list) list.push(p);
    else problems.set(p.row, [p]);
  };

  const seen = new Set<string>();
  input.rows.forEach((cells, i) => {
    const row = first + i;
    const sourceIdColumn = input.mapping.sourceId;
    const sourceId = cellText(cells[sourceIdColumn]);
    if (sourceId !== '' && seen.has(sourceId)) {
      note({ row, field: 'sourceId', code: 'duplicate_source_id' });
      plan.failed.push(row);
      return;
    }
    if (sourceId !== '') seen.add(sourceId);

    const read = readRow(input, row, cells);
    if ('errors' in read) {
      read.errors.forEach(note);
      plan.failed.push(row);
      return;
    }
    const candidate = read.candidate;
    const decision = decideRow(candidate, input.stored.get(candidate.alias), input.runner);
    if (decision.kind === 'error') {
      decision.errors.forEach(note);
      plan.failed.push(row);
      return;
    }
    if (candidate.unknownOwner) note({ row, field: 'owner', code: 'unknown_owner' });
    if (decision.kind === 'create') plan.create.push(decision.create);
    else if (decision.kind === 'update') plan.update.push(decision.update);
    else plan.unchanged.push(decision.unchanged);
    plan.accepted.push(candidate);
  });

  const importedAliases = new Set(plan.accepted.map((c) => c.alias));
  const isKnown = (alias: string): boolean => input.stored.has(alias) || importedAliases.has(alias);
  for (const candidate of plan.accepted) {
    const { links, notes } = rowLinks(candidate, input.source, isKnown);
    plan.links.push(...links);
    notes.forEach(note);
  }

  plan.errors = [...problems.keys()].sort((a, b) => a - b).flatMap((row) => problems.get(row)!);
  return plan;
}

/** Every alias a file's rows name, as the row itself or as a parent, for reading what's stored. */
export function aliasesNamed(input: Pick<ImportPlanInput, 'source' | 'mapping' | 'rows'>): string[] {
  const aliases = new Set<string>();
  const { mapping, source } = input;
  for (const cells of input.rows) {
    const sourceId = cellText(cells[mapping.sourceId]);
    if (sourceId !== '' && sourceId.length <= MAX_SOURCE_ID_LENGTH) aliases.add(sourceAlias(source, sourceId));
    for (const field of ['hostedOn', 'runsOn'] as const) {
      const column = mapping[field];
      if (column === undefined) continue;
      for (const parentId of splitParents(cellText(cells[column]))) {
        if (parentId.length <= MAX_SOURCE_ID_LENGTH) aliases.add(sourceAlias(source, parentId));
      }
    }
  }
  return [...aliases];
}

/** The lowercase owner emails a file's rows name. */
export function ownerEmailsNamed(input: Pick<ImportPlanInput, 'mapping' | 'rows'>): string[] {
  const column = input.mapping.owner;
  if (column === undefined) return [];
  const emails = new Set<string>();
  for (const cells of input.rows) {
    const email = cellText(cells[column]).toLowerCase();
    if (email !== '') emails.add(email);
  }
  return [...emails];
}
