// Guard rail 5 (D84, D95, D107), front gate: agents don't edit CLAUDE.md,
// .claude/, skills.md or logs/, and only the planner edits memory.md and
// TASKS.md. Shell writes are caught best-effort here; the hand-in check
// (check-changed-files.mjs) is the backstop.
//
// `git restore <path>` of a protected file is allowed inside an agent's own
// worktree, so it can undo an accidental change. In the main checkout it
// could wipe the main session's unsaved edits, so it stays blocked there.
import { writeTargetsOf } from './lib/bash-writes.mjs';
import { PROJECT_DIR, gitTopLevel, isInHomeClaudeDir, nearestExistingDir, realish, repoRelative } from './lib/paths.mjs';
import { protectedReason } from './lib/protected.mjs';
import { isMain, runPreToolGuard } from './lib/run.mjs';

function inOwnWorktree(path) {
  const top = gitTopLevel(nearestExistingDir(path));
  return Boolean(top) && realish(top) !== realish(PROJECT_DIR);
}

export function decideProtected(input) {
  if (!input.agentId) return null;
  for (const t of writeTargetsOf(input)) {
    if (t.dynamic) {
      // Fail safe (D119): the real file can't be known, so it can't be checked.
      return { reason: "the file this writes is named at run time ($X, $(…) or `…`), so guard rails 5 and 7 can't check it (D119). Write the file name out.", subject: t.path };
    }
    if (isInHomeClaudeDir(t.path, input.cwd)) {
      return { reason: "agents don't edit Claude Code's own settings in ~/.claude (D95)", subject: t.path };
    }
    const rel = repoRelative(t.path, input.cwd);
    if (rel === null) continue;
    const reason = protectedReason(rel, input.agentType);
    if (!reason) continue;
    if (t.op === 'git-restore' && inOwnWorktree(t.path)) continue;
    return { reason, subject: rel };
  }
  return null;
}

if (isMain(import.meta.url)) {
  runPreToolGuard('5', decideProtected);
}
