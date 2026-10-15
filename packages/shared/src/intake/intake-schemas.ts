// The create, update and record schemas for Evidence and Audit findings, as S1's three per kind
// (D30). Create and update bodies refuse unknown fields, so the server-set fields (the review
// fields among them) can't be sent.
//
// A shared schema can't read the clock (pure), so there are two sets:
// - `intakeCreateSchemas` and `intakeUpdateSchemas` check every rule that doesn't need today (the
//   fields, values, labels and the order of the dates). They're for the OpenAPI document and for
//   checking a form as it's typed.
// - `intakeCreateSchemasOn(today)` and `intakeUpdateSchemasOn(today)` also refuse a collected,
//   identified or closed date after `today` (`YYYY-MM-DD`). The API checks request bodies with
//   these, passing its own today; the web app passes the user's.
// An update's changes are checked on their own; the API then runs `evidenceDateProblems` or
// `findingDateProblems` again on the merged record.
import type { z } from 'zod';
import {
  auditFindingRecordSchema,
  buildAuditFindingCreateSchema,
  buildAuditFindingUpdateSchema,
} from './audit-findings.js';
import { buildEvidenceCreateSchema, buildEvidenceUpdateSchema, evidenceRecordSchema } from './evidence.js';
import type { IntakeRecordKind } from './intake-numbers.js';

export const intakeCreateSchemas = {
  evidence: buildEvidenceCreateSchema(null),
  audit_finding: buildAuditFindingCreateSchema(null),
};

export const intakeUpdateSchemas = {
  evidence: buildEvidenceUpdateSchema(null),
  audit_finding: buildAuditFindingUpdateSchema(null),
};

export const intakeRecordSchemas = {
  evidence: evidenceRecordSchema,
  audit_finding: auditFindingRecordSchema,
};

/** The create schemas, also refusing dates after `today`. A malformed `today` throws. */
export function intakeCreateSchemasOn(today: string): typeof intakeCreateSchemas {
  return {
    evidence: buildEvidenceCreateSchema(today),
    audit_finding: buildAuditFindingCreateSchema(today),
  };
}

/** The update schemas, also refusing dates after `today`. A malformed `today` throws. */
export function intakeUpdateSchemasOn(today: string): typeof intakeUpdateSchemas {
  return {
    evidence: buildEvidenceUpdateSchema(today),
    audit_finding: buildAuditFindingUpdateSchema(today),
  };
}

export type IntakeCreateInput<K extends IntakeRecordKind> = z.infer<(typeof intakeCreateSchemas)[K]>;
export type IntakeUpdateInput<K extends IntakeRecordKind> = z.infer<(typeof intakeUpdateSchemas)[K]>;
export type IntakeRecordOf<K extends IntakeRecordKind> = z.infer<(typeof intakeRecordSchemas)[K]>;
