// The Neo4j audit outbox (D37, D45.4, D73). A graph change and its audit entry are saved in one
// Neo4j transaction: the entry goes into an (:AuditOutbox) node in the org's own database, and the
// worker's relay (outbox-relay.job.ts) copies it to the Postgres audit trail, then deletes it.
// Outbox nodes are hidden from the query accounts (DENY TRAVERSE, graph/privileges.ts).
import { randomUUID } from 'node:crypto';
import type { ManagedTransaction } from 'neo4j-driver';
import type { GraphService } from '../graph/graph.service.js';
import { AUDIT_OUTBOX_LABEL } from '../graph/privileges.js';
import type { AuditEventInput } from './audit.service.js';

export type AuditActor = Pick<AuditEventInput, 'actorType' | 'actorId'>;
export type OutboxAudit = Omit<AuditEventInput, 'orgId' | 'actorType' | 'actorId'>;
/** What an outbox node's `payload` holds (as JSON): the entry without its org. */
export type OutboxPayload = Omit<AuditEventInput, 'orgId' | 'sourceId'>;

// Writes can follow each other within one millisecond, so each node also gets `seq`: a number
// that only grows in this process (microseconds since the epoch, bumped past the last one given).
// The relay reads nodes by `seq`, the order they were written.
let lastSeq = 0;
function nextSeq(): number {
  lastSeq = Math.max(Date.now() * 1000, lastSeq + 1);
  return lastSeq;
}

export class AuditOutbox {
  constructor(private readonly graph: Pick<GraphService, 'write'>) {}

  /**
   * Runs `fn` and saves its audit entry as an outbox node, in one write transaction in
   * `org-<orgId>`. If `fn` throws or the transaction fails, neither is kept.
   */
  async withAuditedWrite<T>(
    orgId: string,
    actor: AuditActor,
    fn: (tx: ManagedTransaction) => Promise<{ result: T; audit: OutboxAudit }>,
  ): Promise<T> {
    return this.graph.write(orgId, async (tx) => {
      const { result, audit } = await fn(tx);
      const payload: OutboxPayload = {
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: audit.action,
        targetType: audit.targetType,
        targetId: audit.targetId,
        before: audit.before,
        after: audit.after,
        meta: audit.meta,
      };
      await tx.run(
        `CREATE (:${AUDIT_OUTBOX_LABEL} {id: $id, orgId: $orgId, payload: $payload, createdAt: datetime(), seq: $seq})`,
        { id: randomUUID(), orgId, payload: JSON.stringify(payload), seq: nextSeq() },
      );
      return result;
    });
  }
}
