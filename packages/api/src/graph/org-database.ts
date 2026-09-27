// One Neo4j database per org (D22): the org ID picks the database, `org-<orgId>`.
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Returns `org-<orgId>`. Throws for anything that isn't a lowercase UUID. */
export function orgDatabaseName(orgId: string): string {
  if (typeof orgId !== 'string' || !LOWERCASE_UUID.test(orgId)) {
    throw new Error('Invalid org ID: expected a lowercase UUID');
  }
  return `org-${orgId}`;
}
