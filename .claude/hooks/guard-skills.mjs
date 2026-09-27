// Guard rail 6 (D80, D84, D88): only approved skills are used.
// - Agents get their approved skills preloaded through their agent file and
//   have no Skill tool, so any Skill call from an agent is blocked.
// - The main session may invoke only skills listed in skills.md.
// Asking the user before invoking (D80) stays the main session's own rule,
// because a hook can't ask.
import { isMain, runPreToolGuard } from './lib/run.mjs';
import { loadApprovedSkills } from './lib/skills.mjs';

export function decideSkill(input, approved = loadApprovedSkills()) {
  const name = String(input.toolInput.skill ?? '').trim().replace(/^\//, '');
  if (input.agentId) {
    return { reason: "agents use the skills preloaded in their agent file; calling the Skill tool is blocked (D88)", subject: name };
  }
  if (!approved.has(name)) {
    return { reason: `"${name}" isn't on the approved list in skills.md (D80, D87). Ask the user before adding it.`, subject: name };
  }
  return null;
}

if (isMain(import.meta.url)) {
  runPreToolGuard('6', (input) => (input.toolName === 'Skill' ? decideSkill(input) : null));
}
