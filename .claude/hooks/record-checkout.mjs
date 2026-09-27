// What guard rails 5 and 7 need to know about each agent (D157). It
// remembers how the checkout looked when an agent started (read by
// check-changed-files.mjs and guard-test-files.mjs), and logs who edited
// which file in logs/edits.jsonl, so the hand-in backstop can tell other
// people's edits apart. It never blocks.
import { isAbsolute, resolve } from 'node:path';
import { snapshot } from './lib/checkout.mjs';
import { readHookInput } from './lib/hook-input.mjs';
import { logEdit, logHookError, now } from './lib/logging.mjs';
import { isMain } from './lib/run.mjs';
import { createStateOnce, readState, writeState } from './lib/state.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

function editedFile(input) {
  const p = input.toolInput.file_path ?? input.toolInput.notebook_path;
  if (!p) return null;
  return isAbsolute(String(p)) ? String(p) : resolve(input.cwd, String(p));
}

// Claude Code's own helper agents (prompt suggestions, /btw) report an
// empty type and use no tools; they aren't agents anyone dispatched.
const isHelper = (input) => !input.agentType && input.event === 'SubagentStop';

// True when this call saved the agent's start.
export function recordStart(input) {
  if (!input.agentId || isHelper(input) || readState(input.agentId, 'start')) return false;
  return createStateOnce(input.agentId, 'start', {
    agentId: input.agentId,
    agentType: input.agentType,
    startedAt: now(),
    cwd: input.cwd,
    ...snapshot(input.cwd),
  });
}

// A reply to a launched run starts a new round of work, so its next Stop is
// checked again rather than passing on the last round's hand-in (D158).
function startNewRound(input) {
  for (const kind of ['finish', 'changed']) {
    const state = readState(input.agentId, kind);
    if (state?.cleared) writeState(input.agentId, kind, { ...state, cleared: false });
  }
}

export function handleEvent(input) {
  recordStart(input);
  if (input.launched && input.event === 'UserPromptSubmit') startNewRound(input);
  if (input.event === 'PreToolUse' && EDIT_TOOLS.has(input.toolName)) {
    const path = editedFile(input);
    if (path) logEdit({ agent_id: input.agentId, agent_type: input.agentType || 'main', tool: input.toolName, path });
  }
}

if (isMain(import.meta.url)) {
  let input = null;
  try {
    input = readHookInput();
    handleEvent(input);
  } catch (error) {
    try {
      logHookError({ rule: '5/7', input, error });
    } catch {}
  }
  process.exit(0);
}
