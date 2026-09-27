import { AWS_KEY, PROJECT, git, makeRepo, put } from './helpers.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changesHooksPath, decideSecrets, skipsHooks } from '../guard-secrets.mjs';
import { gitCall } from '../lib/git.mjs';
import { parseCommand } from '../lib/shell.mjs';

const commitArgs = (command) => parseCommand(command)[0].words.slice(2);
const callOf = (command) => gitCall(parseCommand(command)[0].words.slice(1));

test('spots --no-verify and -n on commits', () => {
  for (const cmd of ['git commit --no-verify -m x', 'git commit -nm x', 'git commit -am x -n']) assert.ok(skipsHooks(commitArgs(cmd)), cmd);
  for (const cmd of ['git commit -m -n', 'git commit -m "no verify here"', 'git commit -am x']) assert.ok(!skipsHooks(commitArgs(cmd)), cmd);
});

test("keeps git's hooks path pointed at the secret scan", () => {
  for (const cmd of ['git config core.hooksPath .claude/githooks', 'git config --get core.hooksPath', 'git -c core.hooksPath=.claude/githooks commit -m x']) {
    assert.equal(changesHooksPath(callOf(cmd)), false, cmd);
  }
  for (const cmd of [
    'git config core.hooksPath /tmp/none',
    'git config --unset core.hooksPath',
    'git config --global core.hooksPath .claude/githooks',
    'git -c core.hooksPath=/dev/null commit -m x',
  ]) {
    assert.equal(changesHooksPath(callOf(cmd)), true, cmd);
  }
});

test('keeps the hooks path when it is set through GIT_CONFIG_* or --config-env (D119)', () => {
  for (const cmd of [
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=CORE.HOOKSPATH GIT_CONFIG_VALUE_0=/tmp/none',
    'GIT_CONFIG_KEY_0=$K GIT_CONFIG_VALUE_0=x git commit -m x',
    `GIT_CONFIG_PARAMETERS="'core.hooksPath'='/tmp/none'" git commit -m x`,
    'export GIT_CONFIG_PARAMETERS',
  ]) {
    assert.match(decideSecrets(cmd, PROJECT)?.reason ?? '', /GIT_CONFIG/, cmd);
  }
  assert.equal(decideSecrets('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=.claude/githooks git status', PROJECT), null);
  assert.equal(decideSecrets('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git status', PROJECT), null);
  assert.equal(changesHooksPath(callOf('git --config-env core.hooksPath=HP commit -m x')), true);
  assert.equal(changesHooksPath(callOf('git --config-env=core.hooksPath=HP commit -m x')), true);
});

test('blocks a commit whose staged changes hold a secret, without showing it', () => {
  const repo = makeRepo();
  put(repo, 'src/config.ts', `export const key = '${AWS_KEY}';\n`);
  git(repo, 'add', 'src/config.ts');
  const verdict = decideSecrets('git commit -m "add config"', repo);
  assert.match(verdict.reason, /src\/config\.ts:1\s+AWS access key ID/);
  assert.ok(!verdict.reason.includes(AWS_KEY));
  assert.ok(!verdict.subject.includes(AWS_KEY));
});

test('scans the working tree when the command adds files first', () => {
  const repo = makeRepo();
  put(repo, 'notes.md', `token ${AWS_KEY}\n`);
  assert.equal(decideSecrets('git commit -m wip', repo), null); // nothing staged yet
  assert.ok(decideSecrets('git add -A && git commit -m wip', repo));
  assert.ok(decideSecrets('git commit -am wip', repo));
  assert.ok(decideSecrets(`cd ${repo} && git add . && git commit -m wip`, PROJECT));
});

test('lets a marked false alarm through', () => {
  const repo = makeRepo();
  put(repo, 'docs/example.md', `sample ${AWS_KEY} (secret-scan: allow)\n`);
  git(repo, 'add', '-A');
  assert.equal(decideSecrets('git commit -m docs', repo), null);
});

test('flags a staged .env file', () => {
  const repo = makeRepo();
  put(repo, '.env', 'X=1\n');
  git(repo, 'add', '-f', '.env');
  assert.match(decideSecrets('git commit -m env', repo).reason, /\.env/);
});

test('blocks skipping the scan and switching it off', () => {
  assert.match(decideSecrets('git commit --no-verify -m x', PROJECT).reason, /--no-verify/);
  assert.match(decideSecrets('git config core.hooksPath /dev/null', PROJECT).reason, /hooks path/);
  assert.equal(decideSecrets('git config core.hooksPath .claude/githooks', PROJECT), null);
});
