// The nightly audit chain check (D56, D72). The worker runs the queue once a day; each run checks
// every org's chain. A broken chain gets an `audit.chain_broken` event on that org's chain and an
// error log line naming the org and the seq.
import type { Logger } from 'pino';
import type { AuditService } from './audit.service.js';

export const VERIFY_CHAINS_QUEUE = 'audit.verify-chains';
/** Once a day, at 02:00 (pg-boss schedules in UTC). */
export const VERIFY_CHAINS_CRON = '0 2 * * *';

export interface VerifyChainsDeps {
  audit: Pick<AuditService, 'append' | 'verifyChain'>;
  log: Logger;
  orgIds: readonly string[];
}

export async function runVerifyChains({ audit, log, orgIds }: VerifyChainsDeps): Promise<void> {
  for (const orgId of orgIds) {
    const result = await audit.verifyChain(orgId);
    if (result.ok) continue;
    log.error({ orgId, brokenAtSeq: result.brokenAtSeq }, 'audit chain broken');
    await audit.append({
      orgId,
      actorType: 'system',
      actorId: 'system',
      action: 'audit.chain_broken',
      meta: { brokenAtSeq: result.brokenAtSeq },
    });
  }
}
