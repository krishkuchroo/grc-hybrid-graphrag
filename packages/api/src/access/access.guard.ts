// The route-level check of the D50 table. It reads the caller from `request.principal` (set by the
// session guard or the API key guard) and the route's `@Requires(subject, action)`. No principal,
// an unknown role, a route with no requirement, or a refusal by the table: 403 in the one error
// format (D47), and the handler never runs (fail safe, principle 7).
// The one opening (S1-004): a route marked `Requires(subject, action, { own: true })` lets an
// `edit_own` cell through and sets `request.ownOnly = true`; its service then refuses anything the
// caller doesn't own (404). Every other cell behaves the same with or without the flag.
import { ForbiddenException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLE_TABLE, can, isRole, isSubject } from '@grc/shared';
import { REQUIRES_KEY, type Requirement } from './requires.decorator.js';

export interface Principal {
  role: string;
  clearance: string;
  userId: string;
  orgId: string;
}

const REFUSED = 'You do not have permission to do this.';

/** Whether the role's cell for the subject is `edit_own`, for an action that cell covers. */
function isOwnCell(role: string, subject: string, action: string): boolean {
  if (!isRole(role) || !isSubject(subject)) return false;
  return ROLE_TABLE[subject][role] === 'edit_own' && (action === 'view' || action === 'edit');
}

export class AccessGuard implements CanActivate {
  private readonly reflector = new Reflector();

  canActivate(context: ExecutionContext): boolean {
    const requirement = this.reflector.getAllAndOverride<Requirement | undefined>(REQUIRES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<{ principal?: Principal; ownOnly?: boolean }>();
    const principal = request.principal;
    if (!requirement || !principal) throw new ForbiddenException(REFUSED);
    if (can(principal.role, requirement.subject, requirement.action)) return true;
    if (requirement.own === true && isOwnCell(principal.role, requirement.subject, requirement.action)) {
      request.ownOnly = true;
      return true;
    }
    throw new ForbiddenException(REFUSED);
  }
}
