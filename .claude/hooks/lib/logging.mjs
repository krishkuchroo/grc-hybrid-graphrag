// Every hook writes its records through here (D92). Files live in logs/,
// which is git-ignored and closed to agents (D107).
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOGS_DIR } from './paths.mjs';
import { redact } from './secret-scan.mjs';
import { agentKey } from './state.mjs';

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

// logs/activity.jsonl: what each agent is doing, for the monitor (D100).
export function logActivity(entry) {
  const clean = { ts: now(), ...entry };
  if (clean.subject !== undefined) clean.subject = clip(clean.subject, 240);
  append(join(LOGS_DIR, 'activity.jsonl'), `${JSON.stringify(clean)}\n`);
}

// logs/notes.jsonl: every note the user sends an agent, and its delivery (D101).
export function logNote(entry) {
  append(join(LOGS_DIR, 'notes.jsonl'), `${JSON.stringify({ ts: now(), ...entry })}\n`);
}

// logs/inbox/<agent>.jsonl: notes waiting for an agent's next step (D101).
export const inboxFile = (agentId) => join(LOGS_DIR, 'inbox', `${agentKey(agentId)}.jsonl`);

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
