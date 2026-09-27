// The audit outbox relay (D37, D45.5, D48, D73). The worker runs it every 2 s. For each org it
// reads the outbox nodes in the org's database oldest first, appends each to the Postgres audit
// trail with `sourceId = <outbox node id>`, and only then deletes the node.
//
// Exactly once: a relay killed between the append and the delete leaves the node behind; the next
// pass appends it again, and the append is a no-op because the sourceId is already on the chain
// (M0-012). In order: if an append fails, that org's later entries wait for a later pass.
// An entry is always appended to the org whose database holds it, whatever its `orgId` says.
import type { Logger } from 'pino';
import { createLogger } from '../common/logger.js';
import type { GraphService } from '../graph/graph.service.js';
import { AUDIT_OUTBOX_LABEL } from '../graph/privileges.js';
import type { AuditService } from './audit.service.js';
import type { OutboxPayload } from './outbox.js';

export const OUTBOX_RELAY_INTERVAL_MS = 2000;

/** Outbox nodes read per org in one pass; the rest wait for the next pass. */
const BATCH = 500;

export interface OutboxRelayDeps {
  graph: Pick<GraphService, 'read' | 'write'>;
  audit: Pick<AuditService, 'append'>;
  /** The orgs to relay. */
  orgIds: () => Promise<readonly string[]>;
  log?: Logger;
  intervalMs?: number;
}

interface OutboxEntry {
  id: string;
  payload: string;
}

export class OutboxRelay {
  private readonly log: Logger;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private started = false;

  constructor(private readonly deps: OutboxRelayDeps) {
    this.log = (deps.log ?? createLogger()).child({ context: 'AuditOutboxRelay' });
    this.intervalMs = deps.intervalMs ?? OUTBOX_RELAY_INTERVAL_MS;
  }

  /** One pass over every org. Rejects if any org failed; the other orgs are still relayed. */
  async runOnce(): Promise<void> {
    const failed: unknown[] = [];
    for (const orgId of await this.deps.orgIds()) {
      try {
        await this.relayOrg(orgId);
      } catch (err) {
        failed.push(err);
        this.log.error({ err, orgId }, 'audit outbox relay failed for org');
      }
    }
    if (failed.length > 0) throw new AggregateError(failed, `audit outbox relay failed for ${failed.length} org(s)`);
  }

  /** Runs a pass now and then every `intervalMs` after each pass ends, until stopped. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  /** Resolves once no pass is running and no new one will start. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.started) return;
      this.running = this.runOnce()
        .catch(() => undefined) // already logged; a failed pass never stops the loop
        .finally(() => {
          this.running = undefined;
          if (this.started) this.schedule(this.intervalMs);
        });
    }, delay);
  }

  private async relayOrg(orgId: string): Promise<void> {
    const entries = await this.deps.graph.read(orgId, async (tx) => {
      const res = await tx.run(
        `MATCH (o:${AUDIT_OUTBOX_LABEL}) RETURN o.id AS id, o.payload AS payload ORDER BY o.seq, o.createdAt LIMIT ${BATCH}`,
      );
      return res.records.map((r) => ({ id: String(r.get('id')), payload: String(r.get('payload')) }));
    });
    // In order; the first failure stops this org's pass, so nothing overtakes it.
    for (const entry of entries) await this.relayEntry(orgId, entry);
  }

  private async relayEntry(orgId: string, entry: OutboxEntry): Promise<void> {
    const p = JSON.parse(entry.payload) as OutboxPayload;
    await this.deps.audit.append({
      orgId,
      actorType: p.actorType,
      actorId: p.actorId,
      action: p.action,
      targetType: p.targetType,
      targetId: p.targetId,
      before: p.before,
      after: p.after,
      meta: p.meta,
      sourceId: entry.id,
    });
    await this.deps.graph.write(orgId, (tx) =>
      tx.run(`MATCH (o:${AUDIT_OUTBOX_LABEL} {id: $id}) DELETE o`, { id: entry.id }),
    );
  }
}
