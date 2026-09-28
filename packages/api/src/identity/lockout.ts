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
  // Attempts whose password check hasn't finished yet. They count against the limit, so guesses
  // sent at the same time can't slip past it (M0-010 security review).
  pending: number;
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

  /**
   * Reserves a slot for one attempt, before the password is checked. Refused while the account is
   * locked, or while the failures so far plus the attempts still being checked already reach the
   * limit. A granted slot must be settled with `fail` or `succeed`.
   */
  begin(key: string): LockState {
    const now = this.now();
    this.sweep(now);
    const entry = this.entries.get(key) ?? { failures: 0, pending: 0, lockedUntil: 0, lastSeen: now };
    if (entry.lockedUntil > now) {
      return { locked: true, retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntil - now) / 1000)) };
    }
    // The lock ran out: start counting afresh.
    if (entry.lockedUntil !== 0) {
      entry.lockedUntil = 0;
      entry.failures = 0;
    }
    entry.lastSeen = now;
    if (entry.failures + entry.pending >= MAX_FAILED_SIGN_INS) {
      this.entries.set(key, entry);
      return { locked: true, retryAfterSeconds: 1 };
    }
    entry.pending++;
    this.entries.set(key, entry);
    return { locked: false };
  }

  /** Settles a slot as a wrong password. True when this one locks the account. */
  fail(key: string): boolean {
    const now = this.now();
    const entry = this.entries.get(key) ?? { failures: 0, pending: 0, lockedUntil: 0, lastSeen: now };
    entry.pending = Math.max(0, entry.pending - 1);
    entry.failures++;
    entry.lastSeen = now;
    let lockedNow = false;
    if (entry.failures >= MAX_FAILED_SIGN_INS && entry.lockedUntil <= now) {
      entry.lockedUntil = now + LOCK_MS;
      entry.failures = 0;
      lockedNow = true;
    }
    this.entries.set(key, entry);
    return lockedNow;
  }

  /** Settles a slot as a right password, which ends the run of failures. */
  succeed(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.pending = Math.max(0, entry.pending - 1);
    entry.failures = 0;
    if (entry.pending === 0 && entry.lockedUntil === 0) this.entries.delete(key);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, entry] of this.entries) {
      if (entry.pending === 0 && entry.lockedUntil <= now && now - entry.lastSeen >= FORGET_MS) this.entries.delete(key);
    }
  }
}
