import { LOGS, ROOT, input } from './helpers.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_FAILED_CHECKS, decideFinish } from '../check-finish.mjs';
import { readState } from '../lib/state.mjs';

const report = (obj) => `Done.\n\`\`\`handoff\n${JSON.stringify(obj)}\n\`\`\``;
const pass = () => ({ ok: true, lines: ['lint: pass'], failures: [] });
const fail = () => ({ ok: false, lines: ['tests: fail'], failures: [{ label: 'tests', message: "the task's tests fail", output: 'FAIL  1 failed' }] });
const noChecks = () => assert.fail('no checks should run');
const here = () => []; // the agent is in its task's own copy (D168)
const taskLog = (id) => readFileSync(join(LOGS, 'tasks', `${id}.md`), 'utf8');

let count = 0;
function agent(agentType) {
  const id = `fin-${agentType}-${(count += 1)}`;
  const event = (raw) => input({ agent_id: id, agent_type: agentType, cwd: ROOT, ...raw });
  return {
    id,
    handIn: (text) => event({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_input: { message: text } }),
    stop: (text) => event({ hook_event_name: 'SubagentStop', last_assistant_message: text }),
  };
}

test('leaves the main session, other agents and other tools alone', () => {
  const handIn = { hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_input: { message: 'x' } };
  assert.equal(decideFinish(input(handIn), noChecks), null);
  assert.equal(decideFinish(input({ ...handIn, agent_id: 'e1', agent_type: 'Explore' }), noChecks), null);
  assert.equal(decideFinish(input({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'e2', agent_type: 'builder-backend' }), noChecks), null);
});

test('asks for a hand-off block', () => {
  assert.match(decideFinish(agent('builder-backend').handIn('all done'), noChecks).reason, /hand-off block/);
});

test("a builder finishes when its checks pass, and isn't checked again when it stops", () => {
  const a = agent('builder-backend');
  let runs = 0;
  const checks = () => {
    runs += 1;
    return pass();
  };
  assert.equal(decideFinish(a.handIn(report({ taskId: 'S1-001', status: 'done', tests: { run: 'pnpm test' } })), checks, here), null);
  assert.equal(decideFinish(a.stop(''), checks, here), null);
  assert.equal(runs, 1);
  assert.match(taskLog('S1-001'), /## Hand-in 1 · builder-backend[\s\S]*checks passed/);
});

test('failed checks send a builder back; after 3, only a blocked hand-off finishes (D86)', () => {
  const a = agent('builder-data');
  const done = report({ taskId: 'S8-002', status: 'done', tests: { run: 'pnpm test' } });
  for (let k = 1; k <= MAX_FAILED_CHECKS; k += 1) {
    const expected = k < MAX_FAILED_CHECKS ? `failed check ${k} of 3` : 'only finish by handing in with status "blocked"';
    assert.ok(decideFinish(a.handIn(done), fail, here).reason.includes(expected), expected);
  }
  assert.equal(readState(a.id, 'finish').attempts, 3);
  assert.match(taskLog('S8-002'), /sent back \(failed check 3 of 3\)[\s\S]*FAIL {2}1 failed/);
  assert.equal(decideFinish(a.handIn(report({ taskId: 'S8-002', status: 'blocked', findings: 'the fixture is wrong' })), fail), null);
  assert.equal(readState(a.id, 'finish').blocked, true);
});

test('a blocked hand-off needs findings', () => {
  assert.match(decideFinish(agent('builder-frontend').handIn(report({ taskId: 'S6-001', status: 'blocked' })), fail).reason, /needs findings/);
});

test('reviewers and the planner finish without checks', () => {
  const reviewer = agent('code-reviewer');
  assert.equal(decideFinish(reviewer.handIn(report({ taskId: 'S1-004', status: 'sent-back', findings: 'a.ts:3 misses the org check' })), noChecks), null);
  assert.match(taskLog('S1-004'), /## Sent back · code-reviewer/);
  assert.equal(decideFinish(agent('planner').handIn(report({ taskId: 'S1', status: 'done' })), noChecks), null);
});

test('at SubagentStop, the backup runs the checks when nothing was handed in', () => {
  assert.match(decideFinish(agent('integrator').stop(report({ taskId: 'S1-005', status: 'done' })), fail).reason, /didn't pass/);
});

test("a task ID that isn't safe as a file name is replaced", () => {
  const planner = agent('planner');
  assert.equal(decideFinish(planner.handIn(report({ taskId: '../../etc', status: 'done' })), noChecks), null);
  assert.equal(readState(planner.id, 'finish').taskId, `unknown-${planner.id}`);
});

test('a test writer or builder outside its task\'s copy is sent back before any check runs (D168)', () => {
  const a = agent('test-writer');
  const away = () => ["you're in the main checkout, not your task's worktree (D168)"];
  const r = decideFinish(a.handIn(report({ taskId: 'S1-007', status: 'done', tests: { run: 'pnpm test' } })), noChecks, away);
  assert.match(r.reason, /main checkout[\s\S]*failed check 1 of 3/);
});

test('a fix is logged with its reason (D167)', () => {
  const a = agent('test-writer');
  const h = report({ taskId: 'S1-008', status: 'done', fixReason: 'contradicted M0-010', tests: { run: 'pnpm test' } });
  assert.equal(decideFinish(a.handIn(h), pass, here), null);
  assert.match(taskLog('S1-008'), /fix \(D167\): contradicted M0-010/);
});
