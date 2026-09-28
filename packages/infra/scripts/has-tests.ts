// Says whether any test file of the given kinds (D177) matches a Vitest filter, so the package
// `test*` scripts can skip a kind with no matching files quietly, without calling the doctor.
// Usage (from a package directory): node ../infra/scripts/has-tests.ts <unit|db|stack>... [--] [vitest args]
// Exit 0: at least one file matches. Exit 3: none match. Exit 1: the listing itself failed.
// It only lists file names (`vitest list --filesOnly`): no test file is imported or run.
import { spawnSync } from 'node:child_process';

const KINDS = new Set(['unit', 'db', 'stack']);
const NONE = 3;

const args = process.argv.slice(2);
const kinds: string[] = [];
while (args.length > 0 && KINDS.has(args[0] ?? '')) kinds.push(args.shift() ?? '');
if (args[0] === '--') args.shift();
if (kinds.length === 0) {
  console.error('has-tests: name at least one kind (unit, db or stack)');
  process.exit(1);
}

const list = spawnSync(
  'vitest',
  ['list', '--filesOnly', '--json', ...kinds.flatMap((k) => ['--project', k]), ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
if (list.error || list.status !== 0) {
  console.error(`has-tests: vitest list failed (${list.error?.message ?? `exit ${list.status}`})`);
  process.exit(1);
}

let files: unknown;
try {
  files = JSON.parse(list.stdout);
} catch {
  console.error('has-tests: vitest list did not print a JSON list');
  process.exit(1);
}
if (!Array.isArray(files)) {
  console.error('has-tests: vitest list did not print a JSON list');
  process.exit(1);
}
process.exit(files.length > 0 ? 0 : NONE);
