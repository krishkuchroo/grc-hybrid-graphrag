// Record numbers (D68, D196): one `(:RecordCounter {kind})` node per type in each org database.
// The next number is taken in the create's own write transaction, so a failed create gives its
// number back. The first is FIRST_NUMBER (1001).
//
// The counter goes up in one SET expression, which takes the node's write lock before it reads
// the old value, so concurrent creates queue on the counter and get numbers with no gaps.
// Only the very first creates of a type can race to make the counter node itself (nothing makes
// it unique): they then take the same number, the record `number` constraint lets one through,
// and the others fail with ConstraintValidationFailed. The service runs those again; by then the
// winner's counter is committed and visible, so no second counter survives.
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import { FIRST_NUMBER, formatNumber, type RecordKind } from '@grc/shared';

export { FIRST_NUMBER };

export const RECORD_COUNTER_LABEL = 'RecordCounter';

const NEXT_NUMBER = `MERGE (c:${RECORD_COUNTER_LABEL} {kind: $kind})
ON CREATE SET c.next = $first
ON MATCH SET c.next = c.next + 1
RETURN c.next AS n`;

/** Takes the next number for `kind` in this transaction's org database. */
export async function takeNumber(tx: ManagedTransaction, kind: RecordKind): Promise<string> {
  const res = await tx.run(NEXT_NUMBER, { kind, first: neo4j.int(FIRST_NUMBER) });
  return formatNumber(kind, Number(res.records[0]?.get('n')));
}

/** How many times a create that lost the race for a new counter is run again. */
export const NUMBER_CLASH_ATTEMPTS = 3;

/** A create that lost the race for a new counter (see above): safe to run again. */
export function isNumberClash(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'Neo.ClientError.Schema.ConstraintValidationFailed';
}
