// Starting AI mapping suggestions (S4-009; D16 (b), D20, D29, D47, D50, D56, D212 (3), (4)):
// `POST /api/v1/mappings/suggestions`.
// - The guard needs the Framework-mappings `edit` cell; the service checks `canSuggestMappings`
//   again (403), so only Admins and Compliance Managers, and API keys with those roles, start one.
// - The body is `{ kind: 'controls', framework }` (the starter's controls to that framework's
//   requirements, SATISFIES) or `{ kind: 'soc2_to_nist' }` (SOC 2 criteria to NIST 800-53
//   controls, MAPS_TO). Anything else is 400.
// - In one Postgres transaction in the caller's own org context: the run's job is queued
//   (`processing.mapping-suggest`, keyed `<orgId>:<kind>:<framework>`, so one run of each kind and
//   framework per org is queued or running at a time) and `mapping_suggestions.started` is
//   appended. They commit together or not at all. While the same run is queued or running, the
//   answer is 202 `already_running` with no new job and no entry.
// - The org, role and clearance always come from `request.principal`; the job carries who started
//   it, so the worker makes the suggestions in their view.
import { FRAMEWORK_KEYS, canSuggestMappings } from '@grc/shared';
import { z } from 'zod';
import type { AuditService } from '../../audit/audit.service.js';
import { ApiError } from '../../common/errors.js';
import type { Db } from '../../db/client.js';
import { withOrgContext, type OrgContext } from '../../db/org-context.js';
import type { JobsService } from '../../jobs/jobs.module.js';
import type { Caller } from '../../records/records.service.js';
import { PROCESSING_JOB_KEYS, PROCESSING_QUEUES, type MappingSuggestJob } from '../queues.js';

/** The body of `POST /api/v1/mappings/suggestions`. */
export const mappingSuggestionsBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('controls'), framework: z.enum(FRAMEWORK_KEYS) }),
  z.strictObject({ kind: z.literal('soc2_to_nist') }),
]);
export type MappingSuggestionsBody = z.infer<typeof mappingSuggestionsBodySchema>;

/** The answer: `started` with the new job's ID, or `already_running` with no new job. */
export const mappingSuggestionsStartedSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('started'), jobId: z.string(), message: z.string() }),
  z.object({ status: z.literal('already_running'), jobId: z.null(), message: z.string() }),
]);
export type MappingSuggestionsStarted = z.infer<typeof mappingSuggestionsStartedSchema>;

/** The audit action of a started run. */
export const MAPPING_SUGGESTIONS_STARTED = 'mapping_suggestions.started';

const FORBIDDEN = (): ApiError => new ApiError(403, 'forbidden', 'You may not start mapping suggestions.');

const STARTED_MESSAGE =
  "Mapping suggestions have started in the background. Each suggestion goes to the Analyst's review queue.";
const RUNNING_MESSAGE = 'These mapping suggestions are already running. Their suggestions go to the review queue.';

function contextOf(caller: Caller): OrgContext {
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

export interface MappingSuggestionsServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'appendInTx'>;
  jobs: Pick<JobsService, 'sendInTx'>;
}

export class MappingSuggestionsService {
  private readonly db: Db;
  private readonly audit: Pick<AuditService, 'appendInTx'>;
  private readonly jobs: Pick<JobsService, 'sendInTx'>;

  constructor(deps: MappingSuggestionsServiceDeps) {
    this.db = deps.db;
    this.audit = deps.audit;
    this.jobs = deps.jobs;
  }

  async start(caller: Caller, body: unknown): Promise<MappingSuggestionsStarted> {
    if (!canSuggestMappings(caller.role)) throw FORBIDDEN();
    const input = mappingSuggestionsBodySchema.parse(body ?? {});
    const framework = input.kind === 'controls' ? input.framework : undefined;
    const data: MappingSuggestJob = {
      orgId: caller.orgId,
      kind: input.kind,
      ...(framework !== undefined ? { framework } : {}),
      startedBy: caller.userId,
      role: caller.role,
      clearance: caller.clearance,
    };
    const singletonKey = PROCESSING_JOB_KEYS.mappingSuggest(caller.orgId, input.kind, framework);

    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const jobId = await this.jobs.sendInTx(tx, PROCESSING_QUEUES.mappingSuggest, data, { singletonKey });
      if (jobId === null) return { status: 'already_running', jobId: null, message: RUNNING_MESSAGE };
      await this.audit.appendInTx(tx, {
        orgId: caller.orgId,
        ...(caller.apiKeyId !== undefined
          ? { actorType: 'api_key' as const, actorId: caller.apiKeyId }
          : { actorType: 'user' as const, actorId: caller.userId }),
        action: MAPPING_SUGGESTIONS_STARTED,
        targetType: 'mapping_suggestions',
        targetId: jobId,
        after: { kind: input.kind, framework: framework ?? null },
        meta: { kind: input.kind, framework: framework ?? null, jobId },
      });
      return { status: 'started', jobId, message: STARTED_MESSAGE };
    });
  }
}
