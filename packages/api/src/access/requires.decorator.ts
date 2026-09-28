// `@Requires(subject, action)`: what a route needs from the D50 table. `AccessGuard` reads it.
// `{ own: true }` opts a route into the "own" cells (for example a Control Owner's `edit_own` on
// controls): the guard lets the request through and the service then checks ownership.
import { SetMetadata } from '@nestjs/common';
import type { Action, Subject } from '@grc/shared';

export const REQUIRES_KEY = 'grc:requires';

export interface Requirement {
  subject: Subject | string;
  action: Action | string;
  own?: boolean;
}

export function Requires(
  subject: Subject | string,
  action: Action | string,
  options?: { own?: boolean },
): MethodDecorator & ClassDecorator {
  const requirement: Requirement = options?.own === true ? { subject, action, own: true } : { subject, action };
  return SetMetadata(REQUIRES_KEY, requirement);
}
