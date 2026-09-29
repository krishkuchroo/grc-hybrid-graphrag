// S1-010 criterion 4 (D114, D115, D57, D201, D69, D204): docs/demo/s1.md gives the click-through
// steps for the S1 checkpoint demo at https://grc.localhost, says the logins come from
// `pnpm seed:demo`, and holds no password (the demo password lives only in `.env`, as
// DEMO_USER_PASSWORD). Same shape as the M0 demo-doc test (front-door/demo-doc.unit.test.ts).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../front-door/helpers.js';

const DOC = join(ROOT, 'docs', 'demo', 's1.md');

function doc(): string {
  if (!existsSync(DOC)) throw new Error(`missing ${DOC}`);
  return readFileSync(DOC, 'utf8');
}

/** The numbered steps (`1. …`), lower-cased and joined. */
function steps(): string {
  return doc()
    .split('\n')
    .filter((l) => /^\s*\d+\.\s+\S/.test(l))
    .map((l) => l.trim().toLowerCase())
    .join('\n');
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

describe('criterion 4: the written S1 demo steps (docs/demo/s1.md)', () => {
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

  it('names the demo logins the steps use, from both orgs', () => {
    const text = doc();
    for (const login of ['risk.manager@acme.example', 'control.owner@acme.example', 'viewer@acme.example']) {
      expect(text, `no step names ${login}`).toContain(login);
    }
    expect(text).toMatch(/@globex\.example/);
  });

  it('has numbered click-through steps', () => {
    expect(steps().split('\n').length).toBeGreaterThanOrEqual(9);
  });

  const journeys: [string, RegExp[]][] = [
    ["the Risk Manager's register, rating and filters", [/risk manager/, /risk register/, /rating/, /filter/]],
    ['creating a risk and linking a control', [/(new risk|create)/, /add link/, /control/]],
    ['removing a link added by mistake (D201)', [/remove/, /link/]],
    ['the stale-save message in two tabs (D69)', [/tab/, /changed since you opened it/]],
    ["the Control Owner's own controls", [/control owner/, /(own|their) controls/]],
    ["the Viewer's read-only screens", [/viewer/, /(read-only|no edit|without an? edit|can['’]t edit|cannot edit)/]],
    ['a low-clearance user missing a restricted risk', [/restricted/, /clearance/]],
    ['the other org seeing none of it', [/globex/, /(doesn['’]t exist or you can['’]t see it|not found)/]],
    ["an asset's dependency map (D204)", [/dependency map/, /asset/]],
  ];

  for (const [journey, patterns] of journeys) {
    it(`has steps for ${journey}`, () => {
      const text = steps();
      for (const re of patterns) expect(text, `no numbered step matches ${re}`).toMatch(re);
    });
  }

  it('never holds the demo password itself', () => {
    const text = doc();
    const pw = demoPassword();
    // Without a DEMO_USER_PASSWORD there is nothing to leak; the other checks still apply.
    if (pw.length >= 12) expect(text.includes(pw)).toBe(false);
  });

  it('writes out no password value (no "password: <value>" line)', () => {
    // "Password: the `DEMO_USER_PASSWORD` value from .env" is fine; a literal value isn't.
    expect(doc()).not.toMatch(/password\s*[:=]\s*[`'"]?(?!DEMO_USER_PASSWORD)[^\s`'"]{8,}/i);
  });
});
