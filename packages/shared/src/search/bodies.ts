// The search request body (D30, D47; S6 shared notes, "Routes"): `POST /api/v1/search` takes
// `{ query, mode? }`. The question rule (trimmed, then 1 to 2,000 characters) is shared with the
// chat's ask body. Unknown fields and unknown modes are refused. The words are the asker's own and
// never go in a log (D163).
import { z } from 'zod';
import { SEARCH_LIMITS } from './limits.js';
import { SEARCH_MODES } from './modes.js';

/** A question: trimmed, then 1 to 2,000 characters. */
export const questionSchema = z.string().trim().min(1).max(SEARCH_LIMITS.questionMaxLength);

/** `hybrid` or `vector`; a body without one gets `DEFAULT_SEARCH_MODE` (`hybrid`). */
export const searchModeSchema = z.enum(SEARCH_MODES);

export const searchBodySchema = z.strictObject({
  query: questionSchema,
  mode: searchModeSchema.optional(),
});

export type SearchBody = z.infer<typeof searchBodySchema>;
