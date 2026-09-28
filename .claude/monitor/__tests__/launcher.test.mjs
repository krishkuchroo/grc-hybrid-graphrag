import { LOGS, PROJECT, put, readJsonl } from './helpers.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { claimInbox } from '../lib/core.mjs';
import { commandFor, createLauncher, listAgents } from '../lib/launcher.mjs';

put(PROJECT, '.claude/agents/builder-backend.md', '---\nname: builder-backend\ndescription: Builds the API.\ntools: Read, Edit\n---\nBody.\n');
put(PROJECT, '.claude/agents/planner.md', '---\nname: planner\ndescription: "Plans a milestone."\n---\n');
put(PROJECT, '.claude/agents/notes.md', 'no front matter here\n');

// A fake `claude`: records each call and exits when told to.
function fakeSpawn() {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 40000 + calls.length;
    child.unref = () => {};
    const stdin = readFileSync(opts.stdio[0] === 'ignore' ? '/dev/null' : `/dev/fd/${opts.stdio[0]}`, 'utf8');
    calls.push({ cmd, args, opts, stdin, child });
    return child;
  };
  return { spawnFn, calls };
}

// The fake reads the prompt before the launcher closes its file.
test('only agents from the agents folder can be launched', () => {
  assert.deepEqual(listAgents('.claude/agents').map((a) => [a.name, a.description]), [['builder-backend', 'Builds the API.'], ['planner', 'Plans a milestone.']]);
  const { spawnFn } = fakeSpawn();
  const l = createLauncher({ spawnFn });
  assert.throws(() => l.launch({ agent: 'general-purpose', prompt: 'hi' }), /Pick one of the agents/);
  assert.throws(() => l.launch({ agent: 'planner', prompt: '   ' }), /Write a prompt/);
  assert.throws(() => l.launch({ agent: 'planner', prompt: 'hi', worktree: '../escape' }), /worktree name/);
  assert.throws(() => l.launch({ agent: 'planner', prompt: 'hi', taskId: 'bad id!' }), /task ID/);
});

test('the flags are fixed: auto mode, edits only in its worktree, never bare or skip-permissions', () => {
  const run = { agent: 'planner', sessionId: 's-1', worktree: 'wt-1' };
  for (const round of [1, 2]) {
    const { args } = commandFor(run, round);
    assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), ['--permission-mode', 'auto']);
    assert.deepEqual(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2), ['--allowedTools', 'Edit(./**)']);
    assert.ok(!args.some((a) => /bare|dangerously|bypass/i.test(a)), args.join(' '));
  }
  assert.deepEqual(commandFor(run, 1).args.slice(-4), ['--worktree', 'wt-1', '--session-id', 's-1']);
  assert.equal(commandFor(run, 1).cwd, PROJECT);
  assert.deepEqual(commandFor(run, 2).args.slice(0, 3), ['-p', '--resume', 's-1']);
  assert.equal(commandFor(run, 2).cwd, join(PROJECT, '.claude', 'worktrees', 'wt-1'));
});

test('the prompt goes in on stdin, never as an argument; at most N run and the rest queue', () => {
  const { spawnFn, calls } = fakeSpawn();
  const l = createLauncher({ spawnFn, maxConcurrent: 2, execFn: () => '' });
  const a = l.launch({ agent: 'planner', prompt: '--help me', taskId: 'M0-001' });
  const b = l.launch({ agent: 'builder-backend', prompt: 'second' });
  const c = l.launch({ agent: 'planner', prompt: 'third' });
  assert.deepEqual([a.status, b.status, c.status], ['running', 'running', 'queued']);
  assert.equal(c.queuePosition, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].stdin, 'Task: M0-001\n--help me');
  assert.ok(!calls[0].args.includes('--help me'));
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.env.CLAUDECODE, undefined);
  // The first ends: the queued one starts.
  writeFileSync(join(LOGS, 'launches', a.sessionId, 'out-1.jsonl'), `${JSON.stringify({ type: 'result', is_error: false, result: 'All done.' })}\n`);
  calls[0].child.emit('exit', 0);
  assert.equal(calls.length, 3);
  const ended = l.list().find((r) => r.sessionId === a.sessionId);
  assert.deepEqual([ended.status, ended.result.text], ['ended', 'All done.']);
  assert.equal(l.list().find((r) => r.sessionId === c.sessionId).status, 'running');
  // A run that ends without a result failed.
  calls[1].child.emit('exit', 1);
  assert.equal(l.list().find((r) => r.sessionId === b.sessionId).status, 'failed');
});

test('a reply reaches a working run at its next step, and continues an ended run', () => {
  const { spawnFn, calls } = fakeSpawn();
  const l = createLauncher({ spawnFn, execFn: () => '' });
  const run = l.launch({ agent: 'planner', prompt: 'start', worktree: 'reply-wt' });
  assert.equal(l.reply(run.sessionId, 'while working').mode, 'next-step');
  assert.deepEqual(claimInbox(`run-${run.sessionId}`).map((n) => n.text), ['while working']);
  calls[0].child.emit('exit', 0);
  mkdirSync(join(PROJECT, '.claude', 'worktrees', 'reply-wt'), { recursive: true });
  assert.equal(l.reply(run.sessionId, 'one more thing').mode, 'new-round');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].stdin, 'one more thing');
  assert.equal(calls[1].args[1], '--resume');
  const notes = readJsonl(join(LOGS, 'notes.jsonl')).filter((n) => n.agent_id === `run-${run.sessionId}`);
  assert.deepEqual(notes.map((n) => n.event), ['queued', 'queued', 'delivered']);
});

test('a note that arrives as a run ends starts its next round', () => {
  const { spawnFn, calls } = fakeSpawn();
  const l = createLauncher({ spawnFn, execFn: () => '' });
  const run = l.launch({ agent: 'planner', prompt: 'start', worktree: 'late-wt' });
  mkdirSync(join(PROJECT, '.claude', 'worktrees', 'late-wt'), { recursive: true });
  l.reply(run.sessionId, 'late note');
  calls[0].child.emit('exit', 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].stdin, 'late note');
});

test('stop ends a queued run at once, and only signals a live process that is ours', () => {
  const { spawnFn, calls } = fakeSpawn();
  const l = createLauncher({ spawnFn, maxConcurrent: 1, execFn: () => 'claude -p --session-id nope' });
  const a = l.launch({ agent: 'planner', prompt: 'a' });
  const b = l.launch({ agent: 'planner', prompt: 'b' });
  assert.equal(l.stop(b.sessionId).status, 'stopped');
  // `ps` shows a different program under that pid: it's marked ended, not killed.
  const stopped = l.stop(a.sessionId);
  assert.notEqual(stopped.status, 'running');
  assert.equal(calls.length, 1);
  assert.throws(() => l.stop(a.sessionId), /not running/);
});

test('after a restart, runs are read back and queued ones wait again', () => {
  const { spawnFn } = fakeSpawn();
  const first = createLauncher({ spawnFn, maxConcurrent: 0 });
  const q = first.launch({ agent: 'planner', prompt: 'later' });
  const again = createLauncher({ spawnFn, maxConcurrent: 0, execFn: () => '' });
  again.reconcile();
  assert.equal(again.list().find((r) => r.sessionId === q.sessionId).status, 'queued');
});

test('a run that cannot start fails alone, and the next one still starts', () => {
  const { spawnFn, calls } = fakeSpawn();
  let first = true;
  const flaky = (...a) => {
    if (first) {
      first = false;
      throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
    }
    return spawnFn(...a);
  };
  const l = createLauncher({ spawnFn: flaky, maxConcurrent: 1, execFn: () => '' });
  const a = l.launch({ agent: 'planner', prompt: 'one' });
  const b = l.launch({ agent: 'planner', prompt: 'two' });
  const byId = (id) => l.list().find((r) => r.sessionId === id);
  assert.equal(byId(a.sessionId).status, 'failed');
  assert.match(byId(a.sessionId).result.text, /too many open files/);
  assert.equal(byId(b.sessionId).status, 'running');
  assert.equal(calls.length, 1);
  // An error while it ends is logged, not thrown into the event loop.
  calls[0].child.emit('exit', 0);
});
