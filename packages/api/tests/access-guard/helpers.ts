// Shared set-up for the M0-008 guard tests (D50, D59).
//
// Contract these tests hold the builder to:
// - `src/access/requires.decorator.ts` exports `Requires(subject, action)`, a Nest decorator that
//   records what a route needs (usable as a plain call on a method).
// - `src/access/access.guard.ts` exports `AccessGuard`, a Nest guard used with `UseGuards`. It reads
//   the caller from `request.principal = { role, clearance, userId, orgId }` (the session guard of
//   M0-010 and the API key guard of M0-011 set it) and asks `can(role, subject, action)` from
//   `@grc/shared`. Refused, or no principal, or an unknown role: 403 in the M0-007 error format
//   (code `forbidden`), and the handler never runs.
//
// Since M0-010 every request needs a signed-in session with MFA checked (the global SessionGuard),
// so the requests carry an admin's session. A test guard that runs after the SessionGuard and
// before AccessGuard then sets `request.principal` from an `x-test-role` header, or removes it for
// `x-test-principal: none`.
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Module, Post, UseGuards } from '@nestjs/common';
import { API_DIR } from '../db/helpers.js';

export const ROUTES = '/api/v1/access-guard-test';
export const ORG_ID = '0b9d6c1e-6a3f-4c55-9d7e-2f1c8a4b7e10';

// Each route, the D50 check it declares, and the roles the table lets through at route level
// (no ownership or record type is known there, so `edit_own` and `evidence_only` refuse).
export const GUARDED: { method: 'GET' | 'POST'; path: string; subject: string; action: string; allowed: string[] }[] = [
  {
    method: 'GET',
    path: 'risks',
    subject: 'risk',
    action: 'view',
    allowed: ['admin', 'risk_manager', 'compliance_manager', 'control_owner', 'auditor', 'analyst', 'viewer'],
  },
  { method: 'POST', path: 'risks', subject: 'risk', action: 'edit', allowed: ['admin', 'risk_manager'] },
  {
    method: 'GET',
    path: 'incidents',
    subject: 'incident',
    action: 'view',
    allowed: ['admin', 'risk_manager', 'compliance_manager', 'auditor', 'analyst'],
  },
  { method: 'POST', path: 'controls', subject: 'control', action: 'edit', allowed: ['admin', 'compliance_manager'] },
  {
    method: 'POST',
    path: 'framework-mappings/approve',
    subject: 'framework_mapping',
    action: 'approve',
    allowed: ['analyst'],
  },
  { method: 'POST', path: 'audit-findings', subject: 'audit_finding', action: 'edit', allowed: ['auditor'] },
  {
    method: 'POST',
    path: 'uploads',
    subject: 'uploads',
    action: 'use',
    allowed: ['admin', 'risk_manager', 'compliance_manager', 'analyst'],
  },
  { method: 'POST', path: 'review-queue/work', subject: 'review_queue', action: 'work', allowed: ['analyst'] },
  { method: 'GET', path: 'audit-trail', subject: 'audit_trail', action: 'view', allowed: ['admin', 'auditor'] },
  { method: 'POST', path: 'users', subject: 'admin', action: 'edit', allowed: ['admin'] },
  {
    method: 'POST',
    path: 'chat',
    subject: 'chat',
    action: 'use',
    allowed: ['admin', 'risk_manager', 'compliance_manager', 'control_owner', 'auditor', 'analyst', 'viewer'],
  },
];

export const ROLES = ['admin', 'risk_manager', 'compliance_manager', 'control_owner', 'auditor', 'analyst', 'viewer'];

// How many times each handler ran, keyed by "METHOD path".
export const calls = new Map<string, number>();

async function load(rel: string, name: string): Promise<unknown> {
  const file = join(API_DIR, rel);
  if (!existsSync(file)) throw new Error(`${rel} does not exist yet`);
  const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
  if (typeof mod[name] !== 'function') throw new Error(`${rel} must export ${name}`);
  return mod[name];
}

type MethodDecoratorFn = (target: object, key: string | symbol, desc: PropertyDescriptor) => void;

export async function accessGuardTestModule(): Promise<unknown> {
  const Requires = (await load('src/access/requires.decorator.ts', 'Requires')) as (
    subject: string,
    action: string,
  ) => MethodDecoratorFn;
  const AccessGuard = (await load('src/access/access.guard.ts', 'AccessGuard')) as new (...args: never[]) => object;

  // Runs after the global SessionGuard (M0-010) and before AccessGuard: it swaps the signed-in
  // principal for one with the role named in `x-test-role`, or removes it for
  // `x-test-principal: none`. No header keeps the session's own principal.
  class PrincipalFromHeader {
    canActivate(context: { switchToHttp(): { getRequest(): Record<string, unknown> } }): boolean {
      const req = context.switchToHttp().getRequest();
      const headers = req.headers as Record<string, string | undefined>;
      const role = headers['x-test-role'];
      if (role !== undefined) {
        req.principal = { role, clearance: 'internal', userId: `user-${role}`, orgId: ORG_ID };
      }
      if (headers['x-test-principal'] === 'none') delete req.principal;
      return true;
    }
  }

  class AccessGuardTestController {}
  const proto = AccessGuardTestController.prototype as unknown as Record<string, () => unknown>;
  for (const route of GUARDED) {
    const key = `${route.method}_${route.path}`.replace(/[^A-Za-z0-9_]/g, '_');
    const label = `${route.method} ${route.path}`;
    proto[key] = () => {
      calls.set(label, (calls.get(label) ?? 0) + 1);
      return { ok: true, route: label };
    };
    const desc = Object.getOwnPropertyDescriptor(proto, key)!;
    (route.method === 'GET' ? Get : Post)(route.path)(proto, key, desc);
    Requires(route.subject, route.action)(proto, key, desc);
  }
  UseGuards(PrincipalFromHeader, AccessGuard)(AccessGuardTestController);
  Controller('access-guard-test')(AccessGuardTestController);

  class AccessGuardTestModule {}
  Module({ controllers: [AccessGuardTestController] })(AccessGuardTestModule);
  return AccessGuardTestModule;
}
