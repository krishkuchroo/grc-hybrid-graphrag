// Reads the hand-off every agent ends its report with (D91). The format is
// defined once, in CLAUDE.md ("Hand-off").
export const STATUSES = ['done', 'blocked', 'approved', 'sent-back'];
export const HAND_IN_TOOLS = new Set(['SubagentHandback', 'StructuredOutput']);

// The agent is handing in its report now (not the SubagentStop backup).
export const isHandInEvent = (input) => input.event === 'PreToolUse' && HAND_IN_TOOLS.has(input.toolName);

function normalize(obj) {
  const tests = obj.tests && typeof obj.tests === 'object' ? obj.tests : {};
  const handoff = {
    taskId: String(obj.taskId ?? '').trim(),
    status: String(obj.status ?? '').trim().toLowerCase(),
    filesChanged: Array.isArray(obj.filesChanged) ? obj.filesChanged.map(String) : [],
    tests: {
      run: typeof tests.run === 'string' ? tests.run.trim().replace(/^`+|`+$/g, '') : '',
      passed: Number.isFinite(tests.passed) ? tests.passed : null,
      failed: Number.isFinite(tests.failed) ? tests.failed : null,
    },
    findings: obj.findings == null ? '' : typeof obj.findings === 'string' ? obj.findings.trim() : JSON.stringify(obj.findings),
  };
  if (!handoff.taskId) return { error: 'the hand-off has no taskId' };
  if (!STATUSES.includes(handoff.status)) return { error: `the hand-off status must be one of: ${STATUSES.join(', ')}` };
  return { handoff };
}

// The report text an agent handed in, wherever it arrived.
export function reportText(input) {
  if (input.toolName === 'SubagentHandback') return String(input.toolInput.message ?? '');
  if (input.toolName === 'StructuredOutput') return JSON.stringify(input.toolInput);
  if (input.event === 'SubagentStop') return String(input.lastAssistantMessage ?? '');
  return '';
}

// { handoff } or { error }.
export function parseHandoff(input) {
  if (input.toolName === 'StructuredOutput' && input.toolInput && typeof input.toolInput === 'object') {
    if ('taskId' in input.toolInput || 'status' in input.toolInput) return normalize(input.toolInput);
  }
  const text = reportText(input);
  // The block closes at a ``` on its own line, so backticks inside findings are fine.
  const blocks = [...text.matchAll(/```handoff[^\n]*\n([\s\S]*?)\n[ \t]*```/g)];
  if (!blocks.length) return { error: 'there is no ```handoff block at the end of the report' };
  try {
    return normalize(JSON.parse(blocks[blocks.length - 1][1]));
  } catch (error) {
    return { error: `the hand-off block isn't valid JSON (${error.message})` };
  }
}
