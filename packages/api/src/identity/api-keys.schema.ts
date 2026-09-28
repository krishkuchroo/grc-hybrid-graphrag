// Machine API keys (D54): one org and one role per key, an expiry, revocable. An org table
// (D73, M0-009 rule), created by migration 0005_api_keys.sql. `key_hash` is the SHA-256 of the
// whole key; the plain key is never stored.
import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organization, user } from './schema.js';

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    name: text('name').notNull(),
    role: text('role').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'api_keys_role_check',
      sql`${t.role} IN ('admin', 'risk_manager', 'compliance_manager', 'control_owner', 'auditor', 'analyst', 'viewer')`,
    ),
  ],
);
