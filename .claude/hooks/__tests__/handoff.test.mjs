import { input } from './helpers.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHandoff } from '../lib/handoff.mjs';

const block = (obj) => `Report text.\n\n\`\`\`handoff\n${JSON.stringify(obj)}\n\`\`\`\n`;
const handback = (message) =>
  input({ hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_input: { message }, agent_id: 'h1', agent_type: 'builder-backend' });

test('reads the last handoff block of a report', () => {
  const text = block({ taskId: 'OLD', status: 'done' }) +
    block({ taskId: 'S1-003', status: 'Done', filesChanged: ['a.ts'], tests: { run: '`pnpm test`', passed: 3, failed: 0 }, findings: ' ok ' });
  assert.deepEqual(parseHandoff(handback(text)).handoff, {
    taskId: 'S1-003',
    status: 'done',
    filesChanged: ['a.ts'],
    tests: { run: 'pnpm test', passed: 3, failed: 0 },
    findings: 'ok',
    fixReason: '',
    skips: [],
  });
});

test("says what's wrong with a bad hand-off", () => {
  assert.match(parseHandoff(handback('no block')).error, /no ```handoff block/);
  assert.match(parseHandoff(handback('```handoff\n{bad json}\n```')).error, /isn't valid JSON/);
  assert.match(parseHandoff(handback(block({ status: 'done' }))).error, /no taskId/);
  assert.match(parseHandoff(handback(block({ taskId: 'X', status: 'finished' }))).error, /must be one of/);
});

test('backticks quoted inside findings keep the block whole', () => {
  const { handoff } = parseHandoff(handback(block({ taskId: 'S1-001', status: 'done', findings: 'it said: no ```handoff block' })));
  assert.equal(handoff.findings, 'it said: no ```handoff block');
});

test('a hand-off without findings has empty findings', () => {
  assert.equal(parseHandoff(handback(block({ taskId: 'S1-001', status: 'blocked' }))).handoff.findings, '');
});

test("takes a workflow agent's structured result as the hand-off", () => {
  const { handoff } = parseHandoff(
    input({
      hook_event_name: 'PreToolUse',
      tool_name: 'StructuredOutput',
      tool_input: { taskId: 'M0-001', status: 'blocked', findings: 'needs a decision' },
      agent_id: 'h2',
      agent_type: 'planner',
    }),
  );
  assert.deepEqual([handoff.taskId, handoff.status, handoff.findings], ['M0-001', 'blocked', 'needs a decision']);
});

test('falls back to the last message at SubagentStop', () => {
  const r = parseHandoff(
    input({ hook_event_name: 'SubagentStop', last_assistant_message: block({ taskId: 'S2-001', status: 'approved' }), agent_id: 'h3', agent_type: 'code-reviewer' }),
  );
  assert.equal(r.handoff.status, 'approved');
});

test('reads a fix reason and the listed skips (D167, D173)', () => {
  const h = parseHandoff(
    handback(block({ taskId: 'S1-003', status: 'done', fixReason: ' contradicted M0-010 ', skips: [{ test: 'a > b', reason: 'needs Gemma' }, { test: 'no reason' }, 'x'] })),
  ).handoff;
  assert.equal(h.fixReason, 'contradicted M0-010');
  assert.deepEqual(h.skips, [{ test: 'a > b', reason: 'needs Gemma' }]);
});
