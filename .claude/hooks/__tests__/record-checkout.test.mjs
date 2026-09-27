import { LOGS, input, makeRepo, readJsonl, runScript } from './helpers.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideFinish } from '../check-finish.mjs';
import { launchedAgentId } from '../lib/hook-input.mjs';
import { readState, writeState } from '../lib/state.mjs';
import { handleEvent } from '../record-checkout.mjs';

const repo = makeRepo();
const edits = () => readJsonl(join(LOGS, 'edits.jsonl'));
const readme = { file_path: join(repo, 'README.md') };
const tool = (raw, toolName, toolInput) => input({ hook_event_name: 'PreToolUse', cwd: repo, tool_name: toolName, tool_input: toolInput, ...raw });

test("an agent's first event records how the checkout looked, once", () => {
  handleEvent(input({ hook_event_name: 'SubagentStart', agent_id: 'c1', agent_type: 'builder-backend', cwd: repo }));
  const first = readState('c1', 'start');
  assert.deepEqual([first.repo, first.agentType, typeof first.head], [repo, 'builder-backend', 'string']);
  handleEvent(tool({ agent_id: 'c1', agent_type: 'builder-backend' }, 'Read', readme));
  assert.deepEqual(readState('c1', 'start'), first);
});

test('logs who edited which file, the main session included, and nothing else', () => {
  handleEvent(tool({}, 'Edit', readme));
  handleEvent(tool({ agent_id: 'c2', agent_type: 'builder-data' }, 'Write', { file_path: 'src/a.ts' }));
  handleEvent(tool({ agent_id: 'c2', agent_type: 'builder-data' }, 'Bash', { command: 'ls' }));
  assert.deepEqual(
    edits().map((e) => [e.agent_id, e.agent_type, e.tool, e.path]),
    [
      [null, 'main', 'Edit', join(repo, 'README.md')],
      ['c2', 'builder-data', 'Write', join(repo, 'src/a.ts')],
    ],
  );
});

test("Claude Code's helper agents are ignored", () => {
  handleEvent(input({ hook_event_name: 'SubagentStop', agent_id: 'helper1', agent_type: '', cwd: repo }));
  assert.equal(readState('helper1', 'start'), null);
});

// D158: a run started with `claude --agent <name>` has no agent_id.
const launched = (event, extra = {}) => input({ hook_event_name: event, agent_type: 'builder-backend', session_id: 'sess-9', cwd: repo, ...extra });

test('a launched run counts as an agent, identified by its session', () => {
  const i = launched('PreToolUse', { tool_name: 'Read', tool_input: readme });
  assert.equal(i.agentId, launchedAgentId('sess-9'));
  assert.equal(i.agentId, 'run-sess-9');
  assert.equal(i.launched, true);
  handleEvent(launched('SessionStart'));
  assert.equal(readState('run-sess-9', 'start').agentType, 'builder-backend');
  // The main session and subagents are unchanged.
  assert.equal(input({ hook_event_name: 'PreToolUse', session_id: 's' }).agentId, null);
  assert.equal(input({ hook_event_name: 'PreToolUse', session_id: 's', agent_id: 'x', agent_type: 'planner' }).agentId, 'x');
});

test("a launched run's Stop is its hand-in, and the finish checks run on it", () => {
  const stop = launched('Stop', { last_assistant_message: 'All done, no hand-off block.' });
  assert.equal(stop.event, 'SubagentStop');
  const verdict = decideFinish(stop);
  assert.match(verdict.reason, /hand-off block/);
  // The main session's Stop stays out of it.
  assert.equal(decideFinish(input({ hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'hi' })), null);
});

test('a reply to a launched run starts a new round that is checked again', () => {
  writeState('run-sess-9', 'finish', { attempts: 0, handIns: 1, cleared: true, taskId: 'X-1' });
  writeState('run-sess-9', 'changed', { attempts: 0, cleared: true });
  handleEvent(launched('UserPromptSubmit', { prompt: 'one more thing' }));
  assert.equal(readState('run-sess-9', 'finish').cleared, false);
  assert.equal(readState('run-sess-9', 'changed').cleared, false);
  assert.equal(readState('run-sess-9', 'finish').taskId, 'X-1');
});

test('the script never blocks, even on bad input', () => {
  const r = runScript('record-checkout.mjs', 'not json');
  assert.equal(r.code, 0);
  assert.equal(readJsonl(join(LOGS, 'guardrails.jsonl')).filter((e) => e.rule === '5/7').at(-1).decision, 'error');
});
