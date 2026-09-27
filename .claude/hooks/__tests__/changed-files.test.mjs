import { LOGS, ROOT, git, input, makeRepo, put, readJsonl } from './helpers.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideChanged } from '../check-changed-files.mjs';
import { changedSince, createdSinceStart, snapshot } from '../lib/checkout.mjs';
import { writeState } from '../lib/state.mjs';

test('a snapshot records HEAD and the files already changed', () => {
  const repo = makeRepo(undefined, { 'a.ts': 'a\n', 'b.ts': 'b\n' });
  put(repo, 'a.ts', 'a changed\n');
  put(repo, 'new.ts', 'new\n');
  const s = snapshot(repo);
  assert.equal(s.repo, repo);
  assert.match(s.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(s.dirty).sort(), ['a.ts', 'new.ts']);
  assert.deepEqual(snapshot(mkdtempSync(join(ROOT, 'plain-'))), { repo: null });
});

test("lists what the agent changed, not what was already dirty or edited by others", () => {
  const repo = makeRepo(undefined, { 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n', 'd.ts': 'd\n' });
  put(repo, 'untracked-before.ts', 'already here\n');
  put(repo, 'b.ts', 'b edited before the start\n');
  put(repo, 'd.ts', 'd edited before the start\n');
  const start = { ...snapshot(repo), startedAt: new Date().toISOString() };
  put(repo, 'a.ts', 'a changed by the agent\n');
  put(repo, 'created.ts', 'made by the agent\n');
  put(repo, 'd.ts', 'd edited again by the agent, now longer\n');
  put(repo, 'c.ts', 'c changed by the main session\n');
  const activity = join(ROOT, 'activity-changed.jsonl');
  const edit = { ts: new Date().toISOString(), event: 'edit', agent_id: null, agent_type: 'main', tool: 'Edit', path: join(repo, 'c.ts') };
  writeFileSync(activity, `${JSON.stringify(edit)}\n`);
  assert.deepEqual(changedSince(start, 'me', activity).sort(), ['a.ts', 'created.ts', 'd.ts']);
});

test("in a worktree, main's later commits aren't the agent's, but its own branch commits are", () => {
  const repo = makeRepo(undefined, { 'memory.md': 'm\n', 'a.ts': 'a\n' });
  const wt = join(repo, '.wt');
  git(repo, 'worktree', 'add', '-q', '--detach', wt);
  const start = { ...snapshot(wt), startedAt: new Date().toISOString() };
  put(repo, 'memory.md', 'a decision made on main\n');
  git(repo, 'commit', '-qam', 'main moves on');
  git(wt, 'switch', '-q', '-c', 'task/X', 'main');
  put(wt, 'a.test.ts', 'the agent\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'X: tests');
  assert.deepEqual(changedSince(start, 'wt-agent', '/nonexistent'), ['a.test.ts']);
  put(wt, 'memory.md', 'the agent edits it\n');
  git(wt, 'commit', '-qam', 'X: sneaky');
  assert.deepEqual(changedSince(start, 'wt-agent', '/nonexistent').sort(), ['a.test.ts', 'memory.md']);
});

test("a builder that takes a task branch doesn't own the test writer's commits there", () => {
  const repo = makeRepo(undefined, { 'a.ts': 'a\n' });
  git(repo, 'branch', 'task/Y');
  const tw = join(repo, '.tw');
  git(repo, 'worktree', 'add', '-q', tw, 'task/Y');
  put(tw, 'a.test.ts', 'the test writer\n');
  git(tw, 'add', '-A');
  git(tw, 'commit', '-qm', 'Y: tests');
  git(tw, 'switch', '-q', '--detach');
  const wt = join(repo, '.builder');
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
  const start = { ...snapshot(wt), startedAt: new Date().toISOString() };
  git(wt, 'switch', '-q', 'task/Y');
  put(wt, 'a.ts', 'built\n');
  assert.deepEqual(changedSince(start, 'builder', '/nonexistent'), ['a.ts']);
  put(wt, 'a.test.ts', 'weakened\n');
  assert.deepEqual(changedSince(start, 'builder', '/nonexistent').sort(), ['a.test.ts', 'a.ts']);
});

test('a resumed agent that rebases its old branch onto a newer main owns only its own work', () => {
  const repo = makeRepo(undefined, { 'skills.md': 's\n' });
  const wt = join(repo, '.wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'task/Z', wt);
  put(wt, 'z.test.ts', 'tests\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'Z: tests');
  git(wt, 'switch', '-q', '--detach');
  const start = { ...snapshot(wt), startedAt: new Date().toISOString() };
  put(repo, 'skills.md', 'fixed on main\n');
  git(repo, 'commit', '-qam', 'main moves on');
  git(wt, 'switch', '-q', 'task/Z');
  git(wt, 'rebase', '-q', 'main');
  assert.deepEqual(changedSince(start, 'resumed', '/nonexistent'), []);
  git(wt, 'rm', '-q', 'skills.md');
  assert.deepEqual(changedSince(start, 'resumed', '/nonexistent'), ['skills.md']);
});

test('createdSinceStart is true only for files the agent made', () => {
  const repo = makeRepo(undefined, { 'src/old.test.ts': 'x\n' });
  put(repo, 'src/before.test.ts', 'before\n');
  const start = snapshot(repo);
  const made = put(repo, 'src/made.test.ts', 'made\n');
  assert.equal(createdSinceStart(start, made), true);
  assert.equal(createdSinceStart(start, join(repo, 'src/old.test.ts')), false);
  assert.equal(createdSinceStart(start, join(repo, 'src/before.test.ts')), false);
  assert.equal(createdSinceStart({ repo: null }, made), false);
});

let count = 0;
function startedAgent(repo, agentType) {
  const id = `chg-${agentType}-${(count += 1)}`;
  writeState(id, 'start', { ...snapshot(repo), startedAt: new Date().toISOString() });
  return (text) =>
    input({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_input: { message: text }, agent_id: id, agent_type: agentType, cwd: repo });
}
const handoff = (obj) => `\`\`\`handoff\n${JSON.stringify(obj)}\n\`\`\``;
const done = handoff({ taskId: 'S1-001', status: 'done' });

test('sends a builder back for changed test files (guard rail 7)', () => {
  const repo = makeRepo(undefined, { 'src/a.test.ts': 'old\n' });
  const handIn = startedAgent(repo, 'builder-backend');
  put(repo, 'src/a.test.ts', 'weakened\n');
  const verdict = decideChanged(handIn(done));
  assert.equal(verdict.rule, '7');
  assert.match(verdict.reason, /src\/a\.test\.ts[\s\S]*git restore/);
});

test('sends any agent back for protected files, but the planner edits the plan files (guard rail 5)', () => {
  const repo = makeRepo(undefined, { 'memory.md': 'm\n', 'TASKS.md': 't\n' });
  const builder = startedAgent(repo, 'builder-platform');
  put(repo, 'memory.md', 'changed\n');
  assert.equal(decideChanged(builder(done)).rule, '5');

  const repo2 = makeRepo(undefined, { 'memory.md': 'm\n', 'TASKS.md': 't\n' });
  const planner = startedAgent(repo2, 'planner');
  put(repo2, 'TASKS.md', 'the board\n');
  assert.equal(decideChanged(planner(done)), null);
});

test('skips the integrator, and lets a blocked hand-off with findings finish', () => {
  const repo = makeRepo(undefined, { 'src/a.test.ts': 'old\n' });
  const integrator = startedAgent(repo, 'integrator');
  put(repo, 'src/a.test.ts', 'merged\n');
  assert.equal(decideChanged(integrator(done)), null);

  const repo2 = makeRepo(undefined, { 'src/a.test.ts': 'old\n' });
  const builder = startedAgent(repo2, 'builder-backend');
  put(repo2, 'src/a.test.ts', 'changed\n');
  assert.equal(decideChanged(builder(handoff({ taskId: 'S1-001', status: 'blocked', findings: 'the test expects the wrong status code' }))), null);
});

test('a blocked hand-in still records the files it had no right to change (D119)', () => {
  const repo = makeRepo(undefined, { 'src/a.test.ts': 'old\n', 'memory.md': 'm\n' });
  const builder = startedAgent(repo, 'builder-data');
  put(repo, 'src/a.test.ts', 'changed\n');
  put(repo, 'memory.md', 'changed\n');
  assert.equal(decideChanged(builder(handoff({ taskId: 'S3-009', status: 'blocked', findings: 'stuck' }))), null);
  const log = readFileSync(join(LOGS, 'tasks', 'S3-009.md'), 'utf8');
  assert.match(log, /Changed files it can't edit[\s\S]*test files[\s\S]*src\/a\.test\.ts[\s\S]*protected files[\s\S]*memory\.md/);
  const noted = readJsonl(join(LOGS, 'guardrails.jsonl')).filter((e) => e.decision === 'noted').at(-1);
  assert.deepEqual([noted.rule, noted.agent_type, noted.subject], ['7', 'builder-data', 'src/a.test.ts, memory.md']);
});

test('does nothing without a start snapshot', () => {
  const handIn = { hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_input: { message: done }, cwd: ROOT };
  assert.equal(decideChanged(input({ ...handIn, agent_id: 'never-started', agent_type: 'builder-backend' })), null);
});
