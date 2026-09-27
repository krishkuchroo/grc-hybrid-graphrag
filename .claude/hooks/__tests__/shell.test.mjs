import './helpers.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dynamicCommand, envSettings, findInvocations, leadingAssignments, parseCommand, unwrap, workingDirs } from '../lib/shell.mjs';

const words = (segment) => segment.words.map((w) => w.value);

test('splits a command line into simple commands at operators', () => {
  assert.deepEqual(parseCommand('a 1 && b 2 || c; d | e & f').map(words), [['a', '1'], ['b', '2'], ['c'], ['d'], ['e'], ['f']]);
});

test('keeps quoted text as one word', () => {
  const [segment] = parseCommand(`git commit -m "fix: don't git push --force" -m 'a b'`);
  assert.deepEqual(words(segment), ['git', 'commit', '-m', "fix: don't git push --force", '-m', 'a b']);
});

test('reads commands inside $(...), backticks, bash -c and eval', () => {
  const segments = parseCommand("echo $(docker ps -q) `git status`; bash -c 'git push -f'; eval \"docker stop x\"");
  const found = findInvocations(segments, ['docker', 'git']).map((i) => [i.name, ...i.args.map((a) => a.value)].join(' '));
  assert.deepEqual(found.sort(), ['docker ps -q', 'docker stop x', 'git push -f', 'git status']);
});

test('skips heredoc bodies and comments', () => {
  const segments = parseCommand('cat <<EOF > notes.txt\ndocker stop other\nEOF\necho done # git push -f');
  assert.equal(findInvocations(segments, ['docker', 'git']).length, 0);
  assert.deepEqual(segments.map(words), [['cat'], ['echo', 'done']]);
});

test('records redirects with their targets', () => {
  const [segment] = parseCommand('node x.js > out.log 2>&1 >> more.log');
  assert.deepEqual(
    segment.redirects.map((r) => [r.op, r.target]),
    [['>', 'out.log'], ['2>&', '1'], ['>>', 'more.log']],
  );
});

test('marks words built from variables or substitutions as dynamic', () => {
  const [segment] = parseCommand('docker stop "$NAME" grc-api $(cat ids)');
  assert.deepEqual(segment.words.map((w) => w.dynamic), [false, false, true, false, true]);
});

test('follows literal cd, and gives up on cd $VAR', () => {
  const segments = parseCommand('cd /tmp && ls; cd sub && ls; cd $X && ls');
  assert.deepEqual(workingDirs(segments, '/start'), ['/start', '/tmp', '/tmp', '/tmp/sub', '/tmp/sub', null]);
});

test('reads leading VAR=value assignments', () => {
  const [segment] = parseCommand('COMPOSE_PROJECT_NAME=other FOO=$(x) docker compose up');
  assert.deepEqual(leadingAssignments(segment), { COMPOSE_PROJECT_NAME: 'other', FOO: null });
});

test('unwrap finds the real command past assignments and wrappers', () => {
  const { words: w, assignments } = unwrap(parseCommand('FOO=1 sudo -u me env BAR=2 timeout 10 rm x')[0]);
  assert.deepEqual(w.map((x) => x.value), ['rm', 'x']);
  assert.deepEqual(assignments.map((x) => x.value), ['FOO=1', 'BAR=2']);
});

test('envSettings finds every variable a command line sets', () => {
  const names = (cmd) => envSettings(parseCommand(cmd)).map((e) => [e.name, e.value]);
  assert.deepEqual(names('A=1 cmd; B=2; env C=3 cmd'), [['A', '1'], ['B', '2'], ['C', '3']]);
  assert.deepEqual(names('export D=4 E; declare -x F=$(x); typeset G=5'), [['D', '4'], ['E', null], ['F', null], ['G', '5']]);
  assert.deepEqual(names('echo A=1'), []);
});

test('dynamicCommand spots a program name built at run time', () => {
  const hidden = (cmd) => dynamicCommand(parseCommand(cmd));
  for (const cmd of ['$(echo docker) ps', '`echo git` push', '$CMD push', '"$D" rm x', 'sudo $CMD', 'env X=1 $(which git) push', 'eval "$X"', 'bash -c "$S"', 'ls | xargs $CMD']) {
    assert.notEqual(hidden(cmd), null, cmd);
  }
  for (const cmd of ['docker ps', 'X=$(pwd) && echo $X', 'echo $(git rev-parse HEAD)', 'bash -c "pnpm test"', 'eval echo hi', 'git commit -m "$MSG"']) {
    assert.equal(hidden(cmd), null, cmd);
  }
});

test('joins lines ending in a backslash', () => {
  const [segment] = parseCommand('git push \\\n  --force origin main');
  assert.deepEqual(words(segment), ['git', 'push', '--force', 'origin', 'main']);
});
