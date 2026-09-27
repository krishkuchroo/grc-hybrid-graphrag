import { LOGS, ROOT, input, makeRepo, readJsonl, runScript } from './helpers.mjs';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { inboxFile } from '../lib/logging.mjs';
import { describeTool, handleEvent, noteContext } from '../monitor-hook.mjs';
import { readState } from '../lib/state.mjs';

const repo = makeRepo();
const SESSION = join(ROOT, 'transcripts', 'sess1.jsonl');
const activity = (agentId) => readJsonl(join(LOGS, 'activity.jsonl')).filter((e) => e.agent_id === agentId);

// Claude Code keeps an agent's transcript next to the session's (hooks docs).
function writeBrief(agentId, prompt) {
  const file = join(ROOT, 'transcripts', 'sess1', 'subagents', `agent-${agentId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`);
}

const tool = (agentId, agentType, toolName, toolInput) =>
  input({ hook_event_name: 'PreToolUse', transcript_path: SESSION, cwd: repo, agent_id: agentId, agent_type: agentType, tool_name: toolName, tool_input: toolInput });
const readme = { file_path: join(repo, 'README.md') };

function queueNote(agentId, note) {
  mkdirSync(dirname(inboxFile(agentId)), { recursive: true });
  appendFileSync(inboxFile(agentId), `${JSON.stringify(note)}\n`);
}

test("logs the main session's edits with their file, and nothing else", () => {
  handleEvent(input({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: readme, cwd: repo }));
  handleEvent(input({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: repo }));
  const main = activity(null);
  assert.equal(main.length, 1);
  assert.deepEqual([main[0].event, main[0].agent_type, main[0].path], ['edit', 'main', join(repo, 'README.md')]);
});

test("an agent's first event records how the checkout looked, once", () => {
  handleEvent(input({ hook_event_name: 'SubagentStart', agent_id: 'm1', agent_type: 'builder-backend', cwd: repo, transcript_path: SESSION }));
  handleEvent(tool('m1', 'builder-backend', 'Read', readme));
  const start = readState('m1', 'start');
  assert.deepEqual([start.repo, start.agentType, typeof start.head], [repo, 'builder-backend', 'string']);
  assert.equal(activity('m1').filter((e) => e.event === 'start').length, 1);
});

test('each step carries the task ID from the brief and a readable subject', () => {
  writeBrief('m2', 'Task: S1-003\nGoal: add the risk register list.');
  handleEvent(tool('m2', 'builder-backend', 'Bash', { command: 'pnpm test', description: 'Run the tests' }));
  handleEvent(tool('m2', 'builder-backend', 'Edit', { file_path: join(repo, 'src/a.ts') }));
  const steps = activity('m2').filter((e) => e.event === 'tool');
  assert.deepEqual(
    steps.map((s) => [s.task_id, s.tool, s.subject]),
    [['S1-003', 'Bash', 'Run the tests — pnpm test'], ['S1-003', 'Edit', 'src/a.ts']],
  );
  assert.equal(steps[0].path, undefined);
  assert.equal(steps[1].path, join(repo, 'src/a.ts'));
});

test("finds a workflow agent's brief one folder down", () => {
  const file = join(ROOT, 'transcripts', 'sess1', 'subagents', 'workflows', 'wf_1', 'agent-w1.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'Task: SMOKE-WF-001\nDo the smoke test.' } })}\n`);
  handleEvent(tool('w1', 'builder-backend', 'Bash', { command: 'echo smoke' }));
  assert.equal(activity('w1').at(-1).task_id, 'SMOKE-WF-001');
});

test('a brief without a task ID is read once; a transcript not written yet is retried', () => {
  writeBrief('m3', 'No task line here');
  handleEvent(tool('m3', 'code-reviewer', 'Read', readme));
  assert.deepEqual(readState('m3', 'task'), { taskId: null, tries: 20 });

  handleEvent(tool('m4', 'planner', 'Read', readme));
  assert.deepEqual(readState('m4', 'task'), { taskId: null, tries: 1 });
  writeBrief('m4', [{ type: 'text', text: 'Task: M0-001 plan milestone 0' }]);
  handleEvent(tool('m4', 'planner', 'Read', readme));
  assert.equal(readState('m4', 'task').taskId, 'M0-001');
});

test("the user's notes reach the agent once, at its next step (D101)", () => {
  queueNote('m5', { id: 'n1', ts: '2026-09-26T14:05:00.000Z', text: 'Use the grc_ prefix.' });
  queueNote('m5', { id: 'n2', ts: '2026-09-26T14:06:00.000Z', text: 'Skip the chart.' });
  const out = handleEvent(tool('m5', 'builder-data', 'Bash', { command: 'ls' }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /^Notes from the user[\s\S]*Use the grc_ prefix\.[\s\S]*Skip the chart\.[\s\S]*status "blocked"/);
  assert.equal(existsSync(inboxFile('m5')), false);
  assert.equal(handleEvent(tool('m5', 'builder-data', 'Bash', { command: 'ls' })), null);
  const delivered = readJsonl(join(LOGS, 'notes.jsonl')).filter((e) => e.agent_id === 'm5' && e.event === 'delivered');
  assert.deepEqual(delivered.map((e) => e.id), ['n1', 'n2']);
});

test('notes wait while the agent is handing in', () => {
  queueNote('m6', { id: 'n3', ts: new Date().toISOString(), text: 'hold on' });
  assert.equal(handleEvent(tool('m6', 'builder-data', 'SubagentHandback', { message: 'report' })), null);
  assert.equal(existsSync(inboxFile('m6')), true);
  assert.equal(activity('m6').at(-1).subject, 'handing in the report');
});

test('many long notes are spread over steps to stay under the context cap', () => {
  const notes = Array.from({ length: 6 }, (_, k) => ({ id: `L${k}`, ts: new Date().toISOString(), text: 'x'.repeat(2000) }));
  const { context, delivered, left } = noteContext(notes);
  assert.ok(context.length < 10_000, String(context.length));
  assert.ok(left.length > 0);
  assert.deepEqual([...delivered, ...left].map((n) => n.id), notes.map((n) => n.id));
});

test("a stop is logged with the task ID; Claude Code's helper agents are ignored", () => {
  handleEvent(input({ hook_event_name: 'SubagentStop', agent_id: 'm2', agent_type: 'builder-backend', cwd: repo, transcript_path: SESSION }));
  assert.equal(activity('m2').at(-1).event, 'stop');
  assert.equal(activity('m2').at(-1).task_id, 'S1-003');
  handleEvent(input({ hook_event_name: 'SubagentStop', agent_id: 'helper1', agent_type: '', cwd: repo }));
  assert.equal(activity('helper1').length, 0);
  assert.equal(readState('helper1', 'start'), null);
});

test('describes the common tools in one line', () => {
  const d = (toolName, toolInput) => describeTool({ toolName, toolInput, cwd: repo });
  assert.equal(d('Grep', { pattern: 'orgId', path: join(repo, 'src') }), 'orgId in src');
  assert.equal(d('Glob', { pattern: '**/*.ts' }), '**/*.ts');
  assert.equal(d('Agent', { subagent_type: 'Explore', description: 'Find the auth code' }), 'Explore: Find the auth code');
  assert.equal(d('WebFetch', { url: 'https://example.com' }), 'https://example.com');
  assert.equal(d('WebSearch', { query: 'pgvector hnsw' }), 'pgvector hnsw');
  assert.equal(d('Skill', { skill: 'superpowers:writing-plans' }), 'superpowers:writing-plans');
  assert.equal(d('StructuredOutput', {}), 'handing in the result');
});

test('the script never blocks, even on bad input', () => {
  const r = runScript('monitor-hook.mjs', 'not json');
  assert.equal(r.code, 0);
  assert.equal(readJsonl(join(LOGS, 'guardrails.jsonl')).filter((e) => e.rule === 'monitor').at(-1).decision, 'error');
});
