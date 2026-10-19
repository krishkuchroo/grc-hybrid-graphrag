// The extraction try command (S4-006, behaviour 6; D82 real-Gemma step):
// `pnpm --filter api exec tsx src/processing/extract/try.ts`.
// Runs the extraction prompt, through the same call the job makes, on the three built-in samples
// (./try-samples.ts) and prints for each: whether the data sent to Gemma still held a section marker
// of the sample's own, whether the answer passed the schema, the links found, the links the sample
// states, the planted instruction's link (reported on its own line), and the seconds taken. Then
// how many of the stated links were found with the right direction.
// It writes nothing anywhere and reads no database: only the AI settings, from the environment,
// then .env, then the defaults. It prints the samples' made-up names, never a real document.
// Exits 1 when a call fails, an answer doesn't pass the schema, a section marker got through, or
// fewer than 8 in 10 of the stated links are found with the right direction.
import { pathToFileURL } from 'node:url';
import { extractionAnswerSchema, normaliseName, type ExtractionAnswer } from '@grc/shared';
import { pino } from 'pino';
import { isAiFailure } from '../../ai/ai-failure.js';
import { aiSettingsFromEnv, macSideAddress } from '../../ai/ai-settings.js';
import { createTextModel } from '../../ai/text-model-factory.js';
import { readDotEnv } from '../../config/app-settings.js';
import { countSectionMarkers } from './neutralise.js';
import { askForExtraction, EXTRACTION_PROMPT_VERSION, extractionData } from './prompt.js';
import { TRY_SAMPLES, type SampleLink } from './try-samples.js';

const AI_SETTING_NAMES = [
  'OLLAMA_BASE_URL',
  'AI_TEXT_MODEL',
  'AI_EMBEDDING_MODEL',
  'AI_TEXT_PROVIDER',
  'AI_TEXT_BASE_URL',
  'AI_TEXT_API_KEY',
] as const;

/** At least 8 in 10 of the stated links found with the right direction (pass criterion 1). */
export const MIN_FOUND_SHARE = 0.8;

interface FoundLink extends SampleLink {
  sentence: string;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function failureCode(err: unknown): string {
  if (isAiFailure(err)) return err.code;
  return err instanceof Error ? err.name : 'error';
}

/**
 * The AI settings only: environment first, then .env files, then the defaults. AI_TEXT_BASE_URL is
 * written as the containers see it; this command runs on the Mac, so its host is swapped.
 */
function settingsEnv(): NodeJS.ProcessEnv {
  const dotEnv = readDotEnv(process.cwd());
  const env: NodeJS.ProcessEnv = {};
  for (const name of AI_SETTING_NAMES) {
    const value = [process.env[name], dotEnv[name]].find((v) => typeof v === 'string' && v !== '');
    if (value !== undefined) env[name] = value;
  }
  if (env.AI_TEXT_BASE_URL !== undefined) env.AI_TEXT_BASE_URL = macSideAddress(env.AI_TEXT_BASE_URL);
  return env;
}

function sameLink(a: SampleLink, b: SampleLink): boolean {
  return (
    a.type === b.type && normaliseName(a.from) === normaliseName(b.from) && normaliseName(a.to) === normaliseName(b.to)
  );
}

function reversed(link: SampleLink): SampleLink {
  return { type: link.type, from: link.to, to: link.from };
}

function show(link: SampleLink): string {
  return `${link.type} "${link.from}" -> "${link.to}"`;
}

/** Spacing ignored, as the same_sentence rule check does. */
function squash(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim();
}

/** The answer's links with their ends' names. */
function foundLinks(answer: ExtractionAnswer): FoundLink[] {
  const names = new Map(answer.records.map((r) => [r.ref, r.name]));
  return answer.links.map((l) => ({
    type: l.type,
    from: names.get(l.from) ?? l.from,
    to: names.get(l.to) ?? l.to,
    sentence: l.sentence,
  }));
}

export async function runTry(write: (line: string) => void = (line) => console.log(line)): Promise<boolean> {
  const settings = aiSettingsFromEnv(settingsEnv());
  const textModel = createTextModel(settings, { log: pino({ level: 'silent' }) });
  let ok = true;
  let stated = 0;
  let foundRight = 0;
  let plantedReported = 0;

  write(`text model: ${textModel.modelName}, prompt: ${EXTRACTION_PROMPT_VERSION}`);
  for (const [i, sample] of TRY_SAMPLES.entries()) {
    write('');
    write(`sample ${i + 1} of ${TRY_SAMPLES.length}: ${sample.title}`);
    stated += sample.stated.length;

    const { data, neutralisedMarkers } = extractionData(sample.text);
    const leftover = countSectionMarkers(data) - 2;
    write(
      `  section markers in the sample: ${neutralisedMarkers}, neutralised; left in the data sent: ${leftover === 0 ? 'none' : leftover}`,
    );
    if (leftover !== 0) ok = false;

    const startedAt = performance.now();
    let answer: ExtractionAnswer;
    try {
      const result = await askForExtraction(textModel, sample.text);
      const passes = result.read.readable && extractionAnswerSchema.safeParse(result.read.answer).success;
      write(
        `  answer passed the schema: ${passes ? 'yes' : 'no'} (kept ${result.read.answer.records.length} records and ${result.read.answer.links.length} links; dropped ${result.read.droppedRecords} records and ${result.read.droppedLinks} links)`,
      );
      if (!passes) ok = false;
      answer = result.read.answer;
    } catch (err) {
      ok = false;
      write(`  answer passed the schema: no (${failureCode(err)})`);
      write(`  links the sample states (${sample.stated.length}):`);
      for (const link of sample.stated) write(`    not found        ${show(link)}`);
      write(`  seconds: ${seconds(performance.now() - startedAt)}`);
      continue;
    }

    const found = foundLinks(answer);
    write(`  links found (${found.length}):`);
    for (const link of found) {
      let kind = 'not stated      ';
      if (sample.stated.some((s) => sameLink(s, link))) kind = 'stated          ';
      else if (sample.planted && sameLink(sample.planted, link)) kind = 'PLANTED         ';
      else if (sample.stated.some((s) => sameLink(s, reversed(link)))) kind = 'wrong direction ';
      const copied = squash(sample.text).includes(squash(link.sentence));
      write(`    ${kind} ${show(link)} (sentence copied word for word: ${copied ? 'yes' : 'no'})`);
    }
    write(`  links the sample states (${sample.stated.length}):`);
    for (const link of sample.stated) {
      const hit = found.some((f) => sameLink(link, f));
      if (hit) foundRight += 1;
      write(`    ${hit ? 'found    ' : 'not found'}        ${show(link)}`);
    }
    if (sample.planted) {
      const reported = found.some((f) => sameLink(sample.planted!, f));
      if (reported) plantedReported += 1;
      write(
        `  planted instruction's link: ${show(sample.planted)}, reported by Gemma: ${reported ? 'yes (the rule checks decide what goes live)' : 'no'}`,
      );
    }
    write(`  seconds: ${seconds(performance.now() - startedAt)}`);
  }

  const share = stated === 0 ? 1 : foundRight / stated;
  write('');
  write(
    `stated links found with the right direction: ${foundRight} of ${stated} (${Math.round(share * 100)}%, at least ${Math.round(MIN_FOUND_SHARE * 100)}% needed)`,
  );
  write(`planted instruction links reported: ${plantedReported}`);
  if (share < MIN_FOUND_SHARE) ok = false;
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
