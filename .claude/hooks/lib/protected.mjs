// Files agents can't edit (D84, D95, D107). The main session changes them
// with the user.
import { canEditPlanFiles } from './roles.mjs';

// `rel` is a path relative to its checkout, with "/" separators.
export function protectedReason(rel, agentType) {
  const p = String(rel).toLowerCase();
  const parts = p.split('/');
  const name = parts[parts.length - 1];
  // Claude Code loads CLAUDE.md and .claude/ from subfolders too.
  if (name === 'claude.md' || name === 'claude.local.md') return 'no agent edits CLAUDE.md (D84)';
  if (parts.includes('.claude')) return 'no agent edits .claude/ (D95)';
  if (p === 'skills.md') return 'no agent edits skills.md (D95)';
  if (p === 'logs' || p.startsWith('logs/')) return 'only the hooks and the monitor write logs/ (D107)';
  if ((p === 'memory.md' || p === 'tasks.md') && !canEditPlanFiles(agentType)) {
    return 'only the planner edits memory.md and TASKS.md; report your status in the hand-off instead (D84, D95)';
  }
  return null;
}
