// End to end: each script run the way Claude Code runs it, with JSON on stdin.
import { AWS_KEY, LOGS, PROJECT, REAL_PROJECT, ROOT, git, makeRepo, put, readJsonl, runScript } from './helpers.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ALLOW_PRAGMA, scanLine } from '../lib/secret-scan.mjs';

copyFileSync(join(REAL_PROJECT, 'skills.md'), join(PROJECT, 'skills.md'));

const builder = { agent_id: 'sc1', agent_type: 'builder-backend' };
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: PROJECT });
const tool = (tool_name, tool_input, who = {}) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input, cwd: PROJECT, ...who });

test("the git guard-rails skill's own check: git push is blocked", () => {
  const r = runScript('guard-git.mjs', { tool_input: { command: 'git push origin main' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^BLOCKED by guard rail 3: only the integrator pushes/);
});

test('each guard blocks with exit 2 and a reason, and allows with exit 0', () => {
  const cases = [
    ['guard-docker.mjs', bash('docker stop orion-neo4j'), 2, /guard rail 1/],
    ['guard-docker.mjs', bash('docker ps'), 0],
    ['guard-secrets.mjs', bash('git commit --no-verify -m x'), 2, /guard rail 2/],
    ['guard-git.mjs', bash('git status'), 0],
    ['guard-protected-files.mjs', tool('Edit', { file_path: join(PROJECT, 'CLAUDE.md') }, builder), 2, /guard rail 5/],
    ['guard-protected-files.mjs', tool('Edit', { file_path: join(PROJECT, 'CLAUDE.md') }), 0],
    ['guard-test-files.mjs', tool('Write', { file_path: join(PROJECT, 'src/a.test.ts') }, builder), 2, /guard rail 7/],
    ['guard-skills.mjs', tool('Skill', { skill: 'superpowers:brainstorming' }), 2, /guard rail 6/],
    ['guard-skills.mjs', tool('Skill', { skill: 'feature-dev:feature-dev' }), 0],
    ['check-finish.mjs', tool('SubagentHandback', { message: 'done' }, builder), 2, /guard rail 4/],
    ['check-changed-files.mjs', tool('SubagentHandback', { message: 'done' }, { agent_id: 'never', agent_type: 'builder-backend' }), 0],
  ];
  const logged = readJsonl(join(LOGS, 'guardrails.jsonl')).length;
  for (const [script, stdin, code, stderr] of cases) {
    const r = runScript(script, stdin);
    assert.equal(r.code, code, `${script} ${JSON.stringify(stdin.tool_input)}: ${r.stderr}`);
    if (stderr) assert.match(r.stderr, stderr);
  }
  const blocks = readJsonl(join(LOGS, 'guardrails.jsonl')).slice(logged).filter((e) => e.decision === 'block');
  assert.deepEqual([...new Set(blocks.map((e) => e.rule))].sort(), ['1', '2', '4', '5', '6', '7']);
});

test('at SubagentStop, a check keeps the agent working through JSON, not an exit code', () => {
  const r = runScript('check-finish.mjs', { hook_event_name: 'SubagentStop', last_assistant_message: 'done', cwd: PROJECT, agent_id: 'sc2', agent_type: 'builder-backend' });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /hand-off block/);
});

test('a crashing guard blocks an agent but only warns the main session', () => {
  const empty = mkdtempSync(join(ROOT, 'empty-')); // no skills.md, so the skill guard fails
  const call = tool('Skill', { skill: 'x' });
  const asAgent = runScript('guard-skills.mjs', { ...call, ...builder }, { env: { CLAUDE_PROJECT_DIR: empty } });
  assert.equal(asAgent.code, 2);
  assert.match(asAgent.stderr, /the check itself failed/);
  assert.equal(runScript('guard-skills.mjs', call, { env: { CLAUDE_PROJECT_DIR: empty } }).code, 1);
  assert.equal(runScript('guard-git.mjs', 'not json').code, 1);
  assert.ok(readJsonl(join(LOGS, 'guardrails.jsonl')).some((e) => e.rule === '6' && e.decision === 'error'));
});

test("git's pre-commit hook stops a commit holding a secret", () => {
  const repo = makeRepo();
  cpSync(join(REAL_PROJECT, '.claude', 'hooks'), join(repo, '.claude', 'hooks'), { recursive: true, filter: (src) => !src.includes('__tests__') });
  cpSync(join(REAL_PROJECT, '.claude', 'githooks'), join(repo, '.claude', 'githooks'), { recursive: true });
  git(repo, 'config', 'core.hooksPath', '.claude/githooks');
  put(repo, 'src/config.ts', `export const key = '${AWS_KEY}';\n`);
  put(repo, 'docs/sample.md', `${AWS_KEY} (${ALLOW_PRAGMA})\n`);
  git(repo, 'add', '-A');
  const blocked = spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'add config'], { encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /skipped[\s\S]*docs\/sample\.md:1/);
  assert.match(blocked.stderr, /BLOCKED by guard rail 2[\s\S]*src\/config\.ts:1\s+AWS access key ID/);
  assert.ok(!blocked.stderr.includes(`key = '${AWS_KEY}`));
  assert.ok(readJsonl(join(LOGS, 'guardrails.jsonl')).some((e) => e.rule === '2' && e.agent_type === 'git'));

  put(repo, 'src/config.ts', 'export const key = process.env.KEY;\n');
  git(repo, 'add', '-A');
  const ok = spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'use env'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});

test('the orchestration files themselves pass the secret scan', () => {
  const findings = [];
  for (const rel of readdirSync(join(REAL_PROJECT, '.claude'), { recursive: true })) {
    if (rel.startsWith('worktrees') || !/\.(?:mjs|md|json|html)$|pre-commit$/.test(rel)) continue;
    readFileSync(join(REAL_PROJECT, '.claude', rel), 'utf8').split('\n').forEach((line, k) => {
      const kind = scanLine(line, `.claude/${rel}`);
      if (kind && !line.includes(ALLOW_PRAGMA)) findings.push(`${rel}:${k + 1} ${kind}`);
    });
  }
  assert.deepEqual(findings, []);
});
