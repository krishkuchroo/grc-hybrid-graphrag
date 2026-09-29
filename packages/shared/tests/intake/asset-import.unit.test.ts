// S3-001 criteria 3 and 4 (D40, D44, D30): the asset import fields, `normaliseHeader`,
// `suggestMapping` (obvious matches pre-filled by column name, never a header twice, no guessing
// when two headers could fill one field), `normaliseValue`, and `importMappingSchema`.
//
// Readings the tests rely on: `suggestMapping` answers with the header exactly as given (the column
// the import reads), not its normalised form, and leaves unmatched fields out of the object.
//
// Agreement (D174): `normaliseValue` turns spreadsheet spellings into S1-001's stored values
// (lowercase with `_`, D197), checked against `ASSET_TYPES` and `CRITICALITIES` from src/records.
import { describe, expect, it } from 'vitest';
import { loadRecords } from '../records/load.js';
import { loadIntake } from './load.js';

const FIELDS = ['sourceId', 'name', 'assetType', 'criticality', 'dataClassification', 'owner', 'hostedOn', 'runsOn'];

describe('asset import fields', () => {
  it('ASSET_IMPORT_FIELDS are the eight fields, in order', async () => {
    const { ASSET_IMPORT_FIELDS } = await loadIntake();
    expect([...ASSET_IMPORT_FIELDS]).toEqual(FIELDS);
  });

  it('REQUIRED_IMPORT_FIELDS are sourceId and name', async () => {
    const { REQUIRED_IMPORT_FIELDS } = await loadIntake();
    expect([...REQUIRED_IMPORT_FIELDS]).toEqual(['sourceId', 'name']);
  });
});

describe('normaliseHeader', () => {
  it.each([
    ['sys_id', 'sys_id'],
    ['SYS_ID', 'sys_id'],
    ['Owner Email', 'owner_email'],
    ['  Owner Email  ', 'owner_email'],
    ['Hosted-On', 'hosted_on'],
    ['u.criticality', 'u_criticality'],
    ['Data Classification', 'data_classification'],
    ['ID', 'id'],
  ])('%j becomes %j', async (input, expected) => {
    const { normaliseHeader } = await loadIntake();
    expect(normaliseHeader(input)).toBe(expected);
  });
});

describe('criterion 3: suggestMapping pre-fills the obvious fields', () => {
  it('a ServiceNow-style export fills every field', async () => {
    const { suggestMapping } = await loadIntake();
    const headers = [
      'sys_id',
      'name',
      'sys_class_name',
      'u_criticality',
      'classification',
      'managed_by',
      'parent',
      'platform',
      'sys_updated_on',
    ];
    expect(suggestMapping(headers)).toEqual({
      sourceId: 'sys_id',
      name: 'name',
      assetType: 'sys_class_name',
      criticality: 'u_criticality',
      dataClassification: 'classification',
      owner: 'managed_by',
      hostedOn: 'parent',
      runsOn: 'platform',
    });
  });

  it('a plain export matches after normalising, and answers with the headers as given', async () => {
    const { suggestMapping } = await loadIntake();
    expect(suggestMapping(['ID', 'Hostname', 'Type', 'Tier', 'Owner Email', 'Hosted On'])).toEqual({
      sourceId: 'ID',
      name: 'Hostname',
      assetType: 'Type',
      criticality: 'Tier',
      owner: 'Owner Email',
      hostedOn: 'Hosted On',
    });
  });

  it('headers with no match fill nothing', async () => {
    const { suggestMapping } = await loadIntake();
    expect(suggestMapping(['Colour', 'Weight', 'Notes', 'Purchase Date'])).toEqual({});
    expect(suggestMapping([])).toEqual({});
  });

  it.each([
    ['sourceId', ['sys_id', 'name', 'asset_id']],
    ['sourceId', ['id', 'ID', 'name']],
    ['name', ['id', 'hostname', 'display_name']],
    ['assetType', ['id', 'name', 'type', 'category']],
    ['criticality', ['id', 'name', 'tier', 'Business Criticality']],
    ['dataClassification', ['id', 'name', 'classification', 'sensitivity']],
    ['owner', ['id', 'name', 'owner', 'assigned_to']],
    ['hostedOn', ['id', 'name', 'host', 'parent']],
    ['runsOn', ['id', 'name', 'runs_on', 'depends_on']],
  ])('leaves %s empty when two headers could fill it (%j)', async (field, headers) => {
    const { suggestMapping } = await loadIntake();
    const mapping = suggestMapping(headers);
    expect(mapping[field], `${field} must stay empty`).toBeUndefined();
  });

  it('still fills the other fields when one field has two candidates', async () => {
    const { suggestMapping } = await loadIntake();
    expect(suggestMapping(['sys_id', 'asset_id', 'hostname', 'tier'])).toEqual({
      name: 'hostname',
      criticality: 'tier',
    });
  });

  it.each([
    [['sys_id', 'name', 'sys_class_name', 'u_criticality', 'owner', 'hosted_on', 'runs_on', 'sensitivity']],
    [['ID', 'Hostname', 'Type', 'Tier', 'Owner Email', 'Hosted On']],
    [['id', 'id', 'host', 'host', 'name']],
    [['asset_id', 'display_name', 'class', 'business_criticality', 'owner_email', 'runs_on_host', 'depends_on']],
  ])('never uses a header twice, and uses only given headers (%j)', async (headers) => {
    const { suggestMapping } = await loadIntake();
    const mapping = suggestMapping(headers);
    const used = Object.values(mapping);
    expect(new Set(used).size).toBe(used.length);
    for (const header of used) expect(headers).toContain(header);
    for (const key of Object.keys(mapping)) expect(FIELDS).toContain(key);
  });

  it.each([
    ['sourceId', ['id', 'sys_id', 'asset_id', 'assetid', 'ci_id']],
    ['name', ['name', 'hostname', 'asset_name', 'display_name']],
    ['assetType', ['type', 'asset_type', 'class', 'sys_class_name', 'category']],
    ['criticality', ['criticality', 'tier', 'business_criticality', 'u_criticality']],
    ['dataClassification', ['data_classification', 'classification', 'sensitivity']],
    ['owner', ['owner', 'owner_email', 'managed_by', 'assigned_to']],
    ['hostedOn', ['hosted_on', 'host', 'parent', 'runs_on_host']],
    ['runsOn', ['runs_on', 'platform', 'depends_on']],
  ])('each synonym of %s fills it on its own', async (field, synonyms) => {
    const { suggestMapping } = await loadIntake();
    for (const synonym of synonyms) {
      expect(suggestMapping([synonym]), synonym).toEqual({ [field]: synonym });
    }
  });

  it('does not change its input', async () => {
    const { suggestMapping } = await loadIntake();
    const headers = Object.freeze(['ID', 'Hostname']);
    suggestMapping(headers);
    expect([...headers]).toEqual(['ID', 'Hostname']);
  });
});

describe('normaliseValue', () => {
  it.each([
    [' Network Device ', 'network_device'],
    ['Cloud-Service', 'cloud_service'],
    ['HIGH', 'high'],
    ['Confidential', 'confidential'],
    ['server', 'server'],
  ])('%j becomes %j', async (input, expected) => {
    const { normaliseValue } = await loadIntake();
    expect(normaliseValue(input)).toBe(expected);
  });

  it("turns spreadsheet spellings of S1-001's asset types and criticalities into the stored values", async () => {
    const { normaliseValue } = await loadIntake();
    const { ASSET_TYPES, CRITICALITIES } = await loadRecords();
    for (const value of [...ASSET_TYPES, ...CRITICALITIES]) {
      const spelt = ` ${value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} `;
      expect(normaliseValue(spelt), spelt).toBe(value);
      expect(normaliseValue(value.replace(/_/g, '-').toUpperCase())).toBe(value);
    }
  });
});

describe('criterion 4: importMappingSchema', () => {
  const VALID = { source: 'servicenow-cmdb', fields: { sourceId: 'sys_id', name: 'name' } };

  it.each([
    ['the two required fields', VALID],
    [
      'every field',
      {
        source: 'ServiceNow CMDB v2.1',
        fields: {
          sourceId: 'sys_id',
          name: 'name',
          assetType: 'sys_class_name',
          criticality: 'u_criticality',
          dataClassification: 'classification',
          owner: 'managed_by',
          hostedOn: 'parent',
          runsOn: 'platform',
        },
      },
    ],
    ['a one-character source', { source: 'a', fields: { sourceId: 'ID', name: 'Hostname' } }],
    ['a 100-character source', { source: 'a'.repeat(100), fields: { sourceId: 'ID', name: 'Hostname' } }],
    [
      'a source with letters, digits, space, _, - and .',
      { source: 'Qualys_scan-2026.09 EU', fields: { sourceId: 'ID', name: 'Hostname' } },
    ],
  ])('accepts %s', async (_name, input) => {
    const { importMappingSchema } = await loadIntake();
    expect(importMappingSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['no sourceId', { source: 'cmdb', fields: { name: 'name' } }],
    ['no name', { source: 'cmdb', fields: { sourceId: 'sys_id' } }],
    ['no fields at all', { source: 'cmdb', fields: {} }],
    ['a column used twice', { source: 'cmdb', fields: { sourceId: 'id', name: 'id' } }],
    [
      'a column used twice by optional fields',
      { source: 'cmdb', fields: { sourceId: 'id', name: 'name', hostedOn: 'host', runsOn: 'host' } },
    ],
    ['an unknown field', { source: 'cmdb', fields: { sourceId: 'id', name: 'name', colour: 'colour' } }],
    ['an empty source', { source: '', fields: { sourceId: 'id', name: 'name' } }],
    ['a 101-character source', { source: 'a'.repeat(101), fields: { sourceId: 'id', name: 'name' } }],
    ['a source with a slash', { source: 'cmdb/prod', fields: { sourceId: 'id', name: 'name' } }],
    ['a source with a colon', { source: 'cmdb:prod', fields: { sourceId: 'id', name: 'name' } }],
    ['a source with markup', { source: '<script>', fields: { sourceId: 'id', name: 'name' } }],
    ['a source that is not text', { source: 42, fields: { sourceId: 'id', name: 'name' } }],
    ['no source', { fields: { sourceId: 'id', name: 'name' } }],
    ['an unknown top-level field', { ...VALID, orgId: 'org-1' }],
    ['a column name that is not text', { source: 'cmdb', fields: { sourceId: 1, name: 'name' } }],
    ['not an object', 'cmdb'],
  ])('refuses %s', async (_name, input) => {
    const { importMappingSchema } = await loadIntake();
    expect(importMappingSchema.safeParse(input).success).toBe(false);
  });
});
