import { defineConfig } from 'vitest/config';

// Tests stay inside this package and run in one process (D82).
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    passWithNoTests: true,
  },
});
