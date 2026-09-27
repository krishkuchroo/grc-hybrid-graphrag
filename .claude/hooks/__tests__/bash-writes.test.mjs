import { ROOT } from './helpers.mjs';
import assert from 'node:assert/strict';
import { globSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { bashWriteTargets, writeTargetsOf } from '../lib/bash-writes.mjs';

const dir = mkdtempSync(join(ROOT, 'bw-'));
const targets = (command) => bashWriteTargets(command, dir).map((t) => `${t.op} ${relative(dir, t.path)}`);

test('fs.globSync is available on this Node version', () => {
  assert.equal(typeof globSync, 'function');
});

test('redirect targets are writes', () => {
  assert.deepEqual(targets('node gen.js > out.txt 2>&1'), ['write out.txt']);
  assert.deepEqual(targets('echo x >> a.log; echo y &> b.log'), ['write a.log', 'write b.log']);
  assert.deepEqual(targets('cat x > /dev/null'), []);
});

test('commands that write, move or delete files', () => {
  assert.deepEqual(targets('rm -rf build dist'), ['delete build', 'delete dist']);
  assert.deepEqual(targets('touch a.ts'), ['write a.ts']);
  assert.deepEqual(targets('mv a.ts b.ts'), ['write a.ts', 'write b.ts']);
  assert.deepEqual(targets('cp -r src/ dest/'), ['write dest']);
  assert.deepEqual(targets("sed -i '' 's/a/b/' x.ts y.ts"), ['write x.ts', 'write y.ts']);
  assert.deepEqual(targets('sed -e s/a/b/ x.ts'), []);
  assert.deepEqual(targets("perl -pi -e 's/a/b/' z.ts"), ['write z.ts']);
  assert.deepEqual(targets('dd if=/dev/zero of=disk.img bs=1'), ['write disk.img']);
  assert.deepEqual(targets('curl -sSL -o dl.bin https://example.com/x'), ['write dl.bin']);
  assert.deepEqual(targets('find tests -name "*.snap" -delete'), ['write tests']);
  assert.deepEqual(targets('npx prettier --write src/a.ts'), ['write src/a.ts']);
  assert.deepEqual(targets('pnpm eslint --fix src'), ['write src']);
});

test('wrappers and cd are followed', () => {
  assert.deepEqual(targets('sudo -u me tee a.txt'), ['write a.txt']);
  assert.deepEqual(targets('env FOO=1 timeout 10 rm x'), ['delete x']);
  assert.deepEqual(targets('cd sub && touch y'), ['write sub/y']);
});

test('git restore and checkout are marked, git rm too', () => {
  assert.deepEqual(targets('git restore a.ts'), ['git-restore a.ts']);
  assert.deepEqual(targets('git checkout HEAD -- b.ts'), ['git-restore b.ts']);
  assert.deepEqual(targets('git rm -q c.ts'), ['git c.ts']);
  assert.deepEqual(targets('git status'), []);
});

test("git's own options are read the way the git guard reads them", () => {
  assert.deepEqual(targets('git -c core.x=y --git-dir .git -C sub restore a.ts'), ['git-restore sub/a.ts']);
});

test('a file name built at run time is marked dynamic; $HOME is known', () => {
  const dyn = (command) => bashWriteTargets(command, dir).map((t) => t.dynamic);
  assert.deepEqual(dyn('cat x > $(echo CLAUDE.md)'), [true]);
  assert.deepEqual(dyn('rm "$F" `echo g`'), [true, true]);
  assert.deepEqual(dyn('echo x > "$HOME/notes.txt"; touch ${HOME}/a'), [false, false]);
  assert.deepEqual(dyn('touch plain.txt'), [false]);
});

test('globs expand to what they match', () => {
  writeFileSync(join(dir, 'one.test.ts'), '');
  writeFileSync(join(dir, 'two.test.ts'), '');
  assert.deepEqual(targets('rm *.test.ts').sort(), ['delete *.test.ts', 'delete one.test.ts', 'delete two.test.ts']);
});

test('edit tools write their own file', () => {
  assert.deepEqual(writeTargetsOf({ toolName: 'Write', toolInput: { file_path: '/x/a.ts' }, cwd: dir }), [{ path: '/x/a.ts', op: 'write' }]);
  assert.deepEqual(writeTargetsOf({ toolName: 'NotebookEdit', toolInput: { notebook_path: '/x/n.ipynb' }, cwd: dir }), [{ path: '/x/n.ipynb', op: 'write' }]);
  assert.deepEqual(writeTargetsOf({ toolName: 'Read', toolInput: { file_path: '/x/a.ts' }, cwd: dir }), []);
});
