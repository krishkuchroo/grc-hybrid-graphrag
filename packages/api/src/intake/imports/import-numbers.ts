// Asset numbers for an import (S3-007, D68, D196): `n` numbers at once from the same
// `(:RecordCounter {kind: 'asset'})` node S1's `takeNumber` uses, in the import batch's own write
// transaction, so a failed batch gives its numbers back and the numbers it keeps run on unbroken.
//
// The counter's `next` holds the last number given (S1: the first create sets it to FIRST_NUMBER).
// One SET expression moves it on by `n`, which takes the node's write lock before it reads the old
// value, so imports and S1's creates queue on the counter and never share a number. As with S1, only
// the very first creates of an org can race to make the counter node itself: the record `number`
// constraint then fails one of them (`isNumberClash`), and that batch runs again.
import neo4j, { type ManagedTransaction } from 'neo4j-driver';
import { FIRST_NUMBER, formatNumber } from '@grc/shared';
import { RECORD_COUNTER_LABEL } from '../../records/record-numbers.js';

const TAKE_NUMBERS = `MERGE (c:${RECORD_COUNTER_LABEL} {kind: $kind})
ON CREATE SET c.next = $first + $n - 1
ON MATCH SET c.next = c.next + $n
RETURN c.next AS last`;

/** Takes `n` asset numbers in this transaction's org database, lowest first. */
export async function takeAssetNumbers(tx: ManagedTransaction, n: number): Promise<string[]> {
  if (!Number.isInteger(n) || n < 0) throw new Error('takeAssetNumbers: n must be a whole number from 0');
  if (n === 0) return [];
  const res = await tx.run(TAKE_NUMBERS, { kind: 'asset', first: neo4j.int(FIRST_NUMBER), n: neo4j.int(n) });
  const last = Number(res.records[0]?.get('last'));
  if (!Number.isInteger(last)) throw new Error('takeAssetNumbers: the counter gave no number');
  return Array.from({ length: n }, (_, i) => formatNumber('asset', last - n + 1 + i));
}

/**
 * Write-locks the asset counter, when there is one, for the rest of this transaction: an import
 * batch takes it before it reads the assets it may change, so two imports of one source at once
 * run their batches one after the other and never make the same asset twice. It changes nothing
 * (a property set and removed again).
 */
export async function lockAssetCounter(tx: ManagedTransaction): Promise<void> {
  await tx.run(`MATCH (c:${RECORD_COUNTER_LABEL} {kind: $kind}) SET c.__lock = true REMOVE c.__lock`, {
    kind: 'asset',
  });
}
