// The `link.removed` audit entry (S1-011, D201): a copy of the removed link in `before`, and the
// same `targetId` as the link's `link.created` entry, so the two pair up in the history (D69).
// `meta` carries the higher of the two ends' labels, as for `link.created` (D56, D186).
import { LABELS, type Label } from '@grc/shared';
import type { OutboxAudit } from '../audit/outbox.js';
import { linkTargetId } from './links.service.js';

/** A link as stored in Neo4j. */
export interface StoredLink {
  type: string;
  fromId: string;
  toId: string;
  createdAt: string;
  createdBy: string;
  origin: string;
}

/** One end of the link. */
export interface LinkAuditEnd {
  number: string;
  label: Label;
}

function higher(a: Label, b: Label): Label {
  return LABELS.indexOf(a) >= LABELS.indexOf(b) ? a : b;
}

export function linkRemovedAudit(link: StoredLink, from: LinkAuditEnd, to: LinkAuditEnd): OutboxAudit {
  return {
    action: 'link.removed',
    targetType: 'link',
    targetId: linkTargetId(link.type, link.fromId, link.toId),
    before: {
      type: link.type,
      fromId: link.fromId,
      toId: link.toId,
      fromNumber: from.number,
      toNumber: to.number,
      createdAt: link.createdAt,
      createdBy: link.createdBy,
      origin: link.origin,
    },
    after: null,
    meta: { type: link.type, fromNumber: from.number, toNumber: to.number, label: higher(from.label, to.label) },
  };
}
