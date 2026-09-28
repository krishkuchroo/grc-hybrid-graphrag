// The create, update and record schemas for the five record types (D30, D51, D69, D73, D197).
// Create and update bodies refuse unknown fields, so the server-set fields can't be sent.
import { z } from 'zod';
import { LABELS } from '../access/labels.js';
import { RECORD_ORIGINS, RECORD_STATUSES, type RecordKind } from './types.js';
import {
  ASSET_TYPES,
  CONTROL_STATUSES,
  CRITICALITIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  RISK_SCALE,
} from './values.js';

const name = z.string().trim().min(1);
const userId = z.string().min(1);
const label = z.enum(LABELS);
const scale = z.int().refine((v) => (RISK_SCALE as readonly number[]).includes(v), 'must be 1 to 5');
const dollars = z.int().nonnegative();

/** Each type's own fields (the S1 shared notes' table). */
const ownFields = {
  asset: {
    assetType: z.enum(ASSET_TYPES),
    criticality: z.enum(CRITICALITIES),
    dataClassification: label,
  },
  risk: {
    impact: scale,
    likelihood: scale,
    financialExposure: dollars,
  },
  control: {
    code: z.string().trim().min(1),
    framework: z.string().trim().min(1),
    controlStatus: z.enum(CONTROL_STATUSES),
    lastTestedDate: z.iso.date(),
  },
  policy: {
    policyVersion: z.string().trim().min(1),
    effectiveDate: z.iso.date(),
  },
  incident: {
    severity: z.enum(INCIDENT_SEVERITIES),
    incidentStatus: z.enum(INCIDENT_STATUSES),
    occurredAt: z.iso.datetime({ offset: true }),
  },
} as const;

function createSchema<K extends RecordKind>(kind: K) {
  return z.strictObject({ name, owner: userId.optional(), label: label.optional(), ...ownFields[kind] });
}

function updateSchema<K extends RecordKind>(kind: K) {
  return createSchema(kind)
    .partial()
    .extend({ version: z.int().min(1) });
}

const commonFields = {
  id: z.uuid(),
  number: z.string().regex(/^[A-Z]{3}\d{7}$/),
  sourceIds: z.array(z.string()),
  name: z.string(),
  label,
  status: z.enum(RECORD_STATUSES),
  owner: userId,
  version: z.int().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  createdBy: userId,
  updatedAt: z.iso.datetime({ offset: true }),
  updatedBy: userId,
  origin: z.enum(RECORD_ORIGINS),
};

function recordSchema<K extends RecordKind>(kind: K) {
  return z.object({ ...commonFields, ...ownFields[kind] });
}

export const createSchemas = {
  asset: createSchema('asset'),
  risk: createSchema('risk'),
  control: createSchema('control'),
  policy: createSchema('policy'),
  incident: createSchema('incident'),
};

export const updateSchemas = {
  asset: updateSchema('asset'),
  risk: updateSchema('risk'),
  control: updateSchema('control'),
  policy: updateSchema('policy'),
  incident: updateSchema('incident'),
};

export const recordSchemas = {
  asset: recordSchema('asset'),
  risk: recordSchema('risk'),
  control: recordSchema('control'),
  policy: recordSchema('policy'),
  incident: recordSchema('incident'),
};

export type CreateRecordInput<K extends RecordKind> = z.infer<(typeof createSchemas)[K]>;
export type UpdateRecordInput<K extends RecordKind> = z.infer<(typeof updateSchemas)[K]>;
export type RecordOf<K extends RecordKind> = z.infer<(typeof recordSchemas)[K]>;
