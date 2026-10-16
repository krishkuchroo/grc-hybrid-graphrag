// Live AI links (S4-008; D37, D38, D45.4, D45.5, D51, D52.5, D69, D73; S4 shared notes, "Live AI
// links"): the links of one chunk that passed every rule check, written by the writer in the org's
// own database, all in one Neo4j transaction with their `link.created` audit entries
// (`AuditOutbox.withAuditedWrites`), as `system:processing`. On each link: origin `ai`, `createdAt`,
// `createdBy`, and where it came from: `sourceDocId`, `chunkId`, `sentence`, `model`,
// `promptVersion` and `sourceLabel` (the document's label; only people cleared for it may be shown
// the sentence, S5 and S6).
//
// - Both ends are read again inside the transaction: each must still exist, be active and be
//   visible in the uploader's view (D50, D51, with ownership for an "own" cell). If one isn't, the
//   records changed since they were matched (a merge, a retirement, a relabel), nothing at all is
//   written, and the caller runs the chunk again later (`LinkEndsChanged`).
// - A link of the same type between the same two records, in that direction, is never doubled,
//   whatever its origin: MERGE finds it (and locks both ends, so two chunks adding it at once make
//   one link). The answer per link says whether it was made now (`created`), was made by this very
//   chunk before (`ours`: a re-run after a crash between the Neo4j and the Postgres steps), or was
//   already there from elsewhere (`exists`).
// - The audit entry holds the link's IDs, type, origin and source IDs, never the sentence (it is
//   the document's text, and the entry is labelled by the link's ends, D186). Nothing is logged here.
import { randomUUID } from 'node:crypto';
import type { ManagedTransaction } from 'neo4j-driver';
import { NODE_LABELS, isLabel, isRecordVisible, type Label, type LinkType, type RecordKind } from '@grc/shared';
import type { AuditOutbox, OutboxAudit } from '../../audit/outbox.js';
import { linkTargetId } from '../../records/links.service.js';
import { higherLabel } from '../match/match-rules.js';
import type { MatchView } from '../match/name-matcher.js';
import { PROCESSING_ACTOR } from '../match/record-merge.js';
import { PROCESSING_ACTOR_ID } from '../queues.js';

/** Where the chunk's live links came from. */
export interface LiveLinkSource {
  documentId: string;
  chunkId: string;
  model: string;
  promptVersion: string;
  /** The document's label (D51). */
  sourceLabel: Label;
}

/** One link to make live: its finding key, its type and its two matched records. */
export interface LiveLinkWrite {
  key: string;
  type: LinkType;
  from: { kind: RecordKind; id: string };
  to: { kind: RecordKind; id: string };
  sentence: string;
}

/** `created`: made now. `ours`: this chunk made it before. `exists`: it was already there. */
export type LiveLinkOutcome = 'created' | 'ours' | 'exists';

/** A matched record is gone, retired or no longer visible to the uploader: nothing was written. */
export class LinkEndsChanged extends Error {
  readonly code = 'link_ends_changed';

  constructor() {
    super('A record the chunk names changed since it was matched.');
    this.name = 'LinkEndsChanged';
  }
}

export interface LiveLinkDeps {
  outbox: Pick<AuditOutbox, 'withAuditedWrites'>;
  now?: () => string;
}

interface WrittenEnd {
  number: string;
  label: Label;
}

/** One end as stored, if it is active and the uploader may see it; null otherwise. */
async function readEnd(
  tx: ManagedTransaction,
  view: MatchView,
  end: { kind: RecordKind; id: string },
): Promise<WrittenEnd | null> {
  const res = await tx.run(
    `MATCH (n:${NODE_LABELS[end.kind]} {id: $id})
     RETURN n.number AS number, n.sensitivity AS label, n.status AS status, n.owner AS owner
     LIMIT 1`,
    { id: end.id },
  );
  const row = res.records[0];
  if (!row) return null;
  const label = row.get('label');
  const number = row.get('number');
  if (row.get('status') !== 'active' || !isLabel(label) || typeof number !== 'string') return null;
  const owner = row.get('owner');
  const isOwner = typeof view.userId === 'string' && view.userId !== '' && owner === view.userId;
  if (!isRecordVisible(view, { recordType: end.kind, label, isOwner })) return null;
  return { number, label };
}

/** Lower record IDs first, so two chunks writing links on the same records lock them in one order. */
function byEnds(a: LiveLinkWrite, b: LiveLinkWrite): number {
  const left = `${a.from.id}:${a.to.id}:${a.type}`;
  const right = `${b.from.id}:${b.to.id}:${b.type}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Writes the chunk's live links in one Neo4j transaction with their `link.created` entries (see the
 * file comment), and answers what happened to each, by finding key. Throws `LinkEndsChanged`, with
 * nothing written, when a matched record changed since it was matched.
 */
export async function writeLiveLinks(
  deps: LiveLinkDeps,
  orgId: string,
  view: MatchView,
  source: LiveLinkSource,
  links: readonly LiveLinkWrite[],
): Promise<Map<string, LiveLinkOutcome>> {
  if (links.length === 0) return new Map();
  const now = deps.now ?? (() => new Date().toISOString());
  const ordered = [...links].sort(byEnds);
  return deps.outbox.withAuditedWrites(orgId, PROCESSING_ACTOR, async (tx) => {
    const outcomes = new Map<string, LiveLinkOutcome>();
    const audits: OutboxAudit[] = [];
    const at = now();
    for (const link of ordered) {
      const from = await readEnd(tx, view, link.from);
      const to = await readEnd(tx, view, link.to);
      if (!from || !to || link.from.id === link.to.id) throw new LinkEndsChanged();
      const token = randomUUID();
      const res = await tx.run(
        `MATCH (a:${NODE_LABELS[link.from.kind]} {id: $fromId}), (b:${NODE_LABELS[link.to.kind]} {id: $toId})
         MERGE (a)-[r:${link.type}]->(b)
         ON CREATE SET r.createdAt = $now, r.createdBy = $actor, r.origin = 'ai',
                       r.sourceDocId = $sourceDocId, r.chunkId = $chunkId, r.sentence = $sentence,
                       r.model = $model, r.promptVersion = $promptVersion, r.sourceLabel = $sourceLabel,
                       r.__created = $token
         WITH r, coalesce(r.__created = $token, false) AS created
         REMOVE r.__created
         RETURN created, r.origin AS origin, r.chunkId AS chunkId
         ORDER BY created DESC
         LIMIT 1`,
        {
          fromId: link.from.id,
          toId: link.to.id,
          now: at,
          actor: PROCESSING_ACTOR_ID,
          sourceDocId: source.documentId,
          chunkId: source.chunkId,
          sentence: link.sentence,
          model: source.model,
          promptVersion: source.promptVersion,
          sourceLabel: source.sourceLabel,
          token,
        },
      );
      const row = res.records[0];
      if (!row) throw new LinkEndsChanged();
      if (row.get('created') === true) {
        outcomes.set(link.key, 'created');
        audits.push(createdAudit(link, source, from, to, at));
      } else if (row.get('origin') === 'ai' && row.get('chunkId') === source.chunkId) {
        outcomes.set(link.key, 'ours');
      } else {
        outcomes.set(link.key, 'exists');
      }
    }
    return { result: outcomes, audits };
  });
}

function createdAudit(
  link: LiveLinkWrite,
  source: LiveLinkSource,
  from: WrittenEnd,
  to: WrittenEnd,
  at: string,
): OutboxAudit {
  return {
    action: 'link.created',
    targetType: 'link',
    targetId: linkTargetId(link.type, link.from.id, link.to.id),
    before: null,
    after: {
      type: link.type,
      fromId: link.from.id,
      toId: link.to.id,
      origin: 'ai',
      createdAt: at,
      createdBy: PROCESSING_ACTOR_ID,
      sourceDocId: source.documentId,
      chunkId: source.chunkId,
      model: source.model,
      promptVersion: source.promptVersion,
      sourceLabel: source.sourceLabel,
    },
    meta: { type: link.type, fromNumber: from.number, toNumber: to.number, label: higherLabel(from.label, to.label) },
  };
}
