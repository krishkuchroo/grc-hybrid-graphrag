// Guard rail 4 (D84, D86, D97): an agent can't finish until its checks pass.
// - Test writer: lint passes and its new tests fail; a fix to tests the
//   builder's code already meets passes instead (D167).
// - Builders: lint, type checks and the task's tests pass, 3 times (D171).
// - Integrator: lint, type checks and the full suite pass.
// - Test writers and builders are checked in their task's own copy (D168).
// - A skipped test fails unless the hand-off lists it with a reason (D173).
// - Planner and reviewers: no checks, but they still end with a hand-off.
// It runs when the agent hands in its report (the SubagentHandback or
// StructuredOutput tool) and again, as a backup, when the agent stops.
// A hand-off with status "blocked" and findings can always finish; after 3
// failed checks it's the only way to finish (D86).
import { evaluate, fixProblems, placeProblem, tail } from './lib/checks.mjs';
import { isHandInEvent, parseHandoff } from './lib/handoff.mjs';
import { appendTaskLog, now, safeTaskId } from './lib/logging.mjs';
import { gitTopLevel } from './lib/paths.mjs';
import { roleOf } from './lib/roles.mjs';
import { isMain, runHandInGuard } from './lib/run.mjs';
import { agentKey, readState, writeState } from './lib/state.mjs';

const RULE = '4';
export const MAX_FAILED_CHECKS = 3;

function logEntry(kind, input, lines) {
  return [`## ${kind} · ${input.agentType} · ${now()}`, `- agent: ${input.agentId}`, ...lines].join('\n');
}

// Where a test writer or builder is, and whether its fix is allowed
// (D167, D168): a list of problems, empty when the checks can run.
export function placeChecks(input, handoff, repo, role) {
  if (role.finishCheck !== 'test-writer' && role.finishCheck !== 'builder') return [];
  const where = placeProblem(handoff, repo);
  if (where) return [where];
  return role.finishCheck === 'test-writer' && handoff.fixReason ? fixProblems(input, handoff, repo) : [];
}

// null to let the agent finish, or { reason, subject } to send it back.
export function decideFinish(input, evaluateChecks = evaluate, checkPlace = placeChecks) {
  if (!input.agentId) return null;
  const role = roleOf(input.agentType);
  if (!role) return null;
  const handIn = isHandInEvent(input);
  if (!handIn && input.event !== 'SubagentStop') return null;

  const state = readState(input.agentId, 'finish') ?? { attempts: 0, handIns: 0, cleared: false };
  if (!handIn && state.cleared) return null; // it already passed when it handed in
  state.handIns += 1;
  const save = (extra) => writeState(input.agentId, 'finish', { ...state, ...extra });

  const { handoff, error } = parseHandoff(input);
  if (!handoff) {
    save({ cleared: false });
    return { reason: `end your report with the hand-off block described in CLAUDE.md ("Hand-off"): ${error}.` };
  }
  const taskId = safeTaskId(handoff.taskId, `unknown-${agentKey(input.agentId)}`);
  state.taskId = taskId;
  const common = [`- status: ${handoff.status}`];
  if (handoff.findings) common.push(`- findings: ${handoff.findings}`);

  if (handoff.status === 'blocked') {
    if (!handoff.findings) {
      save({ cleared: false });
      return { reason: "a blocked hand-off needs findings: say what you tried and what's blocking you (D86).", subject: taskId };
    }
    appendTaskLog(taskId, logEntry('Blocked', input, common));
    save({ cleared: true, blocked: true });
    return null;
  }

  if (role.finishCheck === 'none') {
    const kind = { 'sent-back': 'Sent back', approved: 'Approved' }[handoff.status] ?? 'Hand-off';
    appendTaskLog(taskId, logEntry(kind, input, common));
    save({ cleared: true });
    return null;
  }

  const repo = gitTopLevel(input.cwd) ?? input.cwd;
  const misplaced = checkPlace(input, handoff, repo, role);
  if (handoff.fixReason) common.push(`- fix (D167): ${handoff.fixReason}`);
  const result = misplaced.length
    ? { ok: false, lines: ['checks not run: see below'], failures: misplaced.map((message) => ({ label: 'place', message })) }
    : evaluateChecks(role.finishCheck, handoff, repo);
  const checkLines = result.lines.map((l) => `- ${l}`);
  if (result.ok) {
    appendTaskLog(taskId, logEntry(`Hand-in ${state.handIns}`, input, [...common, ...checkLines, '- result: checks passed']));
    save({ cleared: true });
    return null;
  }

  const attempt = state.attempts + 1;
  const excerpts = result.failures
    .filter((f) => f.output)
    .map((f) => `${f.label}:\n\`\`\`text\n${tail(f.output, 30, 2500)}\n\`\`\``);
  appendTaskLog(
    taskId,
    logEntry(`Hand-in ${state.handIns}`, input, [...common, ...checkLines, `- result: sent back (failed check ${attempt} of ${MAX_FAILED_CHECKS})`, ...excerpts]),
  );
  save({ attempts: attempt, cleared: false });

  const problems = result.failures.map((f) => `- ${f.message}`).join('\n');
  const detail = result.failures
    .filter((f) => f.output)
    .map((f) => `${f.label} output (end):\n${tail(f.output, 20, 1500)}`)
    .join('\n\n');
  const next =
    attempt >= MAX_FAILED_CHECKS
      ? `That's ${attempt} failed checks. You can now only finish by handing in with status "blocked" and findings that say what you tried and what's blocking you (D86).`
      : `Fix it and hand in again (failed check ${attempt} of ${MAX_FAILED_CHECKS}).`;
  return {
    reason: [`your finish checks didn't pass (D97):`, problems, detail, next].filter(Boolean).join('\n\n'),
    subject: taskId,
  };
}

if (isMain(import.meta.url)) {
  runHandInGuard(RULE, (input) => decideFinish(input));
}
