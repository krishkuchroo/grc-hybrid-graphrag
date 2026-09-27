// `@Requires(subject, action)`: what a route needs from the D50 table. `AccessGuard` reads it.
import { SetMetadata } from '@nestjs/common';
import type { Action, Subject } from '@grc/shared';

export const REQUIRES_KEY = 'grc:requires';

export interface Requirement {
  subject: Subject | string;
  action: Action | string;
}

export function Requires(subject: Subject | string, action: Action | string): MethodDecorator & ClassDecorator {
  const requirement: Requirement = { subject, action };
  return SetMetadata(REQUIRES_KEY, requirement);
}
