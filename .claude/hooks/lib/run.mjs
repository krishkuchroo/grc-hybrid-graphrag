// How every guard-rail script starts, blocks and fails.
//
// PreToolUse blocks exit 2 with the reason on stderr, which Claude reads.
// SubagentStop blocks print {"decision":"block","reason":...} and exit 0,
// which keeps the agent working (hooks docs).
//
// If a guard rail itself crashes, an agent's action is blocked to be safe
// (fail safe, CLAUDE.md principle 7), while the main session carries on with
// a visible error, so a bug can't lock us out of fixing it.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readHookInput } from './hook-input.mjs';
import { logBlock, logHookError } from './logging.mjs';
import { roleOf } from './roles.mjs';

export function isMain(metaUrl) {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === metaUrl;
  } catch {
    return false;
  }
}

function blockMessage(rule, reason) {
  return `BLOCKED by guard rail ${rule}: ${reason}`;
}

// What a guard's `decide` returns to block; null allows.
export const block = (reason, subject) => ({ reason, subject });

// `decide(input)` returns null to allow, or { reason, subject } to block.
export async function runPreToolGuard(rule, decide) {
  let input = null;
  try {
    input = readHookInput();
    const verdict = await decide(input);
    if (verdict) {
      logBlock({ rule, input, reason: verdict.reason, subject: verdict.subject });
      process.stderr.write(`${blockMessage(rule, verdict.reason)}\n`);
      process.exit(2);
    }
    process.exit(0);
  } catch (error) {
    try {
      logHookError({ rule, input, error });
    } catch {}
    if (input?.agentId) {
      process.stderr.write(`${blockMessage(rule, `the check itself failed, so the action is blocked to be safe (${error?.message ?? error}).`)}\n`);
      process.exit(2);
    }
    process.stderr.write(`guard rail ${rule} failed: ${error?.stack ?? error}\n`);
    process.exit(1);
  }
}

// For checks that gate an agent's hand-in. On PreToolUse (the report tool)
// a block denies the call; on SubagentStop it keeps the agent working.
export function emitBlock(input, rule, reason, subject) {
  logBlock({ rule, input, reason, subject });
  if (input.event === 'SubagentStop') {
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason: blockMessage(rule, reason) })}\n`);
    process.exit(0);
  }
  process.stderr.write(`${blockMessage(rule, reason)}\n`);
  process.exit(2);
}

// How the hand-in checks start. `decide(input)` returns null to let the agent
// finish, or { reason, subject, rule? } to send it back. If the check itself
// fails, one of our agents' hand-in waits rather than passing unchecked.
export async function runHandInGuard(rule, decide) {
  let input = null;
  try {
    input = readHookInput();
    const verdict = await decide(input);
    if (verdict) emitBlock(input, verdict.rule ?? rule, verdict.reason, verdict.subject);
    process.exit(0);
  } catch (error) {
    try {
      logHookError({ rule, input, error });
    } catch {}
    if (input?.agentId && roleOf(input.agentType)) {
      emitBlock(input, rule, `the hand-in check itself failed (${error?.message ?? error}), so the hand-in is held. Try again; if it keeps failing, hand in with status "blocked".`);
    }
    process.exit(1);
  }
}
