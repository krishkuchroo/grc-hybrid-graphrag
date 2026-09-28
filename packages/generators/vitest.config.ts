import { defineConfig } from 'vitest/config';

// One Vitest project per test kind (D177): `--project unit|db|stack` runs only that kind.
// Browser tests (e2e/*.e2e.ts) are Playwright's, never Vitest's.
const kind = (name: 'unit' | 'db' | 'stack') => ({
  extends: true,
  test: { name, include: [`src/**/*.${name}.test.{ts,tsx}`, `tests/**/*.${name}.test.{ts,tsx}`] },
});

// Tests stay inside this package and run in one process (D82). No retries (D171).
export default defineConfig({
  test: {
    projects: [kind('unit'), kind('db'), kind('stack')],
    retry: 0,
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    passWithNoTests: true,
  },
});
