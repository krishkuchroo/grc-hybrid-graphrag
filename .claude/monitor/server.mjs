// The agent monitor (D100–D103): a local page showing what each agent is
// doing, the task board and the guard rails, with a box to send an agent a
// note (monitor-hook.mjs delivers it at the agent's next step, D101).
//
// Start: node .claude/monitor/server.mjs, then open http://127.0.0.1:4800
// (MONITOR_PORT picks another port). Node built-ins only; it listens on
// 127.0.0.1 only (D102). Pausing or stopping a workflow stays in /workflows.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clip, inboxFile, logNote, now, safeTaskId } from '../hooks/lib/logging.mjs';
import { LOGS_DIR, PROJECT_DIR } from '../hooks/lib/paths.mjs';
import { readState } from '../hooks/lib/state.mjs';

const PORT = Number(process.env.MONITOR_PORT) || 4800;
const PAGE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'index.html');
// A new key each start. The page sends it with every /api call, so other
// web pages open in the browser can't use the API.
const KEY = randomBytes(24).toString('base64url');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((host) => `http://${host}`));

const QUIET_MS = 10 * 60_000;
const MAX_NOTE = 2000;
const MAX_BODY = 16 * 1024;
const FINISHED_SHOWN = 20;
const STEPS_SHOWN = 8;
const MILESTONES = ['M0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

// ---------------------------------------------------------------- reading logs

// Reads a growing JSONL file from where it left off last time.
function follow(file, onEntry, onReset) {
  let offset = 0;
  let inode = null;
  let rest = Buffer.alloc(0);
  return () => {
    let st;
    try {
      st = statSync(file);
    } catch {
      return;
    }
    if (st.ino !== inode || st.size < offset) {
      inode = st.ino;
      offset = 0;
      rest = Buffer.alloc(0);
      onReset();
    }
    if (st.size <= offset) return;
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
          if (!line) continue;
          try {
            onEntry(JSON.parse(line));
          } catch {}
        }
      }
    } finally {
      closeSync(fd);
    }
  };
}

const agents = new Map();
const followActivity = follow(
  join(LOGS_DIR, 'activity.jsonl'),
  (e) => {
    if (!e.agent_id) return; // the main session's edits
    let a = agents.get(e.agent_id);
    if (!a) {
      a = { id: e.agent_id, type: e.agent_type || 'agent', startedAt: e.ts, lastTs: e.ts, taskId: null, lastAction: '', steps: [], stopped: false };
      agents.set(e.agent_id, a);
    }
    if (e.agent_type) a.type = e.agent_type;
    if (e.task_id) a.taskId = e.task_id;
    a.lastTs = e.ts;
    if (e.event === 'start') {
      a.startedAt = e.ts;
      a.cwd = e.cwd;
    } else if (e.event === 'tool') {
      a.stopped = false; // a hand-in sent back keeps the agent working
      a.lastAction = e.subject || e.tool;
      a.steps.push({ ts: e.ts, tool: e.tool, subject: e.subject ?? '' });
      if (a.steps.length > STEPS_SHOWN) a.steps.shift();
    } else if (e.event === 'stop') {
      a.stopped = true;
      a.stoppedAt = e.ts;
    }
  },
  () => agents.clear(),
);

const notes = new Map();
const followNotes = follow(
  join(LOGS_DIR, 'notes.jsonl'),
  (e) => {
    if (!e.id) return;
    const note = notes.get(e.id) ?? { id: e.id, agentId: e.agent_id, ts: null, text: '', deliveredAt: null };
    if (e.event === 'queued') Object.assign(note, { ts: e.ts, text: e.text ?? '', agentId: e.agent_id });
    if (e.event === 'delivered') note.deliveredAt = e.ts;
    notes.set(e.id, note);
  },
  () => notes.clear(),
);

// The last `count` entries of a JSONL file.
function tailJsonl(file, count) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return [];
  }
  const bytes = Math.min(st.size, 512 * 1024);
  const buf = Buffer.alloc(bytes);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, bytes, st.size - bytes);
  } finally {
    closeSync(fd);
  }
  let lines = buf.toString('utf8').split('\n');
  if (bytes < st.size) lines = lines.slice(1); // a cut-off first line
  return lines.filter(Boolean).slice(-count).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// ------------------------------------------------------------ the task board

const BOARD_COLUMNS = {
  id: 'id',
  milestone: 'milestone',
  owner: 'owner',
  status: 'status',
  'pass criteria & tests': 'criteria',
  'blocked notes': 'blockedNotes',
  'task log': 'log',
};
const plain = (text) => String(text ?? '').replace(/[*_`]/g, '').trim();

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

// The first table in TASKS.md, the board the planner keeps (D85).
function readBoard() {
  let text;
  try {
    text = readFileSync(join(PROJECT_DIR, 'TASKS.md'), 'utf8');
  } catch {
    return [];
  }
  const tasks = [];
  let keys = null;
  for (const line of text.split('\n')) {
    const isRow = line.trim().startsWith('|');
    if (!keys) {
      const cells = isRow ? splitRow(line) : [];
      if (plain(cells[0]).toLowerCase() === 'id') keys = cells.map((c) => BOARD_COLUMNS[plain(c).toLowerCase()] ?? null);
      continue;
    }
    if (!isRow) break;
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const task = {};
    keys.forEach((key, k) => {
      if (key) task[key] = cells[k] ?? '';
    });
    task.id = plain(task.id);
    if (!task.id) continue;
    task.milestone = plain(task.milestone);
    task.status = plain(task.status).toLowerCase();
    const safeId = safeTaskId(task.id, null);
    task.hasLog = Boolean(safeId && existsSync(join(LOGS_DIR, 'tasks', `${safeId}.md`)));
    tasks.push(task);
  }
  return tasks;
}

const STATUS_KEYS = { done: 'done', 'in review': 'review', 'in progress': 'progress', blocked: 'blocked' };

function milestoneOrder(id) {
  const k = MILESTONES.indexOf(id.toUpperCase());
  return k < 0 ? MILESTONES.length : k;
}

function milestonesOf(tasks) {
  const rows = new Map(MILESTONES.map((id) => [id, { id, total: 0, done: 0, review: 0, progress: 0, blocked: 0 }]));
  for (const task of tasks) {
    const id = task.milestone || '(none)';
    const row = rows.get(id.toUpperCase()) ?? rows.get(id) ?? { id, total: 0, done: 0, review: 0, progress: 0, blocked: 0 };
    row.total += 1;
    const key = STATUS_KEYS[task.status];
    if (key) row[key] += 1;
    rows.set(row.id, row);
  }
  return [...rows.values()].sort((a, b) => milestoneOrder(a.id) - milestoneOrder(b.id) || a.id.localeCompare(b.id));
}

// ------------------------------------------------------------------ the state

function where(cwd) {
  if (!cwd) return '';
  const rel = relative(PROJECT_DIR, cwd);
  if (!rel) return 'main checkout';
  return rel.startsWith('..') ? cwd : rel;
}

function describeAgent(a, t, notesByAgent) {
  const finish = readState(a.id, 'finish');
  const status = a.stopped ? 'finished' : t - Date.parse(a.lastTs) > QUIET_MS ? 'quiet' : 'running';
  return {
    id: a.id,
    type: a.type,
    status,
    taskId: a.taskId ?? finish?.taskId ?? readState(a.id, 'task')?.taskId ?? null,
    where: where(a.cwd),
    startedAt: a.startedAt,
    lastTs: a.lastTs,
    stoppedAt: a.stoppedAt ?? null,
    lastAction: a.lastAction,
    steps: a.steps,
    finish: finish && { attempts: finish.attempts ?? 0, cleared: Boolean(finish.cleared), blocked: Boolean(finish.blocked) },
    notes: (notesByAgent.get(a.id) ?? []).slice(-5),
  };
}

function attentionOf(tasks, shown, guardrails, t) {
  const out = [];
  for (const task of tasks) {
    if (task.status === 'blocked') out.push({ kind: 'blocked', text: `${task.id} is blocked${task.blockedNotes ? `: ${task.blockedNotes}` : ''}`, taskId: task.id });
  }
  for (const a of shown) {
    const who = `${a.type}${a.taskId ? ` on ${a.taskId}` : ''}`;
    if (a.finish?.blocked) out.push({ kind: 'blocked', text: `${who} handed in as blocked`, taskId: a.taskId });
    else if (a.finish && a.finish.attempts >= 3 && !a.finish.cleared) {
      out.push({ kind: 'blocked', text: `${who} has failed its finish checks ${a.finish.attempts} times (D86)`, taskId: a.taskId });
    }
    if (a.status === 'quiet') out.push({ kind: 'quiet', text: `${who} has been quiet for ${Math.round((t - Date.parse(a.lastTs)) / 60_000)} min` });
  }
  for (const g of guardrails) {
    if (g.decision === 'error' && t - Date.parse(g.ts) < 24 * 3600_000) {
      out.push({ kind: 'error', text: `guard rail ${g.rule} itself failed${g.agent_type ? ` (${g.agent_type})` : ''}; see Guard rails below`, ts: g.ts });
    }
  }
  return out;
}

function buildState() {
  followActivity();
  followNotes();
  const t = Date.now();
  const tasks = readBoard();
  const notesByAgent = new Map();
  for (const note of [...notes.values()].filter((n) => n.ts).sort((x, y) => x.ts.localeCompare(y.ts))) {
    const list = notesByAgent.get(note.agentId) ?? [];
    list.push({ id: note.id, ts: note.ts, text: note.text, deliveredAt: note.deliveredAt });
    notesByAgent.set(note.agentId, list);
  }
  const all = [...agents.values()].map((a) => describeAgent(a, t, notesByAgent));
  const active = all.filter((a) => a.status !== 'finished').sort((x, y) => x.startedAt.localeCompare(y.startedAt));
  const finished = all
    .filter((a) => a.status === 'finished')
    .sort((x, y) => (y.stoppedAt ?? '').localeCompare(x.stoppedAt ?? ''))
    .slice(0, FINISHED_SHOWN);
  const shown = [...active, ...finished];
  const guardrails = tailJsonl(join(LOGS_DIR, 'guardrails.jsonl'), 50).reverse();
  return {
    now: new Date(t).toISOString(),
    project: PROJECT_DIR,
    milestones: milestonesOf(tasks),
    tasks,
    agents: shown,
    attention: attentionOf(tasks, shown, guardrails, t),
    guardrails,
  };
}

// ------------------------------------------------------------------- the API

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const pageCsp = (nonce) =>
  [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

function send(res, status, body, headers) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

const json = (res, status, value) =>
  send(res, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function keyMatches(value) {
  const given = Buffer.from(String(value ?? ''));
  const expected = Buffer.from(KEY);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'That note is too large.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function queueNote(req) {
  if (!ALLOWED_ORIGINS.has(req.headers.origin ?? '')) throw new HttpError(403, 'Notes can only be sent from the monitor page.');
  if (!/^application\/json\s*(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send the note as JSON.');
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "That isn't valid JSON.");
  }
  const agentId = String(body?.agentId ?? '');
  const text = String(body?.text ?? '').trim();
  if (!text) throw new HttpError(400, 'Write a note first.');
  if (text.length > MAX_NOTE) throw new HttpError(400, `Keep a note under ${MAX_NOTE} characters.`);
  followActivity();
  const agent = agents.get(agentId);
  if (!agent) throw new HttpError(404, 'There is no agent with that ID.');
  if (agent.stopped) throw new HttpError(409, 'This agent has finished. Notes reach agents only while they work.');
  const note = { id: randomUUID(), ts: now(), text };
  const file = inboxFile(agentId);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(note)}\n`);
  logNote({ id: note.id, agent_id: agentId, event: 'queued', text: clip(text, MAX_NOTE) });
  return { id: note.id, ts: note.ts };
}

function taskLog(url) {
  const id = safeTaskId(url.searchParams.get('id'), null);
  if (!id) throw new HttpError(400, "That task ID isn't valid.");
  try {
    return { id, text: readFileSync(join(LOGS_DIR, 'tasks', `${id}.md`), 'utf8') };
  } catch {
    throw new HttpError(404, `There's no log for ${id} yet.`);
  }
}

async function route(req, res) {
  // Only our own address, which blocks DNS-rebinding tricks.
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
    return send(res, 403, 'Open the monitor at http://127.0.0.1:' + PORT, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname === '/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Use GET.');
    const nonce = randomBytes(16).toString('base64');
    const page = readFileSync(PAGE_FILE, 'utf8').replaceAll('__NONCE__', nonce).replace('__MONITOR_KEY__', KEY);
    return send(res, 200, page, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': pageCsp(nonce) });
  }
  if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');
  if (!keyMatches(req.headers['x-monitor-key'])) throw new HttpError(403, 'The monitor restarted or the key is wrong. Reload the page.');
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, buildState());
  if (req.method === 'GET' && url.pathname === '/api/task-log') return json(res, 200, taskLog(url));
  if (req.method === 'POST' && url.pathname === '/api/note') return json(res, 200, await queueNote(req));
  throw new HttpError(404, 'Not found.');
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    if (!(error instanceof HttpError)) console.error(error);
    if (res.headersSent) return res.end();
    json(res, error.status ?? 500, { error: error instanceof HttpError ? error.message : 'The monitor hit an error; see its terminal.' });
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is busy. Pick another one: MONITOR_PORT=4801 node .claude/monitor/server.mjs`);
  } else console.error(error);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent monitor: http://127.0.0.1:${PORT}`);
  console.log(`Reading ${LOGS_DIR}. Stop it with Ctrl+C.`);
});
