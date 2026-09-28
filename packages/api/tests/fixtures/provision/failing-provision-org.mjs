// Test fixture (M0-014 follow-up, D164): stands in for `src/identity/provision-org.ts` in the
// operator-script failure tests. The argument checks are the real ones; provisionOrg fails the way
// a failed write does, carrying the org's name and slug and the first Admin's ID, name and email.
// FAIL_SHAPE picks the error: `drizzle` (default), `props` or `plain`.
import { DrizzleQueryError } from 'drizzle-orm/errors';

const real = await import(new globalThis.URL('../../../src/identity/provision-org.ts?real', import.meta.url).href);

export const SLUG = real.SLUG;
export const EMAIL = real.EMAIL;
export const checkProvisionInput = real.checkProvisionInput;
export const orgIdForSlug = real.orgIdForSlug;

/** The first Admin's user ID the failing write carries; the tests look for it in the output. */
export const LEAK_ADMIN_ID = '5eed1eaf-0a0b-4c0d-8e0f-1a2b3c4d5e6f';

class ProvisionStepError extends Error {
  constructor(message, input, options) {
    super(message, options);
    this.name = 'ProvisionStepError';
    this.input = input;
    this.adminId = LEAK_ADMIN_ID;
  }
}

export async function provisionOrg(input) {
  const orgId = real.orgIdForSlug(input.slug);
  const shape = globalThis.process.env.FAIL_SHAPE || 'drizzle';
  if (shape === 'plain') {
    throw new Error(
      `org.created failed for ${input.name} (${input.slug}), admin ${LEAK_ADMIN_ID} ${input.admin.name} <${input.admin.email}>`,
    );
  }
  if (shape === 'props') {
    const cause = Object.assign(new Error(`could not store ${input.name} for ${input.admin.email}`), {
      code: 'ECONNRESET',
      slug: input.slug,
    });
    throw new ProvisionStepError(`org.created failed for ${input.slug}`, input, { cause });
  }
  const pgError = Object.assign(
    new Error('duplicate key value violates unique constraint "organization_slug_unique"'),
    {
      name: 'error',
      code: '23505',
      severity: 'ERROR',
      detail: `Key (slug)=(${input.slug}) already exists.`,
      where: `SQL statement "insert ... values (${input.name}, ${input.admin.email}, ${LEAK_ADMIN_ID})"`,
      table: 'audit_events',
    },
  );
  throw new DrizzleQueryError(
    'insert into "audit_events" ("org_id", "actor_id", "action", "target_type", "target_id", "after") values ($1, $2, $3, $4, $5, $6)',
    [
      orgId,
      LEAK_ADMIN_ID,
      'org.created',
      'organization',
      orgId,
      JSON.stringify({
        name: input.name,
        slug: input.slug,
        admin: { id: LEAK_ADMIN_ID, email: input.admin.email, name: input.admin.name },
      }),
    ],
    pgError,
  );
}
