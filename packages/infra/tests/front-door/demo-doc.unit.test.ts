// M0-016 criterion 7 (D114, D115): docs/demo/m0.md lists the click-through steps the user follows
// (and records, D115) at https://grc.localhost, and says where the demo logins come from
// (`pnpm seed:demo`). The demo password lives only in `.env` (DEMO_USER_PASSWORD), never in the doc.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers.js';

const DOC = join(ROOT, 'docs', 'demo', 'm0.md');

function doc(): string {
  if (!existsSync(DOC)) throw new Error(`missing ${DOC}`);
  return readFileSync(DOC, 'utf8');
}

/** The numbered steps (`1. …`), in order. */
function steps(): string[] {
  return doc()
    .split('\n')
    .filter((l) => /^\s*\d+\.\s+\S/.test(l))
    .map((l) => l.trim());
}

/** DEMO_USER_PASSWORD from the environment, else the nearest `.env` from the repo root up. */
function demoPassword(): string {
  if (process.env.DEMO_USER_PASSWORD) return process.env.DEMO_USER_PASSWORD;
  for (let dir = ROOT; ; dir = dirname(dir)) {
    const envFile = join(dir, '.env');
    if (existsSync(envFile)) {
      const line = readFileSync(envFile, 'utf8')
        .split('\n')
        .find((l) => /^\s*DEMO_USER_PASSWORD\s*=/.test(l));
      const value = (line?.split('=').slice(1).join('=') ?? '').trim().replace(/^['"]|['"]$/g, '');
      if (value) return value;
    }
    if (dirname(dir) === dir) return '';
  }
}

describe('criterion 7: the written M0 demo steps (docs/demo/m0.md)', () => {
  it('exists', () => {
    expect(existsSync(DOC)).toBe(true);
  });

  it('says the demo logins come from `pnpm seed:demo`', () => {
    expect(doc()).toContain('pnpm seed:demo');
  });

  it('says the demo password is the DEMO_USER_PASSWORD value in .env', () => {
    expect(doc()).toContain('DEMO_USER_PASSWORD');
  });

  it('opens the app at https://grc.localhost', () => {
    expect(doc()).toContain('https://grc.localhost');
  });

  it('has numbered click-through steps', () => {
    expect(steps().length).toBeGreaterThanOrEqual(6);
  });

  it('walks through sign-in, MFA set-up, the shell, sign-out and the second org, in that order', () => {
    const text = steps().join('\n').toLowerCase();
    const at = (re: RegExp): number => {
      const m = re.exec(text);
      return m ? m.index : -1;
    };
    const signIn = at(/sign in/);
    const mfa = at(/(two-factor|mfa|authenticator)/);
    const shell = at(/(acme corp|org name|header)/);
    const signOut = at(/sign out/);
    const secondOrg = at(/globex/);
    for (const [name, i] of Object.entries({ signIn, mfa, shell, signOut, secondOrg })) {
      expect(i, `no step mentions ${name}`).toBeGreaterThanOrEqual(0);
    }
    expect(signIn).toBeLessThan(mfa);
    expect(mfa).toBeLessThan(signOut);
    expect(shell).toBeLessThan(signOut);
    expect(signOut).toBeLessThan(secondOrg);
  });

  it('names demo logins from both seeded orgs (acme.example and globex.example)', () => {
    expect(doc()).toMatch(/@acme\.example/);
    expect(doc()).toMatch(/@globex\.example/);
  });

  it('never holds the demo password itself', () => {
    const text = doc();
    const pw = demoPassword();
    // Without a DEMO_USER_PASSWORD there is nothing to leak; the other checks still apply.
    if (pw.length >= 12) expect(text.includes(pw)).toBe(false);
  });
});
