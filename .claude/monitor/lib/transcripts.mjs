// Claude Code's saved conversations: where they live, the task ID in an
// agent's brief, and an agent's conversation as a chat thread (D148).
// Everything read here is untrusted text: it's redacted and only ever shown
// as text.
import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { PROJECT_DIR, clip, clipBlock, parseJsonl, tailLines } from './core.mjs';

const TASK_ID = /\bTask:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})/;
const HEAD_BYTES = 256 * 1024;
export const HAND_IN_TOOLS = { SubagentHandback: 'handing in the report', StructuredOutput: 'handing in the result' };

// ~/.claude/projects/<the path with every other character as "-">.
export const projectKey = (dir) => dir.replace(/[^A-Za-z0-9-]/g, '-');
export const PROJECTS_ROOT = process.env.MONITOR_TRANSCRIPTS_ROOT || join(homedir(), '.claude', 'projects');

// The project's folders: the main checkout's, plus one per worktree that a
// launched run worked in (.claude/worktrees/<name>).
export function projectFolders(projectDir = PROJECT_DIR) {
  const key = projectKey(projectDir);
  let names = [];
  try {
    names = readdirSync(PROJECTS_ROOT);
  } catch {
    return [];
  }
  return names.filter((n) => n === key || n.startsWith(`${key}--claude-worktrees-`)).map((n) => join(PROJECTS_ROOT, n));
}

export function readHead(file, bytes = HEAD_BYTES) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
  return '';
}

// The task ID from the first line of the agent's brief ("Task: S1-003",
// D91): a string, null when the brief has none, undefined when the
// transcript isn't written yet.
export function taskIdFromTranscript(file) {
  let text;
  try {
    text = readHead(file);
  } catch {
    return undefined;
  }
  for (const entry of parseJsonl(text)) {
    if (entry?.type !== 'user') continue;
    return TASK_ID.exec(messageText(entry.message?.content))?.[1] ?? null;
  }
  return undefined;
}

const MAX_TASK_TRIES = 20;

// One more try at a task ID, given the last result ({ taskId, tries }). A brief
// without "Task:" is final; a transcript not written yet is retried, at most
// MAX_TASK_TRIES times.
export function lookUpTaskId(prev, files) {
  const { taskId = null, tries = 0 } = prev ?? {};
  if (taskId || tries >= MAX_TASK_TRIES) return { taskId, tries };
  let found;
  for (const file of files) {
    found = taskIdFromTranscript(file);
    if (found !== undefined) break;
  }
  return { taskId: found ?? null, tries: found === undefined ? tries + 1 : MAX_TASK_TRIES };
}

function shownPath(p, cwd) {
  if (!p) return '';
  const s = String(p);
  if (!isAbsolute(s) || !cwd) return s;
  const rel = relative(cwd, s);
  return rel && !rel.startsWith('..') ? rel : s;
}

// One line saying what a tool call does.
export function describeTool(toolName, t = {}, cwd = '') {
  switch (toolName) {
    case 'Bash':
      return [t.description, t.command].filter(Boolean).join(' — ');
    case 'Read':
    case 'Edit':
    case 'Write':
      return shownPath(t.file_path, cwd);
    case 'NotebookEdit':
      return shownPath(t.notebook_path, cwd);
    case 'Grep':
      return [t.pattern, t.path && shownPath(t.path, cwd)].filter(Boolean).join(' in ');
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
      return HAND_IN_TOOLS[toolName] ?? '';
  }
}

const HANDOFF = /```handoff[^\n]*\n[\s\S]*?\n[ \t]*```/;

// The last `limit` messages of a conversation, oldest first: what the user
// and the agent wrote, one line per tool call, and the hand-off.
export function conversation(file, { limit = 150, maxBytes = 3 * 1024 * 1024 } = {}) {
  const items = [];
  const seen = new Set();
  for (const entry of parseJsonl(tailLines(file, maxBytes).join('\n'))) {
    const content = entry?.message?.content;
    const ts = entry.timestamp ?? null;
    if (entry.type === 'user' && !entry.isMeta) {
      if (typeof content === 'string' || content?.some?.((c) => c?.type === 'text')) {
        const text = messageText(content).trim();
        // Skip Claude Code's own wrappers (command output, reminders).
        if (text && !/^<(?:command|local-command|system-reminder|task-notification)/.test(text)) items.push({ role: 'user', ts, text: clipBlock(text) });
      }
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type === 'tool_result' && c.is_error) items.push({ role: 'error', ts, text: clip(messageText(c.content) || String(c.content ?? ''), 400) });
      }
    } else if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const [k, c] of content.entries()) {
        // A message is saved once per content block; each block once.
        const id = `${entry.message.id ?? entry.uuid}:${k}:${c?.type}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (c?.type === 'text' && c.text?.trim()) {
          items.push({ role: HANDOFF.test(c.text) ? 'handoff' : 'agent', ts, text: clipBlock(c.text) });
        } else if (c?.type === 'tool_use') {
          if (c.name in HAND_IN_TOOLS) {
            const report = c.name === 'SubagentHandback' ? String(c.input?.message ?? '') : JSON.stringify(c.input ?? {}, null, 2);
            items.push({ role: 'handoff', ts, text: clipBlock(report) });
          } else items.push({ role: 'tool', ts, tool: c.name, text: clip(describeTool(c.name, c.input ?? {}, entry.cwd), 300) });
        }
      }
    }
  }
  return items.slice(-limit);
}
