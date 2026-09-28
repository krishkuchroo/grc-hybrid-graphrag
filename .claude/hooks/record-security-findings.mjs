// Records security issues in SECURITY-FINDINGS.md so they can be reviewed
// later. It never blocks anything: it runs after an agent's hand-in has been
// accepted (PostToolUse on the report tool) and, as a backup, when the agent
// stops. Each hand-off is written once.
//
// What counts as a security issue:
// - any security-reviewer hand-off that is sent back or blocked;
// - a security-reviewer approval whose findings carry "Security notes:" or
//   name a non-blocking point for later;
// - any agent's findings that carry "Security notes:".
// The main session adds audit results (insecure-defaults) by hand.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHandoff, HAND_IN_TOOLS } from './lib/handoff.mjs';
import { readHookInput } from './lib/hook-input.mjs';
import { logHookError, now } from './lib/logging.mjs';
import { LOGS_DIR, PROJECT_DIR } from './lib/paths.mjs';
import { redact } from './lib/secret-scan.mjs';
import { isMain } from './lib/run.mjs';
import { readState, writeState } from './lib/state.mjs';

export const FINDINGS_FILE = () => process.env.GRC_SECURITY_FINDINGS || join(PROJECT_DIR, 'SECURITY-FINDINGS.md');

const NOTE_MARKER = /security notes?:/i;
const LATER = /\b(not blocking|non-blocking|worth knowing|for the (planner|user)|follow-?ups?|the user (decides|can decide)|needs? (a )?decision)\b/i;

// null, or the kind of entry this hand-off makes.
export function securityKind(agentType, handoff) {
  const findings = handoff.findings ?? '';
  if (agentType === 'security-reviewer') {
    if (handoff.status === 'sent-back') return 'Sent back';
    if (handoff.status === 'blocked') return 'Question for the user';
    if (findings && (NOTE_MARKER.test(findings) || LATER.test(findings))) return 'Note (approved)';
    return null;
  }
  return findings && NOTE_MARKER.test(findings) ? 'Note' : null;
}

export function nextId(text) {
  const ids = [...String(text).matchAll(/^### SF-(\d+)/gm)].map((m) => Number(m[1]));
  return `SF-${String((ids.length ? Math.max(...ids) : 0) + 1).padStart(3, '0')}`;
}

export function formatEntry({ id, kind, taskId, agentType, agentId, ts, findings }) {
  return [
    '',
    `### ${id} · ${taskId} · ${kind}`,
    `- **Found:** ${ts} by ${agentType} (${agentId})`,
    '- **Review status:** Open',
    `- **Details:** ${redact(findings || '(no details given)').replace(/\s*\n\s*/g, ' ')}`,
    '',
  ].join('\n');
}

function withLock(fn) {
  const lock = join(LOGS_DIR, 'state', 'security-findings.lock');
  mkdirSync(join(LOGS_DIR, 'state'), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

// Returns the new entry's id, or null when nothing was written.
export function record(input) {
  if (!input.agentId) return null;
  const accepted = input.event === 'PostToolUse' && HAND_IN_TOOLS.has(input.toolName);
  if (!accepted && input.event !== 'SubagentStop') return null;
  const { handoff } = parseHandoff(input);
  if (!handoff) return null;
  const kind = securityKind(input.agentType, handoff);
  if (!kind) return null;

  const key = createHash('sha256').update(`${handoff.taskId}\n${handoff.status}\n${handoff.findings}`).digest('hex');
  const state = readState(input.agentId, 'security') ?? { recorded: [] };
  if (state.recorded.includes(key)) return null;

  const file = FINDINGS_FILE();
  const id = withLock(() => {
    if (!existsSync(file)) writeFileSync(file, '# Security findings\n');
    const newId = nextId(readFileSync(file, 'utf8'));
    appendFileSync(
      file,
      formatEntry({ id: newId, kind, taskId: handoff.taskId, agentType: input.agentType, agentId: input.agentId, ts: now(), findings: handoff.findings }),
    );
    return newId;
  });
  writeState(input.agentId, 'security', { recorded: [...state.recorded, key] });
  return id;
}

if (isMain(import.meta.url)) {
  let input = null;
  try {
    input = readHookInput();
    record(input);
  } catch (error) {
    try {
      logHookError({ rule: 'security-findings', input, error });
    } catch {}
  }
  process.exit(0);
}
