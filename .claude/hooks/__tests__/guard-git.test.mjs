import { ROOT, git, makeRepo } from './helpers.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideGit } from '../guard-git.mjs';

const asAgent = (command, type = 'builder-backend') => decideGit(command, type, true);
const asMain = (command) => decideGit(command, '', false);

test('only the integrator pushes', () => {
  assert.ok(asMain('git push origin main'));
  assert.ok(asAgent('git push origin main'));
  assert.equal(asAgent('git push origin main', 'integrator'), null);
  assert.equal(asAgent('git push -u origin s1-003', 'integrator'), null);
});

test('force-push is blocked for everyone', () => {
  for (const cmd of [
    'git push --force',
    'git push -f origin main',
    'git push origin +main',
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc origin main',
    'git push --mirror',
    'git push -uf origin main',
    'git -C repo push --force-if-includes',
  ]) {
    assert.match(asAgent(cmd, 'integrator')?.reason ?? '', /force-push/, cmd);
  }
});

test('deleting branches is blocked for everyone', () => {
  for (const cmd of ['git branch -d old', 'git branch -D old', 'git branch --delete old', 'git push origin --delete old', 'git push origin :old', 'git push -d origin old', 'git update-ref -d refs/heads/old']) {
    assert.ok(asAgent(cmd, 'integrator'), cmd);
  }
  for (const cmd of ['git branch s1-004', 'git branch -vv', 'git branch -m old new']) assert.equal(asAgent(cmd), null, cmd);
});

test('throwing away work is blocked', () => {
  for (const cmd of [
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git clean --force',
    'git checkout .',
    'git checkout -- .',
    'git checkout HEAD -- .',
    'git restore .',
    'git restore --worktree :/',
    'git restore -SW .',
  ]) {
    assert.ok(asAgent(cmd), cmd);
  }
});

test('targeted and safe forms are allowed', () => {
  for (const cmd of [
    'git status',
    'git reset HEAD~1',
    'git reset --soft HEAD~1',
    'git clean -n',
    'git checkout main',
    'git checkout -b s1-004',
    'git checkout -- src/a.ts',
    'git restore src/a.ts',
    'git restore --staged .',
    'git commit -m "never git push --force"',
    'echo "git reset --hard"',
  ]) {
    assert.equal(asAgent(cmd), null, cmd);
  }
});

test("the GitHub CLI can't delete or force either", () => {
  for (const cmd of [
    'gh repo delete me/x --yes',
    'gh repo sync --force',
    'gh pr merge 3 --delete-branch',
    'gh pr merge 3 -d',
    'gh api -X DELETE repos/me/x/git/refs/heads/old',
    'gh api --method=delete repos/me/x',
  ]) {
    assert.ok(asAgent(cmd, 'integrator'), cmd);
  }
  assert.equal(asAgent('gh pr merge 3 --squash', 'integrator'), null);
  assert.ok(asAgent('gh pr merge 3 --squash'));
  assert.ok(asAgent('gh api repos/me/x/issues -f title=x'));
  assert.equal(asAgent('gh api repos/me/x'), null);
  assert.ok(asMain('gh repo create me/x --private --source . --push'));
  assert.equal(asMain('gh repo create me/x --private --source .'), null);
});

test('the main session changes nothing on GitHub either; only the integrator does (D119)', () => {
  for (const cmd of ['gh pr merge 3 --squash', 'gh repo sync', 'gh api repos/me/x/issues -f title=x', 'gh api -X PATCH repos/me/x']) {
    assert.match(asMain(cmd)?.reason ?? '', /only the integrator/, cmd);
  }
  for (const cmd of ['gh api repos/me/x', 'gh pr view 3', 'gh pr list']) assert.equal(asMain(cmd), null, cmd);
});

test("agents don't define git or GitHub CLI aliases (D119)", () => {
  for (const cmd of [
    'git -c alias.p="push --force" p origin main',
    'git -c Alias.P=push status',
    'git config alias.p "push --force"',
    'git config --global alias.p push',
    'git config set alias.p push',
    'gh alias set p "pr merge"',
    'gh alias import aliases.yml',
  ]) {
    assert.match(asAgent(cmd, 'integrator')?.reason ?? '', /alias/, cmd);
  }
  for (const cmd of ['git config --get alias.p', 'git config --list', 'gh alias list']) assert.equal(asAgent(cmd), null, cmd);
});

test('saved aliases are blocked for everyone; built-in commands are never looked up (D119)', () => {
  const repo = makeRepo();
  git(repo, 'config', 'alias.pp', 'push --force');
  assert.match(decideGit('git pp origin main', 'integrator', true, repo)?.reason ?? '', /alias for "push --force"/);
  assert.match(decideGit('git pp', '', false, repo)?.reason ?? '', /alias/);
  assert.match(decideGit(`git -C ${repo} pp`, '', false, ROOT)?.reason ?? '', /alias/);
  assert.equal(decideGit('git status', '', false, repo), null);
  assert.equal(decideGit('git nosuchcommand', '', false, repo), null); // not an alias: git itself refuses it
});

test("gh commands the guard rails don't know are blocked, since they may be aliases (D119)", () => {
  assert.match(asMain('gh pm 3')?.reason ?? '', /isn't a GitHub CLI command/);
  assert.match(asAgent('gh shipit', 'integrator')?.reason ?? '', /isn't a GitHub CLI command/);
});

test("agents set no GIT_CONFIG_ variables (D119)", () => {
  for (const cmd of [
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0="push --force" git p',
    'export GIT_CONFIG_GLOBAL=/tmp/other',
    'env GIT_CONFIG_PARAMETERS="x" git status',
  ]) {
    assert.match(asAgent(cmd, 'integrator')?.reason ?? '', /GIT_CONFIG/, cmd);
  }
  assert.equal(asAgent('GIT_AUTHOR_NAME=x git commit -m y'), null);
});

test('every block says the agent has no authority', () => {
  assert.match(asAgent('git reset --hard').reason, /You don't have authority to run this\.$/);
});
