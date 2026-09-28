// Launching agents from the page (D151–D154, D156, D158).
// - Only agents defined in the project's agents folder, with flags the
//   server fixes: auto permission mode, never --bare, never skip-permissions,
//   so every hook and guard rail runs.
// - Each run works in its own git worktree; at most `maxConcurrent` run at
//   once and the rest wait in a queue.
// - A reply while a run works reaches it at its next step (its inbox); a
//   reply after it ends continues the same conversation (--resume).
// - The prompt goes in on stdin, so it can never be read as a flag.
// Runs are separate processes: they keep going if the monitor restarts, and
// logs/launches/<session>/ keeps their record.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LOGS_DIR, PROJECT_DIR, claimInbox, clip, logNote, now, queueInInbox, readJson, safeId, tailLines, writeJson } from './core.mjs';

export const MAX_PROMPT = 8000;
const WORKTREE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const runsDir = () => join(LOGS_DIR, 'launches');
const runDir = (sessionId) => join(runsDir(), sessionId);
export const runAgentId = (sessionId) => `run-${sessionId}`;

export class LaunchError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The agents the page may launch: name and description from each file's
// front matter.
export function listAgents(agentsDir) {
  const dir = resolve(PROJECT_DIR, agentsDir);
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const agents = [];
  for (const n of names) {
    const head = readFileSync(join(dir, n), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!head) continue;
    const field = (key) => head[1].match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
    const name = field('name');
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) agents.push({ name, description: field('description') });
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

// The command for a round: the first starts the session in a new worktree,
// later ones resume it inside that worktree.
export function commandFor(run, round) {
  // Auto mode, plus file edits inside its own worktree: headless, nobody can
  // approve edits under .claude/, where the worktree lives (D161).
  const common = ['--agent', run.agent, '--permission-mode', 'auto', '--allowedTools', 'Edit(./**)', '--output-format', 'stream-json', '--verbose'];
  if (round === 1) return { args: ['-p', ...common, '--worktree', run.worktree, '--session-id', run.sessionId], cwd: PROJECT_DIR };
  return { args: ['-p', '--resume', run.sessionId, ...common], cwd: join(PROJECT_DIR, '.claude', 'worktrees', run.worktree) };
}

// The outcome of a round from its stream: the final "result" line.
function resultOf(file) {
  for (const line of tailLines(file, 256 * 1024).reverse()) {
    if (!line.includes('"result"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === 'result') return { ok: !e.is_error, text: clip(e.result ?? e.subtype ?? '', 600) };
    } catch {}
  }
  return null;
}

function alive(pid, sessionId, execFn = execFileSync) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // The pid could have been reused by another program: check it's our run.
  try {
    return execFn('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes(sessionId);
  } catch {
    return false;
  }
}

export function createLauncher({ maxConcurrent = 2, agentsDir = '.claude/agents', spawnFn = spawn, execFn = execFileSync, onChange = () => {} } = {}) {
  const runs = new Map();
  const queue = [];
  const children = new Map();

  // Event handlers and timers call in here; an error must not end the server.
  const safely = (fn) => {
    try {
      fn();
    } catch (error) {
      console.error(error);
    }
  };
  const save = (run) => writeJson(join(runDir(run.sessionId), 'run.json'), run);
  const running = () => [...runs.values()].filter((r) => r.status === 'running').length;

  function start(run) {
    const round = run.rounds + 1;
    const dir = runDir(run.sessionId);
    mkdirSync(dir, { recursive: true });
    const promptFile = join(dir, `prompt-${round}.txt`);
    writeFileSync(promptFile, run.nextPrompt);
    const { args, cwd } = commandFor(run, round);
    if (!existsSync(cwd)) {
      Object.assign(run, { status: 'failed', endedAt: now(), result: { ok: false, text: `Its worktree is gone (${cwd}), so it can't continue.` } });
      save(run);
      return;
    }
    // Claude Code refuses to start inside itself when these are set.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const fds = [];
    let child;
    try {
      fds.push(openSync(promptFile, 'r'), openSync(join(dir, `out-${round}.jsonl`), 'a'), openSync(join(dir, `err-${round}.log`), 'a'));
      child = spawnFn('claude', args, { cwd, env, detached: true, stdio: fds });
    } finally {
      for (const fd of fds) closeSync(fd);
    }
    child.unref();
    children.set(run.sessionId, child);
    Object.assign(run, { status: 'running', pid: child.pid, rounds: round, roundStartedAt: now(), nextPrompt: undefined });
    for (const id of run.pendingNoteIds ?? []) logNote({ id, agent_id: run.agentId, event: 'delivered' });
    run.pendingNoteIds = undefined;
    save(run);
    child.on('error', (error) => safely(() => finish(run, { ok: false, text: `It couldn't start: ${error.message}` })));
    child.on('exit', () => safely(() => finish(run)));
  }

  function pump() {
    while (queue.length && running() < maxConcurrent) {
      const run = queue.shift();
      if (run.status !== 'queued') continue;
      try {
        start(run);
      } catch (error) {
        // A run that can't start (disk full, too many open files) fails alone.
        Object.assign(run, { status: 'failed', endedAt: now(), result: { ok: false, text: `It couldn't start: ${error.message}` } });
        safely(() => save(run));
      }
    }
  }

  function finish(run, forced) {
    children.delete(run.sessionId);
    if (run.status !== 'running') return;
    const round = run.rounds;
    const result = forced ?? resultOf(join(runDir(run.sessionId), `out-${round}.jsonl`));
    const err = tailLines(join(runDir(run.sessionId), `err-${round}.log`), 4096).join('\n');
    Object.assign(run, {
      status: run.stopping ? 'stopped' : result?.ok ? 'ended' : 'failed',
      endedAt: now(),
      pid: null,
      stopping: undefined,
      result: result ?? { ok: false, text: clip(err || 'It ended without a result.', 600) },
    });
    save(run);
    // Notes that arrived after its last step start the next round.
    const late = run.status === 'stopped' ? [] : claimInbox(runAgentId(run.sessionId));
    if (late.length) queueRound(run, late.map((n) => n.text).join('\n\n'), late.map((n) => n.id));
    pump();
    onChange();
  }

  function queueRound(run, text, noteIds = []) {
    Object.assign(run, { status: 'queued', nextPrompt: text, pendingNoteIds: noteIds, queuedAt: now() });
    save(run);
    queue.push(run);
  }

  function launch({ agent, prompt, taskId, worktree }) {
    const allowed = listAgents(agentsDir).map((a) => a.name);
    if (!allowed.includes(agent)) throw new LaunchError(400, 'Pick one of the agents in the list.');
    const text = String(prompt ?? '').trim();
    if (!text) throw new LaunchError(400, 'Write a prompt first.');
    if (text.length > MAX_PROMPT) throw new LaunchError(400, `Keep the prompt under ${MAX_PROMPT} characters.`);
    const task = taskId ? safeId(String(taskId).trim()) : null;
    if (taskId && !task) throw new LaunchError(400, 'A task ID has letters, digits, dots, dashes or underscores.');
    const sessionId = randomUUID();
    const name = worktree ? String(worktree).trim().toLowerCase() : `run-${sessionId.slice(0, 8)}`;
    if (!WORKTREE_NAME.test(name)) throw new LaunchError(400, 'A worktree name is lower-case letters, digits and dashes, up to 40.');
    if (existsSync(join(PROJECT_DIR, '.claude', 'worktrees', name)) || [...runs.values()].some((r) => r.worktree === name)) {
      throw new LaunchError(409, `The worktree "${name}" is already in use. Pick another name.`);
    }
    const run = { sessionId, agentId: runAgentId(sessionId), agent, taskId: task, worktree: name, prompt: clip(text, 400), createdAt: now(), rounds: 0 };
    runs.set(sessionId, run);
    queueRound(run, task ? `Task: ${task}\n${text}` : text);
    pump();
    onChange();
    return view(run);
  }

  function reply(sessionId, text) {
    const run = runs.get(sessionId);
    if (!run) throw new LaunchError(404, 'There is no launched run with that ID.');
    const note = { id: randomUUID(), ts: now(), text };
    logNote({ id: note.id, agent_id: run.agentId, event: 'queued', text: clip(text, 2000) });
    if (run.status === 'running' || run.status === 'queued') {
      // Reaches it at its next step; if it ends first, finish() starts a round.
      queueInInbox(run.agentId, note);
      return { mode: 'next-step' };
    }
    queueRound(run, text, [note.id]);
    pump();
    onChange();
    return { mode: 'new-round' };
  }

  function stop(sessionId) {
    const run = runs.get(sessionId);
    if (!run) throw new LaunchError(404, 'There is no launched run with that ID.');
    if (run.status === 'queued') {
      const k = queue.indexOf(run);
      if (k >= 0) queue.splice(k, 1);
      Object.assign(run, { status: 'stopped', endedAt: now() });
      save(run);
    } else if (run.status === 'running') {
      if (!alive(run.pid, sessionId, execFn)) {
        finish(run);
        return view(run);
      }
      run.stopping = true;
      save(run);
      try {
        process.kill(-run.pid, 'SIGTERM'); // its whole process group
      } catch {
        process.kill(run.pid, 'SIGTERM');
      }
    } else throw new LaunchError(409, 'This run is not running.');
    onChange();
    return view(run);
  }

  // After a restart: runs still going are watched again, queued ones requeued.
  function reconcile() {
    let names = [];
    try {
      names = readdirSync(runsDir());
    } catch {}
    for (const name of names) {
      const run = readJson(join(runDir(name), 'run.json'));
      if (!run?.sessionId || runs.has(run.sessionId)) continue;
      runs.set(run.sessionId, run);
      if (run.status === 'queued') queue.push(run);
    }
    queue.sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
    poll();
  }

  // Runs started before a restart have no exit event: check they're alive.
  function poll() {
    for (const run of runs.values()) {
      if (run.status === 'running' && !children.has(run.sessionId) && !alive(run.pid, run.sessionId, execFn)) safely(() => finish(run));
    }
    pump();
  }

  function view(run) {
    const { nextPrompt, pendingNoteIds, stopping, ...rest } = run;
    return { ...rest, queuePosition: run.status === 'queued' ? queue.indexOf(run) + 1 : null };
  }

  const list = () => [...runs.values()].map(view).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const launchedType = (sessionId) => runs.get(sessionId)?.agent ?? null;

  return { launch, reply, stop, reconcile, poll, list, launchedType, runs };
}
