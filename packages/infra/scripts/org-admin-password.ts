// `pnpm org:admin-password --org <slug> --email <email>` (FT-002; D49, D54, D56, D57, D241 (1),
// D244): the platform operator's command for an org Admin's first password, so the Admin of an org
// made by `pnpm org:create` (which leaves the Admin with no password) can sign in at
// https://grc.localhost. First password only (D244, Q-PW-1): changing a password comes with S7's
// set-up links (D214 (1)).
// - The password is typed twice in a terminal, with nothing shown. It is never an argument, an
//   environment variable, output or a log line, and lives in memory only until it is hashed.
// - It is stored with Better Auth's own hash (identity/auth.ts `hashPassword`) in the Admin's
//   `credential` account, as seed-demo.ts's addPerson stores it, with one `auth.password_set`
//   audit entry in the same transaction (CLAUDE.md principle 4). The entry holds no password, no
//   hash and no email.
// - Refused with exit 2 and nothing changed: bad arguments, no terminal, a password that breaks the
//   length rule or differs from its repeat, no such org, an email that is no Admin of the org, or
//   an Admin who already has a password or two-factor sign-in (fail safe, principle 7).
// - Touches no session or two-factor data: the Admin's first sign-in still leads only to the TOTP
//   set-up screen (D49, D54).
// - Opens only the grc_app connection (max 1), through the dev relay on the Mac (D170). Settings:
//   DATABASE_URL_APP, from the environment, else `.env` (org-script-env.ts). Never printed.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScriptDb, ScriptTx } from './org-script-env.js';

// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path.
type Env = typeof import('./org-script-env.js');
const { describeError, load, provisioning, setting, sqlTag } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;
const { toHostAddress } = (await import(
  new URL('./host-address.ts', import.meta.url).href
)) as typeof import('./host-address.js');

// The slices of the api's modules this command uses (loaded from packages/api/src at run time).
interface AuthModule {
  hashPassword(plain: string): Promise<string>;
  MIN_PASSWORD_LENGTH: number;
}
interface AuditEntry {
  orgId: string;
  actorType: 'system';
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
}
interface AuditModule {
  AuditService: new (db: ScriptDb) => { appendInTx(tx: ScriptTx, e: AuditEntry): Promise<unknown> };
}

const { hashPassword, MIN_PASSWORD_LENGTH } = await load<AuthModule>('identity/auth.ts');
const { AuditService } = await load<AuditModule>('audit/audit.service.ts');
const { createDb } = await load<{ createDb(url: string, opts?: { max?: number }): ScriptDb }>('db/client.ts');
const { orgIdForSlug } = await load<{ orgIdForSlug(slug: string): string }>('identity/provision-org.ts');
const sql = await sqlTag();

/** Better Auth's longest password: its default `maxPasswordLength` (better-auth 1.7.6), which
 * identity/auth.ts keeps. Measured as Better Auth does, in `string.length`. */
export const MAX_PASSWORD_LENGTH = 128;

const NAME = 'org:admin-password';
const USAGE = `usage: pnpm ${NAME} --org <org-slug> --email <admin email>  (the password is typed when asked)`;
export const ACTOR_ID = 'org-admin-password';
export const ACTION = 'auth.password_set';

const FLAGS = ['--org', '--email'] as const;
type Flag = (typeof FLAGS)[number];

export interface Args {
  slug: string;
  /** Trimmed and lowercased, as provisionOrg stores it. */
  email: string;
}

/**
 * The arguments, or the problems with them (one message each). An argument that isn't a known
 * flag or its value is named by its position only, never by its text: it could be a password
 * someone tried to pass in.
 */
export function parseArgs(argv: readonly string[]): { args: Args } | { problems: string[] } {
  const values: Partial<Record<Flag, string>> = {};
  const problems: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    const eq = arg.indexOf('=');
    const flag = (eq > 0 ? arg.slice(0, eq) : arg) as Flag;
    if (!FLAGS.includes(flag)) {
      problems.push(
        `argument ${i + 1} is unknown: only --org and --email are accepted, and the password is typed when asked`,
      );
      continue;
    }
    let value: string;
    if (eq > 0) value = arg.slice(eq + 1);
    else if (i + 1 < argv.length) value = argv[++i]!;
    else value = '';
    if (values[flag] !== undefined) problems.push(`${flag} is given more than once`);
    values[flag] = value;
  }
  for (const flag of FLAGS) {
    const value = values[flag];
    if (value === undefined) problems.push(`${flag} is missing`);
    else if (value.trim() === '') problems.push(`${flag} must not be empty`);
  }
  const slug = values['--org'];
  if (slug !== undefined && slug.trim() !== '' && !provisioning.SLUG.test(slug)) {
    problems.push(
      '--org must be an org slug: lowercase letters and digits, joined by single hyphens (for example acme-corp)',
    );
  }
  const email = values['--email'];
  if (email !== undefined && email.trim() !== '' && !provisioning.EMAIL.test(email)) {
    problems.push('--email must look like name@example.com');
  }
  if (problems.length > 0) return { problems };
  return { args: { slug: slug!, email: email!.trim().toLowerCase() } };
}

/** The rule a password breaks, or null when it is fine. Gives the rule only, never the entry. */
export function passwordProblem(first: string, second: string, min = MIN_PASSWORD_LENGTH): string | null {
  if (first.length < min || first.length > MAX_PASSWORD_LENGTH) {
    return `the password must be ${min} to ${MAX_PASSWORD_LENGTH} characters`;
  }
  if (first !== second) return 'the two entries differ';
  return null;
}

/** The terminal the password is read from (process.stdin), and where the prompts go. */
export type TerminalIn = Pick<
  NodeJS.ReadStream,
  'setRawMode' | 'setEncoding' | 'on' | 'removeListener' | 'resume' | 'pause'
>;
export type TerminalOut = Pick<NodeJS.WriteStream, 'write'>;

/**
 * Reads one entry per prompt from a terminal in raw mode, with nothing shown: no characters, no
 * stars. Typed characters are kept; Backspace removes the last one; Enter ends an entry. Ctrl-C,
 * Ctrl-D or the end of the input cancel the whole read (null), keeping nothing. Other control keys and escape
 * sequences (arrows, function keys) are ignored. At most `limit` characters of an entry are kept;
 * the rest are counted (so Backspace still works) and the entry comes back `limit` long. The
 * terminal is always put back as it was before this returns.
 */
export function readHiddenEntries(
  input: TerminalIn,
  output: TerminalOut,
  prompts: readonly string[],
  limit: number,
): Promise<string[] | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (prompts.length === 0) {
      resolvePromise([]);
      return;
    }
    const entries: string[] = [];
    const typed: string[] = [];
    let uncounted = 0; // characters typed past `limit`
    let escape: 'none' | 'esc' | 'csi' | 'ss3' = 'none';
    let afterCr = false;
    let done = false;

    const finish = (result: string[] | null, err?: unknown): void => {
      if (done) return;
      done = true;
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      input.removeListener('error', onError);
      typed.length = 0;
      uncounted = 0;
      try {
        input.setRawMode(false);
      } catch {
        // The terminal is gone (closed or hung up): nothing is left to put back.
      }
      input.pause();
      if (err !== undefined) {
        entries.length = 0;
        rejectPromise(err);
      } else {
        if (result === null) entries.length = 0;
        resolvePromise(result);
      }
    };

    const endEntry = (): void => {
      output.write('\n');
      entries.push(typed.join(''));
      typed.length = 0;
      uncounted = 0;
      if (entries.length === prompts.length) finish(entries);
      else output.write(prompts[entries.length]!);
    };

    const take = (ch: string): void => {
      // Escape sequences (arrows, function keys): ESC [ … final byte (CSI) or ESC O x (SS3). A lone
      // ESC is ignored and the key after it is taken as usual.
      if (escape === 'esc') {
        escape = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'none';
        if (escape !== 'none') return;
      } else if (escape === 'csi') {
        const code = ch.codePointAt(0)!;
        if (code >= 0x40 && code <= 0x7e) escape = 'none';
        return;
      } else if (escape === 'ss3') {
        escape = 'none';
        return;
      }
      const wasCr = afterCr;
      afterCr = false;
      switch (ch) {
        case '\r':
          afterCr = true;
          endEntry();
          return;
        case '\n':
          if (!wasCr) endEntry(); // a pasted CR LF ends one entry, not two
          return;
        case '\x03': // Ctrl-C
        case '\x04': // Ctrl-D
          output.write('\n');
          finish(null);
          return;
        case '\x7f': // Backspace
        case '\b':
          if (uncounted > 0) uncounted--;
          else typed.pop();
          return;
        case '\x1b':
          escape = 'esc';
          return;
      }
      if (ch.codePointAt(0)! < 0x20) return; // other control keys
      if (typed.length < limit) typed.push(ch);
      else uncounted++;
    };

    function onData(chunk: unknown): void {
      for (const ch of String(chunk)) {
        if (done) return;
        take(ch);
      }
    }
    function onEnd(): void {
      output.write('\n');
      finish(null);
    }
    function onError(err: unknown): void {
      finish(null, err);
    }

    try {
      input.setRawMode(true);
    } catch (err) {
      rejectPromise(err);
      return;
    }
    input.setEncoding('utf8');
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('close', onEnd);
    input.on('error', onError);
    output.write(prompts[0]!);
    input.resume();
  });
}

/** A refusal: printed as it is, exit 2, nothing changed. */
export class Refused extends Error {
  override name = 'Refused';
}

/**
 * In one grc_app transaction with app.org_id set to the org's: checks the org and its Admin, then
 * stores the hash in the Admin's new `credential` account and appends `auth.password_set` to the
 * org's audit chain. Throws Refused (the transaction rolls back) when the org or Admin isn't
 * there, or the Admin already has a password or two-factor sign-in.
 */
export async function setFirstPassword(db: ScriptDb, args: Args, hash: string): Promise<{ userId: string }> {
  const orgId = orgIdForSlug(args.slug);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    const org = await tx.execute(sql`SELECT 1 FROM "organization" WHERE id = ${orgId}::uuid AND slug = ${args.slug}`);
    if (org.rows.length === 0) throw new Refused(`no org has the slug ${args.slug}`);

    // The Admin's user row, locked until the end of the transaction, so two runs at once for the
    // same Admin take turns and the second one sees the first one's password.
    const admin = await tx.execute(
      sql`SELECT u.id FROM "user" u
          WHERE u.email = ${args.email}
            AND EXISTS (SELECT 1 FROM "member" m
                        WHERE m.org_id = ${orgId}::uuid AND m.user_id = u.id AND m.role = 'admin')
          FOR UPDATE OF u`,
    );
    if (admin.rows.length === 0) throw new Refused(`no Admin of ${args.slug} has that email`);
    const userId = String(admin.rows[0]!['id']);

    // Read after the lock (a new statement, so a new snapshot). Any `credential` account counts as
    // a password, and any two-factor row as two-factor sign-in: first password only (D244).
    const state = await tx.execute(
      sql`SELECT (u.two_factor_enabled IS TRUE
                  OR EXISTS (SELECT 1 FROM "two_factor" t WHERE t.user_id = u.id)) AS has_two_factor,
                 EXISTS (SELECT 1 FROM "account" a
                         WHERE a.user_id = u.id AND a.provider_id = 'credential') AS has_password
          FROM "user" u WHERE u.id = ${userId}`,
    );
    const row = state.rows[0];
    if (!row || row['has_two_factor'] !== false || row['has_password'] !== false) {
      throw new Refused("that Admin already has a password; changing it comes with S7's set-up links");
    }

    await tx.execute(
      sql`INSERT INTO "account" (id, account_id, provider_id, user_id, password)
          VALUES (${randomUUID()}, ${userId}, 'credential', ${userId}, ${hash})`,
    );
    await new AuditService(db).appendInTx(tx, {
      orgId,
      actorType: 'system',
      actorId: ACTOR_ID,
      action: ACTION,
      targetType: 'user',
      targetId: userId,
    });
    return { userId };
  });
}

function refuse(problems: readonly string[], usage = false): never {
  for (const p of problems) console.error(`${NAME}: ${p}`);
  if (usage) console.error(USAGE);
  console.error(`${NAME}: nothing was changed.`);
  process.exit(2);
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ('problems' in parsed) refuse(parsed.problems, true);
  const { args } = parsed;
  const url = setting('DATABASE_URL_APP');
  if (url === '') refuse(['missing setting (environment or .env): DATABASE_URL_APP']);
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    refuse(['run it in a terminal: the password is typed when asked, never passed in']);
  }

  const entries = await readHiddenEntries(
    process.stdin,
    process.stdout,
    [
      `Password for ${args.email} (${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters, not shown): `,
      'Type it again: ',
    ],
    MAX_PASSWORD_LENGTH + 1,
  );
  if (entries === null) {
    console.error(`${NAME}: cancelled. Nothing was changed.`);
    return 130;
  }
  const problem = passwordProblem(entries[0]!, entries[1]!);
  if (problem !== null) {
    entries.length = 0;
    refuse([problem]);
  }
  const hash = await hashPassword(entries[0]!);
  entries.length = 0;

  const db = createDb(toHostAddress(url), { max: 1 });
  try {
    await setFirstPassword(db, args, hash);
    console.log(
      `Password set for ${args.email} in ${args.slug}. Sign in at https://grc.localhost; you'll set up two-factor sign-in first.`,
    );
    return 0;
  } catch (err) {
    if (err instanceof Refused) {
      console.error(`${NAME}: ${err.message}. Nothing was changed.`);
      return 2;
    }
    console.error(`${NAME}: failed: ${describeError(err)}`);
    return 1;
  } finally {
    await db.$client.end().catch(() => undefined);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(`${NAME}: failed: ${describeError(err)}`);
    process.exitCode = 1;
  }
}
