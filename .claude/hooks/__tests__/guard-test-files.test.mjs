import { input, makeRepo, put } from './helpers.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideTestFiles } from '../guard-test-files.mjs';
import { snapshot } from '../lib/checkout.mjs';
import { writeState } from '../lib/state.mjs';

const repo = makeRepo(undefined, { 'src/a.ts': 'a\n', 'src/a.test.ts': 't\n' });
const call = (agentType, tool, toolInput, id = 't1') =>
  input({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, agent_id: id, agent_type: agentType, cwd: repo });

test("builders can't edit test files (D89, D96)", () => {
  for (const rel of ['src/a.test.ts', 'src/b.spec.tsx', 'tests/fixtures/gemma/answer.json', 'e2e/login.spec.ts', 'packages/api/tests/helpers.ts']) {
    assert.ok(decideTestFiles(call('builder-backend', 'Write', { file_path: join(repo, rel) })), rel);
  }
  assert.ok(decideTestFiles(call('builder-frontend', 'Bash', { command: 'echo x >> src/a.test.ts' })));
  assert.equal(decideTestFiles(call('builder-backend', 'Edit', { file_path: join(repo, 'src/a.ts') })), null);
});

test("the rule is for builders only", () => {
  assert.equal(decideTestFiles(call('test-writer', 'Write', { file_path: join(repo, 'src/a.test.ts') })), null);
  assert.equal(decideTestFiles(call('integrator', 'Write', { file_path: join(repo, 'src/a.test.ts') })), null);
});

test('builders can put a test file back, or remove one they created', () => {
  writeState('t9', 'start', snapshot(repo));
  put(repo, 'src/scaffold.test.ts', 'generated\n');
  assert.equal(decideTestFiles(call('builder-backend', 'Bash', { command: 'git restore src/a.test.ts' }, 't9')), null);
  assert.equal(decideTestFiles(call('builder-backend', 'Bash', { command: 'rm src/scaffold.test.ts' }, 't9')), null);
  assert.ok(decideTestFiles(call('builder-backend', 'Bash', { command: 'rm src/a.test.ts' }, 't9')));
  assert.ok(decideTestFiles(call('builder-backend', 'Bash', { command: 'rm src/*.test.ts' }, 't9')));
});
