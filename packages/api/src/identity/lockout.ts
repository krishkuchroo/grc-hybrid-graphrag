// The sign-in lock (D54): the 5th wrong password in a row locks the account for 15 minutes, and
// every attempt while locked is refused, even with the right password.
//
// The lock keys on the account (the email in lower case), never on the client address: behind
// Caddy many people share one address (M0-007 review, D64). Emails that belong to no account are
// counted the same way, so the lock never shows whether an email exists.
// The counters live in API memory in v1, like the rate-limit counters (D64). Time comes from the
// JavaScript clock.

export const MAX_FAILED_SIGN_INS = 5;
export const LOCK_MS = 15 * 60_000;
// Counters untouched for this long are dropped, so the map can't grow without end.
const FORGET_MS = 24 * 60 * 60_000;

interface Entry {
  failures: number;
  lockedUntil: number;
  lastSeen: number;
}

export type LockState = { locked: false } | { locked: true; retryAfterSeconds: number };

export function lockKey(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export class SignInLockout {
  private readonly entries = new Map<string, Entry>();
  private lastSweep = 0;

  // Read at each call, so a replaced clock (the tests' fake Date) is seen.
  constructor(private readonly now: () => number = () => Date.now()) {}

  state(key: string): LockState {
    const now = this.now();
    this.sweep(now);
    const entry = this.entries.get(key);
    if (!entry || entry.lockedUntil === 0) return { locked: false };
    if (entry.lockedUntil > now) {
      return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)) };
    }
    // The lock ran out: start counting afresh.
    this.entries.delete(key);
    return { locked: false };
  }

  /** Records a wrong password. True when this one locks the account. */
  fail(key: string): boolean {
    const now = this.now();
    const entry = this.entries.get(key) ?? { failures: 0, lockedUntil: 0, lastSeen: now };
    entry.failures++;
    entry.lastSeen = now;
    let lockedNow = false;
    if (entry.failures >= MAX_FAILED_SIGN_INS) {
      entry.lockedUntil = now + LOCK_MS;
      entry.failures = 0;
      lockedNow = true;
    }
    this.entries.set(key, entry);
    return lockedNow;
  }

  /** A right password ends the run of failures. */
  succeed(key: string): void {
    this.entries.delete(key);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil <= now && now - entry.lastSeen >= FORGET_MS) this.entries.delete(key);
    }
  }
}
