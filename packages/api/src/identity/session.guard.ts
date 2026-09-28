// The global SessionGuard (D54, D55, D73). Every route needs a signed-in session, except the ones
// marked public (/api/v1/health) and Better Auth's own routes under /api/v1/auth, which are not
// Nest routes (src/identity/auth-routes.ts guards them).
//
// The org comes from the session and the member row, never from the request: the session's
// active org is used only if the user is a member of it, otherwise the user's own (oldest)
// membership. Membership is read again on every request, so a removed member loses access at
// once. A session that hasn't passed the second factor gets 403 `mfa_required`, except on routes
// marked `AllowWithoutMfa` (/api/v1/me).
// With MFA checked, `request.principal = { orgId, userId, role, clearance }`: what later code
// passes to `withOrgContext` (M0-008 contract).
import { SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../common/errors.js';
import type { Label, Role } from '../db/org-context.js';
import type { AuthService, ResolvedSession } from './auth.js';

export const PUBLIC_ROUTE = 'grc:public-route';
export const ALLOW_WITHOUT_MFA = 'grc:allow-without-mfa';

/** No session needed (health only). */
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(PUBLIC_ROUTE, true);
/** A signed-in user who hasn't finished MFA yet may use this route. */
export const AllowWithoutMfa = (): ClassDecorator & MethodDecorator => SetMetadata(ALLOW_WITHOUT_MFA, true);

export interface Identity {
  user: { id: string; email: string; name: string };
  orgId: string;
  role: Role;
  clearance: Label;
  mfaEnrolled: boolean;
  mfaVerified: boolean;
}

export interface AuthedRequest {
  authSession?: ResolvedSession | null;
  identity?: Identity;
  principal?: { orgId: string; userId: string; role: Role; clearance: Label };
}

export class SessionGuard implements CanActivate {
  private readonly reflector = new Reflector();

  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_ROUTE, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    // Whatever arrived with the request is never trusted.
    delete request.principal;
    delete request.identity;

    const session = request.authSession;
    if (!session) throw new ApiError(401, 'unauthorized', 'Sign in first.');

    const membership = await this.auth.membershipFor(session);
    if (!membership) throw new ApiError(403, 'forbidden', 'You are not a member of an organisation.');

    request.identity = {
      user: { id: session.user.id, email: session.user.email, name: session.user.name },
      orgId: membership.orgId,
      role: membership.role,
      clearance: membership.clearance,
      mfaEnrolled: session.user.twoFactorEnabled,
      mfaVerified: session.mfaVerified,
    };

    if (!session.mfaVerified) {
      if (this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_WITHOUT_MFA, targets)) return true;
      throw new ApiError(403, 'mfa_required', 'Set up and check two-factor sign-in first.');
    }

    request.principal = {
      orgId: membership.orgId,
      userId: session.userId,
      role: membership.role,
      clearance: membership.clearance,
    };
    return true;
  }
}
