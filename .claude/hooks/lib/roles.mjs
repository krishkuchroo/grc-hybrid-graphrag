// The one table of what each of our agents may do (D75, D84, D95, D97).
// Keys are the `name` in each .claude/agents/*.md file, which hooks receive
// as agent_type.
export const ROLES = {
  planner: { finishCheck: 'none', editsPlanFiles: true },
  'test-writer': { finishCheck: 'test-writer' },
  'builder-platform': { finishCheck: 'builder', builder: true },
  'builder-backend': { finishCheck: 'builder', builder: true },
  'builder-frontend': { finishCheck: 'builder', builder: true },
  'builder-data': { finishCheck: 'builder', builder: true },
  'security-reviewer': { finishCheck: 'none' },
  'code-reviewer': { finishCheck: 'none' },
  integrator: { finishCheck: 'integrator', pushes: true },
};

export const roleOf = (agentType) => ROLES[agentType] ?? null;
export const isBuilder = (agentType) => Boolean(ROLES[agentType]?.builder);
export const canPush = (agentType) => Boolean(ROLES[agentType]?.pushes);
export const canEditPlanFiles = (agentType) => Boolean(ROLES[agentType]?.editsPlanFiles);
