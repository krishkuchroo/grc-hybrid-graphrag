// Dev auto-login, the web app's side (D264, D265). With `DEV_AUTO_LOGIN` set for the API on this
// Mac, the app signs that account in by itself, shows a banner on every screen, and lets the person
// pause it by signing out. The API decides everything: the web never assumes the switch is on.
// - On start, one GET /api/v1/auth/dev-auto-login asks whether the switch is on. It is asked once
//   for the page's life: the answer is kept per query client, so the cache clears on sign-out and
//   on an ended session ask nothing again. An error, or anything but `{ on: true }`, is off, and
//   then nothing here shows or changes anything.
// - The banner sits at the top of the shell and of the sign-in frame while the switch is on. It has
//   an icon and words (never colour alone), is a status region and can't be dismissed.
// - On the sign-in page, with the switch on and not paused, the app first asks /me: a person already
//   signed in goes Home and nothing is sent. Only with no session (a 401, or the MFA-pending
//   refusal) does it send the POST, once. The route has no OpenAPI entry, so it isn't in the
//   generated client: `@/api/dev-auto-login` calls it the way the client calls /api/v1/auth/*
//   (same-origin credentials, a JSON body of `{}`). On 200 it asks
//   /me again and goes Home, as a normal sign-in does once its checks pass. The session the API
//   makes has already passed MFA, so the MFA pages are skipped. Any failure, including a POST that
//   answers 200 but leaves no session, shows the password form with one line and is not retried
//   on its own for the rest of the page's life.
// - Signing out (the shell's Sign out, and MFA set-up's) pauses auto-login in that tab: sessionStorage
//   `warrant.devAutoLogin = 'paused'`, plus the same in memory in case the browser refuses storage.
//   Closing the tab ends the pause. A session that ends by the idle or 12-hour limit doesn't pause
//   it. While paused, the sign-in page offers "Sign in as the dev account", which clears the pause
//   and signs in as above.
// The words for these screens are kept here, with the auth screens.
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ShieldOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api/client';
import { getDevAutoLogin, postDevAutoLogin } from '@/api/dev-auto-login';
import { fetchMe, isUnauthorized, ME_KEY } from '@/features/auth/session';
import { cn } from '@/lib/utils';

export const DEV_AUTO_LOGIN_KEY = ['auth', 'dev-auto-login'] as const;

/** The tab's pause (D265): set by Sign out, cleared by "Sign in as the dev account". */
export const DEV_AUTO_LOGIN_STORAGE_KEY = 'warrant.devAutoLogin';
const PAUSED = 'paused';

export const DEV_AUTO_LOGIN_TEXT = {
  banner: 'Dev auto-login on. This Mac signs in without a password or MFA.',
  failed: "Dev auto-login didn't work. Sign in with your password.",
  signInAsDev: 'Sign in as the dev account',
  signingIn: 'Signing in as the dev account…',
} as const;

/** What the app keeps for the page's life, per query client (each mount of the app builds one). */
interface PageState {
  probe: Promise<boolean> | null;
  /** Sign out paused auto-login; kept here too in case sessionStorage refuses the write. */
  paused: boolean;
  /** An automatic sign-in failed: no further automatic try until the button is pressed. */
  autoFailed: boolean;
}

const pageStates = new WeakMap<QueryClient, PageState>();

function pageState(client: QueryClient): PageState {
  let state = pageStates.get(client);
  if (!state) {
    state = { probe: null, paused: false, autoFailed: false };
    pageStates.set(client, state);
  }
  return state;
}

/** True only for the API's `{ on: true }`; anything else, an error included, is off. */
async function askSwitch(): Promise<boolean> {
  try {
    return (await getDevAutoLogin()).on;
  } catch {
    return false;
  }
}

function probeOnce(client: QueryClient): Promise<boolean> {
  const state = pageState(client);
  state.probe ??= askSwitch();
  return state.probe;
}

function switchQuery(client: QueryClient) {
  return {
    queryKey: DEV_AUTO_LOGIN_KEY,
    queryFn: () => probeOnce(client),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  } as const;
}

/** Asks the switch as the app starts, so the first screen usually has the answer. */
export function startDevAutoLoginCheck(client: QueryClient): void {
  void client.prefetchQuery(switchQuery(client));
}

/** Whether the switch is on, as the API answered (false until it has, and on any error). */
export function useDevAutoLoginOn(): boolean {
  const client = useQueryClient();
  const { data } = useQuery(switchQuery(client));
  return data === true;
}

function storedPause(): boolean {
  try {
    return window.sessionStorage.getItem(DEV_AUTO_LOGIN_STORAGE_KEY) === PAUSED;
  } catch {
    return false;
  }
}

function isPaused(client: QueryClient): boolean {
  return pageState(client).paused || storedPause();
}

/** Sign out's part: pauses auto-login in this tab. The shell calls it only while the switch is on. */
export function pauseDevAutoLogin(client: QueryClient): void {
  pageState(client).paused = true;
  try {
    window.sessionStorage.setItem(DEV_AUTO_LOGIN_STORAGE_KEY, PAUSED);
  } catch {
    // The memory copy above still holds the pause for this page.
  }
}

function clearPause(client: QueryClient): void {
  pageState(client).paused = false;
  try {
    window.sessionStorage.removeItem(DEV_AUTO_LOGIN_STORAGE_KEY);
  } catch {
    // Nothing stored to clear.
  }
}

/**
 * Whether this browser already has a session, asked fresh from /me. A 401, or the MFA-pending
 * refusal, means none; any other failure is thrown, so nothing is sent and the form shows its line.
 */
async function hasSession(client: QueryClient): Promise<boolean> {
  try {
    await fetchMe(client);
    return true;
  } catch (err) {
    if (isUnauthorized(err) || (err instanceof ApiError && err.code === 'mfa_required')) {
      client.removeQueries({ queryKey: ME_KEY });
      return false;
    }
    throw err;
  }
}

export interface DevAutoSignIn {
  /** The POST is on its way, or it worked and the app is moving on. */
  signingIn: boolean;
  /** The last try failed: show the password form with the one line. */
  failed: boolean;
  /** Sign out paused auto-login in this tab: offer the button. */
  paused: boolean;
  /** The button: clears the pause and signs in. */
  signInAsDev: () => void;
}

/** The sign-in page's part. With the switch off, every field is false and nothing is sent. */
export function useDevAutoSignIn(): DevAutoSignIn {
  const client = useQueryClient();
  const navigate = useNavigate();
  const on = useDevAutoLoginOn();
  const [paused, setPaused] = useState(() => isPaused(client));
  const [failed, setFailed] = useState(() => pageState(client).autoFailed);
  // One POST per visit to the page (StrictMode runs effects twice in development).
  const sent = useRef(false);

  const signIn = useMutation({
    mutationFn: async () => {
      // Only with no session (D264): a person already signed in goes Home and nothing is sent, so
      // their session isn't replaced by the dev account's.
      if (await hasSession(client)) return;
      await postDevAutoLogin();
      // As after a normal sign-in: forget the old answer and ask who is signed in now. A 200 that
      // leaves no session (no cookie) fails here, so it can't bounce between sign-in and Home.
      client.removeQueries({ queryKey: ME_KEY });
      await fetchMe(client);
    },
    onSuccess: async () => {
      await navigate({ to: '/' });
    },
    onError: () => {
      pageState(client).autoFailed = true;
      setFailed(true);
    },
  });
  const { mutate } = signIn;

  useEffect(() => {
    if (!on || paused || sent.current || pageState(client).autoFailed) return;
    sent.current = true;
    mutate();
  }, [on, paused, client, mutate]);

  function signInAsDev() {
    clearPause(client);
    pageState(client).autoFailed = false;
    setPaused(false);
    setFailed(false);
    sent.current = true;
    mutate();
  }

  return {
    signingIn: on && (signIn.isPending || signIn.isSuccess),
    failed: on && failed && !signIn.isPending && !signIn.isSuccess,
    paused: on && paused,
    signInAsDev,
  };
}

/**
 * The thin bar at the top of the shell and the sign-in frame while the switch is on; nothing when
 * it is off. `className` places it in its frame (a grid row, a column span).
 */
export function DevAutoLoginBanner({ className }: { className?: string }) {
  const on = useDevAutoLoginOn();
  if (!on) return null;
  return (
    <div
      role="status"
      className={cn(
        'border-warning-border bg-warning text-warning-foreground flex min-h-7 items-center justify-center gap-2 border-b px-4 py-1 text-xs leading-tight font-semibold',
        className,
      )}
    >
      <ShieldOff className="size-3.5 shrink-0" aria-hidden />
      <span>{DEV_AUTO_LOGIN_TEXT.banner}</span>
    </div>
  );
}
