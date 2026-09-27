// Reads one `git ...` call: its global options, subcommand and arguments.
// Also the one way the hooks run git themselves.
import { execFileSync } from 'node:child_process';

const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);

// `configs` holds each `-c name=value`. `--config-env name=VAR` takes its
// value from the environment, so it's marked dynamic.
export function gitCall(args) {
  let k = 0;
  let dir = null;
  const configs = [];
  while (k < args.length && args[k].value.startsWith('-')) {
    const v = args[k].value;
    if (v === '-C') {
      dir = args[k + 1] ?? null;
      k += 2;
    } else if (v === '-c') {
      if (args[k + 1]) configs.push(args[k + 1]);
      k += 2;
    } else if (v === '--config-env') {
      if (args[k + 1]) configs.push({ ...args[k + 1], dynamic: true });
      k += 2;
    } else if (v.startsWith('--config-env=')) {
      configs.push({ value: v.slice(13), dynamic: true });
      k += 1;
    } else if (GLOBAL_WITH_VALUE.has(v)) {
      k += 2;
    } else {
      k += 1;
    }
  }
  return { dir, configs, sub: args[k]?.value ?? '', subArgs: args.slice(k + 1) };
}

// A short option cluster such as -fd or -uf.
export const isShortCluster = (v) => /^-[A-Za-z0-9]+$/.test(v);

export function runGit(repo, args, { timeoutMs = 30_000, input } = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    input,
    timeout: timeoutMs,
  });
}

// Git's built-in commands. Git ignores an alias with one of these names, so
// only other names need looking up.
const BUILTINS = new Set(
  `add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap
  check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config
  count-objects credential describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch
  fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep
  hash-object help hook index-pack init interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance
  merge merge-base merge-file merge-index merge-tree mktag mktree multi-pack-index mv name-rev notes pack-objects
  pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase reflog refs remote repack replace
  replay rerere reset restore rev-list rev-parse revert rm shortlog show show-branch show-index show-ref
  sparse-checkout stage stash status stripspace submodule switch symbolic-ref tag unpack-file unpack-objects
  update-index update-ref update-server-info var verify-commit verify-pack verify-tag version whatchanged worktree
  write-tree`.split(/\s+/),
);

// The alias `name` stands for, or null. Aliases on the command line (-c)
// count; `repo` is where git would run, for the aliases saved in config.
export function gitAlias(call, repo) {
  const name = call.sub;
  if (!name || name.startsWith('-') || BUILTINS.has(name)) return null;
  const key = `alias.${name.toLowerCase()}=`;
  const inline = call.configs.find((c) => c.value.toLowerCase().startsWith(key));
  if (inline) return inline.value.slice(key.length);
  try {
    return runGit(repo, ['config', '--get', `alias.${name}`], { timeoutMs: 5000 }).trim() || null;
  } catch {
    return null; // not an alias: an external git-<name> command, or a typo
  }
}
