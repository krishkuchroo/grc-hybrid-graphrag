// The signed-in person as the API reports it (GET /api/v1/me), shared by the router and the shell.
import type { QueryClient } from '@tanstack/react-query';
import { api, ApiError, type GetMeResponse } from '@/api/client';

export type Me = GetMeResponse;

export const ME_KEY = ['me'] as const;

/** Asks the API who is signed in, every time (never from cache): this is how an ended session shows. */
export function fetchMe(queryClient: QueryClient): Promise<Me> {
  return queryClient.fetchQuery({ queryKey: ME_KEY, queryFn: api.getMe, staleTime: 0 });
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** `risk_manager` → `Risk manager`. */
export function formatRole(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

/** The words to show for a refused request. */
export function problemText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Try again.';
}
