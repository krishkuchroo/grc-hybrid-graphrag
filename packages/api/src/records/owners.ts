// Checks that a record's owner is a member of the caller's org (S1-003, D50, D206). The member
// table sits behind the org wall (D73), so the lookup runs as grc_app inside the caller's org
// context, and it also names the org itself.
import { and, eq } from 'drizzle-orm';
import type { Label, Role } from '@grc/shared';
import type { Db } from '../db/client.js';
import { withOrgContext } from '../db/org-context.js';
import { member } from '../identity/schema.js';

export interface OwnerCaller {
  orgId: string;
  userId: string;
  role: Role;
  clearance: Label;
}

/** Whether `userId` is a member of the caller's org. */
export async function isOrgMember(db: Db, caller: OwnerCaller, userId: string): Promise<boolean> {
  const ctx = { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
  const rows = await withOrgContext(db, ctx, (tx) =>
    tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, caller.orgId), eq(member.userId, userId)))
      .limit(1),
  );
  return rows.length > 0;
}
