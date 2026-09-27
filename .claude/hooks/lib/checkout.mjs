// How a checkout looked when an agent started, and which files changed
// since, for the hand-in backstop of guard rails 5 and 7.
import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { runGit as git } from './git.mjs';
import { LOGS_DIR, gitTopLevel, isInside, realish } from './paths.mjs';

const split = (text) => text.split('\0').filter(Boolean);

export function signature(file) {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'missing';
  }
}

// Changed and untracked (not ignored) paths, relative to the repo.
function dirtyPaths(repo) {
  const parts = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0');
  const paths = [];
  for (let k = 0; k < parts.length; k += 1) {
    const entry = parts[k];
    if (!entry) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') {
      k += 1;
      if (parts[k]) paths.push(parts[k]);
    }
  }
  return paths;
}

export function snapshot(cwd) {
  const repo = gitTopLevel(cwd);
  if (!repo) return { repo: null };
  let head = null;
  try {
    head = git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).trim() || null;
  } catch {}
  const dirty = {};
  for (const p of dirtyPaths(repo).slice(0, 5000)) dirty[p] = signature(join(repo, p));
  return { repo, head, dirty };
}

// Paths edited through Edit/Write/NotebookEdit by anyone else (another agent
// or the main session) since `since`, relative to `repo`.
function editedByOthers(agentId, since, repo, activityFile) {
  const out = new Set();
  let text = '';
  try {
    text = readFileSync(activityFile, 'utf8');
  } catch {
    return out;
  }
  const root = realish(repo);
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.path || e.agent_id === agentId || (since && e.ts < since)) continue;
    const abs = realish(e.path);
    if (isInside(abs, root) && abs !== root) out.add(relative(root, abs).split(sep).join('/'));
  }
  return out;
}

// Where to diff from. In a worktree, an agent that moves its branch onto the
// current main brings in commits others made after the worktree was created
// (M0-001's first run): diff from where its branch meets main instead, but
// only when that point is later than the start commit. The main checkout
// always diffs from the start commit.
function diffBase(repo, head) {
  try {
    const gitDir = resolve(repo, git(repo, ['rev-parse', '--git-dir']).trim());
    const common = resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).trim());
    if (realish(gitDir) === realish(common)) return head;
    const base = git(repo, ['merge-base', 'HEAD', 'refs/heads/main']).trim();
    git(repo, ['merge-base', '--is-ancestor', head, base]);
    return base || head;
  } catch {
    return head;
  }
}

// Files this agent changed since it started: anything git sees as changed
// since the start commit (or the diffBase above), minus files that were
// already changed and haven't been touched since, minus files someone else
// edited.
export function changedSince(start, agentId, activityFile = join(LOGS_DIR, 'activity.jsonl')) {
  const { repo, head, dirty = {}, startedAt } = start;
  const names = new Set();
  if (head) split(git(repo, ['diff', '--name-only', '-z', diffBase(repo, head)])).forEach((p) => names.add(p));
  else {
    split(git(repo, ['diff', '--name-only', '-z', '--cached'])).forEach((p) => names.add(p));
    split(git(repo, ['diff', '--name-only', '-z'])).forEach((p) => names.add(p));
  }
  split(git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).forEach((p) => names.add(p));
  const others = editedByOthers(agentId, startedAt, repo, activityFile);
  return [...names].filter((p) => {
    if (p in dirty && dirty[p] === signature(join(repo, p))) return false;
    return !others.has(p);
  });
}

// True when `absPath` didn't exist in the checkout when the agent started
// and isn't tracked by git: the agent created it.
export function createdSinceStart(start, absPath) {
  if (!start?.repo) return false;
  const root = realish(start.repo);
  const abs = realish(absPath);
  if (!isInside(abs, root)) return false;
  const rel = relative(root, abs).split(sep).join('/');
  if (rel in (start.dirty ?? {})) return false;
  try {
    git(start.repo, ['ls-files', '--error-unmatch', '--', rel]);
    return false;
  } catch {
    return true;
  }
}
