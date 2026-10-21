// One training row (TR-001; D248): a chat of three messages and where it came from. Pure.
// - `system` is the request's `instructions` and `user` its `data`, exactly as the app builds them,
//   so the rows teach the prompts the app sends (a prompt change shows up in the next build).
// - `assistant` is the correct answer in the app's output format: for a JSON job the answer as
//   `JSON.stringify` writes it (no spaces, keys in the answer shape's order, which the builder
//   gives its objects); for the `answer` job plain text. Never any thinking text.
// - Keys are written in a fixed order: `job`, `messages`, `split`, `seed`.
import type { TextRequest } from '../../../api/src/ai/text-model.js';
import type { AnswerKey } from '../../../generators/src/world/index.js';
import type { RenderedSources } from '../../../generators/src/sources/index.js';
import type { TokenCounter } from '../../../api/src/processing/reader/tokenizer.js';
import type { Split, TrainingJob } from './jobs.js';

/** One example of one job, before the split: the row's texts and the request the app sends. */
export interface TrainingExample {
  job: TrainingJob;
  /** The seed of the world it came from. */
  seed: number;
  /** The request's `instructions`. */
  system: string;
  /** The request's `data`. */
  user: string;
  /** The correct answer, as the model must write it. */
  assistant: string;
  /** The request the app builds for this example, sent through the real client by the self-check. */
  request: TextRequest<unknown>;
  /**
   * Whether the example asks about a made-up name that matches no record (TR-002). A job keeps
   * these to at most one row in MADE_UP_ONE_IN, before and after `--max-per-job`.
   */
  madeUp?: boolean;
}

/** At most one row in this many of a job asks about a made-up name (TR-002: at most 10%). */
export const MADE_UP_ONE_IN = 10;

export interface TrainingRow {
  job: TrainingJob;
  messages: [
    { role: 'system'; content: string },
    { role: 'user'; content: string },
    { role: 'assistant'; content: string },
  ];
  split: Split;
  seed: number;
}

/** The row of an example, keys in the file's order. */
export function rowOf(example: TrainingExample, split: Split): TrainingRow {
  return {
    job: example.job,
    messages: [
      { role: 'system', content: example.system },
      { role: 'user', content: example.user },
      { role: 'assistant', content: example.assistant },
    ],
    split,
    seed: example.seed,
  };
}

/** One line of `train.jsonl`: the row as JSON, then a line break. */
export function rowLine(row: TrainingRow): string {
  return `${JSON.stringify(row)}\n`;
}

/** One generated world: the answer key of one seed and the sources rendered from it. */
export interface TrainingWorld {
  seed: number;
  key: AnswerKey;
  sources: RenderedSources;
}

/** What the builders share for a run. */
export interface BuildContext {
  /** bge-m3's token counter, which the worker chunks with. */
  counter: TokenCounter;
}

/** One world's examples of one job, and the examples left out, per reason. */
export interface WorldExamples {
  examples: TrainingExample[];
  dropped: Record<string, number>;
}

/** A job's row builder: TR-001 adds `extraction`, TR-002 `graph_query`. */
export interface JobBuilder {
  readonly job: TrainingJob;
  /** The version of the app's prompt the rows are built from (D45.8). */
  readonly promptVersion: string;
  /** Every reason an example can be left out, in the order they are reported. */
  readonly dropReasons: readonly string[];
  /** The examples one world gives. */
  build(world: TrainingWorld, ctx: BuildContext): Promise<WorldExamples>;
  /**
   * Whether the answer the app's client read back from an example's assistant text passes the
   * job's schema and is the example's answer: null when it does, else what differs (no row text).
   */
  checkAnswer(value: unknown, example: TrainingExample): string | null;
}

/** A bug in the builders: an answer that the app would not take as it is. Exit 1. */
export class TrainingDataBug extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrainingDataBug';
  }
}
