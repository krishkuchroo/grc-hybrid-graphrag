// The embedder on Ollama (D25, D31): bge-m3 by default, texts sent in batches, every vector checked
// to be exactly 1,024 finite numbers before any is handed back (D71, D73). A wrong size or count is
// `invalid_output`, so a bad vector is never stored.
//
// Logs (D163): the model, counts, timings and failure codes only. Never a text or a vector.
import { embedMany, type EmbeddingModel } from 'ai';
import type { Logger } from 'pino';
import { createLogger } from '../common/logger.js';
import { AiFailure, AiInputError, toAiError, type AiCallError } from './ai-failure.js';
import type { AiSettings } from './ai-settings.js';
import { EMBEDDING_DIMENSIONS, type EmbedAnswer, type Embedder, type EmbedOptions } from './embedder.js';
import { createOllamaProvider, type FetchLike } from './ollama-provider.js';

/** Texts per call to Ollama. */
export const EMBED_BATCH_SIZE = 32;
/** Per batch: bge-m3 does about 5.6 chunks a second (D32), plus loading it on a cold start. */
export const EMBED_TIMEOUT_MS = 120_000;

export interface OllamaEmbedderOptions {
  settings: Pick<AiSettings, 'ollamaBaseUrl' | 'embeddingModel'>;
  log?: Logger;
  /** Stands in for the network, for tests. */
  fetch?: FetchLike;
  batchSize?: number;
  /** The time limit of a batch, when the call sets none. */
  timeoutMs?: number;
}

function positiveWhole(value: number | undefined, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new AiInputError(`${what} must be a whole number from 1`);
  return value;
}

function rightSize(vector: unknown): vector is number[] {
  return (
    Array.isArray(vector) &&
    vector.length === EMBEDDING_DIMENSIONS &&
    vector.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

export class OllamaEmbedder implements Embedder {
  readonly modelName: string;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly model: EmbeddingModel;
  private readonly log: Logger;
  private readonly batchSize: number;
  private readonly timeoutMs: number;

  constructor(opts: OllamaEmbedderOptions) {
    this.modelName = opts.settings.embeddingModel;
    this.model = createOllamaProvider({ baseUrl: opts.settings.ollamaBaseUrl, fetch: opts.fetch }).embedding(
      this.modelName,
    );
    this.log = (opts.log ?? createLogger()).child({ context: 'AiEmbedder' });
    this.batchSize = positiveWhole(opts.batchSize, 'batchSize') ?? EMBED_BATCH_SIZE;
    this.timeoutMs = positiveWhole(opts.timeoutMs, 'timeoutMs') ?? EMBED_TIMEOUT_MS;
  }

  async embed(texts: readonly string[], opts: EmbedOptions = {}): Promise<EmbedAnswer> {
    if (!Array.isArray(texts)) throw new AiInputError('The texts must be a list.');
    texts.forEach((text, i) => {
      if (typeof text !== 'string' || text.trim() === '') {
        throw new AiInputError(`Text ${i} is empty; an empty text can't be embedded.`);
      }
    });
    const timeoutMs = positiveWhole(opts.timeoutMs, 'timeoutMs') ?? this.timeoutMs;
    const model = this.modelName;
    const vectors: number[][] = [];
    let tokens = 0;
    let batches = 0;
    const startedAt = performance.now();
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      const result = await this.embedBatch(batch, timeoutMs);
      batches += 1;
      if (result.embeddings.length !== batch.length || !result.embeddings.every(rightSize)) {
        const failure = new AiFailure('invalid_output', { model, elapsedMs: result.elapsedMs });
        this.log.warn(
          { model, code: failure.code, elapsedMs: result.elapsedMs, sent: batch.length, got: result.embeddings.length },
          'embedder answer refused',
        );
        throw failure;
      }
      for (const vector of result.embeddings) vectors.push(Array.from(vector));
      tokens += result.tokens;
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (texts.length > 0) {
      this.log.debug({ model, count: texts.length, batches, elapsedMs, tokens }, 'embedder answered');
    }
    return { vectors, model, elapsedMs, batches, tokens };
  }

  private async embedBatch(
    batch: string[],
    timeoutMs: number,
  ): Promise<{ embeddings: unknown[]; tokens: number; elapsedMs: number }> {
    const model = this.modelName;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const startedAt = performance.now();
    try {
      const result = await embedMany({
        model: this.model,
        values: batch,
        // The job queue retries (D72); a retry here would hide "unavailable" for seconds.
        maxRetries: 0,
        maxParallelCalls: 1,
        abortSignal: controller.signal,
      });
      return {
        embeddings: result.embeddings,
        tokens: result.usage.tokens,
        elapsedMs: Math.round(performance.now() - startedAt),
      };
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - startedAt);
      const failure: AiFailure | AiCallError = toAiError(err, { model, elapsedMs, timedOut });
      if (failure instanceof AiFailure) {
        this.log.warn({ model, code: failure.code, elapsedMs, httpStatus: failure.httpStatus }, 'embedder call failed');
      } else {
        this.log.error(
          { model, errorType: failure.errorType, elapsedMs, httpStatus: failure.httpStatus },
          'embedder call failed',
        );
      }
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }
}
