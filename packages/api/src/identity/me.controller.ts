// GET /api/v1/me: who is signed in, their org, role and clearance, and whether MFA is set up.
// Nothing from Better Auth's own tables beyond that (M0-009 security review).
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Controller, Get, Inject, Req } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/errors.js';
import { documentRoute } from '../common/openapi.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { withOrgContext } from '../db/org-context.js';
import { organization } from './schema.js';
import { AllowWithoutMfa, type AuthedRequest } from './session.guard.js';

export const meResponseSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  org: z.object({ id: z.string(), name: z.string() }),
  role: z.string(),
  clearance: z.string(),
  mfaEnrolled: z.boolean(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

export class MeController {
  constructor(private readonly db: Db) {}

  async me(request: AuthedRequest): Promise<MeResponse> {
    const id = request.identity;
    if (!id) throw new ApiError(401, 'unauthorized', 'Sign in first.');
    const ctx = { orgId: id.orgId, userId: id.user.id, role: id.role, clearance: id.clearance };
    const [org] = await withOrgContext(this.db, ctx, (tx) =>
      tx
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .where(eq(organization.id, id.orgId)),
    );
    if (!org) throw new ApiError(403, 'forbidden', 'You are not a member of an organisation.');
    return meResponseSchema.parse({
      user: id.user,
      org,
      role: id.role,
      clearance: id.clearance,
      mfaEnrolled: id.mfaEnrolled,
    });
  }
}
Controller('me')(MeController);
const desc = Object.getOwnPropertyDescriptor(MeController.prototype, 'me')!;
Get()(MeController.prototype, 'me', desc);
Req()(MeController.prototype, 'me', 0);
AllowWithoutMfa()(MeController.prototype, 'me', desc);
Inject(DB)(MeController, undefined, 0);

documentRoute({
  method: 'get',
  path: '/me',
  summary: 'The signed-in user, their org, role and clearance, and whether MFA is set up',
  response: meResponseSchema,
});
