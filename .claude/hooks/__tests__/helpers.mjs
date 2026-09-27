// Shared set-up for the hook tests: node --test '.claude/hooks/__tests__/*.test.mjs'
// Every test file imports this first, so the environment is set before
// lib/paths.mjs reads it. Each file runs in its own process and temp folder.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHookInput } from '../lib/hook-input.mjs';

export const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'grc-hooks-')));
export const PROJECT = join(ROOT, 'project');
export const LOGS = join(ROOT, 'logs');
mkdirSync(PROJECT, { recursive: true });
process.env.CLAUDE_PROJECT_DIR = PROJECT;
process.env.GRC_LOGS_DIR = LOGS;
// Keep the user's own git settings (commit signing, hooks) out of the tests.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Hook Tests';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'hook-tests@example.invalid';
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));

export const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REAL_PROJECT = join(HOOKS_DIR, '..', '..');

// A fake key, assembled at run time so this source never holds one.
export const AWS_KEY = ['AKIA', 'Z7Q3', 'XJ2L', 'KM4N', 'P8R5'].join('');

export function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function put(dir, rel, text) {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

let repoCount = 0;
// A fresh git repo with one commit.
export function makeRepo(dir = join(ROOT, `repo-${++repoCount}`), files = { 'README.md': 'hello\n' }) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

// A hook's stdin, parsed the way the scripts parse it.
export const input = (raw) => parseHookInput(JSON.stringify(raw));

export function readJsonl(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// Runs a hook script the way Claude Code does: JSON on stdin.
export function runScript(name, stdin, { env = {}, cwd = PROJECT } = {}) {
  const r = spawnSync(process.execPath, [join(HOOKS_DIR, name)], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
