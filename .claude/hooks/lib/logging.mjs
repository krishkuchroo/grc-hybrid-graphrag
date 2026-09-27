// Every hook writes its records through here (D92). Files live in logs/,
// which is git-ignored and closed to agents (D107).
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOGS_DIR } from './paths.mjs';
import { redact } from './secret-scan.mjs';

const now = () => new Date().toISOString();

function append(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, text);
}

function clip(text, max = 500) {
  const s = redact(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function logDecision(decision, { rule, input, reason, subject }) {
  append(
    join(LOGS_DIR, 'guardrails.jsonl'),
    `${JSON.stringify({
      ts: now(),
      rule,
      decision,
      event: input?.event || undefined,
      tool: input?.toolName || undefined,
      agent_id: input?.agentId ?? null,
      agent_type: input?.agentType || 'main',
      subject: clip(subject),
      reason: clip(reason, 1000),
    })}\n`,
  );
}

// logs/guardrails.jsonl: every block, with the time, agent, rule and what
// was blocked.
export const logBlock = (entry) => logDecision('block', entry);

// Something a guard rail let through but recorded, such as protected files
// changed by an agent that handed in "blocked".
export const logNotice = (entry) => logDecision('noted', entry);

// A guard rail that crashed. The monitor lists these next to the blocks.
export function logHookError({ rule, input, error }) {
  append(
    join(LOGS_DIR, 'guardrails.jsonl'),
    `${JSON.stringify({
      ts: now(),
      rule,
      decision: 'error',
      event: input?.event || undefined,
      tool: input?.toolName || undefined,
      agent_id: input?.agentId ?? null,
      agent_type: input?.agentType || 'main',
      reason: clip(error?.stack || error, 1000),
    })}\n`,
  );
}

// logs/edits.jsonl: who edited which file through Edit/Write/NotebookEdit,
// so the hand-in backstop can tell other people's edits apart (D157).
export const EDITS_FILE = () => join(LOGS_DIR, 'edits.jsonl');
export function logEdit(entry) {
  append(EDITS_FILE(), `${JSON.stringify({ ts: now(), ...entry })}\n`);
}

export function safeTaskId(id, fallback) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(id ?? '')) ? String(id) : fallback;
}

// logs/tasks/<task-id>.md: one section per attempt, review or hand-off (D92).
export function appendTaskLog(taskId, markdown) {
  const file = join(LOGS_DIR, 'tasks', `${taskId}.md`);
  const header = existsSync(file) ? '' : `# ${taskId}\n`;
  append(file, `${header}\n${redact(markdown).trimEnd()}\n`);
}

export { now, clip };
