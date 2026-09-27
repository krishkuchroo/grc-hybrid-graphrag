// Where things live: the main checkout, the logs folder, and a file's path
// relative to the checkout it sits in.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The main checkout. CLAUDE_PROJECT_DIR points here even inside worktrees.
export const PROJECT_DIR = resolve(
  process.env.CLAUDE_PROJECT_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
);

// GRC_LOGS_DIR lets the tests write somewhere else.
export const LOGS_DIR = resolve(process.env.GRC_LOGS_DIR || join(PROJECT_DIR, 'logs'));

// Real path of the nearest existing ancestor plus the rest, because the file
// may not exist yet (a Write that creates it).
export function realish(p) {
  let cur = resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(basename(cur));
    cur = parent;
  }
  let base = cur;
  try {
    base = realpathSync(cur);
  } catch {}
  return rest.length ? join(base, ...rest) : base;
}

export function nearestExistingDir(p) {
  let cur = resolve(p);
  while (!existsSync(cur) || !statSync(cur).isDirectory()) {
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
  return cur;
}

export function gitTopLevel(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

// A file's path relative to the checkout it sits in, with "/" separators, or
// null when it's outside the project. Worktrees live inside the project
// (.claude/worktrees/<name>/), so the deepest checkout wins.
export function repoRelative(filePath, cwd) {
  const abs = realish(isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
  const roots = new Set([realish(PROJECT_DIR)]);
  const top = gitTopLevel(nearestExistingDir(abs));
  if (top) roots.add(realish(top));
  let best = null;
  for (const root of roots) {
    if (isInside(abs, root) && (!best || root.length > best.length)) best = root;
  }
  if (best === null) return null;
  return relative(best, abs).split(sep).join('/');
}

// Claude Code's own config for this user. Agents never write there.
export function isInHomeClaudeDir(filePath, cwd) {
  const abs = realish(isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
  return isInside(abs, realish(join(homedir(), '.claude')));
}

// Expands a leading ~ the way the shell would.
export function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
