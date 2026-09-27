// How a checkout looked when an agent started, and which files changed
// since, for the hand-in backstop of guard rails 5 and 7.
import { readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
  let tips = [];
  try {
    tips = [...new Set(git(repo, ['for-each-ref', '--format=%(objectname)', 'refs/heads']).split('\n').filter(Boolean))].slice(0, 200);
  } catch {}
  return { repo, head, dirty, tips };
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

// path -> blob id for every file in a commit's tree.
function treeOf(repo, commit) {
  const files = new Map();
  for (const entry of split(git(repo, ['ls-tree', '-r', '-z', commit]))) {
    const tab = entry.indexOf('\t');
    files.set(entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2]);
  }
  return files;
}

// Paths whose current content (or absence) matches a commit that existed
// without the agent: a branch tip when it started, or main now. A worktree
// agent that switches onto a task branch or rebases onto main brings in
// other people's commits; those files aren't its changes (M0-001's runs).
function othersContent(repo, tips, paths) {
  const same = new Set();
  const commits = new Set(tips);
  try {
    commits.add(git(repo, ['rev-parse', '--verify', '-q', 'refs/heads/main']).trim());
  } catch {}
  commits.delete('');
  if (!paths.length || !commits.size) return same;
  const present = paths.filter((p) => signature(join(repo, p)) !== 'missing');
  const current = new Map();
  if (present.length) {
    const ids = git(repo, ['hash-object', '--stdin-paths'], { input: `${present.join('\n')}\n` }).trim().split('\n');
    present.forEach((p, k) => current.set(p, ids[k]));
  }
  for (const commit of commits) {
    let tree;
    try {
      tree = treeOf(repo, commit);
    } catch {
      continue;
    }
    for (const p of paths) if (tree.get(p) === current.get(p)) same.add(p);
  }
  return same;
}

// Files this agent changed since it started: anything git sees as changed
// since the start commit, minus files whose content matches work that
// existed without the agent, minus files that were already changed and
// haven't been touched since, minus files someone else edited.
export function changedSince(start, agentId, activityFile = join(LOGS_DIR, 'activity.jsonl')) {
  const { repo, head, dirty = {}, startedAt } = start;
  const names = new Set();
  if (head) split(git(repo, ['diff', '--name-only', '-z', head])).forEach((p) => names.add(p));
  else {
    split(git(repo, ['diff', '--name-only', '-z', '--cached'])).forEach((p) => names.add(p));
    split(git(repo, ['diff', '--name-only', '-z'])).forEach((p) => names.add(p));
  }
  split(git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).forEach((p) => names.add(p));
  const others = editedByOthers(agentId, startedAt, repo, activityFile);
  const theirs = othersContent(repo, start.tips ?? [], [...names]);
  return [...names].filter((p) => {
    if (theirs.has(p)) return false;
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
