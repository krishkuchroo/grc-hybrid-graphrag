// Prints what one task needs from the live board (the main checkout's TASKS.md), so an agent reads a
// few thousand tokens instead of the whole board (D219): the task's row, the shared notes that apply
// (M0's always; S1's for every later slice, as their notes say; the task's own milestone's), and its
// brief. Works from any worktree. Usage: node .claude/scripts/brief.mjs <task ID>
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const id = String(process.argv[2] ?? '').trim().toUpperCase();
if (!/^[A-Z][A-Z0-9]*-\d{3}$/.test(id)) {
  console.error('brief: give a task ID, such as S2-001');
  process.exit(1);
}

const git = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
if (git.status !== 0) {
  console.error('brief: not inside the git repository');
  process.exit(1);
}
const board = join(dirname(resolve(git.stdout.trim())), 'TASKS.md');
const lines = readFileSync(board, 'utf8').split('\n');

// A section runs from its first line up to the next brief or section heading.
const sectionFrom = (start) => {
  let end = start + 1;
  while (end < lines.length && !/^(Task: |### )/.test(lines[end])) end += 1;
  const body = lines.slice(start, end);
  while (body.length && /^(---)?\s*$/.test(body.at(-1))) body.pop();
  return body.join('\n');
};
const notesOf = (ms) => {
  const k = lines.findIndex((l) => l.startsWith(`### ${ms} shared notes`));
  return k === -1 ? null : sectionFrom(k);
};

const row = lines.find((l) => l.startsWith(`| ${id} |`));
const at = lines.findIndex((l) => l.trim() === `Task: ${id}`);
if (!row && at === -1) {
  console.error(`brief: ${id} is not on the board (${board})`);
  process.exit(1);
}

const ms = id.split('-')[0];
const wanted = ['M0'];
if (/^S\d+$/.test(ms) && ms !== 'S1') wanted.push('S1');
if (ms !== 'M0') wanted.push(ms);

const header = lines.find((l) => l.startsWith('| ID |'));
const out = [`# ${id} (from ${board})`, '', '## Board row', header, row ?? '(no row on the board)'];
for (const m of wanted) {
  const notes = notesOf(m);
  if (notes) out.push('', notes);
}
out.push('', '## Brief', at === -1 ? '(no brief on the board)' : sectionFrom(at));
console.log(out.filter((l) => l !== undefined).join('\n'));
