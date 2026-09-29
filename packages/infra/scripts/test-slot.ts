// Runs a command once one of a few shared test slots is free, so that at most GRC_TEST_SLOTS
// (default 3) db or stack test runs share the Mac at once, from any worktree (D215).
// Usage (from a package directory): node ../infra/scripts/test-slot.ts <command> [args...]
// A slot is a directory under the repository's shared git dir, holding the owner's process ID.
// A slot whose owner is gone is taken over. The command's exit code is passed through.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SLOTS = Math.max(1, Number(process.env.GRC_TEST_SLOTS ?? 3) || 3);
const WAIT_MS = 2000;

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('test-slot: name the command to run');
  process.exit(1);
}

const gitDir = spawnSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' });
if (gitDir.status !== 0) {
  console.error('test-slot: not inside the git repository');
  process.exit(1);
}
const root = join(resolve(gitDir.stdout.trim()), 'grc-test-slots');
mkdirSync(root, { recursive: true });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tryTake(dir: string): boolean {
  try {
    mkdirSync(dir);
  } catch {
    let owner: number;
    try {
      owner = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    } catch {
      return false; // being written right now
    }
    if (Number.isFinite(owner) && alive(owner)) return false;
    rmSync(dir, { recursive: true, force: true });
    try {
      mkdirSync(dir);
    } catch {
      return false;
    }
  }
  writeFileSync(join(dir, 'pid'), String(process.pid));
  return true;
}

async function take(): Promise<string> {
  let told = false;
  for (;;) {
    for (let k = 1; k <= SLOTS; k += 1) {
      const dir = join(root, `slot-${k}`);
      if (tryTake(dir)) return dir;
    }
    if (!told) {
      console.error(`test-slot: all ${SLOTS} test slots are busy; waiting`);
      told = true;
    }
    await new Promise((r) => setTimeout(r, WAIT_MS));
  }
}

const slot = await take();
const release = () => rmSync(slot, { recursive: true, force: true });
const child = spawn(command, args, { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => child.kill(sig));
}
child.on('error', (err) => {
  release();
  console.error(`test-slot: could not start ${command} (${err.message})`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  release();
  process.exit(code ?? (signal ? 1 : 0));
});
