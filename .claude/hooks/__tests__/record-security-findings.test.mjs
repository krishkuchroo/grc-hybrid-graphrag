import { AWS_KEY, input, PROJECT } from './helpers.mjs';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { nextId, record, securityKind } from '../record-security-findings.mjs';

const FILE = join(PROJECT, 'SECURITY-FINDINGS.md');
const block = (obj) => `Report.\n\n\`\`\`handoff\n${JSON.stringify(obj)}\n\`\`\`\n`;
const handIn = (agentType, agentId, handoff, event = 'PostToolUse') =>
  input({
    hook_event_name: event,
    tool_name: event === 'SubagentStop' ? undefined : 'SubagentHandback',
    tool_input: event === 'SubagentStop' ? undefined : { message: block(handoff) },
    last_assistant_message: event === 'SubagentStop' ? block(handoff) : undefined,
    agent_id: agentId,
    agent_type: agentType,
  });
const read = () => readFileSync(FILE, 'utf8');

test('which hand-offs count as security findings', () => {
  const sr = 'security-reviewer';
  assert.equal(securityKind(sr, { status: 'sent-back', findings: 'D55 at a.ts:3' }), 'Sent back');
  assert.equal(securityKind(sr, { status: 'blocked', findings: 'which lockout?' }), 'Question for the user');
  assert.equal(securityKind(sr, { status: 'approved', findings: 'All good. No issues.' }), null);
  assert.equal(securityKind(sr, { status: 'approved', findings: 'Approved. Worth knowing, not blocking: x.' }), 'Note (approved)');
  assert.equal(securityKind(sr, { status: 'approved', findings: 'Approved. Security notes: y.' }), 'Note (approved)');
  assert.equal(securityKind('code-reviewer', { status: 'approved', findings: 'not blocking: naming' }), null);
  assert.equal(securityKind('code-reviewer', { status: 'approved', findings: 'Security notes: logs err' }), 'Note');
});

test('numbers entries after the highest existing one', () => {
  assert.equal(nextId('# Security findings\n'), 'SF-001');
  assert.equal(nextId('### SF-004 · a\n### SF-009 · b\n'), 'SF-010');
});

test('writes a sent-back security review once, even when the stop backup fires too', () => {
  rmSync(FILE, { force: true });
  const h = { taskId: 'S1-003', status: 'sent-back', findings: 'D55: records.ts:40 skips the label check' };
  assert.equal(record(handIn('security-reviewer', 'sr1', h)), 'SF-001');
  assert.equal(record(handIn('security-reviewer', 'sr1', h, 'SubagentStop')), null);
  const text = read();
  assert.match(text, /^### SF-001 · S1-003 · Sent back$/m);
  assert.match(text, /- \*\*Review status:\*\* Open/);
  assert.match(text, /records\.ts:40 skips the label check/);
  assert.equal(text.match(/### SF-/g).length, 1);
});

test('ignores clean approvals, refused hand-ins and the main session', () => {
  rmSync(FILE, { force: true });
  const clean = { taskId: 'S1-004', status: 'approved', findings: 'No issues.' };
  const issue = { taskId: 'S1-004', status: 'sent-back', findings: 'D56 gap' };
  assert.equal(record(handIn('security-reviewer', 'sr2', clean)), null);
  assert.equal(record(handIn('security-reviewer', 'sr3', issue, 'PreToolUse')), null);
  assert.equal(record({ ...handIn('security-reviewer', 'sr4', issue), agentId: null }), null);
});

test('redacts secrets in the details', () => {
  rmSync(FILE, { force: true });
  record(handIn('security-reviewer', 'sr5', { taskId: 'S1-005', status: 'sent-back', findings: `key ${AWS_KEY} in config.ts:2` }));
  assert.doesNotMatch(read(), new RegExp(AWS_KEY));
});
