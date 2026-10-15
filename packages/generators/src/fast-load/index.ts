// Fast-load mode (D42, D213 (7)): the pure batch plan; packages/infra/scripts/fast-load.ts writes it.
export {
  ANSWER_KEY_SOURCE,
  FastLoadPlanError,
  MAX_FAST_LOAD_BATCH,
  fastLoadSourceId,
  planFastLoad,
  type DocumentBatch,
  type FastLoadDocument,
  type FastLoadLink,
  type FastLoadPlan,
  type FastLoadRecord,
  type GraphBatch,
  type OrgFastLoadPlan,
  type PlanFastLoadOptions,
} from './plan.js';
