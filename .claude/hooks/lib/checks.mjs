// Runs the finish checks (D97): lint, type checks and tests.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from './git.mjs';
import { PROJECT_DIR, realish } from './paths.mjs';
import { parseCommand } from './shell.mjs';
import { isTestPath } from './testfiles.mjs';

export const LIMITS_MS = {
  lint: 10 * 60_000,
  typecheck: 10 * 60_000,
  tests: 20 * 60_000,
  fullSuite: 30 * 60_000,
};

// A builder's tests run this many times, and must pass every time (D171).
export const BUILDER_RUNS = 3;

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

// Summary lines: Vitest's "Tests  2 failed | 10 passed | 1 skipped (13)"
// (one per package under `pnpm -r`) and Playwright's "  2 failed" lines.
// Vitest's "Test Files" line counts files, not tests, so it's left out.
const SUMMARY_LINE = /^\s*(?:Tests\s|\d+\s+(?:failed|passed|skipped|flaky|did not run)\b)/i;

// How many tests had `word` (failed, skipped, todo…), summed over every
// summary in the output; null if the output shows no such count.
export function summaryCount(output, word) {
  let total = null;
  const re = new RegExp(`(\\d+)\\s+${word}\\b`, 'i');
  for (const line of String(output ?? '').split('\n')) {
    if (!SUMMARY_LINE.test(line)) continue;
    const m = re.exec(line);
    if (m) total = (total ?? 0) + Number(m[1]);
  }
  return total;
}

// How many tests failed; null if the output shows no summary (the tests
// didn't run).
export const failedCount = (output) => summaryCount(output, 'failed');

// Skipped tests, "todo" ones included (D173).
export const skippedCount = (output) => (summaryCount(output, 'skipped') ?? 0) + (summaryCount(output, 'todo') ?? 0);

// A skipped test fails the check unless the hand-off lists it, with a
// reason for the reviewers to approve (D173).
function skipFailure(output, handoff, label) {
  const skipped = skippedCount(output);
  if (!skipped || handoff.skips.length >= skipped) return null;
  return {
    label,
    message: `${skipped} test(s) were skipped, and the hand-off lists ${handoff.skips.length}. A skipped test counts as a failure (D173): make it run, or list each one in the hand-off's \`skips\` as {"test": "...", "reason": "..."} for the reviewers to approve.`,
    output,
  };
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
    /^test:[\w:-]+$/.test(sub) ||
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
    if (scripts.test) {
      const r = step('full suite', ['pnpm', 'test'], LIMITS_MS.fullSuite);
      const skip = r.ok && skipFailure(r.output, handoff, 'full suite');
      if (skip) failures.push(skip);
    } else lines.push('full suite: skipped (no test script yet)');
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
  const shown = `\`${argv.join(' ')}\``;
  if (finishCheck === 'test-writer' && handoff.fixReason) {
    // A fix to tests the builder's code already meets: green, not red (D167).
    const r = run(argv, repo, LIMITS_MS.tests);
    lines.push(`tests: ${r.ok ? 'pass' : r.timedOut ? 'timed out' : 'fail'} (${shown}; a fix, so they should pass, D167)`);
    if (!r.ok) failures.push({ label: 'tests', message: 'a fix should leave the tests passing against the code on the branch (D167)', output: r.output });
    else {
      const skip = skipFailure(r.output, handoff, 'tests');
      if (skip) failures.push(skip);
    }
    return { ok: failures.length === 0, lines, failures };
  }
  if (finishCheck === 'test-writer') {
    const r = run(argv, repo, LIMITS_MS.tests);
    const failed = failedCount(r.output);
    if (r.ok) {
      lines.push(`tests: pass (${shown}), but they should fail before the code exists`);
      failures.push({ label: 'tests', message: 'your new tests pass, but they should fail until the code exists (red). If the code is already on the branch and you corrected a test, hand in with `fixReason` (D167)', output: r.output });
    } else if (!failed) {
      lines.push(`tests: didn't report failing tests (${shown})`);
      failures.push({ label: 'tests', message: "the test run didn't report any failing tests; check that the command finds your new tests", output: r.output });
    } else {
      lines.push(`tests: red as expected, ${failed} failing (${shown})`);
      const skip = skipFailure(r.output, handoff, 'tests');
      if (skip) failures.push(skip);
    }
    return { ok: failures.length === 0, lines, failures };
  }
  // Builders: the task's tests pass BUILDER_RUNS times in a row (D171).
  for (let k = 1; k <= BUILDER_RUNS; k += 1) {
    const r = run(argv, repo, LIMITS_MS.tests);
    lines.push(`tests run ${k} of ${BUILDER_RUNS}: ${r.ok ? 'pass' : r.timedOut ? 'timed out' : 'fail'} (${shown})`);
    if (!r.ok) {
      const message = r.timedOut
        ? 'the tests took too long and were stopped'
        : k > 1
          ? `the tests passed ${k - 1} time(s), then failed on run ${k}: a flaky test is a bug (D171). If the test is at fault, hand in "blocked" with testProblem, so it goes back to the test writer; if your code is, fix it`
          : "the task's tests fail";
      failures.push({ label: 'tests', message, output: r.output });
      break;
    }
    if (k === 1) {
      const skip = skipFailure(r.output, handoff, 'tests');
      if (skip) {
        failures.push(skip);
        break;
      }
    }
  }
  return { ok: failures.length === 0, lines, failures };
}

// Before a test writer or builder's checks run: is it in its task's own
// copy of the code (D168)? null if so, or the problem.
export function placeProblem(handoff, repo, git = runGit) {
  if (realish(repo) === realish(PROJECT_DIR)) {
    return `you're in the main checkout, not your task's worktree, so the checks would test the wrong code (D168). Work in your own worktree on task/${handoff.taskId}, then hand in again`;
  }
  const branch = `task/${handoff.taskId}`;
  let tip = '';
  try {
    tip = git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).trim();
  } catch {}
  if (!tip) return `there's no branch ${branch}, so the checks can't tell they're testing your task (D168). Commit your work there, then hand in again`;
  try {
    git(repo, ['merge-base', '--is-ancestor', tip, 'HEAD']);
  } catch {
    return `your checkout doesn't hold the tip of ${branch}, so the checks would test the wrong code (D168). Switch to it (\`git switch --detach ${branch}\` after committing), then hand in again`;
  }
  return null;
}

// A test writer's fix (D167) is allowed when the builder's code is
// already on the branch and, since the newest commit that touched code,
// only test files changed (committed or not). It reads the branch itself,
// not the agent's start snapshot, so a resumed test writer isn't blamed
// for the builder's commit.
export function fixProblems(input, handoff, repo, git = runGit) {
  const list = (text) => text.split('\0').filter(Boolean);
  let commits = [];
  try {
    commits = git(repo, ['rev-list', 'refs/heads/main..HEAD']).split('\n').filter(Boolean);
  } catch {}
  const code = commits.find((c) => {
    try {
      return list(git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', c])).some((p) => !isTestPath(p));
    } catch {
      return false;
    }
  });
  if (!code) {
    // A correction to tests that already exist on main, whose code is
    // merged (D185): every changed file is an existing test file.
    // Compared from where the branch left main, so main's later commits
    // aren't counted as the test writer's.
    const changed = new Set();
    try {
      const base = git(repo, ['merge-base', 'HEAD', 'refs/heads/main']).trim();
      list(git(repo, ['diff', '--name-only', '-z', base])).forEach((p) => changed.add(p));
      list(git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).forEach((p) => changed.add(p));
    } catch {}
    const onMain = (p) => {
      try {
        git(repo, ['cat-file', '-e', `refs/heads/main:${p}`]);
        return true;
      } catch {
        return false;
      }
    };
    const existing = changed.size > 0 && [...changed].every((p) => isTestPath(p) && onMain(p));
    return existing
      ? []
      : [`there's no builder code on task/${handoff.taskId}, and not every changed file is a test that already exists on main, so this isn't a fix: new tests must fail first (D167, D185). Drop \`fixReason\` and show them red`];
  }
  const since = new Set();
  try {
    list(git(repo, ['diff', '--name-only', '-z', code])).forEach((p) => since.add(p));
    list(git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).forEach((p) => since.add(p));
  } catch {}
  const mine = [...since].filter((p) => !isTestPath(p));
  return mine.length ? [`a fix may change test files only (D167); since the builder's commit these changed too: ${mine.join(', ')}`] : [];
}
