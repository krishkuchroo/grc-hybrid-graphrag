// Reads the JSON that Claude Code sends every hook on stdin and gives the
// fields friendly names. Shared by all guard rails (D104).
import { readFileSync } from 'node:fs';

// A session started with `claude --agent <name>` (the monitor's launched
// runs) has no agent_id, only agent_type. It counts as an agent too (D158):
// its session ID becomes its agent ID, and its Stop is its hand-in, like a
// subagent's SubagentStop.
export const launchedAgentId = (sessionId) => `run-${sessionId}`;

export function parseHookInput(text) {
  const raw = text && text.trim() ? JSON.parse(text) : {};
  const launched = !raw.agent_id && Boolean(raw.agent_type) && Boolean(raw.session_id);
  const event = raw.hook_event_name ?? '';
  return {
    raw,
    event: launched && event === 'Stop' ? 'SubagentStop' : event,
    toolName: raw.tool_name ?? '',
    toolInput: raw.tool_input ?? {},
    // Present only when the hook fires inside a subagent (hooks docs).
    agentId: raw.agent_id || (launched ? launchedAgentId(raw.session_id) : null),
    launched,
    agentType: raw.agent_type ?? '',
    cwd: raw.cwd || process.cwd(),
    sessionId: raw.session_id ?? '',
    transcriptPath: raw.transcript_path ?? '',
    agentTranscriptPath: raw.agent_transcript_path ?? '',
    lastAssistantMessage: raw.last_assistant_message ?? '',
    stopHookActive: raw.stop_hook_active === true,
  };
}

export function readHookInput() {
  return parseHookInput(readFileSync(0, 'utf8'));
}
