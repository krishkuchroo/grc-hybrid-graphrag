import { LOGS, ROOT, put, readJsonl, runHook } from './helpers.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAIN_INBOX, inboxFile, queueInInbox, readState } from '../lib/core.mjs';
import { handleEvent, noteContext, parseInput } from '../hook.mjs';

const SESSION = join(ROOT, 'sessions', 'sess1.jsonl');
const activity = (agentId) => readJsonl(join(LOGS, 'activity.jsonl')).filter((e) => e.agent_id === agentId);
const input = (raw) => parseInput(JSON.stringify(raw));
const tool = (agentId, agentType, toolName, toolInput) =>
  input({ hook_event_name: 'PreToolUse', transcript_path: SESSION, cwd: ROOT, agent_id: agentId, agent_type: agentType, tool_name: toolName, tool_input: toolInput });

// Claude Code keeps an agent's transcript next to the session's.
const writeBrief = (agentId, content, sub = '') =>
  put(join(ROOT, 'sessions', 'sess1', 'subagents', sub), `agent-${agentId}.jsonl`, `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);

test('the main session logs nothing; subagents log a start once and each step with its task', () => {
  handleEvent(input({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a' }, cwd: ROOT }));
  assert.equal(readJsonl(join(LOGS, 'activity.jsonl')).length, 0);
  writeBrief('m1', 'Task: S1-003\nGoal: add the risk register list.');
  handleEvent(input({ hook_event_name: 'SubagentStart', agent_id: 'm1', agent_type: 'builder-backend', cwd: ROOT, transcript_path: SESSION }));
  handleEvent(tool('m1', 'builder-backend', 'Bash', { command: 'pnpm test', description: 'Run the tests' }));
  handleEvent(tool('m1', 'builder-backend', 'Read', { file_path: join(ROOT, 'src/a.ts') }));
  const steps = activity('m1');
  assert.deepEqual(steps.map((s) => s.event), ['start', 'tool', 'tool']);
  assert.deepEqual(steps.slice(1).map((s) => [s.task_id, s.tool, s.subject]), [['S1-003', 'Bash', 'Run the tests — pnpm test'], ['S1-003', 'Read', 'src/a.ts']]);
});

test("finds a workflow agent's brief one folder down, and retries a brief not written yet", () => {
  writeBrief('w1', 'Task: SMOKE-WF-001\nDo it.', join('workflows', 'wf_1'));
  handleEvent(tool('w1', 'builder-backend', 'Bash', { command: 'echo' }));
  assert.equal(activity('w1').at(-1).task_id, 'SMOKE-WF-001');
  handleEvent(tool('m4', 'planner', 'Read', { file_path: 'x' }));
  assert.deepEqual(readState('m4', 'task'), { taskId: null, tries: 1 });
  writeBrief('m4', [{ type: 'text', text: 'Task: M0-001 plan' }]);
  handleEvent(tool('m4', 'planner', 'Read', { file_path: 'x' }));
  assert.equal(readState('m4', 'task').taskId, 'M0-001');
});

test("the user's notes reach the agent once, at its next step, and wait during a hand-in", () => {
  queueInInbox('m5', { id: 'n1', ts: '2026-09-26T14:05:00.000Z', text: 'Use the grc_ prefix.' });
  assert.equal(handleEvent(tool('m5', 'builder-data', 'SubagentHandback', { message: 'report' })), null);
  assert.equal(existsSync(inboxFile('m5')), true);
  const out = handleEvent(tool('m5', 'builder-data', 'Bash', { command: 'ls' }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /^Note from the user[\s\S]*grc_ prefix[\s\S]*status "blocked"/);
  assert.equal(handleEvent(tool('m5', 'builder-data', 'Bash', { command: 'ls' })), null);
  assert.deepEqual(readJsonl(join(LOGS, 'notes.jsonl')).filter((e) => e.event === 'delivered').map((e) => e.id), ['n1']);
});

test('many long notes are spread over steps to stay under the context cap', () => {
  const notes = Array.from({ length: 6 }, (_, k) => ({ id: `L${k}`, ts: new Date().toISOString(), text: 'x'.repeat(2000) }));
  const { context, delivered, left } = noteContext(notes);
  assert.ok(context.length < 10_000);
  assert.ok(left.length > 0);
  assert.deepEqual([...delivered, ...left].map((n) => n.id), notes.map((n) => n.id));
});

test("answers ride along with the main session's next message, once (D155)", () => {
  queueInInbox(MAIN_INBOX, { id: 'a1', ts: new Date().toISOString(), itemId: 'Q33', itemText: 'the dev switch', text: 'Go with (a).' });
  // A launched run's prompt must not take them (D158).
  assert.equal(handleEvent(input({ hook_event_name: 'UserPromptSubmit', agent_type: 'planner', session_id: 'r1', cwd: ROOT })), null);
  const out = handleEvent(input({ hook_event_name: 'UserPromptSubmit', session_id: 'main', cwd: ROOT }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /Q33 \("the dev switch"\): Go with \(a\)\.[\s\S]*planner record/);
  assert.equal(handleEvent(input({ hook_event_name: 'UserPromptSubmit', session_id: 'main', cwd: ROOT })), null);
  assert.deepEqual(readJsonl(join(LOGS, 'answers.jsonl')).map((e) => [e.id, e.event]), [['a1', 'delivered']]);
});

test('a launched run is an agent: its own transcript, its notes, its Stop', () => {
  const transcript = put(ROOT, 'wt/run1.jsonl', `${JSON.stringify({ type: 'user', message: { content: 'Task: SBX-9\nGo.' } })}\n`);
  const launched = (event, extra = {}) => input({ hook_event_name: event, agent_type: 'builder-backend', session_id: 'run1', transcript_path: transcript, cwd: ROOT, ...extra });
  handleEvent(launched('SessionStart'));
  queueInInbox('run-run1', { id: 'n9', ts: new Date().toISOString(), text: 'Also do X.' });
  const out = handleEvent(launched('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.match(out.hookSpecificOutput.additionalContext, /Also do X/);
  handleEvent(launched('Stop'));
  const steps = activity('run-run1');
  assert.deepEqual(steps.map((s) => s.event), ['start', 'tool', 'stop']);
  assert.equal(steps[0].launched, true);
  assert.equal(steps[1].task_id, 'SBX-9');
});

test("Claude Code's helper agents are ignored, and the script never blocks", () => {
  handleEvent(input({ hook_event_name: 'SubagentStop', agent_id: 'helper1', agent_type: '', cwd: ROOT }));
  assert.equal(activity('helper1').length, 0);
  const r = runHook('not json');
  assert.equal(r.code, 0);
  assert.equal(readJsonl(join(LOGS, 'guardrails.jsonl')).at(-1).rule, 'monitor');
});
