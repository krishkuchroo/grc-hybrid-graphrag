// S3-001 criterion 1 (D50 "Uploads and imports", D51, D53, D71): the upload kinds, the record type
// and formats each kind carries (S3 shared notes, "Upload kinds"), the size limits, the document
// and import statuses, and `canUpload` for every role x kind.
//
// Agreement (D174): the D50 `uploads` row is the one M0-008's tests hold (tests/access/expected.ts:
// admin, risk_manager, compliance_manager and analyst `yes`; control_owner `evidence_only`; auditor
// and viewer `none`). `canUpload` is checked against `ROLE_TABLE` from src/access (table-driven, as
// the brief asks) and, separately, against that row written out by hand.
import { describe, expect, it } from 'vitest';
import { loadModule } from '../access/load.js';
import { EXPORTS, loadIntake, loadSharedIntake } from './load.js';

const ROLES = ['admin', 'risk_manager', 'compliance_manager', 'control_owner', 'auditor', 'analyst', 'viewer'] as const;
const UPLOAD_KINDS = ['asset_list', 'policy_document', 'soc_ticket', 'audit_report'] as const;
const DOCUMENT_KINDS = [...UPLOAD_KINDS, 'evidence'] as const;

/** The shared notes' table, written out by hand. */
const KIND_TABLE: Record<(typeof DOCUMENT_KINDS)[number], { recordType: string; formats: string[] }> = {
  asset_list: { recordType: 'asset', formats: ['csv', 'json'] },
  policy_document: { recordType: 'policy', formats: ['pdf', 'docx', 'txt'] },
  soc_ticket: { recordType: 'incident', formats: ['pdf', 'docx', 'txt', 'json'] },
  audit_report: { recordType: 'audit_finding', formats: ['pdf', 'docx', 'txt', 'json'] },
  evidence: { recordType: 'evidence', formats: ['pdf', 'docx', 'csv', 'json', 'txt'] },
};

/** The D50 `uploads` row, written out by hand (the same row as tests/access/expected.ts). */
const UPLOADS_ROW: Record<(typeof ROLES)[number], 'yes' | 'evidence_only' | 'none'> = {
  admin: 'yes',
  risk_manager: 'yes',
  compliance_manager: 'yes',
  control_owner: 'evidence_only',
  auditor: 'none',
  analyst: 'yes',
  viewer: 'none',
};

function expectedFromCell(cell: string, kind: string): boolean {
  if (cell === 'yes') return true;
  if (cell === 'evidence_only') return kind === 'evidence';
  return false;
}

describe('exports', () => {
  it('src/intake/index.ts exports the whole S3-001 interface', async () => {
    const intake = await loadIntake();
    for (const name of EXPORTS) expect(intake[name], `export ${name}`).toBeDefined();
  });

  it('@grc/shared (src/index.ts) re-exports the intake model', async () => {
    const shared = await loadSharedIntake();
    const intake = await loadIntake();
    for (const name of EXPORTS) expect(shared[name], `src/index.ts export ${name}`).toBe(intake[name]);
  });
});

describe('criterion 1: kinds, record types and formats match the shared notes', () => {
  it('UPLOAD_KINDS are the four upload kinds, in order', async () => {
    const { UPLOAD_KINDS: actual } = await loadIntake();
    expect([...actual]).toEqual([...UPLOAD_KINDS]);
  });

  it('DOCUMENT_KINDS are the upload kinds plus evidence, in order', async () => {
    const { DOCUMENT_KINDS: actual } = await loadIntake();
    expect([...actual]).toEqual([...DOCUMENT_KINDS]);
  });

  it.each([...UPLOAD_KINDS])('isUploadKind(%s) is true', async (kind) => {
    const { isUploadKind } = await loadIntake();
    expect(isUploadKind(kind)).toBe(true);
  });

  it.each([
    ['evidence'],
    ['Asset_List'],
    ['asset list'],
    [''],
    ['toString'],
    ['__proto__'],
    [null],
    [undefined],
    [1],
    [{}],
  ])('isUploadKind(%j) is false', async (value) => {
    const { isUploadKind } = await loadIntake();
    expect(isUploadKind(value)).toBe(false);
  });

  it('DOCUMENT_RECORD_TYPE has exactly the five kinds', async () => {
    const { DOCUMENT_RECORD_TYPE } = await loadIntake();
    expect(Object.keys(DOCUMENT_RECORD_TYPE).sort()).toEqual([...DOCUMENT_KINDS].sort());
  });

  it.each([...DOCUMENT_KINDS])('DOCUMENT_RECORD_TYPE.%s is the table value', async (kind) => {
    const { DOCUMENT_RECORD_TYPE } = await loadIntake();
    expect(DOCUMENT_RECORD_TYPE[kind]).toBe(KIND_TABLE[kind].recordType);
  });

  it('every record type is one of the D50 record types', async () => {
    const { DOCUMENT_RECORD_TYPE } = await loadIntake();
    const access = await loadModule('src/access/index.ts');
    const recordTypes = access.RECORD_TYPES as readonly string[];
    for (const type of Object.values(DOCUMENT_RECORD_TYPE)) expect(recordTypes).toContain(type);
  });

  it('KIND_FORMATS has exactly the five kinds', async () => {
    const { KIND_FORMATS } = await loadIntake();
    expect(Object.keys(KIND_FORMATS).sort()).toEqual([...DOCUMENT_KINDS].sort());
  });

  it.each([...DOCUMENT_KINDS])('KIND_FORMATS.%s is exactly the table formats', async (kind) => {
    const { KIND_FORMATS } = await loadIntake();
    const formats = [...(KIND_FORMATS[kind] ?? [])];
    expect(formats.sort()).toEqual([...KIND_TABLE[kind].formats].sort());
    expect(new Set(formats).size, 'no format listed twice').toBe(formats.length);
  });

  it('FILE_FORMATS are the five D53 formats, in order', async () => {
    const { FILE_FORMATS } = await loadIntake();
    expect([...FILE_FORMATS]).toEqual(['pdf', 'docx', 'csv', 'json', 'txt']);
  });

  it('FORMAT_CONTENT_TYPES gives each format its content type', async () => {
    const { FORMAT_CONTENT_TYPES } = await loadIntake();
    expect({ ...FORMAT_CONTENT_TYPES }).toEqual({
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      csv: 'text/csv',
      json: 'application/json',
      txt: 'text/plain',
    });
  });

  it('MAX_UPLOAD_BYTES is 25 MB and MAX_FILE_NAME_LENGTH is 255', async () => {
    const { MAX_UPLOAD_BYTES, MAX_FILE_NAME_LENGTH } = await loadIntake();
    expect(MAX_UPLOAD_BYTES).toBe(26_214_400);
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_FILE_NAME_LENGTH).toBe(255);
  });

  it('DOCUMENT_STATUSES and IMPORT_STATUSES are the brief lists, in order', async () => {
    const { DOCUMENT_STATUSES, IMPORT_STATUSES } = await loadIntake();
    expect([...DOCUMENT_STATUSES]).toEqual(['stored', 'processing', 'processed', 'failed']);
    expect([...IMPORT_STATUSES]).toEqual(['reading', 'needs_mapping', 'queued', 'importing', 'done', 'failed']);
  });
});

describe('criterion 1: canUpload matches the D50 uploads row for every role x kind', () => {
  it('ROLE_TABLE.uploads is the D50 row (agreement with M0-008)', async () => {
    const access = await loadModule('src/access/index.ts');
    const table = access.ROLE_TABLE as Record<string, Record<string, string>>;
    expect({ ...table.uploads }).toEqual(UPLOADS_ROW);
  });

  const cells = ROLES.flatMap((role) => DOCUMENT_KINDS.map((kind) => [role, kind] as const));

  it.each(cells)('canUpload(%s, %s) follows ROLE_TABLE.uploads', async (role, kind) => {
    const { canUpload } = await loadIntake();
    const access = await loadModule('src/access/index.ts');
    const table = access.ROLE_TABLE as Record<string, Record<string, string>>;
    const cell = table.uploads![role]!;
    expect(canUpload(role, kind)).toBe(expectedFromCell(cell, kind));
  });

  it.each(cells)('canUpload(%s, %s) matches the hand-written D50 row', async (role, kind) => {
    const { canUpload } = await loadIntake();
    expect(canUpload(role, kind)).toBe(expectedFromCell(UPLOADS_ROW[role], kind));
  });

  it('the Control Owner may upload evidence only', async () => {
    const { canUpload } = await loadIntake();
    expect(DOCUMENT_KINDS.filter((kind) => canUpload('control_owner', kind))).toEqual(['evidence']);
  });

  it.each(['auditor', 'viewer'])('the %s may upload nothing', async (role) => {
    const { canUpload } = await loadIntake();
    expect(DOCUMENT_KINDS.filter((kind) => canUpload(role, kind))).toEqual([]);
  });

  it.each([['superuser'], ['Admin'], [''], ['__proto__'], ['toString']])(
    'an unknown role %j may upload nothing',
    async (role) => {
      const { canUpload } = await loadIntake();
      expect(DOCUMENT_KINDS.filter((kind) => canUpload(role, kind))).toEqual([]);
    },
  );

  it.each([['firmware_image'], ['Asset_List'], ['asset'], [''], ['__proto__'], ['toString'], ['constructor']])(
    'an unknown kind %j is false for every role',
    async (kind) => {
      const { canUpload } = await loadIntake();
      expect(ROLES.filter((role) => canUpload(role, kind))).toEqual([]);
    },
  );
});
