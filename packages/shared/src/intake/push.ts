// A push API batch (D47): a batch ID the API remembers, the source, and flat rows.
import { z } from 'zod';
import { sourceNameSchema } from './asset-import.js';

export const MAX_PUSH_ROWS = 5_000;

const flatValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const pushBatchSchema = z.strictObject({
  batchId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/),
  source: sourceNameSchema,
  rows: z.array(z.record(z.string(), flatValue)).min(1).max(MAX_PUSH_ROWS),
});
export type PushBatch = z.infer<typeof pushBatchSchema>;
