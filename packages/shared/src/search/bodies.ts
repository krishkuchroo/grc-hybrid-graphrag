// The search request body (D30, D47; S6 shared notes, "Routes"): `POST /api/v1/search` takes
// `{ query, mode? }`. The question rule (trimmed, then 1 to 2,000 characters, with no U+0000 and no
// lone UTF-16 surrogate) is shared with the chat's ask body. Unknown fields and unknown modes are
// refused. The words are the asker's own and never go in a log (D163).
import { z } from 'zod';
import { SEARCH_LIMITS } from './limits.js';
import { SEARCH_MODES } from './modes.js';

/** A question: trimmed, then 1 to 2,000 characters. It may not hold U+0000 or a lone UTF-16 surrogate:
 * Postgres refuses U+0000 in the saved message (text) and either one in its `chat.asked` entry (jsonb),
 * so such a question is refused (400 validation_failed) before any answer is streamed, and every
 * question that is answered can be saved and audited (D56). */
export const questionSchema = z
  .string()
  .trim()
  .min(1)
  .max(SEARCH_LIMITS.questionMaxLength)
  .refine((q) => !q.includes('\u0000') && q.isWellFormed(), 'must not contain a null character or a lone surrogate');

/** `hybrid` or `vector`; a body without one gets `DEFAULT_SEARCH_MODE` (`hybrid`). */
export const searchModeSchema = z.enum(SEARCH_MODES);

export const searchBodySchema = z.strictObject({
  query: questionSchema,
  mode: searchModeSchema.optional(),
});

export type SearchBody = z.infer<typeof searchBodySchema>;
