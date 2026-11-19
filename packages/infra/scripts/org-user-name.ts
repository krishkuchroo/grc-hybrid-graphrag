// `pnpm org:user-name --org <slug> --email <email> --name "<name>"` (FT-003; D49, D56, D57, D164,
// D170, D268, D270): the platform operator's command for one org member's display name, so the
// `company-x-fast` Admin shows as the name the user chose instead of "Dataset Admin".
// - Every value is an argument; there is no prompt. The name is trimmed, then must be 1 to 100
//   characters (counted as Unicode code points) with no control characters (D270): `org:create`
//   only refuses an empty `--admin-name`, so this rule is the fallback D270 names, which also
//   refuses an empty name.
// - In one grc_app transaction with app.org_id set to the org's (CLAUDE.md principle 4): checks the
//   org and that the email belongs to a member of it (any role), locks that user's row, sets
//   `user.name` (and `updated_at`), and appends one `auth.name_set` audit entry to the org's chain
//   through AuditService.appendInTx. The entry holds `{ oldName, newName }` and no email. The name
//   lives only in Postgres's `user` table: records keep user IDs, and the app reads names from it.
// - Re-run safe (principle 5): when the stored name already equals the new one, nothing is written,
//   no entry is appended, and it exits 0.
// - Refused with exit 2 and nothing changed (fail safe, principle 7): bad arguments, a missing
//   setting, no org with that slug, or an email that isn't a member of the org. Other failures exit
//   1 with the error's type and code only (describeError, D164).
// - Changes nothing else: no session, account, two-factor, member, role, clearance or org row, and
//   no Neo4j database.
// - Opens only the grc_app connection (max 1), through the dev relay on the Mac (D170). Settings:
//   DATABASE_URL_APP, from the environment, else `.env` (org-script-env.ts). Never printed (D57).
// - Output: one success line naming the email and the org; the names themselves are never printed.
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
interface AuditEntry {
  orgId: string;
  actorType: 'system';
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  meta: { oldName: string; newName: string };
}
interface AuditModule {
  AuditService: new (db: ScriptDb) => { appendInTx(tx: ScriptTx, e: AuditEntry): Promise<unknown> };
}

const { AuditService } = await load<AuditModule>('audit/audit.service.ts');
const { createDb } = await load<{ createDb(url: string, opts?: { max?: number }): ScriptDb }>('db/client.ts');
const { orgIdForSlug } = await load<{ orgIdForSlug(slug: string): string }>('identity/provision-org.ts');
const sql = await sqlTag();

export const NAME = 'org:user-name';
export const USAGE = `usage: pnpm ${NAME} --org <org-slug> --email <member email> --name "<name>"`;
export const ACTOR_ID = 'org-user-name';
export const ACTION = 'auth.name_set';

/** The longest display name, in Unicode code points (D270). */
export const MAX_NAME_LENGTH = 100;
/** Control characters (Unicode category Cc: C0, DEL and C1). */
const CONTROL = /\p{Cc}/u;

const FLAGS = ['--org', '--email', '--name'] as const;
type Flag = (typeof FLAGS)[number];

export interface Args {
  slug: string;
  /** Trimmed and lowercased, as provisionOrg stores it. */
  email: string;
  /** Trimmed. */
  name: string;
}

/** The rule a trimmed name breaks, or null when it is fine (D270). Gives the rule only. */
export function nameProblem(name: string): string | null {
  const length = [...name].length;
  if (length < 1 || length > MAX_NAME_LENGTH) return `--name must be 1 to ${MAX_NAME_LENGTH} characters`;
  if (CONTROL.test(name)) return '--name must not hold control characters';
  return null;
}

/**
 * The arguments, or the problems with them (one message each). Exactly --org, --email and --name,
 * each once, as `--flag value` or `--flag=value`. An argument that isn't a known flag or its value
 * is named by its position only, never by its text.
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
      problems.push(`argument ${i + 1} is unknown: only --org, --email and --name are accepted`);
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
  const name = values['--name']?.trim();
  if (name !== undefined && name !== '') {
    const problem = nameProblem(name);
    if (problem !== null) problems.push(problem);
  }
  if (problems.length > 0) return { problems };
  return { args: { slug: slug!, email: email!.trim().toLowerCase(), name: name! } };
}

/** A refusal: printed as it is, exit 2, nothing changed. */
export class Refused extends Error {
  override name = 'Refused';
}

/**
 * In one grc_app transaction with app.org_id set to the org's: checks the org and that the email
 * belongs to one of its members, then sets that user's name and appends `auth.name_set` to the
 * org's audit chain. Throws Refused (the transaction rolls back) when the org or member isn't
 * there. With the name already stored, writes nothing and returns `changed: false`.
 */
export async function setUserName(db: ScriptDb, args: Args): Promise<{ userId: string; changed: boolean }> {
  const orgId = orgIdForSlug(args.slug);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    const org = await tx.execute(sql`SELECT 1 FROM "organization" WHERE id = ${orgId}::uuid AND slug = ${args.slug}`);
    if (org.rows.length === 0) throw new Refused(`no org has the slug ${args.slug}`);

    // The member's user row, locked until the end of the transaction, so two runs at once for the
    // same person take turns and the second one reads the first one's name.
    const found = await tx.execute(
      sql`SELECT u.id, u.name FROM "user" u
          WHERE u.email = ${args.email}
            AND EXISTS (SELECT 1 FROM "member" m WHERE m.org_id = ${orgId}::uuid AND m.user_id = u.id)
          FOR UPDATE OF u`,
    );
    if (found.rows.length === 0) throw new Refused(`no member of ${args.slug} has that email`);
    const userId = String(found.rows[0]!['id']);
    const oldName = String(found.rows[0]!['name']);
    if (oldName === args.name) return { userId, changed: false };

    await tx.execute(sql`UPDATE "user" SET name = ${args.name}, updated_at = now() WHERE id = ${userId}`);
    await new AuditService(db).appendInTx(tx, {
      orgId,
      actorType: 'system',
      actorId: ACTOR_ID,
      action: ACTION,
      targetType: 'user',
      targetId: userId,
      meta: { oldName, newName: args.name },
    });
    return { userId, changed: true };
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

  const db = createDb(toHostAddress(url), { max: 1 });
  try {
    const { changed } = await setUserName(db, args);
    if (changed) console.log(`Name set for ${args.email} in ${args.slug}.`);
    else console.log(`${args.email} in ${args.slug} is already named that. Nothing was changed.`);
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
