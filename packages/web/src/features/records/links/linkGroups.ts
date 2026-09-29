// The spec's six links (LINK_TYPES in @grc/shared), as each record page names them. A "way" is one
// link type seen from one end: from a risk, MITIGATED_BY going out reads "Controls that treat this
// risk". The page groups the ways; on an asset, HOSTS and RUNS go both ways, so each of those two
// groups holds both ways and every row says which.
import { can, LINK_TYPES, type LinkType, type RecordKind } from '@grc/shared';
import { canEditRecord, type Viewer } from '../permissions';

export interface LinkWay {
  type: LinkType;
  /** `out`: this record is the link's `from` end. */
  direction: 'out' | 'in';
  /** The other end's kind. */
  other: RecordKind;
  /** The way's plain title, also the dialog's choice. */
  title: string;
}

export interface LinkGroup {
  title: string;
  ways: LinkWay[];
  /** True when the group holds both ways of one type and each row says which. */
  twoWay: boolean;
}

const TITLES: Record<RecordKind, Array<{ type: LinkType; direction: 'out' | 'in'; title: string }>> = {
  risk: [
    { type: 'EXPOSED_TO', direction: 'in', title: 'Assets exposed to this risk' },
    { type: 'MITIGATED_BY', direction: 'out', title: 'Controls that treat this risk' },
    { type: 'EXPOSES', direction: 'in', title: 'Incidents that exposed this risk' },
  ],
  control: [
    { type: 'MITIGATED_BY', direction: 'in', title: 'Risks it treats' },
    { type: 'GOVERNED_BY', direction: 'out', title: 'Policies that govern it' },
  ],
  policy: [{ type: 'GOVERNED_BY', direction: 'in', title: 'Controls it governs' }],
  asset: [
    { type: 'HOSTS', direction: 'out', title: 'Hosts' },
    { type: 'HOSTS', direction: 'in', title: 'Hosted by' },
    { type: 'RUNS', direction: 'out', title: 'Runs' },
    { type: 'RUNS', direction: 'in', title: 'Runs on' },
    { type: 'EXPOSED_TO', direction: 'out', title: 'Risks it is exposed to' },
    { type: 'IMPACTS', direction: 'in', title: 'Incidents that impacted it' },
  ],
  incident: [
    { type: 'IMPACTS', direction: 'out', title: 'Assets impacted' },
    { type: 'EXPOSES', direction: 'out', title: 'Risks exposed' },
  ],
};

function otherKind(type: LinkType, direction: 'out' | 'in'): RecordKind {
  const row = LINK_TYPES.find((t) => t.type === type)!;
  return direction === 'out' ? row.to : row.from;
}

/** Every way a record of this kind may link, in the page's order. */
export function linkWays(kind: RecordKind): LinkWay[] {
  return TITLES[kind].map((t) => ({ ...t, other: otherKind(t.type, t.direction) }));
}

/** The page's groups: one per way, except that both ways of one type between two assets share one. */
export function linkGroups(kind: RecordKind): LinkGroup[] {
  const groups: LinkGroup[] = [];
  for (const way of linkWays(kind)) {
    const sameType = kind === way.other ? groups.find((g) => g.ways[0]!.type === way.type) : undefined;
    if (sameType) {
      sameType.ways.push(way);
      sameType.title = `${sameType.title} / ${way.title}`;
      sameType.twoWay = true;
    } else {
      groups.push({ title: way.title, ways: [way], twoWay: false });
    }
  }
  return groups;
}

/**
 * The ways the dialog offers (D200): those where the person can edit this record, or can edit
 * records of the other end's kind (a Control Owner their own controls). Each record found is still
 * checked with `canLinkRecords` before it's offered, and the API decides (D7).
 */
export function offeredWays(viewer: Viewer, kind: RecordKind, record: { owner: string }): LinkWay[] {
  const editsThis = canEditRecord(viewer, kind, record);
  return linkWays(kind).filter((way) => editsThis || can(viewer.role, way.other, 'edit', { isOwner: true }));
}
