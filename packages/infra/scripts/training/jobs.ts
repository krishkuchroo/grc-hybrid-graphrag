// The training jobs of `pnpm train:data` (TR-001; D239, D248): the four text-model jobs a row can
// teach, and the ones with no builder yet. Training question 2 (which jobs to train) stays open
// until the before-test, so the jobs are chosen when the command runs. No imports: the command
// reads this before it loads anything else.

/** The four jobs, in the order a training file holds them. */
export const TRAINING_JOBS = ['extraction', 'mapping', 'graph_query', 'answer'] as const;
export type TrainingJob = (typeof TRAINING_JOBS)[number];

export function isTrainingJob(value: string): value is TrainingJob {
  return (TRAINING_JOBS as readonly string[]).includes(value);
}

/**
 * The jobs with no builder yet, and why. TR-002 added `graph_query`'s; `mapping` has no correct
 * answers to train on (Q-TR-3).
 */
export const JOBS_WITHOUT_BUILDER: Readonly<Partial<Record<TrainingJob, string>>> = Object.freeze({
  mapping: 'the generated companies have no framework mappings, so no correct answers exist yet (Q-TR-3)',
  answer: 'its builder comes with TR-003',
});

/** The two sides of the split: by world, about 90% `train` and 10% `validation` (D248). */
export const SPLITS = ['train', 'validation'] as const;
export type Split = (typeof SPLITS)[number];
