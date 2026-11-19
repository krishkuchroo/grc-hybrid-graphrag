// The dev auto-login route (D264), written by hand beside the generated client: the route has no
// OpenAPI entry, so `pnpm gen:api-client` doesn't make it (and doesn't overwrite this file). It is
// called the way the generated client calls /api/v1/auth/*: a relative address, same-origin
// credentials, JSON, and the API's one error format as an ApiError.
// - GET answers `{ on }` and changes nothing; it needs no session.
// - POST sends `{}` as JSON and answers 200 `{ ok: true }` with Better Auth's session cookie;
//   404 when the switch is off, 403 `forbidden` or `dev_auto_login_unavailable` when refused.
import { ApiError, type ApiErrorBody } from './client';

export const DEV_AUTO_LOGIN_PATH = '/api/v1/auth/dev-auto-login';

export interface GetDevAutoLoginResponse {
  on: boolean;
}

export interface PostDevAutoLoginResponse {
  ok: true;
}

async function call(method: 'GET' | 'POST'): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(DEV_AUTO_LOGIN_PATH, {
      method,
      credentials: 'same-origin',
      headers:
        method === 'POST'
          ? { accept: 'application/json', 'content-type': 'application/json' }
          : { accept: 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
    });
  } catch {
    throw new ApiError(0, 'network_error', 'The server could not be reached. Check your connection and try again.');
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const err = (data as Partial<ApiErrorBody> | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? 'The request was refused.', err?.referenceId);
  }
  return data;
}

/** Whether the switch is on. Only the API's `{ on: true }` counts as on. */
export async function getDevAutoLogin(): Promise<GetDevAutoLoginResponse> {
  const data = await call('GET');
  const on = typeof data === 'object' && data !== null && (data as { on?: unknown }).on === true;
  return { on };
}

/** Signs the dev account in; the session cookie comes back with the answer. */
export async function postDevAutoLogin(): Promise<PostDevAutoLoginResponse> {
  await call('POST');
  return { ok: true };
}
