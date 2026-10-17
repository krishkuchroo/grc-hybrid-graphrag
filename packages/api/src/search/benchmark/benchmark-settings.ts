// What a benchmark run ran with, as the API knows it itself (S8-002; D45.8, D73): saved in every
// run's settings beside the start body, so a run says which models, prompts, limits, cut-offs and
// injection rules its numbers came from, and runs can be compared or tuned from their results later.
// - `models`: the text model (Gemma) and the embedding model (bge-m3) the API's own clients use,
//   read from those clients (`TEXT_MODEL`, `EMBEDDER`), so a model changed in the settings shows.
// - `promptVersions`: S4's extraction prompt and S6's graph-query and answer prompts.
// - `limits`: S6's search and chat limits (`SEARCH_LIMITS`).
// - `cutOffs`: S4's duplicate-matching cut-offs.
// - `injectionChecks`: S8-001's `INJECTION_CHECKS`, in plain words.
// Pure: no I/O. Holds no question, answer or record text.
import {
  CHAT_PROMPT_VERSIONS,
  CLEAR_MATCH_MARGIN,
  INJECTION_CHECKS,
  MAX_MATCH_CANDIDATES,
  MEANING_CANDIDATE_SCORE,
  MEANING_CLEAR_SCORE,
  SEARCH_LIMITS,
  SPELLING_CANDIDATE_SCORE,
  SPELLING_CLEAR_SCORE,
  benchmarkRunSettingsSchema,
  type BenchmarkRunSettings,
  type StartBenchmarkRunBody,
} from '@grc/shared';
import { EXTRACTION_PROMPT_VERSION } from '../../processing/extract/prompt.js';

/** The part of a run's settings the API fills in itself. */
export type ApiRunSettings = Pick<
  BenchmarkRunSettings,
  'models' | 'promptVersions' | 'limits' | 'cutOffs' | 'injectionChecks'
>;

/** The model names the API's own clients run with. */
export interface RunModels {
  text: string;
  embedding: string;
}

/** The models, prompt versions, limits, cut-offs and injection checks in effect. */
export function apiRunSettings(models: RunModels): ApiRunSettings {
  return {
    models: { text: models.text, embedding: models.embedding },
    promptVersions: {
      extraction: EXTRACTION_PROMPT_VERSION,
      graphQuery: CHAT_PROMPT_VERSIONS.graphQuery,
      answer: CHAT_PROMPT_VERSIONS.answer,
    },
    limits: { ...SEARCH_LIMITS },
    cutOffs: {
      spellingClearScore: SPELLING_CLEAR_SCORE,
      spellingCandidateScore: SPELLING_CANDIDATE_SCORE,
      meaningClearScore: MEANING_CLEAR_SCORE,
      meaningCandidateScore: MEANING_CANDIDATE_SCORE,
      clearMatchMargin: CLEAR_MATCH_MARGIN,
      maxMatchCandidates: MAX_MATCH_CANDIDATES,
    },
    injectionChecks: { ...INJECTION_CHECKS },
  };
}

/** A run's settings: the start body, plus what the API ran with; checked against the shared shape. */
export function runSettings(body: StartBenchmarkRunBody, api: ApiRunSettings): BenchmarkRunSettings {
  return benchmarkRunSettingsSchema.parse({
    parts: body.parts,
    modes: body.modes,
    questionSet: body.questionSet,
    questionCount: body.questionCount,
    ...(body.unmatchedRecords !== undefined ? { unmatchedRecords: body.unmatchedRecords } : {}),
    ...api,
  });
}
