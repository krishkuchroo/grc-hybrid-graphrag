// S1-001 criteria 1 and 2 (D30, D51, D73, D197): the create, update and record schemas for the
// five record types, the D197 value lists, and the kind, path and node-label tables.
//
// Readings the tests rely on: dates (`lastTestedDate`, `effectiveDate`) are ISO calendar dates
// (YYYY-MM-DD) and `occurredAt` is an ISO date-time; `policyVersion` is text such as "1.2".
import { describe, expect, it } from 'vitest';
import { KINDS, loadRecords, loadShared, type Kind, type Parsed } from './load.js';

const LABELS = ['public', 'internal', 'confidential', 'restricted'] as const;

/** A valid create body per kind, with every one of the type's own fields. */
const VALID_CREATE: Record<Kind, Record<string, unknown>> = {
  asset: {
    name: 'Payroll database server',
    assetType: 'server',
    criticality: 'high',
    dataClassification: 'confidential',
  },
  risk: { name: 'Payroll data breach', impact: 4, likelihood: 3, financialExposure: 250000 },
  control: {
    name: 'Account management',
    code: 'AC-2',
    framework: 'NIST 800-53',
    controlStatus: 'implemented',
    lastTestedDate: '2026-09-01',
  },
  policy: { name: 'Access control policy', policyVersion: '1.2', effectiveDate: '2026-01-01' },
  incident: {
    name: 'Phishing on the payroll team',
    severity: 'high',
    incidentStatus: 'investigating',
    occurredAt: '2026-09-20T10:00:00Z',
  },
};

/** Each list-backed field, with a value that is not on its list. */
const LIST_FIELDS: [Kind, string, unknown][] = [
  ['asset', 'assetType', 'mainframe'],
  ['asset', 'assetType', 'Server'],
  ['asset', 'assetType', 'network device'],
  ['asset', 'criticality', 'severe'],
  ['asset', 'criticality', 'High'],
  ['asset', 'dataClassification', 'secret'],
  ['control', 'controlStatus', 'done'],
  ['control', 'controlStatus', 'Implemented'],
  ['incident', 'severity', 'urgent'],
  ['incident', 'incidentStatus', 'open'],
  ['incident', 'incidentStatus', 'Closed'],
];

/** Each list-backed field with every value on its D197 list. */
const LIST_VALUES: [Kind, string, readonly string[]][] = [
  ['asset', 'assetType', ['server', 'application', 'database', 'network_device', 'cloud_service', 'endpoint']],
  ['asset', 'criticality', ['low', 'medium', 'high', 'critical']],
  ['asset', 'dataClassification', LABELS],
  ['control', 'controlStatus', ['not_implemented', 'planned', 'implemented']],
  ['incident', 'severity', ['low', 'medium', 'high', 'critical']],
  ['incident', 'incidentStatus', ['new', 'investigating', 'contained', 'resolved', 'closed']],
];

const USER_ID = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';

/** A full record as the API returns it, per kind. */
function fullRecord(kind: Kind): Record<string, unknown> {
  const prefix = { asset: 'AST', risk: 'RSK', control: 'CTL', policy: 'POL', incident: 'INC' }[kind];
  const own = { ...VALID_CREATE[kind] };
  delete own.name;
  return {
    id: '0b5c7d9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
    number: `${prefix}0001001`,
    sourceIds: [],
    name: VALID_CREATE[kind].name,
    label: 'internal',
    status: 'active',
    owner: USER_ID,
    version: 1,
    createdAt: '2026-09-28T09:00:00.000Z',
    createdBy: USER_ID,
    updatedAt: '2026-09-28T09:00:00.000Z',
    updatedBy: USER_ID,
    origin: 'manual',
    ...own,
  };
}

/** The parse failed, and at least one issue names the field (by path, unknown key or message). */
function expectRefusedNaming(result: Parsed, field: string): void {
  expect(result.success, `expected the schema to refuse a body with a bad "${field}"`).toBe(false);
  if (result.success) return;
  const named = result.error.issues.some(
    (issue) => issue.path.includes(field) || (issue.keys ?? []).includes(field) || issue.message.includes(field),
  );
  expect(named, `no issue names "${field}": ${JSON.stringify(result.error.issues)}`).toBe(true);
}

function expectAccepted(result: Parsed): void {
  const detail = result.success ? '' : JSON.stringify(result.error.issues);
  expect(result.success, `expected the schema to accept the body: ${detail}`).toBe(true);
}

describe('the kind tables', () => {
  it('RECORD_KINDS is the five kinds', async () => {
    const { RECORD_KINDS } = await loadRecords();
    expect([...RECORD_KINDS].sort()).toEqual([...KINDS].sort());
  });

  it('RECORD_PATHS gives the plural API names (D47)', async () => {
    const { RECORD_PATHS } = await loadRecords();
    expect(RECORD_PATHS).toEqual({
      asset: 'assets',
      risk: 'risks',
      control: 'controls',
      policy: 'policies',
      incident: 'incidents',
    });
  });

  it('NODE_LABELS gives the Neo4j labels', async () => {
    const { NODE_LABELS } = await loadRecords();
    expect(NODE_LABELS).toEqual({
      asset: 'Asset',
      risk: 'Risk',
      control: 'Control',
      policy: 'Policy',
      incident: 'Incident',
    });
  });

  it('has a create, update and record schema for every kind', async () => {
    const { createSchemas, updateSchemas, recordSchemas } = await loadRecords();
    for (const table of [createSchemas, updateSchemas, recordSchemas]) {
      expect(Object.keys(table).sort()).toEqual([...KINDS].sort());
    }
  });

  it('the package entry point exports the record model', async () => {
    const shared = await loadShared();
    const records = await loadRecords();
    expect(shared.formatNumber).toBe(records.formatNumber);
    expect(shared.createSchemas).toBe(records.createSchemas);
  });
});

describe('the D197 value lists', () => {
  it('match the lists the user chose', async () => {
    const api = await loadRecords();
    expect(api.ASSET_TYPES).toEqual([
      'server',
      'application',
      'database',
      'network_device',
      'cloud_service',
      'endpoint',
    ]);
    expect(api.CRITICALITIES).toEqual(['low', 'medium', 'high', 'critical']);
    expect(api.CONTROL_STATUSES).toEqual(['not_implemented', 'planned', 'implemented']);
    expect(api.INCIDENT_SEVERITIES).toEqual(['low', 'medium', 'high', 'critical']);
    expect(api.INCIDENT_STATUSES).toEqual(['new', 'investigating', 'contained', 'resolved', 'closed']);
    expect(api.RISK_SCALE).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('criterion 1: create schemas', () => {
  it.each(KINDS)('%s: accepts a valid record', async (kind) => {
    const { createSchemas } = await loadRecords();
    expectAccepted(createSchemas[kind].safeParse(VALID_CREATE[kind]));
  });

  it.each(KINDS)('%s: accepts a valid record with an owner and a label', async (kind) => {
    const { createSchemas } = await loadRecords();
    expectAccepted(createSchemas[kind].safeParse({ ...VALID_CREATE[kind], owner: USER_ID, label: 'restricted' }));
  });

  it.each(KINDS.flatMap((kind) => LABELS.map((label) => [kind, label] as const)))(
    '%s: accepts the label %s',
    async (kind, label) => {
      const { createSchemas } = await loadRecords();
      expectAccepted(createSchemas[kind].safeParse({ ...VALID_CREATE[kind], label }));
    },
  );

  it.each(KINDS)('%s: refuses a missing name', async (kind) => {
    const { createSchemas } = await loadRecords();
    const body = { ...VALID_CREATE[kind] };
    delete body.name;
    expectRefusedNaming(createSchemas[kind].safeParse(body), 'name');
  });

  it.each(KINDS)('%s: refuses an empty name', async (kind) => {
    const { createSchemas } = await loadRecords();
    expectRefusedNaming(createSchemas[kind].safeParse({ ...VALID_CREATE[kind], name: '' }), 'name');
  });

  it.each(LIST_FIELDS)('%s: refuses %s = %j (not on its list)', async (kind, field, value) => {
    const { createSchemas } = await loadRecords();
    expectRefusedNaming(createSchemas[kind].safeParse({ ...VALID_CREATE[kind], [field]: value }), field);
  });

  it.each(LIST_VALUES)('%s: accepts every %s on its list', async (kind, field, values) => {
    const { createSchemas } = await loadRecords();
    for (const value of values) {
      expectAccepted(createSchemas[kind].safeParse({ ...VALID_CREATE[kind], [field]: value }));
    }
  });

  it.each(
    ['impact', 'likelihood'].flatMap((field) => [0, 6, -1, 2.5, '3', null].map((value) => [field, value] as const)),
  )('risk: refuses %s = %j (off the 1-5 scale or not a whole number)', async (field, value) => {
    const { createSchemas } = await loadRecords();
    expectRefusedNaming(createSchemas.risk.safeParse({ ...VALID_CREATE.risk, [field]: value }), field);
  });

  it('risk: accepts every impact and likelihood on the scale', async () => {
    const { createSchemas } = await loadRecords();
    for (const impact of [1, 2, 3, 4, 5]) {
      for (const likelihood of [1, 2, 3, 4, 5]) {
        expectAccepted(createSchemas.risk.safeParse({ ...VALID_CREATE.risk, impact, likelihood }));
      }
    }
  });

  it.each([-1, -250000, 100.5, 0.01, '250000'])(
    'risk: refuses financialExposure = %j (negative, cents or not a number)',
    async (value) => {
      const { createSchemas } = await loadRecords();
      expectRefusedNaming(
        createSchemas.risk.safeParse({ ...VALID_CREATE.risk, financialExposure: value }),
        'financialExposure',
      );
    },
  );

  it.each([0, 1, 12_000_000])('risk: accepts financialExposure = %j whole dollars', async (value) => {
    const { createSchemas } = await loadRecords();
    expectAccepted(createSchemas.risk.safeParse({ ...VALID_CREATE.risk, financialExposure: value }));
  });

  it.each(KINDS)('%s: refuses an unknown field', async (kind) => {
    const { createSchemas } = await loadRecords();
    expectRefusedNaming(createSchemas[kind].safeParse({ ...VALID_CREATE[kind], colour: 'red' }), 'colour');
  });

  it.each(
    KINDS.flatMap((kind) =>
      ['id', 'number', 'status', 'version', 'sensitivity', 'nameEmbedding'].map((field) => [kind, field] as const),
    ),
  )('%s: refuses %s, which the server sets', async (kind, field) => {
    const { createSchemas } = await loadRecords();
    const value = field === 'version' ? 1 : field === 'nameEmbedding' ? [0.1] : 'x';
    expectRefusedNaming(createSchemas[kind].safeParse({ ...VALID_CREATE[kind], [field]: value }), field);
  });

  it.each([
    ['asset', 'impact', 3],
    ['risk', 'assetType', 'server'],
    ['control', 'severity', 'high'],
    ['policy', 'controlStatus', 'planned'],
    ['incident', 'policyVersion', '1.0'],
  ] as const)("%s: refuses another type's field %s", async (kind, field, value) => {
    const { createSchemas } = await loadRecords();
    expectRefusedNaming(createSchemas[kind].safeParse({ ...VALID_CREATE[kind], [field]: value }), field);
  });

  it.each(KINDS.flatMap((kind) => ['secret', 'Internal', 'top_secret', ''].map((label) => [kind, label] as const)))(
    '%s: refuses the label %j',
    async (kind, label) => {
      const { createSchemas } = await loadRecords();
      expectRefusedNaming(createSchemas[kind].safeParse({ ...VALID_CREATE[kind], label }), 'label');
    },
  );
});

describe('criterion 2: update schemas', () => {
  it.each(KINDS)('%s: accepts a body with only a version', async (kind) => {
    const { updateSchemas } = await loadRecords();
    expectAccepted(updateSchemas[kind].safeParse({ version: 1 }));
  });

  it.each(KINDS)("%s: accepts a version with any of the type's editable fields", async (kind) => {
    const { updateSchemas } = await loadRecords();
    expectAccepted(updateSchemas[kind].safeParse({ ...VALID_CREATE[kind], version: 7 }));
    expectAccepted(updateSchemas[kind].safeParse({ version: 2, name: 'Renamed' }));
    expectAccepted(updateSchemas[kind].safeParse({ version: 2, label: 'restricted' }));
    expectAccepted(updateSchemas[kind].safeParse({ version: 2, owner: USER_ID }));
  });

  it.each(KINDS)('%s: refuses a body without a version', async (kind) => {
    const { updateSchemas } = await loadRecords();
    expectRefusedNaming(updateSchemas[kind].safeParse({ name: 'Renamed' }), 'version');
    expectRefusedNaming(updateSchemas[kind].safeParse({}), 'version');
  });

  it.each(KINDS.flatMap((kind) => [0, -1, 1.5, '1', null].map((version) => [kind, version] as const)))(
    '%s: refuses version = %j (not a whole number of at least 1)',
    async (kind, version) => {
      const { updateSchemas } = await loadRecords();
      expectRefusedNaming(updateSchemas[kind].safeParse({ version, name: 'Renamed' }), 'version');
    },
  );

  it.each(
    KINDS.flatMap((kind) =>
      (
        [
          ['id', '0b5c7d9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e'],
          ['number', 'RSK0001001'],
          ['status', 'retired'],
          ['status', 'active'],
        ] as const
      ).map(([field, value]) => [kind, field, value] as const),
    ),
  )('%s: refuses %s = %j', async (kind, field, value) => {
    const { updateSchemas } = await loadRecords();
    expectRefusedNaming(updateSchemas[kind].safeParse({ version: 1, [field]: value }), field);
  });

  it.each(KINDS)('%s: refuses an unknown field', async (kind) => {
    const { updateSchemas } = await loadRecords();
    expectRefusedNaming(updateSchemas[kind].safeParse({ version: 1, colour: 'red' }), 'colour');
  });

  it('still checks the values it is given', async () => {
    const { updateSchemas } = await loadRecords();
    expectRefusedNaming(updateSchemas.risk.safeParse({ version: 1, impact: 6 }), 'impact');
    expectRefusedNaming(updateSchemas.risk.safeParse({ version: 1, financialExposure: 10.5 }), 'financialExposure');
    expectRefusedNaming(updateSchemas.asset.safeParse({ version: 1, assetType: 'mainframe' }), 'assetType');
    expectRefusedNaming(updateSchemas.incident.safeParse({ version: 1, incidentStatus: 'open' }), 'incidentStatus');
    expectRefusedNaming(updateSchemas.control.safeParse({ version: 1, label: 'secret' }), 'label');
    expectRefusedNaming(updateSchemas.policy.safeParse({ version: 1, name: '' }), 'name');
  });
});

describe('record schemas (the record as the API returns it)', () => {
  it.each(KINDS)('%s: accepts a full record with the common fields and label', async (kind) => {
    const { recordSchemas } = await loadRecords();
    expectAccepted(recordSchemas[kind].safeParse(fullRecord(kind)));
  });

  it.each(KINDS)('%s: accepts a retired record', async (kind) => {
    const { recordSchemas } = await loadRecords();
    expectAccepted(recordSchemas[kind].safeParse({ ...fullRecord(kind), status: 'retired', version: 4 }));
  });

  it.each(KINDS)('%s: refuses a status other than active or retired', async (kind) => {
    const { recordSchemas } = await loadRecords();
    expectRefusedNaming(recordSchemas[kind].safeParse({ ...fullRecord(kind), status: 'deleted' }), 'status');
  });

  it.each(KINDS)('%s: refuses an origin other than manual, import or ai', async (kind) => {
    const { recordSchemas } = await loadRecords();
    expectRefusedNaming(recordSchemas[kind].safeParse({ ...fullRecord(kind), origin: 'robot' }), 'origin');
  });

  it.each(KINDS)('%s: refuses a record without a label', async (kind) => {
    const { recordSchemas } = await loadRecords();
    const body = fullRecord(kind);
    delete body.label;
    expectRefusedNaming(recordSchemas[kind].safeParse(body), 'label');
  });
});
