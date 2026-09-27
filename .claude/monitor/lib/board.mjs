// The task board and the user's open questions, both read from Markdown
// files named in monitor.config.json (D149).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LOGS_DIR, PROJECT_DIR, safeId } from './core.mjs';

const plain = (text) => String(text ?? '').replace(/[*_`]/g, '').trim();

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

const readProjectFile = (file) => {
  try {
    return readFileSync(resolve(PROJECT_DIR, file), 'utf8');
  } catch {
    return null;
  }
};

// The first table whose first header is "ID". Columns come from
// config.board.columns (header text in lower case -> field).
export function parseBoard(text, columns) {
  const tasks = [];
  let keys = null;
  let headers = [];
  for (const line of String(text ?? '').split('\n')) {
    const isRow = line.trim().startsWith('|');
    if (!keys) {
      const cells = isRow ? splitRow(line) : [];
      if (plain(cells[0]).toLowerCase() === 'id') {
        keys = cells.map((c) => columns[plain(c).toLowerCase()] ?? null);
        headers = cells.map(plain);
      }
      continue;
    }
    if (!isRow) break;
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const task = {};
    keys.forEach((key, k) => {
      if (key) task[key] = cells[k] ?? '';
    });
    task.id = plain(task.id);
    if (!task.id) continue;
    task.milestone = plain(task.milestone);
    task.status = plain(task.status).toLowerCase();
    tasks.push(task);
  }
  const shown = keys ? keys.flatMap((key, k) => (key && key !== 'log' ? [{ key, label: headers[k] }] : [])) : [];
  return { tasks, columns: shown };
}

export function readBoard(config) {
  const { tasks, columns } = parseBoard(readProjectFile(config.board.file), config.board.columns);
  for (const task of tasks) {
    const id = safeId(task.id);
    task.hasLog = Boolean(id && existsSync(join(LOGS_DIR, 'tasks', `${id}.md`)));
  }
  return { tasks, columns };
}

const STATUS_KEYS = { done: 'done', 'in review': 'review', 'in progress': 'progress', blocked: 'blocked' };
const emptyRow = (id) => ({ id, total: 0, done: 0, review: 0, progress: 0, blocked: 0 });

export function milestonesOf(tasks, order = []) {
  const wanted = order.map((id) => String(id).toUpperCase());
  const rows = new Map(wanted.map((id) => [id, emptyRow(id)]));
  for (const task of tasks) {
    const id = (task.milestone || '(none)').toUpperCase();
    const row = rows.get(id) ?? emptyRow(id);
    row.total += 1;
    const key = STATUS_KEYS[task.status];
    if (key) row[key] += 1;
    rows.set(id, row);
  }
  const rank = (id) => {
    const k = wanted.indexOf(id);
    return k < 0 ? wanted.length : k;
  };
  // Configured milestones first, in order; the rest as they appear.
  return [...rows.values()].sort((a, b) => rank(a.id) - rank(b.id));
}

// The bullets under `heading` that start with a bold ID ("- **Q33:** …").
// Continuation lines indented under a bullet belong to it.
export function parseOpenQuestions(text, heading) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => l.replace(/[*#\-:\s]/g, '').toLowerCase() === heading.replace(/[*#\-:\s]/g, '').toLowerCase());
  if (start < 0) return [];
  const indent = (l) => l.match(/^\s*/)[0].length;
  const base = indent(lines[start]);
  const items = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    // The section ends at the next heading or a bullet at the heading's level.
    if (/^#{1,6}\s/.test(line) || (indent(line) <= base && /^\s*[-*]\s/.test(line))) break;
    const m = line.match(/^\s*[-*]\s+\*\*([^*]+?):?\*\*:?\s*(.*)$/);
    if (m) {
      current = { id: m[1].trim().replace(/:$/, ''), text: m[2].trim() };
      items.push(current);
    } else if (current) current.text += ` ${line.trim()}`;
  }
  return items;
}

export function readOpenQuestions(config) {
  const source = config.openQuestions;
  if (!source?.file || !source?.heading) return [];
  return parseOpenQuestions(readProjectFile(source.file), source.heading);
}
