// M0-001, criterion 4: a trivial test that workspace.unit.test.ts runs on its own
// through `pnpm --filter infra test -- filter-probe`, to prove the name filter
// reaches Vitest.
import { expect, it } from 'vitest';

it('runs when the filter names it', () => {
  expect(true).toBe(true);
});
