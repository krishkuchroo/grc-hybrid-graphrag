// A small reader for shell command lines. It splits a command into simple
// commands and words closely enough to find docker and git calls and the
// files a command writes. It's best-effort by design: the hand-in checks
// back it up (D104).
import { basename, isAbsolute, resolve } from 'node:path';
import { expandHome } from './paths.mjs';

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const MAX_DEPTH = 5;

const REDIR = /(?:&>>|&>|>>|>\||>&|<&|<<<|<<-|<<|<>|>|<)/y;
const REDIR_FD = /\d+(?:>>|>\||>&|<&|<<<|<<-|<<|<>|>|<)/y;
const OPERATOR = /(?:&&|\|\||\|&|;;|\||;|&|\(|\))/y;
const HEREDOC_DELIM = /(['"]?)([^\s'";|&<>()]+)\1/y;

function stickyExec(re, s, at) {
  re.lastIndex = at;
  return re.exec(s);
}

// Matching ")" for a "$(" that opened just before `start`.
function readParen(s, start) {
  let depth = 1;
  let k = start;
  while (k < s.length) {
    const ch = s[k];
    if (ch === '\\') {
      k += 2;
      continue;
    }
    if (ch === "'") {
      const end = s.indexOf("'", k + 1);
      k = end < 0 ? s.length : end + 1;
      continue;
    }
    if (ch === '"') {
      k += 1;
      while (k < s.length && s[k] !== '"') k += s[k] === '\\' ? 2 : 1;
      k += 1;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return [s.slice(start, k), k];
    }
    k += 1;
  }
  return [s.slice(start), s.length];
}

// Turns a command line into word, operator and redirect tokens. Command
// substitutions become opaque "dynamic" words, and their inner text is
// returned in `nested` so callers can read it too.
export function tokenize(s) {
  const tokens = [];
  const nested = [];
  const heredocs = [];
  let word = null;
  let dynamic = false;
  let i = 0;
  const flush = () => {
    if (word !== null) tokens.push({ type: 'word', value: word, dynamic });
    word = null;
    dynamic = false;
  };
  const add = (text) => {
    word = (word ?? '') + text;
  };

  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];

    if (c === '\n') {
      flush();
      tokens.push({ type: 'op', value: ';' });
      i += 1;
      // Skip heredoc bodies: they're data, not commands.
      while (heredocs.length) {
        const { delim, strip } = heredocs.shift();
        while (i < s.length) {
          const end = s.indexOf('\n', i);
          const line = s.slice(i, end < 0 ? s.length : end);
          i = end < 0 ? s.length : end + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t') {
      flush();
      i += 1;
      continue;
    }
    if (c === '#' && word === null) {
      while (i < s.length && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === '\\') {
      if (next === '\n') i += 2;
      else {
        add(next ?? '');
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      add(s.slice(i + 1, end < 0 ? s.length : end));
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '"') {
      let k = i + 1;
      let buf = '';
      while (k < s.length && s[k] !== '"') {
        if (s[k] === '\\' && k + 1 < s.length && '"\\$`\n'.includes(s[k + 1])) {
          buf += s[k + 1];
          k += 2;
        } else if (s[k] === '$' && s[k + 1] === '(') {
          const [inner, end] = readParen(s, k + 2);
          nested.push(inner);
          buf += '$(…)';
          dynamic = true;
          k = end + 1;
        } else if (s[k] === '`') {
          const end = s.indexOf('`', k + 1);
          nested.push(s.slice(k + 1, end < 0 ? s.length : end));
          buf += '`…`';
          dynamic = true;
          k = end < 0 ? s.length : end + 1;
        } else {
          if (s[k] === '$') dynamic = true;
          buf += s[k];
          k += 1;
        }
      }
      add(buf);
      i = k + 1;
      continue;
    }
    if (c === '$' && next === '(') {
      const [inner, end] = readParen(s, i + 2);
      nested.push(inner);
      add('$(…)');
      dynamic = true;
      i = end + 1;
      continue;
    }
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      nested.push(s.slice(i + 1, end < 0 ? s.length : end));
      add('`…`');
      dynamic = true;
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '$') {
      dynamic = true;
      add('$');
      i += 1;
      continue;
    }
    // Redirects: [n]> [n]>> >| &> &>> < << <<- <<< <> >& <&
    let redir = null;
    if (c === '>' || c === '<' || (c === '&' && next === '>')) redir = stickyExec(REDIR, s, i);
    else if (word === null && c >= '0' && c <= '9') redir = stickyExec(REDIR_FD, s, i);
    if (redir) {
      flush();
      tokens.push({ type: 'redir', op: redir[0] });
      i += redir[0].length;
      if (/^\d*<<-?$/.test(redir[0])) {
        // The next word is the heredoc delimiter.
        while (s[i] === ' ' || s[i] === '\t') i += 1;
        const m = stickyExec(HEREDOC_DELIM, s, i);
        if (m) {
          heredocs.push({ delim: m[2], strip: redir[0].endsWith('-') });
          tokens.push({ type: 'word', value: m[2], dynamic: false });
          i += m[0].length;
        }
      }
      continue;
    }
    const op = '&|;()'.includes(c) ? stickyExec(OPERATOR, s, i) : null;
    if (op) {
      flush();
      tokens.push({ type: 'op', value: op[0] });
      i += op[0].length;
      continue;
    }
    add(c);
    i += 1;
  }
  flush();
  return { tokens, nested };
}

// Splits tokens into simple commands. A redirect's target is the word after it.
function toSegments(tokens) {
  const segments = [];
  let cur = { words: [], redirects: [] };
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type === 'op') {
      if (cur.words.length || cur.redirects.length) segments.push(cur);
      cur = { words: [], redirects: [] };
    } else if (t.type === 'redir') {
      const target = tokens[k + 1]?.type === 'word' ? tokens[k + 1] : null;
      cur.redirects.push({ op: t.op, target: target?.value ?? '', dynamic: target?.dynamic ?? true });
      if (target) k += 1;
    } else if (!(cur.words.length === 0 && (t.value === '{' || t.value === '!'))) {
      cur.words.push(t);
    }
  }
  if (cur.words.length || cur.redirects.length) segments.push(cur);
  return segments;
}

// Scripts handed to `bash -c`, `sh -c` and `eval` are commands too.
function innerScripts(segment) {
  const words = segment.words.map((w) => w.value);
  const scripts = [];
  words.forEach((w, idx) => {
    if (SHELLS.has(basename(w))) {
      for (let k = idx + 1; k < words.length; k += 1) {
        if (/^-[a-z]*c[a-z]*$/.test(words[k]) && words[k + 1] !== undefined) {
          scripts.push(words[k + 1]);
          break;
        }
        if (!words[k].startsWith('-')) break;
      }
    }
    if (w === 'eval' && idx === 0) scripts.push(words.slice(1).join(' '));
  });
  return scripts;
}

// Every simple command in a command line, including ones inside $(...),
// backticks, `bash -c` and `eval`.
export function parseCommand(command, depth = 0) {
  const { tokens, nested } = tokenize(String(command ?? ''));
  const segments = toSegments(tokens);
  if (depth < MAX_DEPTH) {
    for (const seg of [...segments]) {
      for (const script of innerScripts(seg)) segments.push(...parseCommand(script, depth + 1));
    }
    for (const inner of nested) segments.push(...parseCommand(inner, depth + 1));
  }
  return segments;
}

// Places in the command where one of `names` runs, e.g. docker or git, with
// the words that follow it. Wrappers such as sudo, env, xargs and timeout
// are covered because the name is found anywhere in the simple command.
export function findInvocations(segments, names) {
  const wanted = new Set(names);
  const found = [];
  segments.forEach((segment, segIndex) => {
    segment.words.forEach((w, idx) => {
      if (!w.dynamic && wanted.has(basename(w.value))) {
        found.push({ name: basename(w.value), args: segment.words.slice(idx + 1), segment, segIndex });
      }
    });
  });
  return found;
}

// Wrappers that run another command, and which of their flags take a value.
const WRAPPERS = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'],
  env: ['-u', '-C', '-S'],
  nohup: [],
  time: [],
  nice: ['-n'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  command: [],
  builtin: [],
  exec: ['-a'],
  xargs: ['-I', '-i', '-L', '-l', '-n', '-P', '-s', '-E', '-e', '-d', '-a'],
  stdbuf: ['-i', '-o', '-e'],
};
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const EXPORTERS = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);

// The command a simple command really runs, past FOO=bar assignments and
// wrappers such as sudo, env and timeout, with the assignments it passed.
export function unwrap(segment) {
  let words = segment.words;
  const assignments = [];
  for (let guard = 0; guard < 6; guard += 1) {
    while (words.length && ASSIGNMENT.test(words[0].value)) {
      assignments.push(words[0]);
      words = words.slice(1);
    }
    const flags = WRAPPERS[basename(words[0]?.value ?? '')];
    if (!flags) break;
    const name = basename(words[0].value);
    let k = 1;
    while (k < words.length && words[k].value.startsWith('-')) k += flags.includes(words[k].value) ? 2 : 1;
    if (name === 'timeout' && k < words.length) k += 1;
    words = words.slice(k);
  }
  return { words, assignments };
}

// Every environment variable a command line sets: FOO=bar before a command
// or on its own, `env FOO=bar`, and `export`/`declare -x` and the like.
// [{ name, value, dynamic }]; `value` is null when it can't be known.
export function envSettings(segments) {
  const out = [];
  const add = (w) => {
    const m = ASSIGNMENT.exec(w.value);
    if (m) out.push({ name: m[1], value: w.dynamic ? null : m[2], dynamic: w.dynamic });
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(w.value)) out.push({ name: w.value, value: null, dynamic: true });
  };
  for (const segment of segments) {
    const { words, assignments } = unwrap(segment);
    assignments.forEach(add);
    if (EXPORTERS.has(words[0]?.value)) words.slice(1).filter((w) => !w.value.startsWith('-')).forEach(add);
  }
  return out;
}

// The first program name the guards can't read because it's built at run
// time: `$(echo docker) rm …`, `$CMD push`, `eval "$X"`, `bash -c "$X"`.
export function dynamicCommand(segments) {
  for (const segment of segments) {
    const { words } = unwrap(segment);
    if (!words.length) continue;
    if (words[0].dynamic) return words[0].value;
    const name = basename(words[0].value);
    if (name === 'eval' && words.slice(1).some((w) => w.dynamic)) return words.map((w) => w.value).join(' ');
    if (SHELLS.has(name)) {
      const k = words.findIndex((w, idx) => idx > 0 && /^-[a-z]*c[a-z]*$/.test(w.value));
      if (k > 0 && words[k + 1]?.dynamic) return words.map((w) => w.value).join(' ');
    }
  }
  return null;
}

// Environment assignments at the start of a simple command (FOO=bar cmd).
export function leadingAssignments(segment) {
  const env = {};
  for (const w of segment.words) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w.value);
    if (!m) break;
    env[m[1]] = w.dynamic ? null : m[2];
  }
  return env;
}

// The working directory each simple command runs in, following literal
// `cd`/`pushd` calls. null means it can't be known (cd $X, cd -).
export function workingDirs(segments, cwd) {
  let dir = cwd;
  return segments.map((segment) => {
    const words = segment.words;
    const current = dir;
    if (words[0] && (words[0].value === 'cd' || words[0].value === 'pushd')) {
      const target = words.find((w, k) => k > 0 && !w.value.startsWith('-'));
      if (!target) dir = expandHome('~');
      else if (target.dynamic || target.value === '-') dir = null;
      else if (dir !== null || isAbsolute(expandHome(target.value))) {
        const t = expandHome(target.value);
        dir = isAbsolute(t) ? resolve(t) : resolve(dir, t);
      }
    }
    return current;
  });
}
