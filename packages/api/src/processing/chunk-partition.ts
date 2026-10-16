// The org's chunk partition (D71): `chunks` is list-partitioned by org, one partition per org with
// its own HNSW cosine index on the vector. The processing migration makes one for every org that
// already exists; org provisioning (src/identity/provision-org.ts) makes it for every new org.
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Creates the org's chunk partition with its HNSW index and forced RLS (`chunks_create_partition`).
 * Safe to call again: every step is "if missing", so a second call changes nothing. Run as the
 * migration account (the table's owner), like the audit partition.
 */
export async function createChunkPartition(db: Db, orgId: string): Promise<void> {
  if (typeof orgId !== 'string' || !UUID.test(orgId)) throw new Error('chunks: orgId must be a UUID');
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT public.chunks_create_partition(${orgId}::uuid)`);
  });
}
