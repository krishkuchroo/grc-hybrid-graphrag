// The agent monitor (D100–D103, D148–D158): one local page showing what each
// agent is doing, the board, open questions, token use, system health and
// the guard rails, where the user can send notes, answer questions and
// launch agents.
//
// Start: node .claude/monitor/server.mjs, then open http://127.0.0.1:4800
// (MONITOR_PORT or the config's "port" picks another). Node built-ins only;
// it listens on 127.0.0.1 only (D102). Everything project-specific is in
// monitor.config.json (D149).
//
// Updates are pushed to the page as they happen (server-sent events). The
// timers only run while a page is open.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { readBoard, milestonesOf, readOpenQuestions } from './lib/board.mjs';
import {
  CONFIG_FILE,
  LOGS_DIR,
  MAIN_INBOX,
  MONITOR_DIR,
  PROJECT_DIR,
  clip,
  config,
  configProblems,
  follow,
  logAnswer,
  logFile,
  logNote,
  now,
  queueInInbox,
  readState,
  safeId,
  tailJsonl,
  tailLines,
} from './lib/core.mjs';
import { runHealth } from './lib/health.mjs';
import { LaunchError, MAX_PROMPT, createLauncher, listAgents } from './lib/launcher.mjs';
import { createTokenStore } from './lib/tokens.mjs';
import { conversation, projectFolders } from './lib/transcripts.mjs';

const PORT = Number(process.env.MONITOR_PORT) || config.port;
const PAGE_FILE = join(MONITOR_DIR, 'index.html');
// A new key each start. The page sends it with every /api call, so other
// web pages open in the browser can't use the API.
const KEY = randomBytes(24).toString('base64url');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((host) => `http://${host}`));

const QUIET_MS = config.quietMinutes * 60_000;
const MAX_NOTE = 2000;
const MAX_BODY = 32 * 1024;
const FINISHED_SHOWN = 20;
const STEPS_SHOWN = 8;
const TICKET_MS = 15_000;

// ---------------------------------------------------------------- the logs

const agents = new Map();
const followActivity = follow(
  logFile('activity.jsonl'),
  (e) => {
    if (!e.agent_id) return; // the main session
    let a = agents.get(e.agent_id);
    if (!a) {
      a = { id: e.agent_id, type: e.agent_type || 'agent', startedAt: e.ts, lastTs: e.ts, taskId: null, lastAction: '', steps: [], stopped: false };
      agents.set(e.agent_id, a);
    }
    if (e.agent_type) a.type = e.agent_type;
    if (e.task_id) a.taskId = e.task_id;
    if (e.launched) a.launched = true;
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
  logFile('notes.jsonl'),
  (e) => {
    if (!e.id) return;
    const note = notes.get(e.id) ?? { id: e.id, agentId: e.agent_id, ts: null, text: '', deliveredAt: null };
    if (e.event === 'queued') Object.assign(note, { ts: e.ts, text: e.text ?? '', agentId: e.agent_id, groupId: e.group_id ?? null });
    if (e.event === 'delivered') note.deliveredAt = e.ts;
    notes.set(e.id, note);
  },
  () => notes.clear(),
);

const answers = new Map();
const followAnswers = follow(
  logFile('answers.jsonl'),
  (e) => {
    if (!e.id) return;
    const answer = answers.get(e.id) ?? { id: e.id, deliveredAt: null };
    if (e.event === 'queued') Object.assign(answer, { ts: e.ts, itemId: e.item_id, itemText: e.item_text ?? '', text: e.text ?? '' });
    if (e.event === 'delivered') answer.deliveredAt = e.ts;
    answers.set(e.id, answer);
  },
  () => answers.clear(),
);

// ------------------------------------------------------------ the services

let health = null;
const tokens = createTokenStore({ launchedType: (sessionId) => launcher.launchedType(sessionId) });
let tokenSummary = null;
const launcher = createLauncher({ maxConcurrent: config.launch.maxConcurrent, agentsDir: config.launch.agentsDir, onChange: () => schedulePush() });
launcher.reconcile();

// Task -> milestone, from the board, else the part before the first dash.
function milestoneFinder(tasks) {
  const byTask = new Map(tasks.map((t) => [t.id, t.milestone]));
  const known = new Set(config.milestones.map((m) => String(m).toUpperCase()));
  return (taskId) => {
    const m = byTask.get(taskId);
    if (m) return m.toUpperCase();
    const prefix = String(taskId).split('-')[0].toUpperCase();
    return known.size === 0 || known.has(prefix) ? prefix : null;
  };
}

function refreshTokens(tasks) {
  tokens.scan();
  tokenSummary = tokens.summary(milestoneFinder(tasks));
}

// ----------------------------------------------------------------- the state

function where(cwd) {
  if (!cwd) return '';
  const rel = relative(PROJECT_DIR, cwd);
  if (!rel) return 'main checkout';
  return rel.startsWith('..') ? cwd : rel;
}

function describeAgent(a, t, notesByAgent) {
  const finish = readState(a.id, 'finish');
  const status = a.stopped ? 'finished' : t - Date.parse(a.lastTs) > QUIET_MS ? 'quiet' : 'running';
  const tok = tokenSummary?.byAgent.find((r) => r.agentId === a.id);
  return {
    id: a.id,
    type: a.type,
    status,
    launched: Boolean(a.launched),
    taskId: a.taskId ?? finish?.taskId ?? readState(a.id, 'task')?.taskId ?? null,
    where: where(a.cwd),
    startedAt: a.startedAt,
    lastTs: a.lastTs,
    stoppedAt: a.stoppedAt ?? null,
    lastAction: a.lastAction,
    steps: a.steps,
    finish: finish && { attempts: finish.attempts ?? 0, cleared: Boolean(finish.cleared), blocked: Boolean(finish.blocked) },
    notes: (notesByAgent.get(a.id) ?? []).slice(-5),
    tokens: tok ? { total: tok.totals.input + tok.totals.cacheWrite + tok.totals.cacheRead + tok.totals.output, perMinute: Math.round(tokenSummary.burnByAgent[a.id] ?? 0) } : null,
  };
}

function attentionOf(tasks, shown, guardrails, runs, t) {
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
  for (const run of runs) {
    if (run.status === 'failed' && t - Date.parse(run.endedAt) < 24 * 3600_000) out.push({ kind: 'error', text: `The launched ${run.agent} run failed: ${run.result?.text ?? ''}` });
  }
  for (const g of guardrails) {
    if (g.decision === 'error' && t - Date.parse(g.ts) < 24 * 3600_000) {
      out.push({ kind: 'error', text: `guard rail ${g.rule} itself failed${g.agent_type ? ` (${g.agent_type})` : ''}; see Activity`, ts: g.ts });
    }
  }
  return out;
}

// Open questions from the configured file, plus blocked tasks, each with the
// answers the user already gave.
function questionsOf(tasks) {
  const byItem = new Map();
  for (const a of [...answers.values()].filter((x) => x.ts).sort((x, y) => x.ts.localeCompare(y.ts))) {
    const list = byItem.get(a.itemId) ?? [];
    list.push({ id: a.id, ts: a.ts, text: a.text, deliveredAt: a.deliveredAt });
    byItem.set(a.itemId, list);
  }
  const items = [
    ...readOpenQuestions(config).map((q) => ({ id: q.id, kind: 'question', text: q.text })),
    ...tasks.filter((task) => task.status === 'blocked').map((task) => ({ id: task.id, kind: 'blocked task', text: task.blockedNotes || 'Blocked.' })),
  ];
  return items.map((item) => ({ ...item, answers: byItem.get(item.id) ?? [] }));
}

function buildState() {
  followActivity();
  followNotes();
  followAnswers();
  const t = Date.now();
  const { tasks, columns } = readBoard(config);
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
  const guardrails = tailJsonl(logFile('guardrails.jsonl'), 50).reverse();
  const runs = launcher.list();
  return {
    project: PROJECT_DIR,
    problems: configProblems,
    settings: { agentColors: config.agentColors, guardRails: config.guardRails, maxConcurrent: config.launch.maxConcurrent },
    milestones: milestonesOf(tasks, config.milestones),
    tasks,
    boardColumns: columns,
    agents: shown,
    attention: attentionOf(tasks, shown, guardrails, runs, t),
    guardrails,
    questions: questionsOf(tasks),
    launches: runs,
    tokens: tokenSummary && { today: tokenSummary.today, burnPerMinute: tokenSummary.burnPerMinute },
  };
}

// -------------------------------------------------------- live updates (SSE)

const clients = new Set();
const tickets = new Map();
const lastSent = new Map();

function issueTicket() {
  const t = Date.now();
  for (const [ticket, exp] of tickets) if (exp < t) tickets.delete(ticket);
  const ticket = randomBytes(18).toString('base64url');
  tickets.set(ticket, t + TICKET_MS);
  return { ticket };
}

function redeemTicket(ticket) {
  const exp = tickets.get(String(ticket ?? ''));
  tickets.delete(String(ticket ?? ''));
  return Boolean(exp && exp >= Date.now());
}

// Sends an event to every open page, only when it changed.
function broadcast(event, data, force = false) {
  const body = JSON.stringify(data);
  if (!force && lastSent.get(event) === body) return;
  lastSent.set(event, body);
  for (const res of clients) {
    try {
      res.write(`event: ${event}\ndata: ${body}\n\n`);
    } catch {
      clients.delete(res); // a page that went away
    }
  }
}

function pushState() {
  if (!clients.size) return;
  try {
    broadcast('state', buildState());
  } catch (error) {
    console.error(error);
  }
}

let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushState, 250);
}

// Log changes arrive at once through fs.watch; a slow tick catches anything
// it misses and the board file, which lives outside logs/.
try {
  watch(LOGS_DIR, { recursive: true }, (_, name) => {
    if (name && !String(name).startsWith('state')) schedulePush();
  });
} catch {}

async function refreshHealth() {
  health = await runHealth(config.health);
  broadcast('health', health);
}

function refreshTokensAndPush() {
  const before = JSON.stringify(tokenSummary);
  refreshTokens(readBoard(config).tasks);
  if (JSON.stringify(tokenSummary) !== before) {
    broadcast('tokens', tokenSummary);
    schedulePush();
  }
}

setInterval(() => {
  try {
    launcher.poll();
  } catch (error) {
    console.error(error);
  }
  if (clients.size) pushState();
}, 5000).unref();
setInterval(() => {
  if (clients.size) refreshHealth().catch((error) => console.error(error));
}, Math.max(5, config.health.intervalSeconds) * 1000).unref();
setInterval(() => {
  if (!clients.size) return;
  try {
    refreshTokensAndPush();
  } catch (error) {
    console.error(error);
  }
}, 10_000).unref();
setInterval(() => {
  try {
    tokens.save();
  } catch (error) {
    console.error(error);
  }
}, 60_000).unref();

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
        // Stop keeping it, but let the answer go out before the socket closes.
        reject(new HttpError(413, 'That is too large to send.'));
        req.removeAllListeners('data');
        req.resume();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Every change comes from the monitor page itself, as JSON.
async function readJsonBody(req) {
  if (!ALLOWED_ORIGINS.has(req.headers.origin ?? '')) throw new HttpError(403, 'Changes can only be made from the monitor page.');
  if (!/^application\/json\s*(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Send it as JSON.');
  try {
    return JSON.parse(await readBody(req)) ?? {};
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "That isn't valid JSON.");
  }
}

function noteText(body) {
  const text = String(body?.text ?? '').trim();
  if (!text) throw new HttpError(400, 'Write something first.');
  if (text.length > MAX_NOTE) throw new HttpError(400, `Keep it under ${MAX_NOTE} characters.`);
  return text;
}

// One note to one agent or several (D148). Each gets its own result.
async function queueNotes(req) {
  const body = await readJsonBody(req);
  const ids = [...new Set(Array.isArray(body.agentIds) ? body.agentIds.map(String) : [String(body.agentId ?? '')])].filter(Boolean);
  if (!ids.length) throw new HttpError(400, 'Pick at least one agent.');
  if (ids.length > 50) throw new HttpError(400, 'Pick at most 50 agents.');
  const text = noteText(body);
  const groupId = ids.length > 1 ? randomUUID() : undefined;
  followActivity();
  const results = ids.map((agentId) => {
    const run = agentId.startsWith('run-') ? launcher.runs.get(agentId.slice(4)) : null;
    if (run) {
      try {
        return { agentId, ok: true, mode: launcher.reply(run.sessionId, text).mode };
      } catch (error) {
        return { agentId, ok: false, error: error.message };
      }
    }
    const agent = agents.get(agentId);
    if (!agent) return { agentId, ok: false, error: 'There is no agent with that ID.' };
    if (agent.stopped) return { agentId, ok: false, error: 'It has finished. Notes reach agents only while they work.' };
    const note = { id: randomUUID(), ts: now(), text };
    queueInInbox(agentId, note);
    logNote({ id: note.id, agent_id: agentId, event: 'queued', text: clip(text, MAX_NOTE), group_id: groupId });
    return { agentId, ok: true, mode: 'next-step' };
  });
  schedulePush();
  return { results };
}

// An answer to an open question or blocked task, for the main session's
// next message (D155).
async function queueAnswer(req) {
  const body = await readJsonBody(req);
  const itemId = String(body.itemId ?? '').trim();
  if (!itemId || itemId.length > 80) throw new HttpError(400, 'That question ID is not valid.');
  const text = noteText(body);
  const answer = { id: randomUUID(), ts: now(), itemId, itemText: clip(body.itemText ?? '', 200), text };
  queueInInbox(MAIN_INBOX, answer);
  logAnswer({ id: answer.id, event: 'queued', item_id: itemId, item_text: answer.itemText, text: clip(text, MAX_NOTE) });
  schedulePush();
  return { id: answer.id, ts: answer.ts };
}

function taskLog(url) {
  const id = safeId(url.searchParams.get('id'));
  if (!id) throw new HttpError(400, "That task ID isn't valid.");
  try {
    return { id, text: readFileSync(join(LOGS_DIR, 'tasks', `${id}.md`), 'utf8') };
  } catch {
    throw new HttpError(404, `There's no log for ${id} yet.`);
  }
}

function agentConversation(url) {
  const agentId = String(url.searchParams.get('agentId') ?? '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(agentId)) throw new HttpError(400, "That agent ID isn't valid.");
  let file = tokens.fileOf(agentId);
  if (!file && agentId.startsWith('run-')) {
    // A run launched a moment ago: look for its session in the worktree folders.
    tokens.scan();
    file = tokens.fileOf(agentId);
  }
  if (!file) throw new HttpError(404, "Its conversation isn't saved yet. Try again in a few seconds.");
  return { agentId, items: conversation(file) };
}

// Search the activity or guard-rail log, newest first.
function search(url) {
  const log = url.searchParams.get('log') === 'guardrails' ? 'guardrails.jsonl' : 'activity.jsonl';
  const q = String(url.searchParams.get('q') ?? '').toLowerCase().slice(0, 200);
  const type = String(url.searchParams.get('type') ?? '');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 500);
  const out = [];
  for (const line of tailLines(logFile(log), 8 * 1024 * 1024).reverse()) {
    if (q && !line.toLowerCase().includes(q)) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (log === 'activity.jsonl' && !e.agent_id) continue;
    if (type && (e.agent_type || 'main') !== type) continue;
    out.push(e);
    if (out.length >= limit) break;
  }
  return { log: log.replace('.jsonl', ''), entries: out };
}

async function launch(req) {
  const body = await readJsonBody(req);
  const prompt = String(body.prompt ?? '');
  if (prompt.length > MAX_PROMPT) throw new HttpError(400, `Keep the prompt under ${MAX_PROMPT} characters.`);
  return launcher.launch({ agent: String(body.agent ?? ''), prompt, taskId: body.taskId || null, worktree: body.worktree || null });
}

async function stopRun(req) {
  const body = await readJsonBody(req);
  return launcher.stop(String(body.sessionId ?? ''));
}

function openStream(req, res, url) {
  if (!redeemTicket(url.searchParams.get('ticket'))) throw new HttpError(403, 'The live connection needs a fresh ticket. Reload the page.');
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  const drop = () => {
    clearInterval(ping);
    clients.delete(res);
  };
  req.on('close', drop);
  res.on('error', drop);
  // The first page after a quiet spell brings everything up to date.
  if (!tokenSummary) refreshTokens(readBoard(config).tasks);
  res.write(`event: state\ndata: ${JSON.stringify(buildState())}\n\n`);
  res.write(`event: tokens\ndata: ${JSON.stringify(tokenSummary)}\n\n`);
  if (health) res.write(`event: health\ndata: ${JSON.stringify(health)}\n\n`);
  else refreshHealth().catch((error) => console.error(error));
}

async function route(req, res) {
  // Only our own address, which blocks DNS-rebinding tricks.
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
    return send(res, 403, `Open the monitor at http://127.0.0.1:${PORT}`, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname === '/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Use GET.');
    const nonce = randomBytes(16).toString('base64');
    const page = readFileSync(PAGE_FILE, 'utf8').replaceAll('__NONCE__', nonce).replace('__MONITOR_KEY__', KEY);
    return send(res, 200, page, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': pageCsp(nonce) });
  }
  // EventSource can't send headers, so the stream takes a one-time ticket.
  if (req.method === 'GET' && url.pathname === '/api/events') return openStream(req, res, url);
  if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');
  if (!keyMatches(req.headers['x-monitor-key'])) throw new HttpError(403, 'The monitor restarted or the key is wrong. Reload the page.');
  const get = req.method === 'GET';
  const post = req.method === 'POST';
  switch (url.pathname) {
    case '/api/ticket':
      if (post) return json(res, 200, issueTicket());
      break;
    case '/api/state':
      if (get) return json(res, 200, buildState());
      break;
    case '/api/task-log':
      if (get) return json(res, 200, taskLog(url));
      break;
    case '/api/conversation':
      if (get) return json(res, 200, agentConversation(url));
      break;
    case '/api/search':
      if (get) return json(res, 200, search(url));
      break;
    case '/api/tokens':
      if (get) return json(res, 200, tokenSummary ?? (refreshTokens(readBoard(config).tasks), tokenSummary));
      break;
    case '/api/health':
      if (get) return json(res, 200, health ?? (await runHealth(config.health)));
      break;
    case '/api/agents':
      if (get) return json(res, 200, { agents: listAgents(config.launch.agentsDir) });
      break;
    case '/api/note':
      if (post) return json(res, 200, await queueNotes(req));
      break;
    case '/api/answer':
      if (post) return json(res, 200, await queueAnswer(req));
      break;
    case '/api/launch':
      if (post) return json(res, 200, await launch(req));
      break;
    case '/api/launch/stop':
      if (post) return json(res, 200, await stopRun(req));
      break;
    default:
      throw new HttpError(404, 'Not found.');
  }
  throw new HttpError(405, 'That method is not allowed here.');
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    const known = error instanceof HttpError || error instanceof LaunchError;
    if (!known) console.error(error);
    if (res.headersSent) return res.end();
    json(res, error.status ?? 500, { error: known ? error.message : 'The monitor hit an error; see its terminal.' });
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is busy. Pick another one: MONITOR_PORT=${PORT + 1} node .claude/monitor/server.mjs`);
  } else console.error(error);
  process.exit(1);
});

function shutdown() {
  tokens.save();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent monitor: http://127.0.0.1:${PORT}`);
  console.log(`Project ${PROJECT_DIR}, logs ${LOGS_DIR}, config ${CONFIG_FILE}. Stop it with Ctrl+C.`);
  for (const problem of configProblems) console.warn(problem);
  if (!projectFolders().length) console.warn("No saved Claude Code conversations found for this project yet, so token counts start at zero.");
});
