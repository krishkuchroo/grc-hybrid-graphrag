// The full-pipeline base step's records and framework mappings (FT-001; D37, D45.5, D212 (3), D237):
// what `pnpm dataset:load --mode full --step base` sends after the asset lists, through the record
// and mapping routes, as the run's Admin key (./client.ts).
// - Records (D237, Q-FT-1 answer (1)): every risk, control, policy and incident of the answer key's
//   org, kind by kind in that order, each kind in the answer key's order, through
//   `POST /api/v1/<plural>` with the create schema (its name and own fields, its label when the key
//   gives one, and the owner the command names: an API key must name one). A record whose exact name
//   a record of its kind (of any status) already has is skipped, so a re-run, or a run into an org
//   that already holds some of them (`--org`), adds nothing twice. Assets come only from the asset
//   lists, and no links are drawn between these records: finding them is the documents' job.
// - Framework mappings: each `framework-mappings.json` row through `POST /api/v1/mappings`. Its
//   control is found through the controls list by its answer-key name, exactly (an active record
//   first, then the lowest number); its requirement through the framework's requirement list by its
//   code, exactly (an active one first). A `link_exists` answer counts as already there.
// Errors name a code and where (a kind and an answer-key key, or a row), never a name (D164).
import type { RecordKind } from '@grc/shared';
import type { WorldOrg, WorldRecord } from '../world/index.js';
import type { DatasetApi, DatasetRecordRow } from './client.js';

/** The kinds the records step creates, in order: every kind but assets, which come from asset lists. */
export const DATASET_RECORD_KINDS = ['risk', 'control', 'policy', 'incident'] as const satisfies readonly RecordKind[];
export type DatasetRecordKind = (typeof DATASET_RECORD_KINDS)[number];

const LISTS: Readonly<Record<DatasetRecordKind, 'risks' | 'controls' | 'policies' | 'incidents'>> = {
  risk: 'risks',
  control: 'controls',
  policy: 'policies',
  incident: 'incidents',
};

/** A step that can't go on: a code and where, never a value from the data. */
export class DatasetLoadError extends Error {
  constructor(
    readonly code:
      'bad_owner' | 'unknown_control_key' | 'control_not_found' | 'framework_not_found' | 'requirement_not_found',
    readonly where: string,
  ) {
    super(`dataset load: ${code} (${where})`);
    this.name = 'DatasetLoadError';
  }
}

export interface DatasetRecordsResult {
  created: Record<DatasetRecordKind, number>;
  skipped: Record<DatasetRecordKind, number>;
}

export interface LoadDatasetRecordsOptions {
  /** Called when a kind is done, with its counts only. */
  onKindDone?: (kind: DatasetRecordKind, counts: { created: number; skipped: number }) => void;
}

/** The create body of an answer-key record: its fields but its key and owner, and the owner given. */
function createBody(record: WorldRecord, ownerId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(record)) {
    if (field === 'key' || field === 'owner' || value === undefined) continue;
    body[field] = value;
  }
  body['owner'] = ownerId;
  return body;
}

/** Creates the org's risks, controls, policies and incidents that aren't there yet by name (see the top). */
export async function loadDatasetRecords(
  api: Pick<DatasetApi, 'recordRows' | 'createRecord'>,
  org: WorldOrg,
  ownerId: string,
  opts: LoadDatasetRecordsOptions = {},
): Promise<DatasetRecordsResult> {
  if (typeof ownerId !== 'string' || ownerId.trim() === '') throw new DatasetLoadError('bad_owner', org.key);
  const created = { risk: 0, control: 0, policy: 0, incident: 0 };
  const skipped = { risk: 0, control: 0, policy: 0, incident: 0 };
  for (const kind of DATASET_RECORD_KINDS) {
    const names = new Set((await api.recordRows(kind)).map((row) => row.name));
    for (const record of org[LISTS[kind]] as readonly WorldRecord[]) {
      if (names.has(record.name)) {
        skipped[kind] += 1;
        continue;
      }
      const made = await api.createRecord(kind, createBody(record, ownerId));
      names.add(made.name);
      names.add(record.name);
      created[kind] += 1;
    }
    opts.onKindDone?.(kind, { created: created[kind], skipped: skipped[kind] });
  }
  return { created, skipped };
}

/** One `framework-mappings.json` row: the control's answer-key key and the requirement it satisfies. */
export interface DatasetFrameworkMapping {
  controlKey: string;
  framework: string;
  code: string;
}

export interface DatasetMappingsResult {
  added: number;
  existing: number;
}

function preferred<T extends { status: string }>(rows: readonly T[], order: (a: T, b: T) => number): T | undefined {
  return [...rows].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || order(a, b))[0];
}

const byNumber = (a: DatasetRecordRow, b: DatasetRecordRow): number =>
  a.number < b.number ? -1 : a.number > b.number ? 1 : 0;

/** Adds each row's control-to-requirement mapping that isn't there yet (see the top). */
export async function loadDatasetMappings(
  api: Pick<DatasetApi, 'recordRows' | 'frameworks' | 'requirementsByCode' | 'addMapping'>,
  org: WorldOrg,
  rows: readonly DatasetFrameworkMapping[],
): Promise<DatasetMappingsResult> {
  const result: DatasetMappingsResult = { added: 0, existing: 0 };
  if (rows.length === 0) return result;
  const controlNames = new Map(org.controls.map((c) => [c.key, c.name]));
  const controlsByName = new Map<string, DatasetRecordRow[]>();
  for (const row of await api.recordRows('control')) {
    const list = controlsByName.get(row.name);
    if (list) list.push(row);
    else controlsByName.set(row.name, [row]);
  }
  const frameworkIds = new Map((await api.frameworks()).map((f) => [f.key, f.id]));
  const requirementIds = new Map<string, string | null>();

  for (const [i, row] of rows.entries()) {
    const where = `framework-mappings.json row ${i + 1} (${row.controlKey})`;
    const name = controlNames.get(row.controlKey);
    if (name === undefined) throw new DatasetLoadError('unknown_control_key', where);
    const control = preferred(controlsByName.get(name) ?? [], byNumber);
    if (control === undefined) throw new DatasetLoadError('control_not_found', where);
    const frameworkId = frameworkIds.get(row.framework);
    if (frameworkId === undefined) throw new DatasetLoadError('framework_not_found', where);
    const requirementKey = `${row.framework} ${row.code}`;
    if (!requirementIds.has(requirementKey)) {
      const found = preferred(await api.requirementsByCode(frameworkId, row.code), (a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      );
      requirementIds.set(requirementKey, found?.id ?? null);
    }
    const requirementId = requirementIds.get(requirementKey);
    if (requirementId === null || requirementId === undefined) {
      throw new DatasetLoadError('requirement_not_found', where);
    }
    if ((await api.addMapping(control.id, requirementId)) === 'added') result.added += 1;
    else result.existing += 1;
  }
  return result;
}

/** The answer key's record counts of the kinds the records step creates. */
export function datasetRecordCounts(org: WorldOrg): Record<DatasetRecordKind, number> {
  return {
    risk: org.risks.length,
    control: org.controls.length,
    policy: org.policies.length,
    incident: org.incidents.length,
  };
}
