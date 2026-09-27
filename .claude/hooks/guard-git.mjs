// Guard rail 3 (D81, D84, D105): no force-pushes, branch deletions or hard
// resets, no throwing away unsaved work, and only the integrator pushes.
// Ported from the approved git-guardrails-claude-code script (D90), with
// the integrator allowed to push (D81) and the whole-folder-only forms of
// `git checkout .` and `git restore .` (D105). Aliases and GIT_CONFIG_*
// settings can hide what a command runs, so they're blocked too (D119).
import { isAbsolute, resolve } from 'node:path';
import { gitAlias, gitCall, isShortCluster } from './lib/git.mjs';
import { expandHome } from './lib/paths.mjs';
import { canPush } from './lib/roles.mjs';
import { block, isMain, runPreToolGuard } from './lib/run.mjs';
import { envSettings, findInvocations, parseCommand, workingDirs } from './lib/shell.mjs';

// Pathspecs that mean "the whole folder".
const WHOLE_FOLDER = new Set(['.', './', ':/', ':(top)', ':/.', '*']);
const PUSH_LONG_WITH_VALUE = new Set(['--push-option', '--repo', '--receive-pack', '--exec']);
const CHECKOUT_WITH_VALUE = new Set(['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file']);
const RESTORE_WITH_VALUE = new Set(['-s', '--source', '--conflict', '--pathspec-from-file']);
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', 'get', 'list']);
// The GitHub CLI's own commands; anything else is an alias or an extension.
const GH_COMMANDS = new Set(
  `agent-task alias api attestation auth browse cache co codespace completion config copilot cs extension gist gpg-key
  help issue label org pr preview project release repo ruleset run search secret ssh-key status variable version
  workflow`.split(/\s+/),
);
const NO_AUTHORITY = "You don't have authority to run this.";

function pushProblems(args) {
  let force = false;
  let deletes = false;
  for (let k = 0; k < args.length; k += 1) {
    const v = args[k].value;
    if (v === '--') continue;
    if (v === '--force' || v === '--force-if-includes' || v === '--mirror' || v.startsWith('--force-with-lease')) force = true;
    else if (v === '--delete' || v === '--prune') deletes = true;
    else if (PUSH_LONG_WITH_VALUE.has(v) || v === '-o') k += 1;
    else if (isShortCluster(v)) {
      if (v.includes('f')) force = true;
      if (v.includes('d')) deletes = true;
    } else if (!v.startsWith('-')) {
      if (v.startsWith('+') || v.includes(':+')) force = true;
      if (v.startsWith(':') && v.length > 1) deletes = true;
    }
  }
  return { force, deletes };
}

function pathspecs(args, valueFlags) {
  const out = [];
  let rest = false;
  for (let k = 0; k < args.length; k += 1) {
    const v = args[k].value;
    if (!rest && v === '--') {
      rest = true;
      continue;
    }
    if (!rest && v.startsWith('-')) {
      if (valueFlags.has(v)) k += 1;
      continue;
    }
    out.push(v);
  }
  return out;
}

const touchesWholeFolder = (specs) => specs.some((s) => WHOLE_FOLDER.has(s));

// Agents don't define git aliases: `-c alias.x=…` or `git config alias.x …`.
function definesAlias(call) {
  if (call.configs.some((c) => c.dynamic || /^alias\./i.test(c.value))) return true;
  if (call.sub !== 'config') return false;
  const words = call.subArgs.map((w) => w.value);
  if (words.some((w) => CONFIG_READS.has(w))) return false;
  return call.subArgs.some((w) => w.dynamic || /^alias\./i.test(w.value));
}

function gitDir(call, dir, cwd) {
  const base = dir ?? cwd;
  if (!call.dir || call.dir.dynamic) return base;
  const d = expandHome(call.dir.value);
  return isAbsolute(d) ? d : resolve(base, d);
}

function decideGitCall(call, agentType, text) {
  const args = call.subArgs;
  const has = (...flags) => args.some((w) => flags.includes(w.value));
  const cluster = (letters) => args.some((w) => isShortCluster(w.value) && [...w.value.slice(1)].some((ch) => letters.includes(ch)));
  switch (call.sub) {
    case 'push': {
      const { force, deletes } = pushProblems(args);
      if (force) return block(`force-push is never allowed, not even for the integrator (D84). ${NO_AUTHORITY}`, text);
      if (deletes) return block(`deleting branches is blocked, here and on GitHub (D84). ${NO_AUTHORITY}`, text);
      if (!canPush(agentType)) return block(`only the integrator pushes to GitHub (D81). ${NO_AUTHORITY}`, text);
      return null;
    }
    case 'branch':
      if (has('--delete') || cluster('dD')) return block(`deleting branches is blocked (D84). ${NO_AUTHORITY}`, text);
      return null;
    case 'reset':
      if (has('--hard')) return block(`git reset --hard throws away work and is blocked (D84). ${NO_AUTHORITY}`, text);
      return null;
    case 'clean':
      if (has('--force') || cluster('f')) return block(`git clean -f deletes untracked files, which is unsaved work (D105). ${NO_AUTHORITY}`, text);
      return null;
    case 'checkout':
      if (touchesWholeFolder(pathspecs(args, CHECKOUT_WITH_VALUE))) {
        return block(`git checkout . throws away every unsaved change in the folder (D105). Name the files instead. ${NO_AUTHORITY}`, text);
      }
      return null;
    case 'restore': {
      if (!touchesWholeFolder(pathspecs(args, RESTORE_WITH_VALUE))) return null;
      const staged = has('--staged') || cluster('S');
      const worktree = has('--worktree') || cluster('W');
      if (staged && !worktree) return null; // only unstages; nothing is lost
      return block(`git restore . throws away every unsaved change in the folder (D105). Name the files instead. ${NO_AUTHORITY}`, text);
    }
    case 'update-ref':
      if (has('-d', '--delete')) return block(`deleting refs, which deletes branches, is blocked (D84). ${NO_AUTHORITY}`, text);
      return null;
    default:
      return null;
  }
}

function apiMethod(values) {
  for (let k = 0; k < values.length; k += 1) {
    const v = values[k];
    if (v === '-X' || v === '--method') return String(values[k + 1] ?? '').toUpperCase();
    if (v.startsWith('--method=')) return v.slice(9).toUpperCase();
    if (/^-X[A-Za-z]+$/.test(v)) return v.slice(2).toUpperCase();
  }
  const sendsFields = values.some((v) => ['-f', '-F', '--field', '--raw-field', '--input'].includes(v));
  return sendsFields ? 'POST' : 'GET';
}

// The GitHub CLI can push and delete too.
function decideGh(args, agentType, isAgent, text) {
  const values = args.map((w) => w.value);
  const [area, action] = values.filter((v) => !v.startsWith('-'));
  if (area && !GH_COMMANDS.has(area)) {
    return block(`"gh ${area}" isn't a GitHub CLI command the guard rails know; if it's an alias, write the command out (D119). ${NO_AUTHORITY}`, text);
  }
  if (isAgent && area === 'alias' && (action === 'set' || action === 'import')) {
    return block(`agents don't define GitHub CLI aliases; they can hide what a command does (D119). ${NO_AUTHORITY}`, text);
  }
  const method = area === 'api' ? apiMethod(values) : null;
  if (area === 'repo' && action === 'delete') return block(`deleting a GitHub repository is blocked (D84). ${NO_AUTHORITY}`, text);
  if (area === 'repo' && action === 'sync' && values.includes('--force')) return block(`force-syncing on GitHub is a force-push (D84). ${NO_AUTHORITY}`, text);
  if (area === 'pr' && action === 'merge' && (values.includes('-d') || values.includes('--delete-branch'))) {
    return block(`deleting branches is blocked, here and on GitHub (D84). ${NO_AUTHORITY}`, text);
  }
  if (method === 'DELETE') return block(`deleting things on GitHub through the API is blocked (D84). ${NO_AUTHORITY}`, text);
  if (!canPush(agentType)) {
    if (area === 'repo' && action === 'create' && values.includes('--push')) return block(`only the integrator pushes to GitHub (D81). ${NO_AUTHORITY}`, text);
    if ((area === 'pr' && action === 'merge') || (area === 'repo' && action === 'sync') || (area === 'api' && method !== 'GET')) {
      return block(`only the integrator changes the GitHub repository (D81, D119). ${NO_AUTHORITY}`, text);
    }
  }
  return null;
}

export function decideGit(command, agentType = '', isAgent = false, cwd = process.cwd()) {
  const text = String(command ?? '');
  const segments = parseCommand(text);
  if (isAgent) {
    const setting = envSettings(segments).find((e) => e.name.startsWith('GIT_CONFIG'));
    if (setting) return block(`setting ${setting.name} changes git's settings behind the guard rails, so agents don't set it (D119). ${NO_AUTHORITY}`, text);
  }
  const dirs = workingDirs(segments, cwd);
  for (const inv of findInvocations(segments, ['git'])) {
    const call = gitCall(inv.args);
    if (isAgent && definesAlias(call)) {
      return block(`agents don't define git aliases; they can hide what a command does (D119). ${NO_AUTHORITY}`, text);
    }
    const alias = gitAlias(call, gitDir(call, dirs[inv.segIndex], cwd));
    if (alias !== null) {
      return block(`"git ${call.sub}" is an alias for "${alias}". Write the command out, so the guard rails can check it (D119). ${NO_AUTHORITY}`, text);
    }
    const verdict = decideGitCall(call, agentType, text);
    if (verdict) return verdict;
  }
  for (const inv of findInvocations(segments, ['gh'])) {
    const verdict = decideGh(inv.args, agentType, isAgent, text);
    if (verdict) return verdict;
  }
  return null;
}

if (isMain(import.meta.url)) {
  // Wired to Bash only; any call carrying a command is checked.
  runPreToolGuard('3', (input) =>
    typeof input.toolInput.command === 'string' ? decideGit(input.toolInput.command, input.agentType, Boolean(input.agentId), input.cwd) : null,
  );
}
