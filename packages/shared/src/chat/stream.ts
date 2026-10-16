// The ask route's stream (D47: chat streams its answer; S6 shared notes, "The stream"). The route
// answers `text/event-stream`; each event is one frame, `event: <name>` then `data: <JSON>`, and the
// JSON holds the event's name too, so either line identifies it. In order:
// - `queued { position }`: the place in Gemma's queue (1 means next), sent again as it changes;
// - `step { step }`: `searching_documents`, `querying_graph` (hybrid only), `writing_answer`;
// - `sources { sources, fallback? }`: what the answer may cite, and why the graph path fell back;
// - `token { text }`: the next piece of the answer;
// - then `done { message }` (the saved message) or `error { code, message, referenceId }`.
// S6-006 sends them and S6-007 reads them, both through these schemas.
import { z } from 'zod';
import { GRAPH_FALLBACK_REASONS } from '../search/fallback.js';
import { answerSourceSchema } from '../search/sources.js';
import { chatMessageSchema } from './messages.js';

export const CHAT_STREAM_CONTENT_TYPE = 'text/event-stream';

export const CHAT_STEPS = ['searching_documents', 'querying_graph', 'writing_answer'] as const;
export type ChatStep = (typeof CHAT_STEPS)[number];

export const CHAT_STREAM_EVENT_NAMES = ['queued', 'step', 'sources', 'token', 'done', 'error'] as const;
export type ChatStreamEventName = (typeof CHAT_STREAM_EVENT_NAMES)[number];

export const chatQueuedEventSchema = z.object({ event: z.literal('queued'), position: z.int().min(1) });

export const chatStepEventSchema = z.object({ event: z.literal('step'), step: z.enum(CHAT_STEPS) });

export const chatSourcesEventSchema = z.object({
  event: z.literal('sources'),
  sources: z.array(answerSourceSchema),
  fallback: z.enum(GRAPH_FALLBACK_REASONS).optional(),
});

export const chatTokenEventSchema = z.object({ event: z.literal('token'), text: z.string() });

export const chatDoneEventSchema = z.object({ event: z.literal('done'), message: chatMessageSchema });

/** An error in the one error format's fields (D47). */
export const chatErrorEventSchema = z.object({
  event: z.literal('error'),
  code: z.string().min(1),
  message: z.string(),
  referenceId: z.string().min(1),
});

export const chatStreamEventSchema = z.discriminatedUnion('event', [
  chatQueuedEventSchema,
  chatStepEventSchema,
  chatSourcesEventSchema,
  chatTokenEventSchema,
  chatDoneEventSchema,
  chatErrorEventSchema,
]);

export type ChatQueuedEvent = z.infer<typeof chatQueuedEventSchema>;
export type ChatStepEvent = z.infer<typeof chatStepEventSchema>;
export type ChatSourcesEvent = z.infer<typeof chatSourcesEventSchema>;
export type ChatTokenEvent = z.infer<typeof chatTokenEventSchema>;
export type ChatDoneEvent = z.infer<typeof chatDoneEventSchema>;
export type ChatErrorEvent = z.infer<typeof chatErrorEventSchema>;
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;

/** One event as a `text/event-stream` frame. JSON keeps any line break inside the text escaped, so
 * the data is always one line. */
export function encodeChatStreamEvent(event: ChatStreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** An event from a frame's `data` text, or `null` when it isn't valid JSON or isn't a known event. */
export function parseChatStreamEvent(data: string): ChatStreamEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = chatStreamEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
