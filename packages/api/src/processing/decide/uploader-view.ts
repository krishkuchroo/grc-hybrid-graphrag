// Whose view a document's processing works in (S4 shared notes, "Whose view"; D51, D54, D230): the
// uploader's. A person by their current membership of the org (role and clearance, with their user
// ID for the "own" cells), an API key by its one role at its own clearance while it is neither
// revoked nor expired (D230; the user ID `api_key:<id>`, as the API gives it), and the system's own
// fast load as Admin at Restricted. Anyone else (a member who left, a key that no longer works, a
// role or clearance row value that isn't known) is null: they see nothing, so nothing the document
// names is matched and every link waits for the Analyst (fail safe, D45.7).
import { isLabel, isRole } from '@grc/shared';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../../db/org-context.js';
import { apiKeys } from '../../identity/api-keys.schema.js';
import { member } from '../../identity/schema.js';
import type { DocumentRow } from '../../intake/intake.schema.js';
import { SYSTEM_MATCH_VIEW, type MatchView } from '../match/name-matcher.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The uploader's view of the org, read in `tx` (under the org's context), or null when they see nothing. */
export async function uploaderView(
  tx: Tx,
  doc: Pick<DocumentRow, 'orgId' | 'uploaderType' | 'uploaderId'>,
  now: Date = new Date(),
): Promise<MatchView | null> {
  if (doc.uploaderType === 'system') return SYSTEM_MATCH_VIEW;
  if (doc.uploaderType === 'user') {
    if (typeof doc.uploaderId !== 'string' || doc.uploaderId.trim() === '') return null;
    const [row] = await tx
      .select({ role: member.role, clearance: member.clearance })
      .from(member)
      .where(and(eq(member.organizationId, doc.orgId), eq(member.userId, doc.uploaderId)))
      .limit(1);
    if (!row || !isRole(row.role) || !isLabel(row.clearance)) return null;
    return { role: row.role, clearance: row.clearance, userId: doc.uploaderId };
  }
  if (doc.uploaderType === 'api_key' && UUID.test(doc.uploaderId)) {
    const [row] = await tx
      .select({
        role: apiKeys.role,
        clearance: apiKeys.clearance,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.orgId, doc.orgId), eq(apiKeys.id, doc.uploaderId)))
      .limit(1);
    if (!row || row.revokedAt !== null || row.expiresAt <= now) return null;
    if (!isRole(row.role) || !isLabel(row.clearance)) return null;
    return { role: row.role, clearance: row.clearance, userId: `api_key:${doc.uploaderId}` };
  }
  return null;
}
