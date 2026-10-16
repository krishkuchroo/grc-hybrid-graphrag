// The search route (S6-005; D46, D47, D48, D50 Chat row, D51; S6 shared notes, "Routes"), under
// /api/v1, with the Chat `use` cell (every role, people and API keys alike, S6-Q8):
//   POST /search   { query, mode? }   -> the search answer: the mode, the fused results after the
//                                        visibility checks (best first, at most 50, each marked if
//                                        it went into the context), the graph part and the timings
//     400 validation_failed · 403 forbidden · 503 assistant_unavailable (bge-m3 can't be reached)
// One ranked list, so not paged. A hybrid search's graph query goes through the text model's own
// one-at-a-time slot, so it queues with the chat's questions (D48). When the graph path fails, the
// answer is documents only with the fallback reason, never an error (D45.7). Searches aren't audited
// (S6-Q7); the 10-a-minute limit it shares with asking is added in main.api.ts (S6-006, D64).
// The org, role and clearance always come from `request.principal`. Decorators are applied as plain
// calls, so the code runs without decorator syntax support.
import {
  Body,
  Catch,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseFilters,
  UseGuards,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { CHAT_ERRORS, DEFAULT_SEARCH_MODE, searchAnswerSchema, searchBodySchema, type SearchAnswer } from '@grc/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { isAiFailure } from '../../ai/ai-failure.js';
import { ApiError, sendError } from '../../common/errors.js';
import { documentRoute } from '../../common/openapi.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import { RETRIEVAL, type Retrieval, type SearchCaller } from '../retrieval.js';

/** The asker from the request's principal (403 without one): a person, or a machine API key. */
export function searchCallerOf(request: AuthedRequest): SearchCaller {
  const p = request.principal;
  if (!p) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
  return {
    orgId: p.orgId,
    userId: p.userId,
    role: p.role,
    clearance: p.clearance,
    kind: p.apiKeyId !== undefined ? 'api_key' : 'person',
  };
}

/** bge-m3 (or Gemma) can't be reached: 503 `assistant_unavailable`. */
export class AssistantUnavailableError extends Error {
  constructor() {
    super(CHAT_ERRORS.assistant_unavailable.message);
    this.name = 'AssistantUnavailableError';
  }
}

/** Sends `AssistantUnavailableError` as 503 `assistant_unavailable` in the one error format (D47).
 * The global filter would send every 5xx as an unexpected error, so this route has its own. */
export class AssistantUnavailableFilter implements ExceptionFilter {
  catch(_exception: AssistantUnavailableError, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const { status, message } = CHAT_ERRORS.assistant_unavailable;
    sendError(
      http.getRequest<FastifyRequest>(),
      http.getResponse<FastifyReply>(),
      status,
      'assistant_unavailable',
      message,
    );
  }
}
Catch(AssistantUnavailableError)(AssistantUnavailableFilter);

export class SearchController {
  constructor(private readonly retrieval: Retrieval) {}

  async search(request: AuthedRequest, body: unknown): Promise<SearchAnswer> {
    const caller = searchCallerOf(request);
    const { query, mode } = searchBodySchema.parse(body ?? {});
    try {
      const result = await this.retrieval.retrieve(caller, query, { mode: mode ?? DEFAULT_SEARCH_MODE });
      return { mode: result.mode, results: result.results, graph: result.graph, timings: result.timings };
    } catch (err) {
      if (isAiFailure(err)) throw new AssistantUnavailableError();
      throw err;
    }
  }
}
{
  const p = SearchController.prototype;
  const d = (method: keyof SearchController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Post()(p, 'search', d('search'));
  HttpCode(200)(p, 'search', d('search'));
  Req()(p, 'search', 0);
  Body()(p, 'search', 1);

  Requires('chat', 'use')(SearchController);
  UseGuards(AccessGuard)(SearchController);
  UseFilters(new AssistantUnavailableFilter())(SearchController);
  Controller('search')(SearchController);
  Inject(RETRIEVAL)(SearchController, undefined, 0);
}

documentRoute({
  method: 'post',
  path: '/search',
  summary:
    'Search what you can see, in `hybrid` mode (the default: vector search over the document passages and an AI-written, read-only graph query in your org, fused with RRF k=60) or `vector` mode (passages only, no Gemma). Answers the fused results after the visibility checks, best first, at most 50, each with its rank, score, the paths that found it and whether it went into the context; the graph part (whether the query ran, the query, the fallback reason when it failed, the rows read); and the timings in ms. Only passages and records you could open yourself are listed: never another org, a record type your role does not view, a label above your clearance, a removed document or a link with a hidden end. When the graph path fails the answer uses documents only and gives the fallback reason. 503 assistant_unavailable when the embedding model cannot be reached. Shares the 10-a-minute limit with asking (429 rate_limited)',
  body: searchBodySchema,
  response: searchAnswerSchema,
});
