// Asking a question (S6-007 behaviour 9; D47: chat streams its answer). The ask route answers
// `text/event-stream`, which the generated client can't read as it comes, so this one call is made
// with `fetch` itself: the same relative /api/v1 address, the same origin and the session cookie,
// like every other request (D7, M0-015). Each frame's data is parsed with S6-001's event schemas
// (`parseChatStreamEvent`), and a frame that isn't a known event is skipped.
// - A refusal before the stream starts (400, 401, 404, 429…) comes back in the one error format and
//   is thrown as the client's `ApiError`, with the Retry-After seconds for a 429.
// - Aborting the signal (Stop, or the person leaving) closes the connection: the API then frees
//   Gemma's slot and saves what was written as stopped. The promise rejects with `AskAborted`.
// - The promise resolves with how the stream ended: `done`, `error`, or `cut` when the connection
//   closed before either.
import { CHAT_STREAM_CONTENT_TYPE, parseChatStreamEvent, type ChatStreamEvent } from '@grc/shared';
import { ApiError, type ApiErrorBody, type PostChatConversationsIdMessagesBody } from '@/api/client';

/** Thrown when the ask's signal was aborted. */
export class AskAborted extends Error {
  constructor() {
    super('The question was stopped.');
    this.name = 'AskAborted';
  }
}

export type AskEnding = 'done' | 'error' | 'cut';

export interface AskOptions {
  signal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}

const NETWORK_MESSAGE = 'The server could not be reached. Check your connection and try again.';

/** An `event-stream` reader: takes the text as it arrives and gives back each finished frame's
 * data (its `data:` lines joined). Comments, other fields and a frame left unfinished at the end
 * are skipped, as the event-stream format says. */
export function createFrameReader() {
  let buffer = '';
  let data: string[] = [];

  return {
    push(chunk: string): string[] {
      buffer += chunk;
      let text = buffer;
      // A carriage return at the very end may be the first half of `\r\n`: keep it for the next chunk.
      let held = '';
      if (text.endsWith('\r')) {
        held = '\r';
        text = text.slice(0, -1);
      }
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      buffer = (lines.pop() ?? '') + held;
      const frames: string[] = [];
      for (const line of lines) {
        if (line === '') {
          if (data.length > 0) frames.push(data.join('\n'));
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        if (field !== 'data') continue;
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        data.push(value);
      }
      return frames;
    },
  };
}

async function refusalOf(res: Response): Promise<ApiError> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  let body: Partial<ApiErrorBody> | undefined;
  try {
    body = text ? (JSON.parse(text) as Partial<ApiErrorBody>) : undefined;
  } catch {
    body = undefined;
  }
  const err = body?.error;
  const retryAfter = Number(res.headers.get('retry-after'));
  return new ApiError(
    res.status,
    err?.code ?? 'error',
    err?.message ?? 'The request was refused.',
    err?.referenceId,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}

/** Asks `question` in the conversation and hands each event of the answer to `onEvent`, in order. */
export async function askQuestion(conversationId: string, question: string, options: AskOptions): Promise<AskEnding> {
  const { signal, onEvent } = options;
  const body: PostChatConversationsIdMessagesBody = { question };
  let res: Response;
  try {
    res = await fetch(`/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: CHAT_STREAM_CONTENT_TYPE, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (signal.aborted) throw new AskAborted();
    throw new ApiError(0, 'network_error', NETWORK_MESSAGE);
  }
  if (!res.ok) throw await refusalOf(res);
  const type = res.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith(CHAT_STREAM_CONTENT_TYPE) || res.body === null) {
    throw new ApiError(res.status, 'error', 'The answer could not be read.');
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const frames = createFrameReader();
  let ending: AskEnding = 'cut';
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch {
        if (signal.aborted) throw new AskAborted();
        return ending;
      }
      if (chunk.done) return ending;
      for (const data of frames.push(chunk.value)) {
        const event = parseChatStreamEvent(data);
        if (event === null) continue;
        if (event.event === 'done') ending = 'done';
        else if (event.event === 'error') ending = 'error';
        onEvent(event);
      }
      if (signal.aborted) throw new AskAborted();
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released, or the connection is gone: nothing more to read either way.
    }
  }
}
