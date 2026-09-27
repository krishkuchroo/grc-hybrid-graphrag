// Shared set-up for the monitor tests: node --test '.claude/monitor/__tests__/*.test.mjs'
// Every test file imports this first, so the environment is set before
// lib/core.mjs reads it. Each file runs in its own process and temp folder.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'monitor-tests-')));
export const PROJECT = join(ROOT, 'project');
export const LOGS = join(ROOT, 'logs');
export const TRANSCRIPTS = join(ROOT, 'transcripts');
export const CONFIG = join(ROOT, 'monitor.config.json');
mkdirSync(join(PROJECT, '.claude', 'agents'), { recursive: true });
mkdirSync(TRANSCRIPTS, { recursive: true });
writeFileSync(CONFIG, JSON.stringify({ milestones: ['M0', 'S1'], openQuestions: { file: 'CLAUDE.md', heading: 'Open questions for the user' } }));
process.env.CLAUDE_PROJECT_DIR = PROJECT;
process.env.MONITOR_LOGS_DIR = LOGS;
process.env.MONITOR_CONFIG = CONFIG;
process.env.MONITOR_TRANSCRIPTS_ROOT = TRANSCRIPTS;
process.on('exit', () => rmSync(ROOT, { recursive: true, force: true }));

export const MONITOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

export function put(dir, rel, text) {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}

export const jsonl = (entries) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');

export function readJsonl(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// Runs the hook the way Claude Code does: JSON on stdin.
export function runHook(stdin) {
  const r = spawnSync(process.execPath, [join(MONITOR_DIR, 'hook.mjs')], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    encoding: 'utf8',
    env: process.env,
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Starts the server on a free port; resolves once it listens.
export function startServer(port) {
  const child = spawn(process.execPath, [join(MONITOR_DIR, 'server.mjs')], { env: { ...process.env, MONITOR_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      if (String(d).includes('Agent monitor:')) resolve(child);
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}
