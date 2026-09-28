// GET /api/v1/people (S1-004): the caller's org members, for the owner picker. Any signed-in user
// or API key; paged (D47). Each person is `{ id, name, role }` only: no email, no clearance. The
// member table sits behind the org wall, so the read runs in the caller's org context (D55, D73),
// and it is also limited to the caller's own org by name.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ApiError } from '../common/errors.js';
import { documentRoute } from '../common/openapi.js';
import { pageQuerySchema, type Paged } from '../common/paging.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { withOrgContext } from '../db/org-context.js';
import { member, user } from './schema.js';
import type { AuthedRequest } from './session.guard.js';

export const personSchema = z.object({ id: z.string(), name: z.string(), role: z.string() });
export const peopleListSchema = z.object({
  items: z.array(personSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int(),
});

export type Person = z.infer<typeof personSchema>;

export class PeopleController {
  constructor(private readonly db: Db) {}

  async list(request: AuthedRequest, query: unknown): Promise<Paged<Person>> {
    const p = request.principal;
    if (!p) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
    const { page, pageSize } = pageQuerySchema.parse(query ?? {});
    const ctx = { orgId: p.orgId, userId: p.userId, role: p.role, clearance: p.clearance };
    const inOrg = eq(member.organizationId, p.orgId);
    return withOrgContext(this.db, ctx, async (tx) => {
      const [totalRow] = await tx.select({ n: count() }).from(member).where(inOrg);
      const items = await tx
        .select({ id: user.id, name: user.name, role: member.role })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(inOrg)
        .orderBy(asc(user.name), asc(user.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return { items, page, pageSize, total: Number(totalRow?.n ?? 0) };
    });
  }
}

const proto = PeopleController.prototype;
const desc = Object.getOwnPropertyDescriptor(proto, 'list')!;
Get()(proto, 'list', desc);
Req()(proto, 'list', 0);
Query()(proto, 'list', 1);
Controller('people')(PeopleController);
Inject(DB)(PeopleController, undefined, 0);

documentRoute({
  method: 'get',
  path: '/people',
  summary: "The caller's org members for the owner picker, paged: id, name and role only",
  response: peopleListSchema,
});
