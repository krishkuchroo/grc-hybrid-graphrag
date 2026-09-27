// `pnpm setup:secrets` (D57): writes the git-ignored `.env` in the current folder.
// - Every name in `.env.example` that is missing from `.env` is added.
// - Secrets (names with PASSWORD, SECRET, TOKEN or KEY) get a fresh random, URL-safe value
//   when missing or empty. A value that is already set is never changed.
// - NEO4J_DESKTOP_PASSWORD is the user's own Neo4j Desktop password: left empty, and named in
//   the output so the user knows to fill it in.
// - Secrets are never printed, and `.env` ends at mode 600.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const USER_SUPPLIED = 'NEO4J_DESKTOP_PASSWORD';
const SECRET_NAME = /PASSWORD|SECRET|TOKEN|KEY/;
const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

const examplePath = join(process.cwd(), '.env.example');
const envPath = join(process.cwd(), '.env');

if (!existsSync(examplePath)) {
  console.error('setup:secrets: .env.example not found. Run it from the repo root.');
  process.exit(1);
}

const names = readFileSync(examplePath, 'utf8')
  .split('\n')
  .map((l) => LINE.exec(l)?.[1])
  .filter((n): n is string => n !== undefined);

const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n') : [];
if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

function isSecret(name: string): boolean {
  return SECRET_NAME.test(name) && name !== USER_SUPPLIED;
}

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

function isEmpty(raw: string): boolean {
  const v = raw.trim();
  return v === '' || v === '""' || v === "''";
}

const generated: string[] = [];
const seen = new Map<string, number>();
lines.forEach((l, i) => {
  const name = LINE.exec(l)?.[1];
  if (name !== undefined && !seen.has(name)) seen.set(name, i);
});

for (const name of names) {
  const index = seen.get(name);
  if (index === undefined) {
    const value = isSecret(name) ? newSecret() : '';
    if (value) generated.push(name);
    lines.push(`${name}=${value}`);
    seen.set(name, lines.length - 1);
  } else if (isSecret(name) && isEmpty(LINE.exec(lines[index]!)![2]!)) {
    lines[index] = `${name}=${newSecret()}`;
    generated.push(name);
  }
}

// Tighten an existing file before writing secrets into it; a new file is created at 600.
if (existsSync(envPath)) chmodSync(envPath, 0o600);
writeFileSync(envPath, `${lines.join('\n')}\n`, { mode: 0o600 });
chmodSync(envPath, 0o600);

console.log(
  generated.length > 0
    ? `setup:secrets: wrote .env (mode 600) with new values for: ${generated.join(', ')}.`
    : 'setup:secrets: .env is up to date; no values changed.',
);

const desktopIndex = seen.get(USER_SUPPLIED);
if (desktopIndex !== undefined && isEmpty(LINE.exec(lines[desktopIndex]!)![2]!)) {
  console.log(
    `setup:secrets: ${USER_SUPPLIED} is empty. Fill it in yourself with the Neo4j Desktop \`neo4j\` account's password.`,
  );
}
