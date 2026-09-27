// M0-003 criterion 1 and D57: the migration account is never used at runtime.
// Runtime code (everything under `src/`) never reads DATABASE_URL_MIGRATE, and the database
// module connects with DATABASE_URL_APP. Only `drizzle.config.ts` (outside `src/`, used by
// drizzle-kit) reads DATABASE_URL_MIGRATE. No database needed.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_DIR } from './helpers.js';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('the migration account is never used at runtime (D57)', () => {
  it('the database module connects with DATABASE_URL_APP, and no runtime source reads DATABASE_URL_MIGRATE', () => {
    const modulePath = join(API_DIR, 'src', 'db', 'db.module.ts');
    expect(existsSync(modulePath), 'src/db/db.module.ts exists').toBe(true);
    expect(readFileSync(modulePath, 'utf8')).toContain('DATABASE_URL_APP');

    const offenders = sourceFiles(join(API_DIR, 'src')).filter((f) =>
      readFileSync(f, 'utf8').includes('DATABASE_URL_MIGRATE'),
    );
    expect(offenders).toEqual([]);
  });

  it('drizzle.config.ts reads DATABASE_URL_MIGRATE', () => {
    const configPath = join(API_DIR, 'drizzle.config.ts');
    expect(existsSync(configPath), 'drizzle.config.ts exists').toBe(true);
    expect(readFileSync(configPath, 'utf8')).toContain('DATABASE_URL_MIGRATE');
  });
});
