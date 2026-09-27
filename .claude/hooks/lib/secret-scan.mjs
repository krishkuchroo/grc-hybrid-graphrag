// D94: our own small pattern scan for secrets in commits (D57). It runs as
// git's pre-commit check and, as a backup, when an agent runs `git commit`.
// Findings name the file, line and kind of secret, never the secret itself.
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runGit } from './git.mjs';
import { isTestPath } from './testfiles.mjs';

// A line containing this is skipped. Every skip is printed, so reviewers see it.
export const ALLOW_PRAGMA = 'secret-scan: allow';

// Known key formats: checked in every file.
const TOKEN_PATTERNS = [
  { name: 'private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: 'AWS access key ID', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI-style API key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Stripe live key', re: /\b[rs]k_live_[A-Za-z0-9]{16,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}/ },
];

// A password inside a connection string, like postgres://app:s3cret@host.
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:([^\s@/'"`]+)@/gi;

// A secret-looking name assigned a quoted literal. Test files are skipped,
// because login tests need literal passwords.
const ASSIGNMENT =
  /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|bearer)[a-z0-9_]*["']?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

const PLACEHOLDER =
  /^(?:x+|\*+|\.+|changeme|change-me|password|passw0rd|secret|example|placeholder|dummy|test|todo|none|null|undefined|redacted|your[-_a-z]*)$/i;
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);
const EXAMPLE_ENV = /^\.env\.(?:example|sample|template)$/;

function looksReal(value) {
  if (/[${}<>%]|process\.env|import\.meta/.test(value)) return false;
  if (PLACEHOLDER.test(value)) return false;
  if (/^(.)\1+$/.test(value)) return false;
  return true;
}

export function isEnvFile(path) {
  const name = basename(String(path));
  return /^\.env(?:\..+)?$/.test(name) && !EXAMPLE_ENV.test(name);
}

// The kind of secret on one line, or null.
export function scanLine(line, file = '') {
  for (const { name, re } of TOKEN_PATTERNS) if (re.test(line)) return name;
  for (const m of line.matchAll(URL_PASSWORD)) {
    if (m[1].length >= 8 && looksReal(m[1])) return 'password in a connection string';
  }
  if (isTestPath(file) || EXAMPLE_ENV.test(basename(file))) return null;
  for (const m of line.matchAll(ASSIGNMENT)) {
    if (looksReal(m[1])) return 'hard-coded secret';
  }
  if (JWT.test(line)) return 'JSON web token';
  return null;
}

// Scans the added lines of a `git diff -U0` output.
export function scanDiff(diffText) {
  const findings = [];
  const allowed = [];
  let file = null;
  let lineNo = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (file && LOCKFILES.has(basename(file))) file = null;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      file = null;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (line.startsWith('+')) {
      const text = line.slice(1);
      const kind = scanLine(text, file);
      if (kind) {
        if (text.includes(ALLOW_PRAGMA)) allowed.push({ file, line: lineNo, kind });
        else findings.push({ file, line: lineNo, kind });
      }
      lineNo += 1;
    } else if (line.startsWith(' ')) {
      lineNo += 1;
    }
  }
  return { findings, allowed };
}

const git = (repo, args) => runGit(repo, args, { timeoutMs: 60_000 });

const DIFF_FLAGS = ['-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR'];

function envFileFindings(paths) {
  return paths.filter(isEnvFile).map((file) => ({
    file,
    line: 0,
    kind: 'a .env file (secrets stay in the git-ignored .env, D57)',
  }));
}

// What `git commit` is about to record.
export function scanStaged(repo) {
  const names = git(repo, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
    .split('\0')
    .filter(Boolean);
  const { findings, allowed } = scanDiff(git(repo, ['diff', '--cached', ...DIFF_FLAGS]));
  return { findings: [...envFileFindings(names), ...findings], allowed };
}

// Everything a later `git add` could pick up: tracked changes against HEAD,
// plus untracked files that aren't ignored.
export function scanWorkingTree(repo) {
  let base;
  try {
    base = git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).trim();
  } catch {
    base = git(repo, ['hash-object', '-t', 'tree', '/dev/null']).trim();
  }
  const result = scanDiff(git(repo, ['diff', base, ...DIFF_FLAGS]));
  const findings = [...result.findings];
  const allowed = [...result.allowed];
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean);
  findings.push(...envFileFindings(untracked));
  for (const file of untracked.slice(0, 500)) {
    if (LOCKFILES.has(basename(file))) continue;
    let text;
    try {
      if (statSync(join(repo, file)).size > 1024 * 1024) continue;
      text = readFileSync(join(repo, file), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue;
    text.split('\n').forEach((line, i) => {
      const kind = scanLine(line, file);
      if (!kind) return;
      (line.includes(ALLOW_PRAGMA) ? allowed : findings).push({ file, line: i + 1, kind });
    });
  }
  return { findings, allowed };
}

export function formatFindings(findings) {
  return findings.map((f) => `  ${f.file}${f.line ? `:${f.line}` : ''}  ${f.kind}`).join('\n');
}

// The block both commit checks give: git's pre-commit hook and guard-secrets.
export function secretsVerdict(findings) {
  return {
    reason: `this commit would include secrets. Move them to the git-ignored .env (D57), or mark a false alarm with "${ALLOW_PRAGMA}" on that line:\n${formatFindings(findings)}`,
    subject: findings.map((f) => `${f.file}:${f.line} ${f.kind}`).join(', '),
  };
}

// Hides secret-looking values before anything is written to a log.
export function redact(text) {
  let out = String(text);
  for (const { re } of TOKEN_PATTERNS) out = out.replace(new RegExp(re.source, 'g'), '[redacted]');
  out = out.replace(URL_PASSWORD, (m, pw) => m.replace(pw, '[redacted]'));
  out = out.replace(ASSIGNMENT, (m, value) => (looksReal(value) ? m.replace(value, '[redacted]') : m));
  out = out.replace(
    /((?:password|passwd|secret|token|api[_-]?key|apikey)[a-z0-9_]*=)([^\s'"]{8,})/gi,
    (m, key, value) => (looksReal(value) ? `${key}[redacted]` : m),
  );
  return out;
}
