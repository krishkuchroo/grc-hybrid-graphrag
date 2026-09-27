// Guard rails 7 and 5, backstop at hand-in (D89, D95, D104, D107):
// builders didn't change test files, and no agent changed files it can't
// edit, however the change was made. It compares the checkout with how it
// looked when the agent started (recorded by monitor-hook.mjs). The
// integrator is skipped: its merges bring in other agents' approved work.
import { changedSince } from './lib/checkout.mjs';
import { isHandInEvent, parseHandoff } from './lib/handoff.mjs';
import { appendTaskLog, logNotice, now, safeTaskId } from './lib/logging.mjs';
import { protectedReason } from './lib/protected.mjs';
import { isBuilder, roleOf } from './lib/roles.mjs';
import { isMain, runHandInGuard } from './lib/run.mjs';
import { agentKey, readState, writeState } from './lib/state.mjs';
import { isTestPath } from './lib/testfiles.mjs';

const list = (paths) => paths.map((p) => `  ${p}`).join('\n');

// null to let the agent finish, or { rule, reason, subject } to send it back.
export function decideChanged(input) {
  if (!input.agentId) return null;
  const role = roleOf(input.agentType);
  if (!role || role.pushes) return null;
  const handIn = isHandInEvent(input);
  if (!handIn && input.event !== 'SubagentStop') return null;

  const state = readState(input.agentId, 'changed') ?? { attempts: 0, cleared: false };
  if (!handIn && state.cleared) return null;
  const start = readState(input.agentId, 'start');
  if (!start?.repo) return null;

  const changed = changedSince(start, input.agentId);
  const tests = isBuilder(input.agentType) ? changed.filter(isTestPath) : [];
  const locked = changed.filter((p) => !tests.includes(p) && protectedReason(p, input.agentType));
  if (!tests.length && !locked.length) {
    writeState(input.agentId, 'changed', { ...state, cleared: true });
    return null;
  }
  const rule = tests.length ? '7' : '5';
  const subject = [...tests, ...locked].join(', ');
  const { handoff } = parseHandoff(input);
  if (handoff?.status === 'blocked' && handoff.findings) {
    // A blocked hand-in can always finish (D86), but what it touched is
    // recorded for the user.
    const taskId = safeTaskId(handoff.taskId, `unknown-${agentKey(input.agentId)}`);
    const lines = [`## Changed files it can't edit · ${input.agentType} · ${now()}`, `- agent: ${input.agentId}`];
    if (tests.length) lines.push(`- test files (D89):\n${list(tests)}`);
    if (locked.length) lines.push(`- protected files (D84, D95, D107):\n${list(locked)}`);
    appendTaskLog(taskId, lines.join('\n'));
    logNotice({ rule, input, reason: 'handed in "blocked" with these files changed; the user sorts them out', subject });
    writeState(input.agentId, 'changed', { ...state, cleared: true });
    return null;
  }
  writeState(input.agentId, 'changed', { attempts: state.attempts + 1, cleared: false });
  const parts = [];
  if (tests.length) {
    parts.push(
      `you changed test files, which belong to the test writer (D89):\n${list(tests)}\nPut them back with \`git restore <path>\`, or \`rm\` test files you created. If a test looks wrong, say why in your findings.`,
    );
  }
  if (locked.length) {
    parts.push(
      `you changed files agents can't edit (D84, D95, D107):\n${list(locked)}\nIn your own worktree, put them back with \`git restore <path>\`. In the main checkout, hand in with status "blocked" and name the files, so the main session can sort it out.`,
    );
  }
  return { rule, reason: parts.join('\n\n'), subject };
}

if (isMain(import.meta.url)) {
  runHandInGuard('5/7', decideChanged);
}
