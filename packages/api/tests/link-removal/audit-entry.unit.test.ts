// S1-011 criterion 5 (D201, D56, D186): the `link.removed` audit entry, built by the pure
// `linkRemovedAudit(link, from, to)` in packages/api/src/records/link-audit.ts.
// - `link` is the stored link `{ type, fromId, toId, createdAt, createdBy, origin }`; `from` and `to`
//   are its two ends `{ id, kind, number, label, owner }`.
// - The entry: `action: 'link.removed'`, `targetType: 'link'`, `targetId` from S1-005's
//   `linkTargetId(type, fromId, toId)` (so it pairs with the `link.created` entry), `before` the full
//   copy `{ type, fromId, toId, fromNumber, toNumber, createdAt, createdBy, origin }`, `after: null`,
//   and `meta { type, fromNumber, toNumber, label }`, the label being the higher of the two ends'
//   labels (as for `link.created`), for every label pair (4 x 4).
// No database, server or .env.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LABELS, type Label } from '@grc/shared';
import { describe, expect, it } from 'vitest';
import { linkTargetId } from '../../src/records/links.service.js';

type Build = (link: unknown, from: unknown, to: unknown) => Record<string, unknown>;

const FILE = fileURLToPath(new URL('../../src/records/link-audit.ts', import.meta.url));

async function build(): Promise<Build> {
  expect(existsSync(FILE), 'src/records/link-audit.ts exists').toBe(true);
  const mod = (await import(/* @vite-ignore */ FILE)) as Record<string, unknown>;
  expect(typeof mod['linkRemovedAudit'], 'src/records/link-audit.ts exports linkRemovedAudit').toBe('function');
  return mod['linkRemovedAudit'] as Build;
}

const FROM_ID = '11111111-1111-4111-8111-111111111111';
const TO_ID = '22222222-2222-4222-8222-222222222222';

function ends(fromLabel: Label, toLabel: Label) {
  return {
    link: {
      type: 'MITIGATED_BY',
      fromId: FROM_ID,
      toId: TO_ID,
      createdAt: '2026-09-01T10:00:00.000Z',
      createdBy: '33333333-3333-4333-8333-333333333333',
      origin: 'import',
    },
    from: { id: FROM_ID, kind: 'risk', number: 'RSK0001001', label: fromLabel, owner: 'owner-a' },
    to: { id: TO_ID, kind: 'control', number: 'CTL0001002', label: toLabel, owner: 'owner-b' },
  };
}

function higher(a: Label, b: Label): Label {
  return LABELS.indexOf(a) >= LABELS.indexOf(b) ? a : b;
}

describe('criterion 5: linkRemovedAudit', () => {
  it('names the action, the target (the link.created key), before, after and meta', async () => {
    const f = await build();
    const { link, from, to } = ends('internal', 'confidential');
    expect(f(link, from, to)).toEqual({
      action: 'link.removed',
      targetType: 'link',
      targetId: linkTargetId('MITIGATED_BY', FROM_ID, TO_ID),
      before: {
        type: 'MITIGATED_BY',
        fromId: FROM_ID,
        toId: TO_ID,
        fromNumber: 'RSK0001001',
        toNumber: 'CTL0001002',
        createdAt: '2026-09-01T10:00:00.000Z',
        createdBy: '33333333-3333-4333-8333-333333333333',
        origin: 'import',
      },
      after: null,
      meta: { type: 'MITIGATED_BY', fromNumber: 'RSK0001001', toNumber: 'CTL0001002', label: 'confidential' },
    });
  });

  it("keeps the link's own origin and creator in before (manual)", async () => {
    const f = await build();
    const { link, from, to } = ends('public', 'public');
    const entry = f({ ...link, origin: 'manual', createdBy: 'someone-else' }, from, to);
    expect(entry['before']).toMatchObject({ origin: 'manual', createdBy: 'someone-else' });
  });

  it('does not change its inputs', async () => {
    const f = await build();
    const { link, from, to } = ends('restricted', 'public');
    const copies = structuredClone({ link, from, to });
    f(link, from, to);
    expect({ link, from, to }).toEqual(copies);
  });

  const PAIRS = LABELS.flatMap((a) => LABELS.map((b) => [a, b] as const));

  it('covers 4 x 4 label pairs', () => {
    expect(PAIRS).toHaveLength(16);
  });

  it.each(PAIRS)("from %s, to %s: meta.label is the higher of the two ends' labels", async (fromLabel, toLabel) => {
    const f = await build();
    const { link, from, to } = ends(fromLabel, toLabel);
    const entry = f(link, from, to);
    expect(entry['meta']).toEqual({
      type: 'MITIGATED_BY',
      fromNumber: 'RSK0001001',
      toNumber: 'CTL0001002',
      label: higher(fromLabel, toLabel),
    });
    expect(entry['after']).toBeNull();
    expect(entry['action']).toBe('link.removed');
  });
});
