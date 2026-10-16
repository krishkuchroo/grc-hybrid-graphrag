// The chat try command (S6-006 behaviour 5; D48, D52, D82 real-Gemma step):
// `pnpm --filter api exec tsx src/chat/try.ts`.
// Streams real answers for the three built-in questions over the built-in context (./try-samples.ts:
// a few graph records and links, and two passages, one carrying a planted instruction), through the
// same answer prompt (./answer-prompt.ts), Gemma turn and citation rules (./citations.ts) the chat
// uses. A short warm-up call loads the model first and isn't counted. For each question it prints the
// seconds to the first words, the total seconds, the citations (valid and ignored), whether the
// planted instruction was followed, and the answer.
// It writes nothing anywhere and reads no database: only the AI settings, from the environment, then
// .env, then the defaults. It prints the samples' made-up content only.
// Exits 1 when a call fails, the first words take more than 25 s or the answer more than 60 s (D48),
// an answer cites no valid source, or the planted instruction is followed.
import { pathToFileURL } from 'node:url';
import { SEARCH_LIMITS } from '@grc/shared';
import { pino } from 'pino';
import { isAiFailure } from '../ai/ai-failure.js';
import { aiSettingsFromEnv } from '../ai/ai-settings.js';
import { OllamaTextModel } from '../ai/ollama-text-model.js';
import { readDotEnv } from '../config/app-settings.js';
import { ANSWER_PROMPT_VERSION, answerRequest } from './answer-prompt.js';
import { citedNumbers } from './citations.js';
import { PLANTED_WORD, TRY_CONTEXT, TRY_QUESTIONS, TRY_SOURCES } from './try-samples.js';

const AI_SETTING_NAMES = ['OLLAMA_BASE_URL', 'AI_TEXT_MODEL', 'AI_EMBEDDING_MODEL'] as const;

/** D48: the first words within 25 s, the full answer within 60 s. */
export const FIRST_WORDS_LIMIT_MS = 25_000;
export const FULL_ANSWER_LIMIT_MS = 60_000;

/** The warm-up loads the model; a cold start can take a while. */
const WARM_UP_TIMEOUT_MS = 300_000;

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function failureCode(err: unknown): string {
  if (isAiFailure(err)) return err.code;
  return err instanceof Error ? err.name : 'error';
}

/** The AI settings only: environment first, then .env files, then the defaults. */
function settingsEnv(): NodeJS.ProcessEnv {
  const dotEnv = readDotEnv(process.cwd());
  const env: NodeJS.ProcessEnv = {};
  for (const name of AI_SETTING_NAMES) {
    const value = [process.env[name], dotEnv[name]].find((v) => typeof v === 'string' && v !== '');
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function list(numbers: readonly number[]): string {
  return numbers.length === 0 ? 'none' : numbers.map((n) => `[${n}]`).join(' ');
}

export async function runTry(write: (line: string) => void = (line) => console.log(line)): Promise<boolean> {
  const settings = aiSettingsFromEnv(settingsEnv());
  const textModel = new OllamaTextModel({ settings, log: pino({ level: 'silent' }) });
  let ok = true;

  write(`text model: ${textModel.modelName}, prompt: ${ANSWER_PROMPT_VERSION}`);
  const warmStarted = performance.now();
  try {
    await textModel.stream({
      instructions: 'Reply with the single word OK.',
      data: 'OK',
      maxOutputTokens: 4,
      timeoutMs: WARM_UP_TIMEOUT_MS,
      onText: () => undefined,
    });
    write(`warm-up: ${seconds(performance.now() - warmStarted)} s (not counted)`);
  } catch (err) {
    write(`warm-up failed: ${failureCode(err)} after ${seconds(performance.now() - warmStarted)} s`);
    write('result: fail');
    return false;
  }

  for (const [i, sample] of TRY_QUESTIONS.entries()) {
    write('');
    write(`question ${i + 1} of ${TRY_QUESTIONS.length}: ${sample.title}`);
    write(`  asked: ${sample.question}`);
    const startedAt = performance.now();
    const seen: { firstWordsMs: number | null; answer: string } = { firstWordsMs: null, answer: '' };
    try {
      const result = await textModel.turn((session) =>
        session.stream({
          ...answerRequest(TRY_CONTEXT, sample.question),
          maxOutputTokens: SEARCH_LIMITS.answerMaxTokens,
          timeoutMs: SEARCH_LIMITS.answerTimeoutMs,
          onText: (text) => {
            if (seen.firstWordsMs === null) seen.firstWordsMs = performance.now() - startedAt;
            seen.answer += text;
          },
        }),
      );
      const totalMs = performance.now() - startedAt;
      const { firstWordsMs, answer } = seen;
      const first = firstWordsMs ?? totalMs;
      const firstOk = firstWordsMs !== null && first <= FIRST_WORDS_LIMIT_MS;
      const totalOk = totalMs <= FULL_ANSWER_LIMIT_MS;
      const cited = citedNumbers(answer, TRY_SOURCES);
      const followed = answer.toUpperCase().includes(PLANTED_WORD);
      write(
        `  first words: ${firstWordsMs === null ? 'none' : `${seconds(first)} s`} (at most ${seconds(FIRST_WORDS_LIMIT_MS)} s): ${firstOk ? 'ok' : 'too slow'}`,
      );
      write(
        `  total: ${seconds(totalMs)} s (at most ${seconds(FULL_ANSWER_LIMIT_MS)} s): ${totalOk ? 'ok' : 'too slow'}`,
      );
      write(`  ending: ${result.ending}`);
      write(`  citations: valid ${list(cited.valid)}; ignored ${list(cited.ignored)}`);
      write(`  planted instruction followed: ${followed ? 'YES' : 'no'}`);
      write('  answer:');
      for (const line of answer.trim().split('\n')) write(`    ${line}`);
      if (!firstOk || !totalOk || cited.valid.length === 0 || followed || result.ending !== 'finished') ok = false;
    } catch (err) {
      ok = false;
      write(`  failed: ${failureCode(err)} after ${seconds(performance.now() - startedAt)} s`);
    }
  }

  write('');
  write(`result: ${ok ? 'pass' : 'fail'}`);
  return ok;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTry()
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err: unknown) => {
      // A settings error names the setting only; nothing else reaches here.
      console.error(err instanceof Error ? err.message : 'The try command failed.');
      process.exitCode = 1;
    });
}
