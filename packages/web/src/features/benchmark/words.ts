// How the Benchmark screen (S8-010) says what isn't already in S8-001's plain words (@grc/shared
// BENCHMARK_TEXT, the kind, part, mode, outcome and status words, each metric's label and
// definition): scores, the difference between the modes, where a question set came from, who
// started a run, and the two modes' colours.
import {
  BENCHMARK_METRIC_BY_NAME,
  benchmarkModeText,
  benchmarkPartText,
  isBenchmarkMetricName,
  type BenchmarkMetricName,
  type BenchmarkPerson,
  type QuestionSetSource,
} from '@grc/shared';
import { formatCount } from '@/features/frameworks/CoverageBar';

/** The two question modes' colours: hybrid in the app's action teal, the vector-only baseline in
 * slate. Both reach 3:1 against white, as chart marks must. */
export const MODE_COLOR = {
  hybrid: '#0e5c63',
  vector: '#7f939e',
} as const;

export type QuestionMode = keyof typeof MODE_COLOR;
export const QUESTION_MODES: readonly QuestionMode[] = ['hybrid', 'vector'];

/** Reciprocal rank is a fraction, not a share, so it reads as `0.62` rather than `62%`. */
function isFraction(metric: string): boolean {
  return metric === 'reciprocal_rank';
}

/** A score metric's value: `86%`, or `0.62` for reciprocal rank; `—` when it wasn't measured. */
export function formatScore(metric: string, value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const v = Math.min(1, Math.max(0, value));
  return isFraction(metric) ? v.toFixed(2) : `${Math.round(v * 100)}%`;
}

export type DiffTone = 'better' | 'worse' | 'even' | 'none';

export interface ScoreDiff {
  /** `+32 pts`, `−0.08`, `Even`, or `—` when a mode has no value. */
  text: string;
  tone: DiffTone;
  /** The difference in a sentence, for screen readers and titles. */
  sentence: string;
}

function higherIsBetter(metric: string): boolean {
  return isBenchmarkMetricName(metric) ? BENCHMARK_METRIC_BY_NAME[metric as BenchmarkMetricName].higherIsBetter : true;
}

/**
 * Hybrid against vector only on one score metric: the gap in percentage points (or as a fraction for
 * reciprocal rank), and whether it favours hybrid, given which way the metric is better.
 */
export function scoreDiff(
  metric: string,
  hybrid: number | null | undefined,
  vector: number | null | undefined,
): ScoreDiff {
  if (
    typeof hybrid !== 'number' ||
    typeof vector !== 'number' ||
    !Number.isFinite(hybrid) ||
    !Number.isFinite(vector)
  ) {
    return { text: '—', tone: 'none', sentence: 'There is nothing to compare: one of the modes has no value.' };
  }
  const fraction = isFraction(metric);
  const gap = fraction ? Math.round((hybrid - vector) * 100) / 100 : Math.round((hybrid - vector) * 100);
  if (gap === 0) return { text: 'Even', tone: 'even', sentence: 'Hybrid and vector only score the same.' };
  const sign = gap > 0 ? '+' : '−';
  const size = fraction ? Math.abs(gap).toFixed(2) : `${Math.abs(gap)} pts`;
  const better = gap > 0 === higherIsBetter(metric);
  const amount = fraction ? Math.abs(gap).toFixed(2) : `${Math.abs(gap)} percentage points`;
  return {
    text: `${sign}${size}`,
    tone: better ? 'better' : 'worse',
    sentence: `Hybrid is ${amount} ${gap > 0 ? 'higher' : 'lower'} than vector only, which is ${better ? 'better' : 'worse'}.`,
  };
}

/** Where a run's question set came from: "Generated (seed 42, accuracy, ORG-01)" or "Hand-written". */
export function dataVersionText(source: QuestionSetSource): string {
  if (source.type === 'hand_written') return 'Hand-written';
  return `Generated (seed ${source.seed}, ${source.size}, ${source.orgKey})`;
}

/** Where a run's questions came from, in a phrase: "hand-written for acme", "generated from seed 42
 * (accuracy, ORG-01) for gen-42-1 and fast-42-accuracy-1". */
export function questionSetText(source: QuestionSetSource): string {
  const orgs = orgSlugsText(source.orgSlugs);
  if (source.type === 'hand_written') return `hand-written for ${orgs}`;
  return `generated from seed ${source.seed} (${source.size}, ${source.orgKey}) for ${orgs}`;
}

/** The orgs a question set fits: "acme", "gen-42-1 and fast-42-tiny-1". */
export function orgSlugsText(slugs: readonly string[]): string {
  if (slugs.length <= 1) return slugs[0] ?? '';
  return `${slugs.slice(0, -1).join(', ')} and ${slugs[slugs.length - 1]}`;
}

/** "Retrieval, answers and extraction". */
export function partsText(parts: readonly string[]): string {
  const text = orgSlugsText(parts.map(benchmarkPartText));
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/** "Hybrid and vector only": the question modes; extraction's own `pipeline` mode goes without saying. */
export function modesText(modes: readonly string[]): string {
  const shown = modes.filter((mode) => mode !== 'pipeline').map(benchmarkModeText);
  const text = orgSlugsText(shown);
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/** Who started a run: their name, the key's name, or what to say when neither can be found. */
export function startedByText(person: BenchmarkPerson): string {
  if (person.name) return person.name;
  return person.id.startsWith('api_key:') ? 'An API key that no longer exists' : 'A former member';
}

/** `1 question`, `24 questions`. */
export function countText(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** A share as a whole percent: `0.873` → `87%`; `—` for none. */
export function percentText(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

/** A setting's name in words: `contextPassages` → `Context passages`, `max_results` → `Max results`. */
export function settingName(key: string): string {
  const text = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

/** A setting's value: `0.85`, `1,000`. */
export function settingValue(value: number): string {
  return Number.isFinite(value) ? NUMBER.format(value) : String(value);
}
