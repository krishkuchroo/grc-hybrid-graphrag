// Files a shell command would write, delete or move, for the front gates of
// guard rails 5 and 7. Best-effort: the hand-in check catches anything this
// misses (D104).
import { globSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { gitCall } from './git.mjs';
import { parseCommand, unwrap, workingDirs } from './shell.mjs';

const HARMLESS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '-']);

// Words that aren't flags, skipping the value of flags that take one.
function operands(words, valueFlags = []) {
  const out = [];
  let rest = false;
  for (let k = 0; k < words.length; k += 1) {
    const w = words[k];
    if (!rest && w.value === '--') {
      rest = true;
      continue;
    }
    if (!rest && w.value.startsWith('-') && w.value !== '-') {
      if (valueFlags.includes(w.value)) k += 1;
      continue;
    }
    out.push(w);
  }
  return out;
}

function flagValue(words, names) {
  for (let k = 0; k < words.length; k += 1) {
    const v = words[k].value;
    for (const n of names) {
      if (v === n && words[k + 1]) return words[k + 1];
      if (n.startsWith('--') && v.startsWith(`${n}=`)) return { value: v.slice(n.length + 1), dynamic: words[k].dynamic };
    }
  }
  return null;
}

function gitTargets(words) {
  const { dir, sub, subArgs: args } = gitCall(words);
  const ops = operands(args, ['-s', '--source', '-b', '-B', '--conflict', '-m']);
  let paths = [];
  if (sub === 'checkout') {
    const dd = args.findIndex((w) => w.value === '--');
    paths = dd >= 0 ? args.slice(dd + 1) : ops.slice(1);
  } else if (sub === 'restore' || sub === 'rm' || sub === 'mv') {
    paths = ops;
  }
  return { dir, paths, op: sub === 'checkout' || sub === 'restore' ? 'git-restore' : 'git' };
}

function targetsOf(words) {
  const name = basename(words[0]?.value ?? '');
  const args = words.slice(1);
  const all = (valueFlags) => operands(args, valueFlags);
  switch (name) {
    case 'tee':
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
      return all();
    case 'touch':
      return all(['-r', '--reference', '-d', '-t']);
    case 'truncate':
      return all(['-s', '--size', '-r', '--reference']);
    case 'mv': {
      const t = flagValue(args, ['-t', '--target-directory']);
      return [...all(['-t', '--target-directory', '-S', '--suffix']), ...(t ? [t] : [])];
    }
    case 'cp':
    case 'install':
    case 'ln':
    case 'rsync': {
      const t = flagValue(args, ['-t', '--target-directory']);
      const ops = all(['-t', '--target-directory', '-S', '--suffix', '-m', '-o', '-g', '-e', '--exclude', '--include']);
      return t ? [t] : ops.slice(-1);
    }
    case 'sed': {
      const inPlace = args.some((w) => /^--in-place/.test(w.value) || /^-[a-zA-Z]*i/.test(w.value));
      if (!inPlace) return [];
      const cleaned = args.filter((w, k) => !(w.value === '' && /^-[a-zA-Z]*i$/.test(args[k - 1]?.value ?? '')));
      const hasScriptFlag = cleaned.some((w) => ['-e', '--expression', '-f', '--file'].includes(w.value));
      const ops = operands(cleaned, ['-e', '--expression', '-f', '--file', '-l']);
      return hasScriptFlag ? ops : ops.slice(1);
    }
    case 'perl': {
      if (!args.some((w) => /^-[a-zA-Z]*i/.test(w.value))) return [];
      const out = [];
      for (let k = 0; k < args.length; k += 1) {
        const v = args[k].value;
        if (/^-[a-zA-Z]*[eE]$/.test(v)) k += 1;
        else if (!v.startsWith('-')) out.push(args[k]);
      }
      return out;
    }
    case 'dd':
      return args.filter((w) => w.value.startsWith('of=')).map((w) => ({ ...w, value: w.value.slice(3) }));
    case 'curl': {
      const o = flagValue(args, ['-o', '--output']);
      return o ? [o] : [];
    }
    case 'wget': {
      const o = flagValue(args, ['-O', '--output-document']);
      return o ? [o] : [];
    }
    case 'find': {
      const deletes = args.some((w) => w.value === '-delete') || args.some((w, k) => ['-exec', '-execdir', '-ok'].includes(w.value) && ['rm', 'mv', 'shred', 'unlink'].includes(basename(args[k + 1]?.value ?? '')));
      if (!deletes) return [];
      const starts = [];
      for (const w of args) {
        if (w.value.startsWith('-') || w.value === '(' || w.value === '!') break;
        starts.push(w);
      }
      return starts;
    }
    default:
      break;
  }
  // Formatters and linters that rewrite files: `prettier --write`, `eslint --fix`.
  const idx = words.findIndex((w) => ['prettier', 'eslint'].includes(basename(w.value)));
  if (idx >= 0) {
    const rest = words.slice(idx + 1);
    const writes = rest.some((w) => ['--write', '-w', '--fix'].includes(w.value));
    if (writes) return operands(rest, ['-c', '--config', '--ext', '-f', '--format', '-o', '--output-file', '--rule', '--ignore-pattern', '--ignore-path', '--cache-location', '--max-warnings', '--plugin', '--parser']);
  }
  return [];
}

function expandGlobs(pattern, cwd) {
  if (!/[*?[]/.test(pattern)) return [pattern];
  try {
    const matches = globSync(pattern, { cwd }).slice(0, 1000);
    return matches.length ? [pattern, ...matches] : [pattern];
  } catch {
    return [pattern];
  }
}

function expandVars(value) {
  return value.replace(/^(?:\$HOME|\$\{HOME\}|~)(?=\/|$)/, homedir());
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// Files a tool call writes: the file of an edit tool, or a command's targets.
export function writeTargetsOf(input) {
  if (EDIT_TOOLS.has(input.toolName)) {
    const p = input.toolInput.file_path ?? input.toolInput.notebook_path;
    return p ? [{ path: p, op: 'write' }] : [];
  }
  if (input.toolName === 'Bash') return bashWriteTargets(input.toolInput.command, input.cwd);
  return [];
}

// [{ path, op, dynamic }] with `path` absolute. `op` is "write", "delete",
// "git-restore" or "git". `dynamic` means the name is built at run time,
// so the real file can't be known.
export function bashWriteTargets(command, cwd) {
  const segments = parseCommand(command);
  const dirs = workingDirs(segments, cwd);
  const out = [];
  const add = (w, dir, op) => {
    const raw = expandVars(w.value);
    if (!raw || HARMLESS.has(raw) || /^\d+$/.test(raw)) return;
    // Built at run time ($X, $(…), `…`), apart from $HOME, which is known.
    const dynamic = Boolean(w.dynamic) && /[$`]/.test(raw);
    const base = dir ?? cwd;
    for (const p of expandGlobs(raw, base)) out.push({ path: isAbsolute(p) ? p : resolve(base, p), op, dynamic });
  };
  segments.forEach((segment, k) => {
    const dir = dirs[k];
    for (const r of segment.redirects) {
      if (/[>]/.test(r.op) && !/&$/.test(r.op) && r.op !== '>&') add({ value: r.target, dynamic: r.dynamic }, dir, 'write');
    }
    const { words } = unwrap(segment);
    if (!words.length) return;
    const name = basename(words[0].value);
    if (name === 'git') {
      const g = gitTargets(words.slice(1));
      const gitDir = g.dir && !g.dir.dynamic ? resolve(dir ?? cwd, expandVars(g.dir.value)) : dir;
      for (const p of g.paths) add(p, gitDir, g.op);
      return;
    }
    const op = ['rm', 'rmdir', 'unlink', 'shred'].includes(name) ? 'delete' : 'write';
    for (const t of targetsOf(words)) add(t, dir, op);
  });
  return out;
}
