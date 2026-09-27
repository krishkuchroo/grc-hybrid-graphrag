import { PROJECT, REAL_PROJECT, ROOT, input, makeRepo } from './helpers.mjs';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideSkill } from '../guard-skills.mjs';
import { expandHome, isInHomeClaudeDir, realish, repoRelative } from '../lib/paths.mjs';
import { approvedSkills } from '../lib/skills.mjs';

test('paths are relative to the checkout they sit in', () => {
  assert.equal(repoRelative(join(PROJECT, 'packages/api/x.ts'), PROJECT), 'packages/api/x.ts');
  assert.equal(repoRelative('memory.md', PROJECT), 'memory.md');
  assert.equal(repoRelative('/etc/hosts', PROJECT), null);
  const worktree = makeRepo(join(PROJECT, '.claude', 'worktrees', 'w1'));
  assert.equal(repoRelative(join(worktree, 'CLAUDE.md'), worktree), 'CLAUDE.md');
});

test('realish resolves symlinks in the part of the path that exists', () => {
  const link = join(ROOT, 'link-to-project');
  symlinkSync(PROJECT, link);
  assert.equal(realish(join(link, 'not-yet', 'file.ts')), join(PROJECT, 'not-yet', 'file.ts'));
});

test("the user's own Claude folder is recognised", () => {
  assert.ok(isInHomeClaudeDir(join(homedir(), '.claude', 'settings.json'), '/'));
  assert.ok(!isInHomeClaudeDir(join(PROJECT, '.claude', 'settings.json'), PROJECT));
  assert.equal(expandHome('~/x'), join(homedir(), 'x'));
});

const approved = approvedSkills(readFileSync(join(REAL_PROJECT, 'skills.md'), 'utf8'));

test('reads the approved plugin:skill names from skills.md', () => {
  const expected = [
    'superpowers:writing-plans',
    'superpowers:test-driven-development',
    'superpowers:systematic-debugging',
    'superpowers:verification-before-completion',
    'frontend-design:frontend-design',
    'vercel:shadcn',
    'vercel:ai-sdk',
    'mattpocock-skills:code-review',
    'fp-check:fp-check',
    'insecure-defaults:insecure-defaults',
    'differential-review:differential-review',
    'mattpocock-skills:resolving-merge-conflicts',
    'mattpocock-skills:git-guardrails-claude-code',
    'mattpocock-skills:writing-for-agents',
    'feature-dev:feature-dev',
    'workflow-authoring',
  ];
  assert.deepEqual([...approved].sort(), expected.sort());
});

test('agents never call the Skill tool; the main session uses approved skills only', () => {
  const call = (skill, agentType) =>
    input({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill }, ...(agentType ? { agent_id: 'k1', agent_type: agentType } : {}) });
  assert.ok(decideSkill(call('superpowers:test-driven-development', 'builder-backend'), approved));
  assert.equal(decideSkill(call('feature-dev:feature-dev'), approved), null);
  assert.equal(decideSkill(call('/workflow-authoring'), approved), null);
  assert.ok(decideSkill(call('superpowers:brainstorming'), approved));
  assert.ok(decideSkill(call('writing-plans'), approved)); // exact names only
});
