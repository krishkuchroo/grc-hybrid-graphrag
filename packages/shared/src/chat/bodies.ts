// The chat request bodies (D30, D47; S6 shared notes, "Routes"). Unknown fields are refused.
// - Asking, `POST /api/v1/chat/conversations/:id/messages`: `{ question, mode? }`, with the search
//   body's question rule (trimmed, then 1 to 2,000 characters) and its modes (`hybrid` by default;
//   `vector` is for the benchmark).
// - Starting a conversation, `POST /api/v1/chat/conversations`: an empty body.
import { z } from 'zod';
import { questionSchema, searchModeSchema } from '../search/bodies.js';

export const askBodySchema = z.strictObject({
  question: questionSchema,
  mode: searchModeSchema.optional(),
});

export const startConversationBodySchema = z.strictObject({});

export type AskBody = z.infer<typeof askBodySchema>;
export type StartConversationBody = z.infer<typeof startConversationBodySchema>;
