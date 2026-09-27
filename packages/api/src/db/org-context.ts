// The per-transaction org context that RLS relies on (D73).
// `withOrgContext` checks its input first, then runs `fn` in one transaction after setting
// app.org_id, app.user_id, app.role and app.clearance with SET LOCAL semantics, so the
// settings end with the transaction and never carry over to the next pooled use.
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

// The names shared across tasks (TASKS.md, M0 shared notes). M0-008 moves them to @grc/shared.
export const ROLES = [
  'admin',
  'risk_manager',
  'compliance_manager',
  'control_owner',
  'auditor',
  'analyst',
  'viewer',
] as const;
export const LABELS = ['public', 'internal', 'confidential', 'restricted'] as const;

export type Role = (typeof ROLES)[number];
export type Label = (typeof LABELS)[number];

export interface OrgContext {
  orgId: string;
  userId: string;
  role: Role;
  clearance: Label;
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function check(ctx: OrgContext): void {
  if (typeof ctx.orgId !== 'string' || !UUID.test(ctx.orgId)) {
    throw new Error('withOrgContext: orgId must be a UUID');
  }
  if (typeof ctx.userId !== 'string' || ctx.userId.trim() === '') {
    throw new Error('withOrgContext: userId must be a non-empty string');
  }
  if (!(ROLES as readonly string[]).includes(ctx.role)) {
    throw new Error('withOrgContext: role is not one of the known roles');
  }
  if (!(LABELS as readonly string[]).includes(ctx.clearance)) {
    throw new Error('withOrgContext: clearance is not one of the known labels');
  }
}

export async function withOrgContext<T>(db: Db, ctx: OrgContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  check(ctx);
  return db.transaction(async (tx) => {
    // set_config(..., true) is SET LOCAL, with the values passed as bound parameters.
    await tx.execute(sql`SELECT set_config('app.org_id', ${ctx.orgId}, true),
                                set_config('app.user_id', ${ctx.userId}, true),
                                set_config('app.role', ${ctx.role}, true),
                                set_config('app.clearance', ${ctx.clearance}, true)`);
    return fn(tx);
  });
}
