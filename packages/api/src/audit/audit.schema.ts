// The audit trail in Postgres (D37, D56, D73): add-only events, one hash chain per org, the table
// partitioned by org (one partition per org, made by `createAuditPartition`). Created by
// migration 0003_audit.sql. grc_app may only SELECT and INSERT, under the org wall; a trigger
// refuses UPDATE, DELETE and TRUNCATE by anyone, the owner included.
import { sql } from 'drizzle-orm';
import { bigint, check, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organization } from '../identity/schema.js';

export const AUDIT_ACTOR_TYPES = ['user', 'api_key', 'system'] as const;

export const auditEvents = pgTable(
  'audit_events',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    meta: jsonb('meta'),
    sourceId: text('source_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.seq] }),
    unique('audit_events_org_source_id').on(t.orgId, t.sourceId),
    check('audit_events_actor_type_check', sql`${t.actorType} IN ('user', 'api_key', 'system')`),
  ],
);
