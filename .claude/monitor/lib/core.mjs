// The monitor's shared basics: where things live, the config, and reading
// and writing the JSONL logs. Self-contained (D149): nothing here imports
// from outside .claude/monitor/, so the folder can be copied to any project.
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MONITOR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The main checkout. CLAUDE_PROJECT_DIR points here inside workflow agents'
// worktrees, but at the worktree for a run started with --worktree, so
// .claude/worktrees/<name> maps back to the main checkout (D161).
export const mainCheckout = (dir) => resolve(dir).replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/, '');
export const PROJECT_DIR = mainCheckout(process.env.CLAUDE_PROJECT_DIR || join(MONITOR_DIR, '..', '..'));

// ------------------------------------------------------------------ config

// Everything project-specific lives in monitor.config.json (D149). These
// defaults fit any project; a missing or broken file falls back to them.
export const DEFAULT_CONFIG = {
  port: 4800,
  logsDir: 'logs',
  quietMinutes: 10,
  // The first Markdown table whose first header is "ID". `columns` maps the
  // header text (lower case) to the field the page shows.
  board: { file: 'TASKS.md', columns: { id: 'id', milestone: 'milestone', owner: 'owner', status: 'status' } },
  // Milestone order. Empty: the order they first appear on the board.
  milestones: [],
  // Agent type -> blue, purple, orange, green, cyan, yellow, red or pink.
  agentColors: {},
  // Guard-rail rule -> a short label for the blocks table.
  guardRails: {},
  // { file, heading }: the section of a Markdown file holding the user's
  // open questions, one "- **Q12:** …" bullet each. null hides the panel.
  openQuestions: null,
  health: {
    intervalSeconds: 15,
    containers: [], // name prefixes: docker ps --filter name=^<prefix>
    ports: [], // { label, port, host? }
    http: [], // { label, url } (127.0.0.1 or localhost only)
    dockerMemoryLimitGB: null, // what Docker is meant to be limited to
  },
  launch: { maxConcurrent: 2, agentsDir: '.claude/agents' },
};

function merge(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const b = base[key];
    out[key] = b && typeof b === 'object' && !Array.isArray(b) && value && typeof value === 'object' && !Array.isArray(value) ? merge(b, value) : value;
  }
  return out;
}

export const CONFIG_FILE = resolve(process.env.MONITOR_CONFIG || join(MONITOR_DIR, 'monitor.config.json'));
export const configProblems = [];

export function loadConfig(file = CONFIG_FILE) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return DEFAULT_CONFIG;
  }
  try {
    return merge(DEFAULT_CONFIG, JSON.parse(text));
  } catch (error) {
    configProblems.push(`${file} isn't valid JSON (${error.message}); using the defaults.`);
    return DEFAULT_CONFIG;
  }
}

export const config = loadConfig();

// MONITOR_LOGS_DIR lets the tests write somewhere else.
export const LOGS_DIR = resolve(process.env.MONITOR_LOGS_DIR || join(PROJECT_DIR, config.logsDir));

// ----------------------------------------------------------------- writing

export const now = () => new Date().toISOString();

export function append(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, text);
}

export const appendJsonl = (file, entry) => append(file, `${JSON.stringify(entry)}\n`);

export const logFile = (name) => join(LOGS_DIR, name);

// logs/activity.jsonl: what each agent is doing (D100).
export function logActivity(entry) {
  const clean = { ts: now(), ...entry };
  if (clean.subject !== undefined) clean.subject = clip(clean.subject, 240);
  appendJsonl(logFile('activity.jsonl'), clean);
}

// logs/notes.jsonl: every note the user sends an agent, and its delivery (D101).
export const logNote = (entry) => appendJsonl(logFile('notes.jsonl'), { ts: now(), ...entry });

// logs/answers.jsonl: the user's answers to open questions, and when the
// main session got them (D155).
export const logAnswer = (entry) => appendJsonl(logFile('answers.jsonl'), { ts: now(), ...entry });

// The monitor's own crashes, listed with the guard-rail blocks.
export function logMonitorError(input, error) {
  appendJsonl(logFile('guardrails.jsonl'), {
    ts: now(),
    rule: 'monitor',
    decision: 'error',
    event: input?.event || undefined,
    tool: input?.toolName || undefined,
    agent_id: input?.agentId ?? null,
    agent_type: input?.agentType || 'main',
    reason: clip(error?.stack || error, 1000),
  });
}

// ----------------------------------------------------------------- the state

export function agentKey(agentId) {
  const id = String(agentId);
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : createHash('sha256').update(id).digest('hex').slice(0, 32);
}

// logs/state/<agent>.<kind>.json, shared with the guard rails' own kinds.
const stateFile = (agentId, kind) => join(LOGS_DIR, 'state', `${agentKey(agentId)}.${kind}.json`);

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
}

export const readState = (agentId, kind) => readJson(stateFile(agentId, kind));
export const writeState = (agentId, kind, value) => writeJson(stateFile(agentId, kind), value);

// Creates the state only if none exists; true when this call created it.
export function createStateOnce(agentId, kind, value) {
  mkdirSync(join(LOGS_DIR, 'state'), { recursive: true });
  try {
    writeFileSync(stateFile(agentId, kind), JSON.stringify(value), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

// ------------------------------------------------------------------- inboxes

// logs/inbox/<id>.jsonl: notes waiting for an agent's next step (D101), and
// "main-session" for answers waiting for the user's next message (D155).
export const inboxFile = (id) => join(LOGS_DIR, 'inbox', `${agentKey(id)}.jsonl`);
export const MAIN_INBOX = 'main-session';

export function queueInInbox(id, item) {
  appendJsonl(inboxFile(id), item);
}

// Takes what's waiting, exactly once: renaming the inbox is the claim, so
// two hooks can't both deliver the same item.
export function claimInbox(id) {
  const inbox = inboxFile(id);
  const claimed = `${inbox}.claim-${process.pid}`;
  try {
    renameSync(inbox, claimed);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const text = readFileSync(claimed, 'utf8');
  rmSync(claimed, { force: true });
  return parseJsonl(text).filter((item) => item && typeof item.text === 'string');
}

// ------------------------------------------------------------------- reading

export function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

// Reads a growing JSONL file from where it left off last time. `filter`
// skips lines cheaply before they're parsed.
export function follow(file, onEntry, onReset = () => {}, filter = null) {
  let offset = 0;
  let inode = null;
  let rest = Buffer.alloc(0);
  const read = () => {
    let st;
    try {
      st = statSync(file);
    } catch {
      return false;
    }
    if (st.ino !== inode || st.size < offset) {
      inode = st.ino;
      offset = 0;
      rest = Buffer.alloc(0);
      onReset();
    }
    if (st.size <= offset) return false;
    const fd = openSync(file, 'r');
    try {
      while (offset < st.size) {
        const buf = Buffer.alloc(Math.min(st.size - offset, 8 * 1024 * 1024));
        const n = readSync(fd, buf, 0, buf.length, offset);
        if (n <= 0) break;
        offset += n;
        const chunk = Buffer.concat([rest, buf.subarray(0, n)]);
        const end = chunk.lastIndexOf(0x0a);
        rest = chunk.subarray(end + 1);
        if (end < 0) continue;
        for (const line of chunk.subarray(0, end).toString('utf8').split('\n')) {
          if (!line || (filter && !filter(line))) continue;
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          onEntry(entry);
        }
      }
    } finally {
      closeSync(fd);
    }
    return true;
  };
  read.position = () => ({ inode, offset: offset - rest.length });
  // Starts from a saved position (the token counts' cache).
  read.seek = (pos) => {
    inode = pos.inode;
    offset = pos.offset;
    rest = Buffer.alloc(0);
  };
  return read;
}

// The last lines of a file, newest last, reading at most `maxBytes`.
export function tailLines(file, maxBytes = 512 * 1024) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return [];
  }
  const bytes = Math.min(st.size, maxBytes);
  const buf = Buffer.alloc(bytes);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, bytes, st.size - bytes);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  if (bytes < st.size) lines.shift(); // a cut-off first line
  return lines.filter(Boolean);
}

export const tailJsonl = (file, count, maxBytes) => parseJsonl(tailLines(file, maxBytes).slice(-count).join('\n'));

export function safeId(id, fallback = null) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(id ?? '')) ? String(id) : fallback;
}

// ------------------------------------------------------------------ redaction

// Hides secret-looking values before anything is logged or shown. The same
// patterns as the project's commit scan, kept here so the folder stands alone.
const TOKEN_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b[rs]k_live_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:([^\s@/'"`]+)@/gi;
const ASSIGNMENT =
  /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|bearer)[a-z0-9_]*["']?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/gi;
const PLAIN_ASSIGNMENT = /((?:password|passwd|secret|token|api[_-]?key|apikey)[a-z0-9_]*=)([^\s'"]{8,})/gi;
const PLACEHOLDER =
  /^(?:x+|\*+|\.+|changeme|change-me|password|passw0rd|secret|example|placeholder|dummy|test|todo|none|null|undefined|redacted|your[-_a-z]*)$/i;
const looksReal = (v) => !/[${}<>%]|process\.env|import\.meta/.test(v) && !PLACEHOLDER.test(v) && !/^(.)\1+$/.test(v);

export function redact(text) {
  let out = String(text ?? '');
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[redacted]');
  out = out.replace(URL_PASSWORD, (m, pw) => m.replace(pw, '[redacted]'));
  out = out.replace(ASSIGNMENT, (m, value) => (looksReal(value) ? m.replace(value, '[redacted]') : m));
  return out.replace(PLAIN_ASSIGNMENT, (m, key, value) => (looksReal(value) ? `${key}[redacted]` : m));
}

// One line, redacted and cut to `max` characters.
export function clip(text, max = 500) {
  const s = redact(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Redacted and cut, keeping line breaks (conversation text).
export function clipBlock(text, max = 4000) {
  const s = redact(text).trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
