// The route-level check of the D50 table. It reads the caller from `request.principal` (set by the
// session guard or the API key guard) and the route's `@Requires(subject, action)`. No principal,
// an unknown role, a route with no requirement, or a refusal by the table: 403 in the one error
// format (D47), and the handler never runs (fail safe, principle 7).
import { ForbiddenException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can } from '@grc/shared';
import { REQUIRES_KEY, type Requirement } from './requires.decorator.js';

export interface Principal {
  role: string;
  clearance: string;
  userId: string;
  orgId: string;
}

const REFUSED = 'You do not have permission to do this.';

export class AccessGuard implements CanActivate {
  private readonly reflector = new Reflector();

  canActivate(context: ExecutionContext): boolean {
    const requirement = this.reflector.getAllAndOverride<Requirement | undefined>(REQUIRES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<{ principal?: Principal }>();
    const principal = request.principal;
    if (!requirement || !principal || !can(principal.role, requirement.subject, requirement.action)) {
      throw new ForbiddenException(REFUSED);
    }
    return true;
  }
}
