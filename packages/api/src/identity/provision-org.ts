// Org provisioning (M0-014; D4, D22, D45.5, D53, D57, D73, D133): one call creates an org
// everywhere: the Postgres org row, its audit partition, the first Admin, the `org.created` audit
// event, `org-<orgId>` in Neo4j and `grc-org-<orgId>` in storage.
//
// Safe to re-run (D45.5): the slug names the org. The org ID is derived from the slug (a
// name-based UUID), so a re-run finds the same org without reading across the org wall, and every
// step is "create if missing". A call that fails part-way is finished by calling it again.
//
// Postgres writes run as grc_app under the org's own context, so RLS applies (D57, D73). Only the
// audit partition is made by the migration account, which owns the audit table.
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { AuditService, createAuditPartition } from '../audit/audit.service.js';
import type { Db } from '../db/client.js';
import type { Tx } from '../db/org-context.js';
import { member, organization, user } from './schema.js';

export interface ProvisionOrgInput {
  name: string;
  slug: string;
  admin: { email: string; name: string };
}

export interface ProvisionOrgDeps {
  /** grc_app, the restricted runtime account. */
  db: Db;
  /** grc_migrator, the migration account: only for the audit partition. */
  migrator: Db;
  graph: { createOrgDatabase(orgId: string): Promise<void> };
  files: { ensureBucket(orgId: string): Promise<void> };
}

/** Lowercase letters and digits, in groups joined by single hyphens. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Something before the `@`, and a domain with a dot after it. */
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The fixed namespace for org IDs derived from slugs (UUID v5, RFC 9562).
const ORG_NAMESPACE = 'a3c1d2e4-5f60-4b7a-8c9d-0e1f2a3b4c5d';

/** The org ID for a slug: a lowercase name-based UUID (v5), the same on every run. */
export function orgIdForSlug(slug: string): string {
  const ns = Buffer.from(ORG_NAMESPACE.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(ns).update(slug, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The problems with an input, one message per bad field; empty when it is fine. */
export function checkProvisionInput(input: ProvisionOrgInput): string[] {
  const problems: string[] = [];
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  if (!text(input?.name)) problems.push('name must not be empty');
  if (!text(input?.slug) || !SLUG.test(input.slug)) {
    problems.push('slug must be lowercase letters and digits, joined by single hyphens');
  }
  if (!text(input?.admin?.email) || !EMAIL.test(input.admin.email)) {
    problems.push('admin email must look like name@example.com');
  }
  if (!text(input?.admin?.name)) problems.push('admin name must not be empty');
  return problems;
}

// One grc_app transaction with only app.org_id set, so RLS limits it to this org.
function inOrg<T>(db: Db, orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export async function provisionOrg(input: ProvisionOrgInput, deps: ProvisionOrgDeps): Promise<{ orgId: string }> {
  const problems = checkProvisionInput(input);
  if (problems.length > 0) throw new Error(`provisionOrg: ${problems.join('; ')}`);
  const name = input.name.trim();
  const slug = input.slug;
  const adminEmail = input.admin.email.trim().toLowerCase();
  const adminName = input.admin.name.trim();
  const orgId = orgIdForSlug(slug);

  // 1. The audit partition, so the org.created event has somewhere to go.
  await createAuditPartition(deps.migrator, orgId);

  // 2. The org row and its first Admin, in one transaction.
  const adminUserId = await inOrg(deps.db, orgId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'provision:' + orgId}, 0))`);
    await tx.insert(organization).values({ id: orgId, name, slug }).onConflictDoNothing();
    const [org] = await tx.select({ slug: organization.slug }).from(organization).where(eq(organization.id, orgId));
    if (!org || org.slug !== slug) throw new Error(`provisionOrg: the slug ${slug} is taken by another org`);

    const [existing] = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.role, 'admin')))
      .limit(1);
    if (existing) return existing.userId;

    await tx
      .insert(user)
      .values({ id: randomUUID(), name: adminName, email: adminEmail })
      .onConflictDoNothing({ target: user.email });
    const [admin] = await tx.select({ id: user.id }).from(user).where(eq(user.email, adminEmail));
    // No password and no MFA: the Admin sets both at first sign-in (D49, D54).
    await tx.insert(member).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: admin!.id,
      role: 'admin',
      clearance: 'restricted',
    });
    return admin!.id;
  });

  // 3. org.created in the new org's own chain; a re-run finds it by its sourceId.
  await new AuditService(deps.db).append({
    orgId,
    actorType: 'system',
    actorId: 'org-provisioning',
    action: 'org.created',
    targetType: 'organization',
    targetId: orgId,
    after: { name, slug },
    meta: { adminUserId },
    sourceId: `org.created:${orgId}`,
  });

  // 4. The org's graph database and storage bucket (both "create if missing").
  await deps.graph.createOrgDatabase(orgId);
  await deps.files.ensureBucket(orgId);

  return { orgId };
}
