// Cross-org access (D9, D55). Each is an org table (D73): `org_id` is the org whose data
// may be read. Created by migration 0001_identity_and_rls.sql; `app_visible_org` reads them.
// - auditor_grants: read-only, time-limited access for an auditor (`user_id`).
// - parent_links: a parent org (`parent_org_id`) reads its subsidiary once approved.
// - break_glass_sessions: platform break-glass, read-only for a limited time, with a reason.
import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organization, user } from './schema.js';

export const auditorGrants = pgTable('auditor_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organization.id),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const parentLinks = pgTable(
  'parent_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    parentOrgId: uuid('parent_org_id')
      .notNull()
      .references(() => organization.id),
    status: text('status').notNull().default('requested'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('parent_links_status_check', sql`${t.status} IN ('requested', 'approved', 'ended')`),
    check('parent_links_not_self_check', sql`${t.orgId} <> ${t.parentOrgId}`),
  ],
);

export const breakGlassSessions = pgTable('break_glass_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => organization.id),
  userId: text('user_id')
    .notNull()
    .references(() => user.id),
  reason: text('reason').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
