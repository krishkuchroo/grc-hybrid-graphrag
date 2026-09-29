// S1-012 criterion 6, the code side (the M0-015 rule, D30): link removal goes through the generated
// typed client, the links feature writes no address and calls no network itself, and the web uses the shared rules
// (`canLinkRecords`, D200; `isRemovableLinkOrigin`, D207) rather than its own copies.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = fileURLToPath(new URL('../../', import.meta.url));
const LINKS_DIR = join(WEB, 'src', 'features', 'records', 'links');
const DIALOG = join(LINKS_DIR, 'RemoveLinkDialog.tsx');
const CLIENT = join(WEB, 'src', 'api', 'client.ts');

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const read = (path: string): string => readFileSync(path, 'utf8');

describe('the code side', () => {
  it('has RemoveLinkDialog.tsx', () => {
    expect(existsSync(DIALOG), relative(WEB, DIALOG)).toBe(true);
  });

  it('the generated client knows POST /api/v1/links/remove', () => {
    expect(read(CLIENT)).toContain("'/api/v1/links/remove'");
  });

  it('the links feature calls the generated client’s remove route', () => {
    const text = filesUnder(LINKS_DIR).map(read).join('\n');
    expect(text).toMatch(/\bapi\.postLinksRemove\b/);
  });

  it('the links feature never calls the network itself nor writes an address', () => {
    const offenders = filesUnder(LINKS_DIR)
      .filter((path) => {
        const text = read(path);
        return (
          /\bfetch\s*\(/.test(text) ||
          /XMLHttpRequest|EventSource|WebSocket/.test(text) ||
          /['"`]\/api\/v1\/links\/remove/.test(text) ||
          /https?:\/\/|grc\.localhost|127\.0\.0\.1/.test(text)
        );
      })
      .map((path) => relative(WEB, path));
    expect(offenders).toEqual([]);
  });

  it('uses isRemovableLinkOrigin from @grc/shared (D207)', () => {
    const text = filesUnder(LINKS_DIR).map(read).join('\n');
    expect(text).toMatch(/import\s*\{[^}]*\bisRemovableLinkOrigin\b[^}]*\}\s*from\s*['"]@grc\/shared['"]/);
  });

  it('uses canLinkRecords from @grc/shared for the per-row decision (D200)', () => {
    const text = filesUnder(join(WEB, 'src', 'features', 'records'))
      .map(read)
      .join('\n');
    expect(text).toMatch(/import\s*\{[^}]*\bcanLinkRecords\b[^}]*\}\s*from\s*['"]@grc\/shared['"]/);
  });
});
