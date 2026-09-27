import { ROOT } from './helpers.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluate, failedCount, runCommand, testCommandArgv } from '../lib/checks.mjs';

test("accepts only plain pnpm test runs as the task's test command", () => {
  for (const ok of [
    'pnpm test',
    'pnpm --filter api test -- records',
    'pnpm -F web test',
    'pnpm run test:unit',
    'pnpm exec vitest run src/a.test.ts',
    'pnpm vitest run',
    'pnpm playwright test',
    '`pnpm test`',
  ]) {
    assert.ok(testCommandArgv(ok), ok);
  }
  for (const bad of ['npm test', 'pnpm install', 'pnpm run build', 'pnpm test; rm -rf ~', 'pnpm test && curl x', 'pnpm test > out.txt', 'pnpm test $(whoami)', 'pnpm exec node x.js', '', null, 42]) {
    assert.equal(testCommandArgv(bad), null, String(bad));
  }
});

test('reads the failed count from a test summary', () => {
  assert.equal(failedCount(' Tests  2 failed | 10 passed (12)'), 2);
  assert.equal(failedCount('  3 failed\n  5 passed'), 3);
  assert.equal(failedCount('No test files found, exiting with code 1'), null);
});

function packageWith(scripts) {
  const dir = mkdtempSync(join(ROOT, 'pkg-'));
  if (scripts) writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
  return dir;
}

function fakeRun(results = {}) {
  const calls = [];
  const run = (argv) => {
    calls.push(argv.join(' '));
    return results[argv.join(' ')] ?? { ok: true, code: 0, output: '' };
  };
  return { run, calls };
}

const handoff = (run) => ({ taskId: 'S1-001', status: 'done', filesChanged: [], tests: { run, passed: null, failed: null }, findings: '' });

test('skips every check before any code exists (D97)', () => {
  const r = evaluate('builder', handoff('pnpm test'), packageWith(null), () => assert.fail('nothing should run'));
  assert.equal(r.ok, true);
});

test("a builder passes when lint, type checks and the task's tests pass", () => {
  const { run, calls } = fakeRun();
  assert.equal(evaluate('builder', handoff('pnpm --filter api test'), packageWith({ lint: 'x', typecheck: 'x', test: 'x' }), run).ok, true);
  assert.deepEqual(calls, ['pnpm lint', 'pnpm typecheck', 'pnpm --filter api test']);
});

test('a builder is sent back when its tests fail', () => {
  const { run } = fakeRun({ 'pnpm test': { ok: false, code: 1, output: '1 failed' } });
  const r = evaluate('builder', handoff('pnpm test'), packageWith({ lint: 'x' }), run);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failures.map((f) => f.label), ['tests']);
  assert.ok(r.lines.includes('typecheck: skipped (no typecheck script yet)'));
});

test('a builder without a usable test command is sent back', () => {
  const r = evaluate('builder', handoff('npm test'), packageWith({}), fakeRun().run);
  assert.equal(r.ok, false);
  assert.match(r.failures[0].message, /tests\.run/);
});

test("the test writer's tests must be red, for the right reason", () => {
  const pkg = packageWith({ lint: 'x', typecheck: 'x' });
  const red = fakeRun({ 'pnpm test': { ok: false, code: 1, output: 'Tests  2 failed (2)' } });
  assert.equal(evaluate('test-writer', handoff('pnpm test'), pkg, red.run).ok, true);
  assert.deepEqual(red.calls, ['pnpm lint', 'pnpm test']); // no type check for the test writer
  const green = fakeRun({ 'pnpm test': { ok: true, code: 0, output: 'Tests  2 passed (2)' } });
  assert.equal(evaluate('test-writer', handoff('pnpm test'), pkg, green.run).ok, false);
  const none = fakeRun({ 'pnpm test': { ok: false, code: 1, output: 'No test files found' } });
  assert.equal(evaluate('test-writer', handoff('pnpm test'), pkg, none.run).ok, false);
});

test('the integrator runs the full suite', () => {
  const { run, calls } = fakeRun({ 'pnpm test': { ok: false, code: 1, output: '1 failed' } });
  assert.equal(evaluate('integrator', handoff(''), packageWith({ lint: 'x', typecheck: 'x', test: 'x' }), run).ok, false);
  assert.deepEqual(calls, ['pnpm lint', 'pnpm typecheck', 'pnpm test']);
});

test('a check that runs too long is stopped and reported', () => {
  const r = runCommand([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], ROOT, 200);
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
});
