// `@Requires(subject, action)`: what a route needs from the D50 table. `AccessGuard` reads it.
// `Requires(subject, action, { own: true })` also lets an `edit_own` cell through the guard; the
// route's service then applies the ownership rule (S1-004, D50, D206).
import { SetMetadata } from '@nestjs/common';
import type { Action, Subject } from '@grc/shared';

export const REQUIRES_KEY = 'grc:requires';

export interface Requirement {
  subject: Subject | string;
  action: Action | string;
  /** The route's service checks ownership itself, so an `edit_own` cell may pass the guard. */
  own?: boolean;
}

export interface RequiresOptions {
  own?: boolean;
}

export function Requires(
  subject: Subject | string,
  action: Action | string,
  options?: RequiresOptions,
): MethodDecorator & ClassDecorator {
  const requirement: Requirement = options?.own === true ? { subject, action, own: true } : { subject, action };
  return SetMetadata(REQUIRES_KEY, requirement);
}
