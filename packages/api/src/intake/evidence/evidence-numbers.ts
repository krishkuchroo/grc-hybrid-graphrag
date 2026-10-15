// Evidence numbers (D68, D213 (1)): `EVD0001001` upward, per org, from the
// `(:RecordCounter {kind: 'evidence'})` node in the org's database. The next number is taken in the
// create's own write transaction, the same way S1's `takeNumber` does, so a failed create gives its
// number back. A create that loses the race to make a brand-new counter fails on the `number`
// constraint and is run again (S1's `isNumberClash` and `NUMBER_CLASH_ATTEMPTS`).
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import { FIRST_NUMBER, formatIntakeNumber } from '@grc/shared';
import { RECORD_COUNTER_LABEL } from '../../records/record-numbers.js';

export const EVIDENCE_COUNTER_KIND = 'evidence';

const NEXT_NUMBER = `MERGE (c:${RECORD_COUNTER_LABEL} {kind: $kind})
ON CREATE SET c.next = $first
ON MATCH SET c.next = c.next + 1
RETURN c.next AS n`;

/** Takes the next `EVD` number in this transaction's org database. */
export async function takeEvidenceNumber(tx: ManagedTransaction): Promise<string> {
  const res = await tx.run(NEXT_NUMBER, { kind: EVIDENCE_COUNTER_KIND, first: neo4j.int(FIRST_NUMBER) });
  return formatIntakeNumber(EVIDENCE_COUNTER_KIND, Number(res.records[0]?.get('n')));
}
