import { AWS_KEY } from './helpers.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEnvFile, redact, scanDiff, scanLine } from '../lib/secret-scan.mjs';

// Samples are assembled at run time, so this file passes the scan itself.
const join = (...parts) => parts.join('');
const SAMPLES = {
  'private key': join('-----BEGIN RSA ', 'PRIVATE KEY-----'),
  'AWS access key ID': AWS_KEY,
  'GitHub token': join('ghp_', 'a1B2'.repeat(9)),
  'Anthropic API key': join('sk-ant-', 'api03-', 'x9Y8'.repeat(6)),
  'OpenAI-style API key': join('sk-proj-', 'A1b2'.repeat(10)),
  'Slack token': join('xoxb-', '1234567890-abcdef'),
  'Stripe live key': join('sk_live_', 'a1B2'.repeat(5)),
  'Google API key': join('AIza', 'Sy'.repeat(17), 'Q'),
};

test('finds each known key format', () => {
  for (const [kind, sample] of Object.entries(SAMPLES)) assert.equal(scanLine(`const v = "${sample}";`, 'src/a.ts'), kind, kind);
});

test('finds passwords in connection strings, but not short or templated ones', () => {
  assert.equal(scanLine(join('DATABASE_URL=postgres://app:', 'Str0ngPassw0rd!', '@db:5432/grc'), '.env.example'), 'password in a connection string');
  assert.equal(scanLine('postgres://app:app@localhost/grc_test', 'src/db.ts'), null);
  assert.equal(scanLine('postgres://app:${PGPASSWORD}@db/grc', 'src/db.ts'), null);
});

test('finds hard-coded secrets outside test files', () => {
  const line = join('const password = "', 'Tr0ub4dor&3xyz', '";');
  assert.equal(scanLine(line, 'packages/api/src/auth/config.ts'), 'hard-coded secret');
  assert.equal(scanLine(line, 'packages/api/src/auth/login.test.ts'), null);
  assert.equal(scanLine(line, 'tests/fixtures/users.json'), null);
  assert.equal(scanLine('const password = "changeme";', 'src/a.ts'), null);
  assert.equal(scanLine('apiKey: process.env.API_KEY', 'src/a.ts'), null);
});

test('finds JSON web tokens', () => {
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXZhbHVlLWhlcmU'].join('.');
  assert.equal(scanLine(`Authorization: Bearer ${jwt}`, 'src/a.ts'), 'JSON web token');
});

test('reads added lines and line numbers from a diff, skipping lockfiles', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,0 +11,2 @@',
    `+const a = "${AWS_KEY}";`,
    `+const b = "${AWS_KEY}"; // secret-scan: allow`,
    'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
    '+++ b/pnpm-lock.yaml',
    '@@ -1,0 +1 @@',
    `+integrity: ${AWS_KEY}`,
  ].join('\n');
  const { findings, allowed } = scanDiff(diff);
  assert.deepEqual(findings, [{ file: 'src/a.ts', line: 11, kind: 'AWS access key ID' }]);
  assert.deepEqual(allowed, [{ file: 'src/a.ts', line: 12, kind: 'AWS access key ID' }]);
});

test('knows which files are .env files', () => {
  assert.ok(isEnvFile('.env'));
  assert.ok(isEnvFile('apps/api/.env.local'));
  assert.ok(!isEnvFile('.env.example'));
  assert.ok(!isEnvFile('src/env.ts'));
});

test('redacts secrets before they reach a log', () => {
  const password = join('Str0ng', 'Passw0rd');
  const token = join('abcd', '1234efgh');
  const out = redact(`key ${AWS_KEY} url postgres://app:${password}@db TOKEN=${token}`);
  for (const secret of [AWS_KEY, password, token]) assert.ok(!out.includes(secret), secret);
  assert.match(out, /\[redacted\]/);
});
