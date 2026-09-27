// Runs the finish checks (D97): lint, type checks and tests.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCommand } from './shell.mjs';

export const LIMITS_MS = {
  lint: 10 * 60_000,
  typecheck: 10 * 60_000,
  tests: 20 * 60_000,
  fullSuite: 30 * 60_000,
};

// null when there's no package.json yet: no code, so no checks (D97).
export function packageScripts(repo) {
  try {
    return JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts ?? {};
  } catch {
    return null;
  }
}

export function runCommand(argv, cwd, timeoutMs) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal)) {
    return { ok: false, timedOut: true, code: null, output };
  }
  if (r.error) return { ok: false, code: null, output: `${output}${r.error.message}` };
  return { ok: r.status === 0, code: r.status, output };
}

export function tail(text, lines = 40, maxChars = 3000) {
  const out = String(text ?? '').trimEnd().split('\n').slice(-lines).join('\n');
  return out.length > maxChars ? out.slice(-maxChars) : out;
}

// How many tests failed, from Vitest's or Playwright's summary; null if the
// output shows no summary (the tests didn't run).
export function failedCount(output) {
  const m = /(\d+)\s+failed\b/i.exec(output);
  return m ? Number(m[1]) : null;
}

// The task's test command from the hand-off, as argv. The hook runs it with
// the user's permissions, so only a plain `pnpm` test run is accepted.
export function testCommandArgv(run) {
  if (typeof run !== 'string') return null;
  const text = run.trim().replace(/^`+|`+$/g, '');
  if (!text || text.length > 300) return null;
  const segments = parseCommand(text);
  if (segments.length !== 1 || segments[0].redirects.length) return null;
  const words = segments[0].words;
  if (!words.length || words.some((w) => w.dynamic)) return null;
  const argv = words.map((w) => w.value);
  if (argv[0] !== 'pnpm') return null;
  let k = 1;
  while (k < argv.length && argv[k].startsWith('-')) {
    k += ['--filter', '-F', '-C', '--dir'].includes(argv[k]) ? 2 : 1;
  }
  const sub = argv[k];
  const next = argv[k + 1] ?? '';
  const allowed =
    ['test', 't', 'vitest', 'playwright'].includes(sub) ||
    (sub === 'run' && /^test(?:[:-][\w:-]+)?$/.test(next)) ||
    (sub === 'exec' && ['vitest', 'playwright'].includes(next));
  return allowed ? argv : null;
}

// Runs the checks for a role. `run` is injectable for tests.
export function evaluate(finishCheck, handoff, repo, run = runCommand) {
  const scripts = packageScripts(repo);
  if (!scripts) return { ok: true, lines: ['checks skipped: no package.json yet, so no code (D97)'], failures: [] };
  const lines = [];
  const failures = [];
  const step = (label, argv, limit) => {
    const r = run(argv, repo, limit);
    lines.push(`${label}: ${r.ok ? 'pass' : r.timedOut ? 'timed out' : 'fail'}`);
    if (!r.ok) failures.push({ label, message: r.timedOut ? `${label} took too long and was stopped` : `${label} failed`, output: r.output });
    return r;
  };
  if (scripts.lint) step('lint', ['pnpm', 'lint'], LIMITS_MS.lint);
  else lines.push('lint: skipped (no lint script yet)');
  if (finishCheck !== 'test-writer') {
    if (scripts.typecheck) step('typecheck', ['pnpm', 'typecheck'], LIMITS_MS.typecheck);
    else lines.push('typecheck: skipped (no typecheck script yet)');
  }
  if (finishCheck === 'integrator') {
    if (scripts.test) step('full suite', ['pnpm', 'test'], LIMITS_MS.fullSuite);
    else lines.push('full suite: skipped (no test script yet)');
    return { ok: failures.length === 0, lines, failures };
  }
  const argv = testCommandArgv(handoff.tests.run);
  if (!argv) {
    lines.push('tests: not run');
    failures.push({
      label: 'tests',
      message: 'put the command that runs this task\'s tests in the hand-off\'s tests.run, as a pnpm test run such as "pnpm --filter api test -- records"',
    });
    return { ok: false, lines, failures };
  }
  const r = run(argv, repo, LIMITS_MS.tests);
  const shown = `\`${argv.join(' ')}\``;
  if (finishCheck === 'test-writer') {
    const failed = failedCount(r.output);
    if (r.ok) {
      lines.push(`tests: pass (${shown}), but they should fail before the code exists`);
      failures.push({ label: 'tests', message: 'your new tests pass, but they should fail until the code exists (red)', output: r.output });
    } else if (!failed) {
      lines.push(`tests: didn't report failing tests (${shown})`);
      failures.push({ label: 'tests', message: "the test run didn't report any failing tests; check that the command finds your new tests", output: r.output });
    } else {
      lines.push(`tests: red as expected, ${failed} failing (${shown})`);
    }
  } else {
    lines.push(`tests: ${r.ok ? 'pass' : r.timedOut ? 'timed out' : 'fail'} (${shown})`);
    if (!r.ok) failures.push({ label: 'tests', message: r.timedOut ? 'the tests took too long and were stopped' : "the task's tests fail", output: r.output });
  }
  return { ok: failures.length === 0, lines, failures };
}
