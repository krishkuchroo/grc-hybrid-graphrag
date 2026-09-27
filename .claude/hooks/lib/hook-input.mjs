// Reads the JSON that Claude Code sends every hook on stdin and gives the
// fields friendly names. Shared by all guard rails (D104).
import { readFileSync } from 'node:fs';

export function parseHookInput(text) {
  const raw = text && text.trim() ? JSON.parse(text) : {};
  return {
    raw,
    event: raw.hook_event_name ?? '',
    toolName: raw.tool_name ?? '',
    toolInput: raw.tool_input ?? {},
    // Present only when the hook fires inside a subagent (hooks docs).
    agentId: raw.agent_id || null,
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
