// Guard rail 7 (D89, D96), front gate: builders can't edit test files.
// Two ways to undo stay open: `git restore <path>` puts a test file back,
// and `rm` removes a test file the builder created itself (a scaffolding
// tool can generate them). Shell writes are caught best-effort here; the
// hand-in check (check-changed-files.mjs) is the backstop.
import { writeTargetsOf } from './lib/bash-writes.mjs';
import { createdSinceStart } from './lib/checkout.mjs';
import { repoRelative } from './lib/paths.mjs';
import { isBuilder } from './lib/roles.mjs';
import { isMain, runPreToolGuard } from './lib/run.mjs';
import { readState } from './lib/state.mjs';
import { isTestPath } from './lib/testfiles.mjs';

export const TEST_FILE_REASON =
  'test files belong to the test writer (D89). If a test looks wrong, explain why in your hand-off findings and it goes back to the test writer.';

export function decideTestFiles(input) {
  if (!isBuilder(input.agentType)) return null;
  let start;
  for (const t of writeTargetsOf(input)) {
    if (t.op === 'git-restore') continue;
    const rel = repoRelative(t.path, input.cwd);
    if (rel === null || !isTestPath(rel)) continue;
    if (t.op === 'delete') {
      start ??= readState(input.agentId, 'start');
      if (createdSinceStart(start, t.path)) continue;
    }
    return { reason: TEST_FILE_REASON, subject: rel };
  }
  return null;
}

if (isMain(import.meta.url)) {
  runPreToolGuard('7', decideTestFiles);
}
