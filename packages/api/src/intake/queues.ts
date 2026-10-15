// The intake job queues (D29, D72) and the system context the worker's intake jobs run under
// (S3 shared notes, planner's reading R10). `processing.document-read` is queued by uploads and
// handled by S4's processing module.
import type { OrgContext } from '../db/org-context.js';

export const INTAKE_QUEUES = {
  assetListRead: 'intake.asset-list-read',
  assetImport: 'intake.asset-import',
  documentRead: 'processing.document-read',
} as const;

export type IntakeQueue = (typeof INTAKE_QUEUES)[keyof typeof INTAKE_QUEUES];

/** The user ID intake's system context runs as. */
export const INTAKE_SYSTEM_USER_ID = 'system:intake';

/**
 * The context the worker's intake jobs (and the evidence document rows, planner's reading R12) use
 * with `withOrgContext`: the org wall still applies, and Admin at Restricted sees every record type
 * and label inside the org.
 */
export function INTAKE_SYSTEM_CONTEXT(orgId: string): OrgContext {
  return { orgId, userId: INTAKE_SYSTEM_USER_ID, role: 'admin', clearance: 'restricted' };
}
