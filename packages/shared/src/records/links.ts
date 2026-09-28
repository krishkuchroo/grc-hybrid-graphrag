// The spec's links between records (ontology, section 2), each with its direction.
import { isRecordKind, type RecordKind } from './types.js';

export const LINK_TYPES = [
  { type: 'HOSTS', from: 'asset', to: 'asset' },
  { type: 'RUNS', from: 'asset', to: 'asset' },
  { type: 'EXPOSED_TO', from: 'asset', to: 'risk' },
  { type: 'MITIGATED_BY', from: 'risk', to: 'control' },
  { type: 'GOVERNED_BY', from: 'control', to: 'policy' },
  { type: 'IMPACTS', from: 'incident', to: 'asset' },
  { type: 'EXPOSES', from: 'incident', to: 'risk' },
] as const satisfies readonly { type: string; from: RecordKind; to: RecordKind }[];

export type LinkType = (typeof LINK_TYPES)[number]['type'];

export function isAllowedLink(type: string, fromKind: string, toKind: string): boolean {
  if (!isRecordKind(fromKind) || !isRecordKind(toKind)) return false;
  return LINK_TYPES.some((row) => row.type === type && row.from === fromKind && row.to === toKind);
}

export function linkTypesBetween(fromKind: string, toKind: string): LinkType[] {
  return LINK_TYPES.filter((row) => row.from === fromKind && row.to === toKind).map((row) => row.type);
}

/** The asset map (D204): centred on one asset, 1 to 3 steps out along HOSTS and RUNS (2 when none
 * is given), and at most this many assets, the centre included. */
export const MAP_DEFAULT_DEPTH = 2;
export const MAP_MAX_DEPTH = 3;
export const MAP_MAX_NODES = 200;
