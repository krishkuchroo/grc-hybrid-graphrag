import { PROJECT, git, input, put } from './helpers.mjs';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideProtected } from '../guard-protected-files.mjs';

const at = (rel) => join(PROJECT, rel);
const edit = (agentType, file) =>
  input({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file }, agent_id: 'p1', agent_type: agentType, cwd: PROJECT });
const bash = (agentType, command, cwd = PROJECT) =>
  input({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, agent_id: 'p1', agent_type: agentType, cwd });

test('the main session edits anything', () => {
  assert.equal(decideProtected(input({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: at('CLAUDE.md') }, cwd: PROJECT })), null);
});

test('no agent edits CLAUDE.md, .claude/, skills.md or logs/', () => {
  for (const rel of ['CLAUDE.md', 'packages/api/CLAUDE.md', 'CLAUDE.local.md', '.claude/settings.json', '.claude/agents/planner.md', 'skills.md', 'logs/activity.jsonl']) {
    assert.ok(decideProtected(edit('planner', at(rel))), rel);
  }
  assert.match(decideProtected(edit('builder-backend', join(homedir(), '.claude', 'settings.json'))).reason, /~\/\.claude/);
});

test('only the planner edits memory.md and TASKS.md', () => {
  assert.ok(decideProtected(edit('builder-backend', at('memory.md'))));
  assert.ok(decideProtected(edit('integrator', at('TASKS.md'))));
  assert.equal(decideProtected(edit('planner', at('memory.md'))), null);
  assert.equal(decideProtected(edit('planner', at('TASKS.md'))), null);
  assert.equal(decideProtected(edit('builder-backend', at('packages/api/src/records.ts'))), null);
});

test('catches shell writes to protected files', () => {
  for (const cmd of [
    'echo x > CLAUDE.md',
    'echo x >> memory.md',
    "sed -i '' s/a/b/ skills.md",
    'rm -f .claude/settings.json',
    'cp /tmp/x .claude/agents/planner.md',
    'cd packages && tee api/CLAUDE.md < /dev/null',
    'mv notes.md TASKS.md',
  ]) {
    assert.ok(decideProtected(bash('builder-backend', cmd)), cmd);
  }
  assert.equal(decideProtected(bash('builder-backend', 'echo x > packages/api/notes.md')), null);
});

test("an agent's write to a file named at run time is blocked (D119)", () => {
  for (const cmd of ['cat x > $(echo CLAUDE.md)', 'cp a "$DEST"', 'rm `cat list`']) {
    assert.match(decideProtected(bash('code-reviewer', cmd))?.reason ?? '', /named at run time/, cmd);
  }
  assert.equal(decideProtected(bash('builder-backend', 'echo x > "$HOME/scratch.txt"')), null);
  const main = input({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat x > $(echo out.txt)' }, cwd: PROJECT });
  assert.equal(decideProtected(main), null);
});

// Last, because it turns the test project into a git repo.
test('an agent may git restore a protected file only in its own worktree', () => {
  git(PROJECT, 'init', '-q', '-b', 'main');
  put(PROJECT, 'CLAUDE.md', 'rules\n');
  git(PROJECT, 'add', '-A');
  git(PROJECT, 'commit', '-q', '-m', 'init');
  const worktree = at('.claude/worktrees/b1');
  git(PROJECT, 'worktree', 'add', '-q', '-b', 'worktree-b1', worktree);
  assert.equal(decideProtected(bash('builder-backend', 'git restore CLAUDE.md', worktree)), null);
  assert.ok(decideProtected(bash('builder-backend', 'git restore CLAUDE.md', PROJECT)));
  assert.ok(decideProtected(bash('builder-backend', 'echo x > CLAUDE.md', worktree)));
});
