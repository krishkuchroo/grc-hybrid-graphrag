// M0-014 follow-up, D163 + D164 (Q43 a): when a write fails, `pnpm org:create` and
// `pnpm seed:demo` print only the error's type and code (plus IDs), never its message, stack,
// cause or other properties. Drizzle's DrizzleQueryError puts the query's params in its message,
// and a pg error carries the row in `detail` and `where`, so printing the message shows the org's
// name and slug and the first Admin's ID and email.
//
// Contract, the same fields as the audit outbox relay's failure log (D163):
// - `describeError(err)` in `packages/infra/scripts/org-script-env.ts` returns one line holding
//   - the error type: `err.name`, or the constructor's name when `name` is the generic 'Error';
//   - the error code: `err.code`, else `err.cause.code`, when it is a string;
//   and nothing else from the error: not its message, stack, cause, or any other property.
// - Both scripts print a failed run through that line (stderr), exit non-zero, and print none of
//   the org's values (name, slug, first Admin's ID, name or email) on stdout or stderr.
//
// The script tests run the real scripts with plain node, with provisionOrg swapped for a fixture
// that throws those errors (tests/fixtures/provision), so no database is needed.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(new URL('../../../infra/scripts/', import.meta.url));
const HOOK = fileURLToPath(new URL('../fixtures/provision/failing-provision-hook.mjs', import.meta.url));
// The fixture's first Admin ID (tests/fixtures/provision/failing-provision-org.mjs).
const ADMIN_ID = '5eed1eaf-0a0b-4c0d-8e0f-1a2b3c4d5e6f';

type DescribeError = (err: unknown) => string;

async function loadDescribeError(): Promise<DescribeError> {
  const mod = (await import(new URL('org-script-env.ts', `file://${SCRIPTS}`).href)) as { describeError?: unknown };
  if (typeof mod.describeError !== 'function') throw new Error('org-script-env.ts must export describeError');
  return mod.describeError as DescribeError;
}

// ---------- values that must never be printed ----------

const ORG = {
  name: 'LEAKorg Northwind Traders',
  slug: 'leakslug-7a1b',
  admin: { email: 'leak.admin7a1@leakmail.example', name: 'LEAKadmin Jane Operator' },
};

const VALUES = [ORG.name, ORG.slug, ORG.admin.email, ORG.admin.name, ADMIN_ID];

/** The values found in the output, including fragments a shortened message could keep. */
function leaks(output: string, values: readonly string[] = VALUES): string[] {
  const found = values.filter((v) => output.includes(v));
  if (/leak/i.test(output)) found.push('a fragment of a LEAK marker');
  if (output.includes('7a1')) found.push('a fragment of the slug or email');
  if (output.includes('5eed1eaf')) found.push('a fragment of the admin ID');
  return found;
}

// ---------- the errors, as a failed write throws them ----------

function drizzleError(): Error {
  const pgError = Object.assign(
    new Error('duplicate key value violates unique constraint "organization_slug_unique"'),
    {
      name: 'error',
      code: '23505',
      severity: 'ERROR',
      detail: `Key (slug)=(${ORG.slug}) already exists.`,
      where: `SQL statement "insert ... values (${ORG.name}, ${ORG.admin.email}, ${ADMIN_ID})"`,
    },
  );
  return new DrizzleQueryError(
    'insert into "audit_events" ("org_id", "actor_id", "action", "after") values ($1, $2, $3, $4)',
    ['0c7e7f0e-3c1a-5d2b-9e4f-000000000001', ADMIN_ID, 'org.created', JSON.stringify(ORG)],
    pgError,
  );
}

class ProvisionStepError extends Error {
  constructor(
    message: string,
    readonly input: typeof ORG,
    readonly adminId: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProvisionStepError';
  }
}

function errorWithValues(): Error {
  const cause = Object.assign(new Error(`could not store ${ORG.name} for ${ORG.admin.email}`), {
    code: 'ECONNRESET',
    slug: ORG.slug,
  });
  return new ProvisionStepError(`org.created failed for ${ORG.slug}`, ORG, ADMIN_ID, { cause });
}

function plainError(): Error {
  return new Error(`org.created failed for ${ORG.name} (${ORG.slug}), admin ${ADMIN_ID} <${ORG.admin.email}>`);
}

// ---------- describeError ----------

describe('describeError (D164): error type and code only', () => {
  it('a DrizzleQueryError with a pg cause gives the type and the cause code', async () => {
    const describeError = await loadDescribeError();
    const line = describeError(drizzleError());
    expect(line).toContain('DrizzleQueryError');
    expect(line).toContain('23505');
  });

  it('a DrizzleQueryError gives none of its params, the cause message, detail or where', async () => {
    const describeError = await loadDescribeError();
    const err = drizzleError();
    const line = describeError(err);
    expect(leaks(line)).toEqual([]);
    expect(line).not.toContain('insert into');
    expect(line).not.toContain('duplicate key value');
  });

  it('an error carrying the values as properties and in its cause gives its type and the cause code', async () => {
    const describeError = await loadDescribeError();
    const line = describeError(errorWithValues());
    expect(line).toContain('ProvisionStepError');
    expect(line).toContain('ECONNRESET');
  });

  it('an error carrying the values as properties and in its cause gives none of them', async () => {
    const describeError = await loadDescribeError();
    const line = describeError(errorWithValues());
    expect(leaks(line)).toEqual([]);
    expect(line).not.toContain('could not store');
    expect(line).not.toContain('failed for');
  });

  it('an own string code wins over the cause code', async () => {
    const describeError = await loadDescribeError();
    const err = Object.assign(new Error(`write failed for ${ORG.slug}`, { cause: { code: 'CAUSECODE' } }), {
      code: 'OWNCODE',
    });
    const line = describeError(err);
    expect(line).toContain('OWNCODE');
    expect(line).not.toContain('CAUSECODE');
    expect(leaks(line)).toEqual([]);
  });

  it('a plain Error gives its type and none of its message', async () => {
    const describeError = await loadDescribeError();
    const line = describeError(plainError());
    expect(line).toContain('Error');
    expect(leaks(line)).toEqual([]);
    expect(line).not.toContain('failed for');
  });

  it('a subclass that keeps the generic name Error gives the constructor name', async () => {
    const describeError = await loadDescribeError();
    class OrgWriteFailure extends Error {}
    const line = describeError(new OrgWriteFailure(`could not write ${ORG.name}`));
    expect(line).toContain('OrgWriteFailure');
    expect(leaks(line)).toEqual([]);
  });

  it('a non-string code is left out', async () => {
    const describeError = await loadDescribeError();
    const err = Object.assign(new Error(`write failed for ${ORG.slug}`), { code: 4242 });
    const line = describeError(err);
    expect(line).not.toContain('4242');
    expect(leaks(line)).toEqual([]);
  });

  it('a thrown string holding the values prints none of them', async () => {
    const describeError = await loadDescribeError();
    const line = describeError(`org.created failed for ${ORG.name} (${ORG.slug}) ${ADMIN_ID} ${ORG.admin.email}`);
    expect(typeof line).toBe('string');
    expect(leaks(line)).toEqual([]);
  });
});

// ---------- the scripts' failure path ----------

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

let cwd: string;

beforeAll(async () => {
  // Outside the repo, so no `.env` is read: every setting comes from the environment below.
  cwd = await mkdtemp(join(tmpdir(), 'grc-script-errors-'));
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function scriptEnv(shape: 'drizzle' | 'props' | 'plain'): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    FAIL_SHAPE: shape,
    // Never connected to: the fixture's provisionOrg fails before any query.
    DATABASE_URL_APP: 'postgres://nobody:unused@127.0.0.1:1/unused',
    DATABASE_URL_MIGRATE: 'postgres://nobody:unused@127.0.0.1:1/unused',
    NEO4J_URI: 'bolt://127.0.0.1:1',
    NEO4J_ADMIN_PASSWORD: 'unused-admin-password',
    NEO4J_WRITER_PASSWORD: 'unused-writer-password',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_ACCESS_KEY: 'unused-access-key',
    S3_SECRET_KEY: 'unused-secret-key',
    DEMO_USER_PASSWORD: 'unused-demo-password-123',
  };
}

/** Runs a script the way its root pnpm script does, with provisionOrg swapped for the fixture. */
function runScript(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        '--import',
        HOOK,
        join(SCRIPTS, file),
        ...args,
      ],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const CREATE_ARGS = [
  '--name',
  ORG.name,
  '--slug',
  ORG.slug,
  '--admin-email',
  ORG.admin.email,
  '--admin-name',
  ORG.admin.name,
];

// seed:demo's first org (packages/infra/scripts/seed-demo.ts).
const SEED_VALUES = ['Acme Corp', 'demo-acme', 'admin@acme.example', 'Admin (Acme Corp)', ADMIN_ID];

function seedLeaks(output: string): string[] {
  const found = SEED_VALUES.filter((v) => output.includes(v));
  if (/acme/i.test(output)) found.push('a fragment of the org name, slug or email');
  if (output.includes('5eed1eaf')) found.push('a fragment of the admin ID');
  return found;
}

const T = 90_000;

describe('pnpm org:create failure output (D164)', () => {
  it(
    'a DrizzleQueryError prints the type and code on stderr and exits non-zero',
    async () => {
      const r = await runScript('create-org.ts', CREATE_ARGS, scriptEnv('drizzle'));
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toContain('org:create: failed');
      expect(r.stderr).toContain('DrizzleQueryError');
      expect(r.stderr).toContain('23505');
    },
    T,
  );

  it(
    'a DrizzleQueryError prints none of the org name, slug, admin ID, name or email',
    async () => {
      const r = await runScript('create-org.ts', CREATE_ARGS, scriptEnv('drizzle'));
      expect(r.stderr).toContain('org:create: failed');
      expect(leaks(r.stdout + r.stderr)).toEqual([]);
    },
    T,
  );

  it(
    'an error carrying the values as properties and in its cause prints its type and code, and none of them',
    async () => {
      const r = await runScript('create-org.ts', CREATE_ARGS, scriptEnv('props'));
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toContain('ProvisionStepError');
      expect(r.stderr).toContain('ECONNRESET');
      expect(leaks(r.stdout + r.stderr)).toEqual([]);
    },
    T,
  );

  it(
    'a plain Error prints its type and none of its message',
    async () => {
      const r = await runScript('create-org.ts', CREATE_ARGS, scriptEnv('plain'));
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toContain('org:create: failed');
      expect(r.stderr).toContain('Error');
      expect(leaks(r.stdout + r.stderr)).toEqual([]);
    },
    T,
  );
});

describe('pnpm seed:demo failure output (D164)', () => {
  it(
    'a DrizzleQueryError prints the type and code on stderr and exits non-zero',
    async () => {
      const r = await runScript('seed-demo.ts', [], scriptEnv('drizzle'));
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toContain('seed:demo: failed');
      expect(r.stderr).toContain('DrizzleQueryError');
      expect(r.stderr).toContain('23505');
    },
    T,
  );

  it(
    'a DrizzleQueryError prints none of the demo org name, slug, admin ID, name or email',
    async () => {
      const r = await runScript('seed-demo.ts', [], scriptEnv('drizzle'));
      expect(r.stderr).toContain('seed:demo: failed');
      expect(seedLeaks(r.stdout + r.stderr)).toEqual([]);
    },
    T,
  );

  it(
    'an error carrying the values as properties and in its cause prints its type and code, and none of them',
    async () => {
      const r = await runScript('seed-demo.ts', [], scriptEnv('props'));
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toContain('ProvisionStepError');
      expect(r.stderr).toContain('ECONNRESET');
      expect(seedLeaks(r.stdout + r.stderr)).toEqual([]);
    },
    T,
  );

  it(
    'a plain Error prints its type and none of its message',
    async () => {
      const r = await runScript('seed-demo.ts', [], scriptEnv('plain'));
      expect(r.status, r.stderr).not.toBe(0);
      expect(r.stderr).toContain('seed:demo: failed');
      expect(seedLeaks(r.stdout + r.stderr)).toEqual([]);
    },
    T,
  );
});
