// Guard rail 2 (D57, D84, D94): no commits with secrets. The main check is
// git's own pre-commit hook (.claude/githooks/pre-commit), which sees
// exactly what gets committed, the user's commits included. This guard is
// its backup when an agent runs `git commit`, and it stops anyone skipping
// or switching off that check.
import { isAbsolute, resolve } from 'node:path';
import { gitCall, isShortCluster } from './lib/git.mjs';
import { expandHome, gitTopLevel } from './lib/paths.mjs';
import { block, isMain, runPreToolGuard } from './lib/run.mjs';
import { scanStaged, scanWorkingTree, secretsVerdict } from './lib/secret-scan.mjs';
import { envSettings, findInvocations, parseCommand, workingDirs } from './lib/shell.mjs';

// Set once at setup: git config core.hooksPath .claude/githooks
export const HOOKS_PATH = '.claude/githooks';

const COMMIT_LONG_WITH_VALUE = new Set([
  '--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date',
  '--fixup', '--squash', '--cleanup', '--trailer', '--pathspec-from-file', '--untracked-files',
]);
const COMMIT_SHORT_WITH_VALUE = new Set(['m', 'F', 'C', 'c', 't']);

// --no-verify (or -n) skips the pre-commit secret scan.
export function skipsHooks(args) {
  for (let k = 0; k < args.length; k += 1) {
    const v = args[k].value;
    if (v === '--') break;
    if (v === '--no-verify') return true;
    if (COMMIT_LONG_WITH_VALUE.has(v)) {
      k += 1;
      continue;
    }
    if (isShortCluster(v)) {
      for (const ch of v.slice(1)) {
        if (ch === 'n') return true;
        if (COMMIT_SHORT_WITH_VALUE.has(ch)) {
          if (v.endsWith(ch)) k += 1;
          break;
        }
      }
    }
  }
  return false;
}

// Commits the working tree rather than only what's staged: -a, --all, or paths.
function commitsWorkingTree(args) {
  for (let k = 0; k < args.length; k += 1) {
    const v = args[k].value;
    if (v === '--') return k + 1 < args.length;
    if (v === '--all' || v === '--include' || v === '--only') return true;
    if (COMMIT_LONG_WITH_VALUE.has(v)) {
      k += 1;
      continue;
    }
    if (v.startsWith('--')) continue;
    if (isShortCluster(v)) {
      for (const ch of v.slice(1)) {
        if (ch === 'a') return true;
        if (COMMIT_SHORT_WITH_VALUE.has(ch)) {
          if (v.endsWith(ch)) k += 1;
          break;
        }
      }
      continue;
    }
    return true; // a pathspec
  }
  return false;
}

// Pointing core.hooksPath anywhere but ours would switch the scan off.
export function changesHooksPath(call) {
  for (const c of call.configs) {
    if (/^core\.hookspath=/i.test(c.value)) {
      if (c.dynamic) return true;
      if (c.value.slice(c.value.indexOf('=') + 1) !== HOOKS_PATH) return true;
    }
  }
  if (call.sub !== 'config') return false;
  const words = call.subArgs.map((w) => w.value);
  const idx = words.findIndex((w) => w.toLowerCase() === 'core.hookspath');
  if (idx < 0) return false;
  if (words.some((w) => ['--get', '--get-all', '--get-regexp', '--list', '-l', 'get', 'list'].includes(w))) return false;
  if (words.some((w) => ['--unset', '--unset-all', '--remove-section', 'unset'].includes(w))) return true;
  if (words.some((w) => ['--global', '--system', '--file', '-f'].includes(w))) return true;
  const value = call.subArgs[idx + 1];
  return !value || value.dynamic || value.value !== HOOKS_PATH;
}

// The same through the environment: GIT_CONFIG_KEY_n with GIT_CONFIG_VALUE_n,
// or GIT_CONFIG_PARAMETERS. A value that can't be read counts as a change.
export function envChangesHooksPath(settings) {
  const env = new Map(settings.map((e) => [e.name, e]));
  for (const e of settings) {
    if (e.name === 'GIT_CONFIG_PARAMETERS' && (e.value === null || /core\.hookspath/i.test(e.value))) return true;
    const n = /^GIT_CONFIG_KEY_(\d+)$/.exec(e.name)?.[1];
    if (n === undefined) continue;
    if (e.value === null) return true;
    if (e.value.toLowerCase() !== 'core.hookspath') continue;
    if (env.get(`GIT_CONFIG_VALUE_${n}`)?.value !== HOOKS_PATH) return true;
  }
  return false;
}

function repoFor(call, dir) {
  let base = dir;
  if (call.dir) {
    if (call.dir.dynamic || base === null) return null;
    const d = expandHome(call.dir.value);
    base = isAbsolute(d) ? d : resolve(base, d);
  }
  return base === null ? null : gitTopLevel(base);
}

export function decideSecrets(command, cwd) {
  const text = String(command ?? '');
  const segments = parseCommand(text);
  if (envChangesHooksPath(envSettings(segments))) {
    return block(`setting core.hooksPath through GIT_CONFIG_* would switch off the secret scan (D57, D119). It stays ${HOOKS_PATH}.`, text);
  }
  const dirs = workingDirs(segments, cwd);
  let addedEarlier = false;
  for (const inv of findInvocations(segments, ['git'])) {
    const call = gitCall(inv.args);
    if (changesHooksPath(call)) {
      return block(`changing git's hooks path would switch off the secret scan (D57). It stays ${HOOKS_PATH}.`, text);
    }
    if (call.sub === 'add' || call.sub === 'stage') addedEarlier = true;
    if (call.sub !== 'commit') continue;
    if (skipsHooks(call.subArgs)) {
      return block('--no-verify would skip the secret scan on this commit (D57)', text);
    }
    const repo = repoFor(call, dirs[inv.segIndex]);
    if (!repo) continue;
    const result = addedEarlier || commitsWorkingTree(call.subArgs) ? scanWorkingTree(repo) : scanStaged(repo);
    if (result.findings.length) return secretsVerdict(result.findings);
  }
  return null;
}

if (isMain(import.meta.url)) {
  // Wired to Bash only; any call carrying a command is checked.
  runPreToolGuard('2', (input) => (typeof input.toolInput.command === 'string' ? decideSecrets(input.toolInput.command, input.cwd) : null));
}
