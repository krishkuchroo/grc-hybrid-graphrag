// S1-004 "The own cells" (D50, D199, D206): the guard's opt-in `own` flag, with a fake execution
// context and no database.
//
// Contract:
// - `Requires(subject, action, { own: true })` (src/access/requires.decorator.ts) marks a route whose
//   "own" cells the service checks. `Requires(subject, action)` without it is unchanged.
// - `AccessGuard` (src/access/access.guard.ts): when the caller's D50 cell for the subject is
//   `edit_own` and the flag is on, it lets the request through and sets `request.ownOnly = true`.
//   The service then applies ownership (404 on anything not owned).
// - Every other cell behaves exactly as before, flag or not: allowed by `can(role, subject, action)`,
//   otherwise a 403 ForbiddenException, and `request.ownOnly` is never set. No principal or an
//   unknown role is still 403. The M0-008 access-guard tests still pass unchanged.
import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_TABLE, can, type Role } from '@grc/shared';

type RequiresFn = (subject: string, action: string, options?: { own?: boolean }) => MethodDecorator & ClassDecorator;
type Guard = { canActivate(ctx: ExecutionContext): boolean | Promise<boolean> };

async function load(): Promise<{ Requires: RequiresFn; AccessGuard: new () => Guard }> {
  const { Requires } = (await import('../../src/access/requires.decorator.js')) as unknown as { Requires: RequiresFn };
  const { AccessGuard } = (await import('../../src/access/access.guard.js')) as unknown as {
    AccessGuard: new () => Guard;
  };
  return { Requires, AccessGuard };
}

interface FakeRequest {
  principal?: { role: string; clearance: string; userId: string; orgId: string };
  ownOnly?: boolean;
}

/** A handler carrying `Requires(subject, action, options)`, and a context for one request. */
async function contextFor(
  subject: string,
  action: string,
  options: { own?: boolean } | undefined,
  request: FakeRequest,
): Promise<ExecutionContext> {
  const { Requires } = await load();
  class Route {
    handle(): string {
      return 'ran';
    }
  }
  const desc = Object.getOwnPropertyDescriptor(Route.prototype, 'handle')!;
  const decorator = options === undefined ? Requires(subject, action) : Requires(subject, action, options);
  (decorator as MethodDecorator)(Route.prototype, 'handle', desc);
  return {
    getHandler: () => Route.prototype.handle,
    getClass: () => Route,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => undefined }),
    getType: () => 'http',
    getArgs: () => [request],
    getArgByIndex: (i: number) => [request][i],
    switchToRpc: () => {
      throw new Error('not rpc');
    },
    switchToWs: () => {
      throw new Error('not ws');
    },
  } as unknown as ExecutionContext;
}

function principal(role: string) {
  return { role, clearance: 'restricted', userId: `user-${role}`, orgId: '0b9d6c1e-6a3f-4c55-9d7e-2f1c8a4b7e10' };
}

/** 'pass' with the ownOnly value, or 'forbidden'. */
async function check(
  role: string | undefined,
  subject: string,
  action: string,
  options?: { own?: boolean },
): Promise<{ result: 'pass' | 'forbidden'; ownOnly: unknown }> {
  const { AccessGuard } = await load();
  const request: FakeRequest = role === undefined ? {} : { principal: principal(role) };
  const ctx = await contextFor(subject, action, options, request);
  try {
    const ok = await new AccessGuard().canActivate(ctx);
    expect(ok).toBe(true);
    return { result: 'pass', ownOnly: request.ownOnly };
  } catch (err) {
    expect(err, 'a refusal is a ForbiddenException (403)').toBeInstanceOf(ForbiddenException);
    return { result: 'forbidden', ownOnly: request.ownOnly };
  }
}

describe('the own flag on an edit_own cell (a Control Owner on controls)', () => {
  it('the table still has control_owner / control as edit_own', () => {
    expect(ROLE_TABLE.control.control_owner).toBe('edit_own');
  });

  it.each(['view', 'edit'])('with the flag, control_owner %s on control passes and sets ownOnly', async (action) => {
    expect(await check('control_owner', 'control', action, { own: true })).toEqual({ result: 'pass', ownOnly: true });
  });

  it.each(['view', 'edit'])('without the flag, control_owner %s on control is refused, as before', async (action) => {
    expect(await check('control_owner', 'control', action)).toEqual({ result: 'forbidden', ownOnly: undefined });
  });

  it.each(['view', 'edit'])('with { own: false }, control_owner %s on control is refused', async (action) => {
    expect((await check('control_owner', 'control', action, { own: false })).result).toBe('forbidden');
  });
});

const OTHER_CELLS = ROLES.flatMap((role) =>
  (['view', 'edit'] as const).map((action) => ({ role, action, cell: ROLE_TABLE.control[role] })),
).filter((c) => c.cell !== 'edit_own');

describe('every other cell behaves exactly as before, flag or not', () => {
  it.each(OTHER_CELLS)('$role $action on control ($cell) with the flag', async ({ role, action }) => {
    const expected = can(role, 'control', action) ? 'pass' : 'forbidden';
    const got = await check(role, 'control', action, { own: true });
    expect(got.result).toBe(expected);
    expect(got.ownOnly, 'ownOnly is set only for an edit_own cell').not.toBe(true);
  });

  it.each(
    ROLES.flatMap((role: Role) =>
      (['asset', 'risk', 'policy', 'incident'] as const).flatMap((subject) =>
        (['view', 'edit'] as const).map((action) => ({ role, subject, action })),
      ),
    ),
  )('$role $action on $subject: the same answer with and without the flag', async ({ role, subject, action }) => {
    const expected = can(role, subject, action) ? 'pass' : 'forbidden';
    const without = await check(role, subject, action);
    const withFlag = await check(role, subject, action, { own: true });
    expect(without.result).toBe(expected);
    expect(withFlag.result).toBe(expected);
    expect(withFlag.ownOnly).not.toBe(true);
  });

  it('upload_own (a Control Owner on evidence) is not opened by the flag', async () => {
    expect(ROLE_TABLE.evidence.control_owner).toBe('upload_own');
    expect((await check('control_owner', 'evidence', 'upload', { own: true })).result).toBe('forbidden');
    expect((await check('control_owner', 'evidence', 'view', { own: true })).result).toBe('forbidden');
  });

  it('no principal is refused, with the flag', async () => {
    expect(await check(undefined, 'control', 'edit', { own: true })).toEqual({
      result: 'forbidden',
      ownOnly: undefined,
    });
  });

  it('an unknown role is refused, with the flag', async () => {
    expect(await check('superuser', 'control', 'edit', { own: true })).toEqual({
      result: 'forbidden',
      ownOnly: undefined,
    });
  });

  it('a route with no requirement is refused', async () => {
    const { AccessGuard } = await load();
    class Bare {
      handle(): void {}
    }
    const request: FakeRequest = { principal: principal('admin') };
    const ctx = {
      getHandler: () => Bare.prototype.handle,
      getClass: () => Bare,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    await expect(Promise.resolve().then(() => new AccessGuard().canActivate(ctx))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
