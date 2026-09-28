// The agent monitor's feed (D100, D101, D148). It records what each agent
// does in logs/activity.jsonl, hands agents the notes the user sends from
// the monitor page, and hands the main session the user's answers to open
// questions (D155). It never blocks.
//
// Wire it to SessionStart, SubagentStart, UserPromptSubmit, PreToolUse (*),
// SubagentStop and Stop; see README.md.
import { basename, dirname, join } from 'node:path';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  MAIN_INBOX,
  appendJsonl,
  claimInbox,
  createStateOnce,
  inboxFile,
  logActivity,
  logAnswer,
  logMonitorError,
  logNote,
  readState,
  writeState,
} from './lib/core.mjs';
import { HAND_IN_TOOLS, describeTool, lookUpTaskId } from './lib/transcripts.mjs';

// additionalContext is capped at 10,000 characters (hooks docs).
const MAX_CONTEXT = 9000;

// The same rule as the guard rails (D158): a session started with
// `claude --agent <name>` (a launched run) counts as an agent.
export function parseInput(text) {
  const raw = text && text.trim() ? JSON.parse(text) : {};
  const launched = !raw.agent_id && Boolean(raw.agent_type) && Boolean(raw.session_id);
  const event = raw.hook_event_name ?? '';
  return {
    event: launched && event === 'Stop' ? 'SubagentStop' : event,
    toolName: raw.tool_name ?? '',
    toolInput: raw.tool_input ?? {},
    agentId: raw.agent_id || (launched ? `run-${raw.session_id}` : null),
    agentType: raw.agent_type ?? '',
    launched,
    cwd: raw.cwd || process.cwd(),
    sessionId: raw.session_id ?? '',
    transcriptPath: raw.transcript_path ?? '',
    agentTranscriptPath: raw.agent_transcript_path ?? '',
  };
}

// Where an agent's own transcript lives. SubagentStop names it; other events
// only name the main session's, next to a folder holding the agents' ones.
// A launched run's transcript is its own session's.
function transcriptCandidates(input) {
  if (input.launched) return input.transcriptPath ? [input.transcriptPath] : [];
  const out = [];
  if (input.agentTranscriptPath) out.push(input.agentTranscriptPath);
  if (input.transcriptPath) {
    const dir = join(dirname(input.transcriptPath), basename(input.transcriptPath, '.jsonl'), 'subagents');
    out.push(join(dir, `agent-${input.agentId}.jsonl`));
    // Workflow agents sit one level down, in subagents/workflows/<run>/.
    let runs = [];
    try {
      runs = readdirSync(join(dir, 'workflows'));
    } catch {}
    for (const run of runs) out.push(join(dir, 'workflows', run, `agent-${input.agentId}.jsonl`));
  }
  return out;
}

// Cached in state "task".
function taskIdFor(input) {
  const state = readState(input.agentId, 'task');
  const next = lookUpTaskId(state, transcriptCandidates(input));
  if (next.tries !== state?.tries) writeState(input.agentId, 'task', next);
  return next.taskId;
}

const clock = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '--:--' : d.toTimeString().slice(0, 5);
};

// The context Claude reads, plus the items that didn't fit this time.
function fitContext(items, line) {
  const lines = [];
  let size = 0;
  let k = 0;
  for (; k < items.length; k += 1) {
    const text = line(items[k]);
    if (lines.length && size + text.length > MAX_CONTEXT) break;
    lines.push(text);
    size += text.length + 1;
  }
  return { lines, delivered: items.slice(0, k), left: items.slice(k) };
}

export function noteContext(notes) {
  const { lines, delivered, left } = fitContext(notes, (n) => `- [${clock(n.ts)}] ${n.text}`);
  const one = lines.length === 1;
  const context = [
    `${one ? 'Note' : 'Notes'} from the user, sent through the agent monitor (D101):`,
    ...lines,
    '',
    `Treat ${one ? 'it' : 'them'} as the user's instruction for your current task and mention ${one ? 'it' : 'them'} in your hand-off findings. If ${one ? 'it conflicts' : 'one conflicts'} with CLAUDE.md or a decision in memory.md, hand in with status "blocked" and explain the conflict.`,
  ].join('\n');
  return { context, delivered, left };
}

export function answerContext(answers) {
  const { lines, delivered, left } = fitContext(answers, (a) => `- ${a.itemId}${a.itemText ? ` ("${a.itemText}")` : ''}: ${a.text}`);
  const context = [
    `The user answered ${lines.length === 1 ? 'an open question' : 'open questions'} on the agent monitor (D155):`,
    ...lines,
    '',
    'These are the user\'s own answers. Have the planner record each one in memory.md as a decision, then act on them; mention them in your reply.',
  ].join('\n');
  return { context, delivered, left };
}

function requeue(id, items) {
  for (const item of items) appendJsonl(inboxFile(id), item);
}

function deliverNotes(input) {
  const notes = claimInbox(input.agentId);
  if (!notes.length) return null;
  const { context, delivered, left } = noteContext(notes);
  requeue(input.agentId, left);
  for (const note of delivered) logNote({ id: note.id, agent_id: input.agentId, event: 'delivered' });
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } };
}

function deliverAnswers() {
  const answers = claimInbox(MAIN_INBOX);
  if (!answers.length) return null;
  const { context, delivered, left } = answerContext(answers);
  requeue(MAIN_INBOX, left);
  for (const a of delivered) logAnswer({ id: a.id, event: 'delivered' });
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } };
}

function ensureStarted(input) {
  if (readState(input.agentId, 'seen')) return;
  if (createStateOnce(input.agentId, 'seen', { at: new Date().toISOString() })) {
    logActivity({ event: 'start', agent_id: input.agentId, agent_type: input.agentType, cwd: input.cwd, launched: input.launched || undefined });
  }
}

// Returns the JSON to print, or null.
export function handleEvent(input) {
  if (!input.agentId) {
    // The main session: the user's answers ride along with their next message.
    return input.event === 'UserPromptSubmit' ? deliverAnswers() : null;
  }
  // Claude Code's own helper agents (prompt suggestions, /btw) report an
  // empty type and use no tools; they aren't agents anyone dispatched.
  if (!input.agentType && input.event === 'SubagentStop' && !readState(input.agentId, 'seen')) return null;

  ensureStarted(input);
  const base = { agent_id: input.agentId, agent_type: input.agentType };

  if (input.event === 'SubagentStop') {
    logActivity({ event: 'stop', ...base, task_id: readState(input.agentId, 'task')?.taskId ?? null });
    return null;
  }
  if (input.event !== 'PreToolUse') return null;

  logActivity({ event: 'tool', ...base, task_id: taskIdFor(input), tool: input.toolName, subject: describeTool(input.toolName, input.toolInput, input.cwd) });
  // Notes wait while the agent is handing in.
  if (input.toolName in HAND_IN_TOOLS) return null;
  return deliverNotes(input);
}

function isMain() {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMain()) {
  let input = null;
  try {
    input = parseInput(readFileSync(0, 'utf8'));
    const output = handleEvent(input);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    try {
      logMonitorError(input, error);
    } catch {}
  }
  process.exit(0);
}
