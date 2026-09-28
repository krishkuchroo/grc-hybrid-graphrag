// S1-006 criterion 8, the code side (the M0-015 rule, D30): the typed client is regenerated with the
// S1-004 routes, and the records kit never talks to the network itself nor writes a host.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(WEB, 'src');
const CLIENT = join(SRC, 'api', 'client.ts');
const RECORDS = join(SRC, 'features', 'records');

// The files the S1-006 brief creates; the scans below must cover them.
const KIT = [
  'src/features/records/RecordTable.tsx',
  'src/features/records/RecordPage.tsx',
  'src/features/records/RecordForm.tsx',
  'src/features/records/LabelBadge.tsx',
  'src/features/records/OwnerPicker.tsx',
  'src/features/records/RetireDialog.tsx',
  'src/features/records/useRecords.ts',
  'src/features/records/permissions.ts',
  'src/features/records/risks/RiskRegister.tsx',
  'src/features/records/risks/RiskPage.tsx',
  'src/features/records/risks/RatingBadge.tsx',
];

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const read = (path: string): string => readFileSync(path, 'utf8');

describe('the generated client and the records kit (criterion 8, code side)', () => {
  it('has every file the brief names', () => {
    const present = filesUnder(RECORDS).map((p) => relative(WEB, p));
    expect(present).toEqual(expect.arrayContaining(KIT));
  });

  it.each(['/api/v1/risks', '/api/v1/people'])('the regenerated client knows %s', (route) => {
    expect(read(CLIENT)).toContain(route);
  });

  it('the client knows the one-record and retire routes', () => {
    const text = read(CLIENT);
    expect(text).toMatch(/\/api\/v1\/risks\/(\{id\}|\$\{)/);
    expect(text).toMatch(/\/api\/v1\/risks\/(\{id\}|\$\{[^}]+\})\/retire/);
  });

  it('the records kit never calls the network itself', () => {
    const files = filesUnder(RECORDS);
    expect(files.length, 'the records kit exists').toBeGreaterThan(0);
    const offenders = files
      .filter((path) => {
        const text = read(path);
        return (
          /\bfetch\s*\(/.test(text) ||
          /XMLHttpRequest|EventSource|WebSocket/.test(text) ||
          /from\s+['"](axios|ky|@better-fetch\/[^'"]*)['"]/.test(text)
        );
      })
      .map((path) => relative(WEB, path));
    expect(offenders).toEqual([]);
  });

  it('the records kit writes no host and uses the typed client', () => {
    const files = filesUnder(RECORDS);
    expect(files.length).toBeGreaterThan(0);
    const withHost = files
      .filter((path) =>
        /https?:\/\/|\blocalhost\b|grc\.localhost|127\.0\.0\.1/.test(
          read(path).replace(/https?:\/\/www\.w3\.org\/[^\s'"`]*/g, ''),
        ),
      )
      .map((path) => relative(WEB, path));
    expect(withHost).toEqual([]);
    expect(files.some((path) => /from\s+['"]@\/api\/client['"]/.test(read(path)))).toBe(true);
  });
});
