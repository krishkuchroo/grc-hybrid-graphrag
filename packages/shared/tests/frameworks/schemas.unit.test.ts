// S2-001 criterion 6 (D30, D51, D67, D68, D69, D73): the Framework and Requirement schemas (the
// record as the API returns it) and the catalog-file schemas (one requirement, one mapping).
//
// Readings the tests rely on:
// - The record schemas carry S1's common fields (tests/records/schemas.unit.test.ts), with `label`
//   for `sensitivity`, plus the type's own fields from the S2 shared notes. Unlike S1's
//   `recordSchemas`, criterion 6 says they refuse unknown fields.
// - `requirementSchema` checks `code` against its own `framework`'s pattern.
// - `catalogMappingSchema` checks each end's `code` against that end's framework.
import { describe, expect, it } from 'vitest';
import { LABELS } from './expected.js';
import { loadFrameworks, type Schema } from './load.js';

const NOW = '2026-09-29T08:00:00.000Z';

const COMMON = {
  sourceIds: [],
  label: 'internal',
  status: 'active',
  owner: 'system',
  version: 1,
  createdAt: NOW,
  createdBy: 'system:framework-catalog',
  updatedAt: NOW,
  updatedBy: 'system:framework-catalog',
  origin: 'import',
};

/** The other common fields every record carries (S1 shared notes, D68, D69, D73). */
const COMMON_REQUIRED = [
  'name',
  'sourceIds',
  'owner',
  'version',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
] as const;

const VALID_FRAMEWORK = {
  ...COMMON,
  id: '0b7c6b1e-3c1a-5d2e-9f10-1a2b3c4d5e6f',
  number: 'FWK0001001',
  name: 'NIST SP 800-53',
  key: 'nist_800_53',
  frameworkVersion: 'Rev. 5',
  publisher: 'NIST',
  description: 'Security and privacy controls for information systems and organizations.',
};

const VALID_REQUIREMENT = {
  ...COMMON,
  id: '5f1e2d3c-4b5a-5968-8776-655443322110',
  number: 'REQ0001014',
  name: 'AC-2(1) Automated System Account Management',
  code: 'AC-2(1)',
  title: 'Automated System Account Management',
  description: 'Support the management of system accounts using automated mechanisms.',
  framework: 'nist_800_53',
  group: 'AC',
  parentCode: 'AC-2',
  sortKey: 'AC-0002(0001)',
};

/** One valid requirement per framework (the sort key's text is the builder's; any string passes). */
const REQUIREMENT_PER_FRAMEWORK = [
  { framework: 'nist_800_53', code: 'AC-2', group: 'AC', parentCode: null },
  { framework: 'nist_csf_2', code: 'GV.OC-01', group: 'GV.OC', parentCode: null },
  { framework: 'iso_27001', code: 'A.5.1', group: 'A.5', parentCode: null },
  { framework: 'soc_2', code: 'CC6.1', group: 'CC6', parentCode: null },
];

const VALID_CATALOG_REQUIREMENT = {
  code: 'GV.OC-01',
  title: 'Mission understanding',
  description: 'The organizational mission is understood and informs cybersecurity risk management.',
  group: 'GV.OC',
};

const VALID_MAPPING = {
  from: { framework: 'nist_csf_2', code: 'PR.AA-05' },
  to: { framework: 'nist_800_53', code: 'AC-2' },
};

function accepts(schema: Schema, input: unknown): void {
  const result = schema.safeParse(input);
  expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
}

function refuses(schema: Schema, input: unknown): void {
  expect(schema.safeParse(input).success).toBe(false);
}

describe('criterion 6: frameworkSchema', () => {
  it('accepts a valid framework', async () => {
    const { frameworkSchema } = await loadFrameworks();
    accepts(frameworkSchema, VALID_FRAMEWORK);
  });

  it.each(['nist_csf_2', 'iso_27001', 'soc_2'])('accepts the key %s', async (key) => {
    const { frameworkSchema } = await loadFrameworks();
    accepts(frameworkSchema, { ...VALID_FRAMEWORK, key });
  });

  it('refuses an unknown field', async () => {
    const { frameworkSchema } = await loadFrameworks();
    refuses(frameworkSchema, { ...VALID_FRAMEWORK, extra: 'x' });
  });

  it('refuses `sensitivity` in place of `label` (the API returns label)', async () => {
    const { frameworkSchema } = await loadFrameworks();
    const input: Record<string, unknown> = { ...VALID_FRAMEWORK, sensitivity: 'internal' };
    delete input.label;
    refuses(frameworkSchema, input);
  });

  it.each(['scf', 'NIST_800_53', '', 'nist-800-53'])('refuses the unknown framework key %j', async (key) => {
    const { frameworkSchema } = await loadFrameworks();
    refuses(frameworkSchema, { ...VALID_FRAMEWORK, key });
  });

  it.each(['secret', 'Internal', 'top_secret', ''])('refuses the label %j (not one of the four)', async (label) => {
    const { frameworkSchema } = await loadFrameworks();
    refuses(frameworkSchema, { ...VALID_FRAMEWORK, label });
  });

  it.each(LABELS)('accepts the label %s', async (label) => {
    const { frameworkSchema } = await loadFrameworks();
    accepts(frameworkSchema, { ...VALID_FRAMEWORK, label });
  });

  it('accepts a retired framework (records are retired, never deleted, D69)', async () => {
    const { frameworkSchema } = await loadFrameworks();
    accepts(frameworkSchema, { ...VALID_FRAMEWORK, status: 'retired' });
  });

  it.each([
    'key',
    'frameworkVersion',
    'publisher',
    'description',
    'id',
    'number',
    'label',
    'status',
    'origin',
    ...COMMON_REQUIRED,
  ])('refuses a framework without %s', async (field) => {
    const { frameworkSchema } = await loadFrameworks();
    const input: Record<string, unknown> = { ...VALID_FRAMEWORK };
    delete input[field];
    refuses(frameworkSchema, input);
  });

  it.each([
    ['status', 'deleted'],
    ['origin', 'scraped'],
    ['id', 'not-a-uuid'],
    ['version', 0],
  ])('refuses %s = %j', async (field, value) => {
    const { frameworkSchema } = await loadFrameworks();
    refuses(frameworkSchema, { ...VALID_FRAMEWORK, [field]: value });
  });
});

describe('criterion 6: requirementSchema', () => {
  it('accepts a valid 800-53 enhancement', async () => {
    const { requirementSchema } = await loadFrameworks();
    accepts(requirementSchema, VALID_REQUIREMENT);
  });

  it.each(REQUIREMENT_PER_FRAMEWORK)('accepts a $framework requirement ($code)', async (fields) => {
    const { requirementSchema } = await loadFrameworks();
    accepts(requirementSchema, { ...VALID_REQUIREMENT, ...fields, name: `${fields.code} Title` });
  });

  it('refuses an unknown field', async () => {
    const { requirementSchema } = await loadFrameworks();
    refuses(requirementSchema, { ...VALID_REQUIREMENT, extra: 'x' });
  });

  it.each(['scf', 'NIST_800_53', '', 'iso_27002'])('refuses the unknown framework key %j', async (framework) => {
    const { requirementSchema } = await loadFrameworks();
    refuses(requirementSchema, { ...VALID_REQUIREMENT, framework });
  });

  it.each([
    ['nist_800_53', 'GV.OC-01'],
    ['nist_800_53', 'ac-2'],
    ['nist_csf_2', 'AC-2'],
    ['nist_csf_2', 'GV.OC-1'],
    ['iso_27001', 'A.9.1'],
    ['iso_27001', 'CC6.1'],
    ['soc_2', 'CC0.1'],
    ['soc_2', 'A.5.1'],
  ])('refuses a %s requirement with the code %s (not its pattern)', async (framework, code) => {
    const { requirementSchema } = await loadFrameworks();
    refuses(requirementSchema, { ...VALID_REQUIREMENT, framework, code, parentCode: null });
  });

  it.each(['secret', 'Confidential', 'top_secret', ''])('refuses the label %j (not one of the four)', async (label) => {
    const { requirementSchema } = await loadFrameworks();
    refuses(requirementSchema, { ...VALID_REQUIREMENT, label });
  });

  it.each(LABELS)('accepts the label %s', async (label) => {
    const { requirementSchema } = await loadFrameworks();
    accepts(requirementSchema, { ...VALID_REQUIREMENT, label });
  });

  it('accepts a retired requirement (records are retired, never deleted, D69)', async () => {
    const { requirementSchema } = await loadFrameworks();
    accepts(requirementSchema, { ...VALID_REQUIREMENT, status: 'retired' });
  });

  it('keeps the code exactly as given (D212 (1))', async () => {
    const { requirementSchema } = await loadFrameworks();
    const result = requirementSchema.safeParse(VALID_REQUIREMENT);
    expect(result.success && (result.data as { code: unknown }).code).toBe('AC-2(1)');
  });

  it.each([
    'code',
    'title',
    'description',
    'framework',
    'group',
    'parentCode',
    'sortKey',
    'id',
    'number',
    'label',
    'status',
    'origin',
    ...COMMON_REQUIRED,
  ])('refuses a requirement without %s', async (field) => {
    const { requirementSchema } = await loadFrameworks();
    const input: Record<string, unknown> = { ...VALID_REQUIREMENT };
    delete input[field];
    refuses(requirementSchema, input);
  });
});

describe('criterion 6: catalogRequirementSchema', () => {
  it('accepts a requirement as it sits in a catalog file', async () => {
    const { catalogRequirementSchema } = await loadFrameworks();
    accepts(catalogRequirementSchema, VALID_CATALOG_REQUIREMENT);
  });

  it('refuses an unknown field (strict)', async () => {
    const { catalogRequirementSchema } = await loadFrameworks();
    refuses(catalogRequirementSchema, { ...VALID_CATALOG_REQUIREMENT, extra: 'x' });
  });

  it.each(['framework', 'label', 'id', 'number'])('refuses a record field %s in a catalog entry', async (field) => {
    const { catalogRequirementSchema } = await loadFrameworks();
    refuses(catalogRequirementSchema, { ...VALID_CATALOG_REQUIREMENT, [field]: 'x' });
  });

  it.each(['code', 'title', 'description', 'group'])('refuses an entry without %s', async (field) => {
    const { catalogRequirementSchema } = await loadFrameworks();
    const input: Record<string, unknown> = { ...VALID_CATALOG_REQUIREMENT };
    delete input[field];
    refuses(catalogRequirementSchema, input);
  });
});

describe('criterion 6: catalogMappingSchema', () => {
  it('accepts a CSF subcategory to 800-53 control mapping', async () => {
    const { catalogMappingSchema } = await loadFrameworks();
    accepts(catalogMappingSchema, VALID_MAPPING);
  });

  it('accepts an 800-53 control to ISO control mapping', async () => {
    const { catalogMappingSchema } = await loadFrameworks();
    accepts(catalogMappingSchema, {
      from: { framework: 'nist_800_53', code: 'AC-2(1)' },
      to: { framework: 'iso_27001', code: 'A.5.16' },
    });
  });

  it('refuses an unknown field at the top level (strict)', async () => {
    const { catalogMappingSchema } = await loadFrameworks();
    refuses(catalogMappingSchema, { ...VALID_MAPPING, type: 'MAPS_TO' });
  });

  it.each(['from', 'to'])('refuses an unknown field in %s (strict)', async (end) => {
    const { catalogMappingSchema } = await loadFrameworks();
    const endValue = VALID_MAPPING[end as 'from' | 'to'];
    refuses(catalogMappingSchema, { ...VALID_MAPPING, [end]: { ...endValue, title: 'x' } });
  });

  it.each(['from', 'to'])('refuses an unknown framework key in %s', async (end) => {
    const { catalogMappingSchema } = await loadFrameworks();
    const endValue = VALID_MAPPING[end as 'from' | 'to'];
    refuses(catalogMappingSchema, { ...VALID_MAPPING, [end]: { ...endValue, framework: 'scf' } });
  });

  it.each([
    ['from', { framework: 'nist_csf_2', code: 'AC-2' }],
    ['from', { framework: 'nist_csf_2', code: 'PR.AA-5' }],
    ['to', { framework: 'nist_800_53', code: 'PR.AA-05' }],
    ['to', { framework: 'nist_800_53', code: 'ac-2' }],
    ['to', { framework: 'iso_27001', code: 'A.9.1' }],
  ])('refuses a code that does not match its framework in %s: %j', async (end, value) => {
    const { catalogMappingSchema } = await loadFrameworks();
    refuses(catalogMappingSchema, { ...VALID_MAPPING, [end]: value });
  });

  it.each(['from', 'to'])('refuses a mapping without %s', async (end) => {
    const { catalogMappingSchema } = await loadFrameworks();
    const input: Record<string, unknown> = { ...VALID_MAPPING };
    delete input[end];
    refuses(catalogMappingSchema, input);
  });
});
