// The agent monitor's feed (D100, D101). It records what each agent does in
// logs/activity.jsonl, remembers how the checkout looked when an agent
// started (for check-changed-files.mjs and guard-test-files.mjs), and hands
// agents the notes the user sends from the monitor page. It never blocks.
import { appendFileSync, closeSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { snapshot } from './lib/checkout.mjs';
import { readHookInput } from './lib/hook-input.mjs';
import { inboxFile, logActivity, logHookError, logNote, now } from './lib/logging.mjs';
import { repoRelative } from './lib/paths.mjs';
import { isMain } from './lib/run.mjs';
import { createStateOnce, readState, writeState } from './lib/state.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const HAND_IN_SUBJECTS = { SubagentHandback: 'handing in the report', StructuredOutput: 'handing in the result' };
const TASK_ID = /\bTask:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})/;
const MAX_TASK_TRIES = 20;
const TRANSCRIPT_HEAD = 256 * 1024;
// additionalContext is capped at 10,000 characters (hooks docs).
const MAX_NOTE_CONTEXT = 9000;

const absolute = (p, cwd) => (isAbsolute(p) ? p : resolve(cwd, p));

function editedFile(input) {
  const p = input.toolInput.file_path ?? input.toolInput.notebook_path;
  return p ? absolute(String(p), input.cwd) : null;
}

function shownPath(p, cwd) {
  if (!p) return '';
  return repoRelative(String(p), cwd) ?? String(p);
}

// One line saying what a tool call does, for the monitor's step list.
export function describeTool(input) {
  const t = input.toolInput;
  switch (input.toolName) {
    case 'Bash':
      return [t.description, t.command].filter(Boolean).join(' — ');
    case 'Read':
    case 'Edit':
    case 'Write':
      return shownPath(t.file_path, input.cwd);
    case 'NotebookEdit':
      return shownPath(t.notebook_path, input.cwd);
    case 'Grep':
      return [t.pattern, t.path && shownPath(t.path, input.cwd)].filter(Boolean).join(' in ');
    case 'Glob':
      return String(t.pattern ?? '');
    case 'Skill':
      return String(t.skill ?? '');
    case 'Agent':
      return [t.subagent_type, t.description].filter(Boolean).join(': ');
    case 'WebFetch':
      return String(t.url ?? '');
    case 'WebSearch':
      return String(t.query ?? '');
    default:
      return HAND_IN_SUBJECTS[input.toolName] ?? '';
  }
}

// Where an agent's own transcript lives. SubagentStop names it; other events
// only name the main session's, next to a folder holding the agents' ones.
function transcriptCandidates(input) {
  const out = [];
  if (input.agentTranscriptPath) out.push(input.agentTranscriptPath);
  if (input.transcriptPath) {
    const dir = join(dirname(input.transcriptPath), basename(input.transcriptPath, '.jsonl'), 'subagents');
    out.push(join(dir, `agent-${input.agentId}.jsonl`), join(dir, `${input.agentId}.jsonl`));
    // Workflow agents sit one level down, in subagents/workflows/<run>/.
    let runs = [];
    try {
      runs = readdirSync(join(dir, 'workflows'));
    } catch {}
    for (const run of runs) out.push(join(dir, 'workflows', run, `agent-${input.agentId}.jsonl`));
  }
  return out;
}

function readHead(file, bytes) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

// The task ID from the first line of the agent's brief ("Task: S1-003", D91).
export function taskIdFromTranscript(file) {
  let text;
  try {
    text = readHead(file, TRANSCRIPT_HEAD);
  } catch {
    return undefined; // not written yet
  }
  for (const line of text.split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== 'user') continue;
    return TASK_ID.exec(messageText(entry.message?.content))?.[1] ?? null;
  }
  return undefined;
}

// Cached in state "task"; looked up at most MAX_TASK_TRIES times.
function taskIdFor(input) {
  const state = readState(input.agentId, 'task') ?? { taskId: null, tries: 0 };
  if (state.taskId || state.tries >= MAX_TASK_TRIES) return state.taskId;
  let found;
  for (const file of transcriptCandidates(input)) {
    found = taskIdFromTranscript(file);
    if (found !== undefined) break;
  }
  // A brief without "Task:" is final; a transcript not written yet is retried.
  writeState(input.agentId, 'task', { taskId: found ?? null, tries: found === undefined ? state.tries + 1 : MAX_TASK_TRIES });
  return found ?? null;
}

function ensureStarted(input) {
  if (readState(input.agentId, 'start')) return;
  const created = createStateOnce(input.agentId, 'start', {
    agentId: input.agentId,
    agentType: input.agentType,
    startedAt: now(),
    cwd: input.cwd,
    ...snapshot(input.cwd),
  });
  if (created) logActivity({ event: 'start', agent_id: input.agentId, agent_type: input.agentType, cwd: input.cwd });
}

const clock = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '--:--' : d.toTimeString().slice(0, 5);
};

// Takes the agent's waiting notes, exactly once: renaming the inbox is the
// claim, so two hooks can't both deliver the same note.
export function claimNotes(agentId) {
  const inbox = inboxFile(agentId);
  const claimed = `${inbox}.claim-${process.pid}`;
  try {
    renameSync(inbox, claimed);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const text = readFileSync(claimed, 'utf8');
  rmSync(claimed, { force: true });
  const notes = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const note = JSON.parse(line);
      if (note && typeof note.text === 'string') notes.push(note);
    } catch {}
  }
  return notes;
}

// The context Claude reads, plus the notes that didn't fit this time.
export function noteContext(notes) {
  const lines = [];
  let size = 0;
  let k = 0;
  for (; k < notes.length; k += 1) {
    const line = `- [${clock(notes[k].ts)}] ${notes[k].text}`;
    if (lines.length && size + line.length > MAX_NOTE_CONTEXT) break;
    lines.push(line);
    size += line.length + 1;
  }
  const heading = lines.length === 1 ? 'Note from the user' : 'Notes from the user';
  const context = [
    `${heading}, sent through the agent monitor (D101):`,
    ...lines,
    '',
    `Treat ${lines.length === 1 ? 'it' : 'them'} as the user's instruction for your current task and mention ${lines.length === 1 ? 'it' : 'them'} in your hand-off findings. If ${lines.length === 1 ? 'it conflicts' : 'one conflicts'} with CLAUDE.md or a decision in memory.md, hand in with status "blocked" and explain the conflict.`,
  ].join('\n');
  return { context, delivered: notes.slice(0, k), left: notes.slice(k) };
}

function deliverNotes(input) {
  const notes = claimNotes(input.agentId);
  if (!notes.length) return null;
  const { context, delivered, left } = noteContext(notes);
  if (left.length) appendFileSync(inboxFile(input.agentId), left.map((n) => `${JSON.stringify(n)}\n`).join(''));
  for (const note of delivered) logNote({ id: note.id, agent_id: input.agentId, event: 'delivered' });
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } };
}

// Returns the JSON to print, or null.
export function handleEvent(input) {
  if (!input.agentId) {
    if (input.event === 'PreToolUse' && EDIT_TOOLS.has(input.toolName)) {
      const path = editedFile(input);
      if (path) logActivity({ event: 'edit', agent_id: null, agent_type: 'main', tool: input.toolName, path });
    }
    return null;
  }
  // Claude Code's own helper agents (prompt suggestions, /btw) report an
  // empty type and use no tools; they aren't agents anyone dispatched.
  if (!input.agentType && input.event === 'SubagentStop' && !readState(input.agentId, 'start')) return null;

  ensureStarted(input);
  const base = { agent_id: input.agentId, agent_type: input.agentType };

  if (input.event === 'SubagentStop') {
    const taskId = readState(input.agentId, 'task')?.taskId ?? readState(input.agentId, 'finish')?.taskId ?? null;
    logActivity({ event: 'stop', ...base, task_id: taskId });
    return null;
  }
  if (input.event !== 'PreToolUse') return null;

  const entry = { event: 'tool', ...base, task_id: taskIdFor(input), tool: input.toolName, subject: describeTool(input) };
  if (EDIT_TOOLS.has(input.toolName)) entry.path = editedFile(input) ?? undefined;
  logActivity(entry);

  if (input.toolName in HAND_IN_SUBJECTS) return null;
  return deliverNotes(input);
}

if (isMain(import.meta.url)) {
  let input = null;
  try {
    input = readHookInput();
    const output = handleEvent(input);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    try {
      logHookError({ rule: 'monitor', input, error });
    } catch {}
  }
  process.exit(0);
}
