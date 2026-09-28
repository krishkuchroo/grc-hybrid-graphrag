// The Better Auth routes the web app calls, in the OpenAPI document (D30), so the typed web client
// is generated from the same spec as every other route. The routes themselves are mounted by
// auth-routes.ts; these schemas describe what they take and return, not how they work.
import { z } from 'zod';
import { documentRoute } from '../common/openapi.js';

const authUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  twoFactorEnabled: z.boolean().optional(),
});

/** A new session: after a password alone (no MFA yet), or after a second factor. */
const sessionResponseSchema = z.object({
  token: z.string(),
  user: authUserSchema,
});

export const signInBodySchema = z.object({ email: z.string(), password: z.string() });
export const signInResponseSchema = z.union([z.object({ twoFactorRedirect: z.literal(true) }), sessionResponseSchema]);
export const enableTwoFactorBodySchema = z.object({ password: z.string() });
export const enableTwoFactorResponseSchema = z.object({ totpURI: z.string(), backupCodes: z.array(z.string()) });
export const codeBodySchema = z.object({ code: z.string() });

documentRoute({
  method: 'post',
  path: '/auth/sign-in/email',
  summary: 'Sign in with email and password; with MFA set up, the second factor comes next',
  body: signInBodySchema,
  response: signInResponseSchema,
});

documentRoute({
  method: 'post',
  path: '/auth/sign-out',
  summary: 'End the current session',
  body: z.object({}),
  response: z.object({ success: z.boolean() }),
});

documentRoute({
  method: 'post',
  path: '/auth/two-factor/enable',
  summary: 'Start MFA set-up: the authenticator URI and the backup codes, shown once',
  body: enableTwoFactorBodySchema,
  response: enableTwoFactorResponseSchema,
});

documentRoute({
  method: 'post',
  path: '/auth/two-factor/verify-totp',
  summary: 'Check a 6-digit authenticator code (finishes sign-in or MFA set-up)',
  body: codeBodySchema,
  response: sessionResponseSchema,
});

documentRoute({
  method: 'post',
  path: '/auth/two-factor/verify-backup-code',
  summary: 'Check a backup code instead of an authenticator code',
  body: codeBodySchema,
  response: sessionResponseSchema,
});
