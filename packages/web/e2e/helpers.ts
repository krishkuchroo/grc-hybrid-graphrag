// M0-016: helpers for the end-to-end sign-in through the front door (D60, D54, D114).
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ORIGIN = 'https://grc.localhost';

/** The two demo users the e2e run signs in as. `pnpm seed:demo` creates them (M0-014). Each run
 * clears their two-factor set-up first, so the demo walkthrough should use other logins. */
export const ACME_USER = { email: 'viewer@acme.example', name: 'Viewer (Acme Corp)', org: 'Acme Corp', role: 'Viewer' };
export const GLOBEX_USER = {
  email: 'viewer@globex.example',
  name: 'Viewer (Globex Ltd)',
  org: 'Globex Ltd',
  role: 'Viewer',
};

/** DEMO_USER_PASSWORD from the environment, else the nearest `.env` from here up (never printed). */
export function demoPassword(): string {
  if (process.env.DEMO_USER_PASSWORD) return process.env.DEMO_USER_PASSWORD;
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      const line = readFileSync(file, 'utf8')
        .split('\n')
        .find((l) => /^\s*DEMO_USER_PASSWORD\s*=/.test(l));
      const value = (line?.split('=').slice(1).join('=') ?? '').trim().replace(/^['"]|['"]$/g, '');
      if (value) return value;
    }
    if (dirname(dir) === dir) break;
  }
  throw new Error(
    'DEMO_USER_PASSWORD is not set (environment or .env). Run `pnpm setup:secrets` and `pnpm seed:demo`.',
  );
}

/**
 * Clears one demo user's two-factor set-up and sessions in the stack's own database, so the run
 * starts from "no MFA yet" every time (MFA can't be turned off through the app, D49). Runs psql in
 * grc-postgres; the email goes in as a psql variable, never spliced into the SQL.
 */
export function resetMfa(email: string): void {
  const sql = [
    `DELETE FROM "two_factor" WHERE user_id IN (SELECT id FROM "user" WHERE email = :'email');`,
    `DELETE FROM "session" WHERE user_id IN (SELECT id FROM "user" WHERE email = :'email');`,
    `UPDATE "user" SET two_factor_enabled = false WHERE email = :'email';`,
    `SELECT count(*) FROM "user" WHERE email = :'email';`,
  ].join('\n');
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  if (process.env.DOCKER_CONFIG) env.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      'grc-postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'grc',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-v',
      `email=${email}`,
      '-f',
      '-',
    ],
    { env, input: sql, encoding: 'utf8', timeout: 20_000 },
  );
  if (r.status !== 0) {
    throw new Error(`could not reset MFA for ${email} in grc-postgres: ${(r.stderr ?? '').trim() || String(r.error)}`);
  }
  const lines = (r.stdout ?? '').trim().split('\n');
  if (lines[lines.length - 1] !== '1') {
    throw new Error(`demo user ${email} not found; run \`pnpm seed:demo\` against the stack first`);
  }
}

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('the TOTP secret is not base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The current code for an otpauth:// URI (RFC 6238), as an authenticator app would show it. */
export function totpNow(uri: string, at = Date.now()): string {
  const url = new URL(uri);
  const secret = url.searchParams.get('secret');
  if (!secret) throw new Error('the otpauth URI has no secret');
  const digits = Number(url.searchParams.get('digits') ?? 6);
  const period = Number(url.searchParams.get('period') ?? 30);
  const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toLowerCase().replace('-', '');
  const counter = Math.floor(at / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, '0');
}
