// The 28 read-only Neo4j accounts AI graph queries run as (D73): one per role × clearance
// (D50, D51). Each account's password is derived from one secret in `.env`
// (NEO4J_QUERY_SECRET) with HMAC-SHA256, so no password is shared between accounts and
// `.env` holds one value instead of 28.
import { createHmac } from 'node:crypto';
import { LABELS, ROLES, isLabel, isRole, type Label, type Role } from '@grc/shared';

export interface QueryAccount {
  role: Role;
  clearance: Label;
  name: string;
}

/** `grc_ro_<role>_<clearance>`. Throws for an unknown role or clearance (fail safe). */
export function queryAccountName(role: Role | string, clearance: Label | string): string {
  if (!isRole(role)) throw new Error('Unknown role for a graph query account');
  if (!isLabel(clearance)) throw new Error('Unknown clearance for a graph query account');
  return `grc_ro_${role}_${clearance}`;
}

/** All 28 accounts, in role then clearance order. */
export const QUERY_ACCOUNTS: readonly QueryAccount[] = ROLES.flatMap((role) =>
  LABELS.map((clearance) => ({ role, clearance, name: queryAccountName(role, clearance) })),
);

/** The account's password, derived from NEO4J_QUERY_SECRET. */
export function queryAccountPassword(secret: string, role: Role | string, clearance: Label | string): string {
  if (!secret) throw new Error('NEO4J_QUERY_SECRET is not set');
  return createHmac('sha256', secret).update(queryAccountName(role, clearance)).digest('base64url');
}
