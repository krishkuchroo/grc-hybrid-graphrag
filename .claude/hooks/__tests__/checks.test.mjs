import { ROOT, git, makeRepo, put } from './helpers.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BUILDER_RUNS, evaluate, failedCount, fixProblems, placeProblem, runCommand, skippedCount, testCommandArgv } from '../lib/checks.mjs';

test("accepts only plain pnpm test runs as the task's test command", () => {
  for (const ok of [
    'pnpm test',
    'pnpm --filter api test -- records',
    'pnpm -F web test',
    'pnpm run test:unit',
    'pnpm test:unit',
    'pnpm --filter api test:db -- records',
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

test('adds up the summaries of every package, and ignores the file counts', () => {
  const out = ' Test Files  1 failed | 2 passed (3)\n      Tests  2 failed | 10 passed | 1 skipped (13)\n' +
    ' Test Files  4 passed (4)\n      Tests  7 passed | 2 skipped | 1 todo (10)\nexpected 9 failed to equal 0';
  assert.equal(failedCount(out), 2);
  assert.equal(skippedCount(out), 4);
  assert.equal(skippedCount('  3 skipped\n  5 passed'), 3); // Playwright
  assert.equal(skippedCount('Tests  5 passed (5)'), 0);
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

const handoff = (run, extra = {}) => ({ taskId: 'S1-001', status: 'done', filesChanged: [], tests: { run, passed: null, failed: null }, findings: '', fixReason: '', skips: [], ...extra });

test('skips every check before any code exists (D97)', () => {
  const r = evaluate('builder', handoff('pnpm test'), packageWith(null), () => assert.fail('nothing should run'));
  assert.equal(r.ok, true);
});

test("a builder passes when lint, type checks and the task's tests pass", () => {
  const { run, calls } = fakeRun();
  assert.equal(evaluate('builder', handoff('pnpm --filter api test'), packageWith({ lint: 'x', typecheck: 'x', test: 'x' }), run).ok, true);
  assert.deepEqual(calls, ['pnpm lint', 'pnpm typecheck', ...Array(BUILDER_RUNS).fill('pnpm --filter api test')]); // 3 runs (D171)
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

test('a test that passes and then fails is flaky, and sends the builder back (D171)', () => {
  let n = 0;
  const run = (argv) => (argv[1] === 'test' ? ((n += 1), n === 2 ? { ok: false, code: 1, output: 'Tests  1 failed | 4 passed (5)' } : { ok: true, code: 0, output: '' }) : { ok: true, code: 0, output: '' });
  const r = evaluate('builder', handoff('pnpm test'), packageWith({}), run);
  assert.equal(r.ok, false);
  assert.equal(n, 2); // stops at the first failure
  assert.match(r.failures[0].message, /passed 1 time\(s\), then failed on run 2[\s\S]*flaky/);
});

test('a skipped test fails the check unless the hand-off lists it with a reason (D173)', () => {
  const pkg = packageWith({ test: 'x' });
  const skipped = { ok: true, code: 0, output: 'Tests  1 skipped | 4 passed (5)' };
  const run = () => skipped;
  const r = evaluate('builder', handoff('pnpm test'), pkg, run);
  assert.equal(r.ok, false);
  assert.match(r.failures[0].message, /1 test\(s\) were skipped[\s\S]*D173/);
  assert.equal(evaluate('builder', handoff('pnpm test', { skips: [{ test: 'x', reason: 'needs Gemma' }] }), pkg, run).ok, true);
  assert.equal(evaluate('integrator', handoff(''), pkg, run).ok, false);
  const red = () => ({ ok: false, code: 1, output: 'Tests  2 failed | 11 skipped (13)' }); // M0-010's nested beforeAll
  assert.equal(evaluate('test-writer', handoff('pnpm test'), pkg, red).ok, false);
});

test("a test writer's fix passes green instead of red (D167)", () => {
  const pkg = packageWith({ lint: 'x' });
  const green = () => ({ ok: true, code: 0, output: 'Tests  3 passed (3)' });
  assert.equal(evaluate('test-writer', handoff('pnpm test', { fixReason: 'contradicted M0-010' }), pkg, green).ok, true);
  const red = (argv) => (argv[1] === 'test' ? { ok: false, code: 1, output: 'Tests  1 failed (1)' } : { ok: true, code: 0, output: '' });
  assert.match(evaluate('test-writer', handoff('pnpm test', { fixReason: 'x' }), pkg, red).failures[0].message, /should leave the tests passing/);
  assert.match(evaluate('test-writer', handoff('pnpm test'), pkg, green).failures[0].message, /fixReason/);
});

test('the checks run only in the task\'s own copy (D168)', () => {
  const h = handoff('pnpm test', { taskId: 'S1-009' });
  assert.match(placeProblem(h, process.env.CLAUDE_PROJECT_DIR, () => ''), /main checkout/);
  const other = packageWith({});
  assert.match(placeProblem(h, other, () => ''), /no branch task\/S1-009/);
  const noTip = (repo, args) => {
    if (args[0] === 'rev-parse') return 'abc123\n';
    throw new Error('not an ancestor');
  };
  assert.match(placeProblem(h, other, noTip), /doesn't hold the tip of task\/S1-009/);
  assert.equal(placeProblem(h, other, (repo, args) => (args[0] === 'rev-parse' ? 'abc123\n' : '')), null);
});

test('a fix needs builder code on the branch, and only test files after it (D167)', () => {
  const repo = makeRepo(undefined, { 'a.ts': 'a\n' });
  git(repo, 'switch', '-q', '-c', 'task/F1');
  put(repo, 'a.test.ts', 'the first tests\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'F1: tests');
  const fix = { taskId: 'F1', fixReason: 'x' };
  assert.match(fixProblems({}, fix, repo).join('\n'), /no builder code on task\/F1/);

  put(repo, 'b.ts', 'the builder\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'F1: code');
  put(repo, 'a.test.ts', 'the corrected test\n');
  git(repo, 'commit', '-qam', 'F1: fix');
  assert.deepEqual(fixProblems({}, fix, repo), []); // the builder's commit isn't the test writer's (resumed agents too)
  put(repo, 'b.ts', 'the test writer sneaks in code\n');
  assert.match(fixProblems({}, fix, repo).join('\n'), /test files only[\s\S]*b\.ts/);
});

test('a fix to tests that already exist on main is allowed without builder code on the branch (D185)', () => {
  const repo = makeRepo(undefined, { 'a.ts': 'a\n', 'a.test.ts': 'flaky\n' });
  git(repo, 'switch', '-q', '-c', 'task/F2');
  const fix = { taskId: 'F2', fixReason: 'flaky' };
  put(repo, 'a.test.ts', 'steady\n');
  git(repo, 'commit', '-qam', 'F2: steady');
  assert.deepEqual(fixProblems({}, fix, repo), []);
  git(repo, 'switch', '-q', 'main'); // main moves on after the branch left it
  put(repo, 'memory.md', 'a later decision\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'main moves on');
  git(repo, 'switch', '-q', 'task/F2');
  assert.deepEqual(fixProblems({}, fix, repo), []);
  put(repo, 'b.test.ts', 'a brand-new test\n'); // new tests must still go red first
  assert.match(fixProblems({}, fix, repo).join('\n'), /isn't a fix/);
});
