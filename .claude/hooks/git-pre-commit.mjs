// Guard rail 2's main check (D57, D94). Git runs it before every commit, the
// user's included, through core.hooksPath = .claude/githooks. It scans
// exactly what's staged and stops the commit if it finds a secret.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const PSEUDO_INPUT = { event: 'git pre-commit', agentType: 'git' };

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
}

async function main() {
  const toplevel = git(['rev-parse', '--show-toplevel']);
  // Logs go to the main checkout's logs/, also when committing in a worktree.
  // lib/paths.mjs reads this when it loads, so it's set before the imports.
  process.env.GRC_LOGS_DIR ||= join(dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir'])), 'logs');
  const { ALLOW_PRAGMA, formatFindings, scanStaged, secretsVerdict } = await import('./lib/secret-scan.mjs');
  const { logBlock } = await import('./lib/logging.mjs');

  const { findings, allowed } = scanStaged(toplevel);
  if (allowed.length) {
    process.stderr.write(`Secret scan: these lines were skipped because they say "${ALLOW_PRAGMA}":\n${formatFindings(allowed)}\n`);
  }
  if (!findings.length) return 0;
  const { reason, subject } = secretsVerdict(findings);
  logBlock({ rule: '2', input: PSEUDO_INPUT, reason, subject });
  process.stderr.write(`BLOCKED by guard rail 2: ${reason}\n`);
  return 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  // Fail safe: if the scan can't run, the commit waits.
  process.stderr.write(`guard rail 2: the secret scan failed, so the commit is stopped to be safe (${error?.message ?? error})\n`);
  try {
    (await import('./lib/logging.mjs')).logHookError({ rule: '2', input: PSEUDO_INPUT, error });
  } catch {}
  process.exitCode = 1;
}
