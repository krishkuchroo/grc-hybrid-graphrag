// The small embedder interface (D25, D45.2, D71): texts in, one vector of exactly 1,024 numbers
// each out, or a typed `AiFailure` (`unavailable`, `timed_out`, `invalid_output`). A test or
// another model can stand in for it behind the EMBEDDER token.

export const EMBEDDER = Symbol('Embedder');

/** bge-m3's size, and the size of every stored vector (`vector(1024)`, D73). */
export const EMBEDDING_DIMENSIONS = 1024;

export interface EmbedOptions {
  /** Time limit for each batch sent to the model. */
  timeoutMs?: number;
}

export interface EmbedAnswer {
  /** One vector per text, in the same order, each exactly EMBEDDING_DIMENSIONS finite numbers. */
  vectors: number[][];
  /** The model that made the vectors, so callers can record it (D69). */
  model: string;
  /** Time all the batches took, in milliseconds. */
  elapsedMs: number;
  /** How many calls the texts were sent in. */
  batches: number;
  tokens?: number;
}

export interface Embedder {
  /** The model this client asks, for example `bge-m3`. */
  readonly modelName: string;
  readonly dimensions: number;
  /**
   * Embeds the texts in batches. An empty text is refused with an `AiInputError` before anything
   * is sent. A vector of the wrong size, or the wrong number of vectors, is an `invalid_output`
   * failure, and no vector of that call is returned.
   */
  embed(texts: readonly string[], opts?: EmbedOptions): Promise<EmbedAnswer>;
}
