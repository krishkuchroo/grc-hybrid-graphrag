// `pnpm org:create --name … --slug … --admin-email … --admin-name …` (M0-014, D133): the platform
// operator's command for creating an org and its first Admin. It calls provisionOrg and prints the
// new org ID. Arguments are checked before anything is created; running it again with the same
// slug is safe and prints the same ID. Settings: see org-script-env.ts.
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path.
type Env = typeof import('./org-script-env.js');
const { connect, describeError, missingSettings, provisioning } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;

const FLAGS = ['--name', '--slug', '--admin-email', '--admin-name'] as const;
type Flag = (typeof FLAGS)[number];

const USAGE = 'usage: pnpm org:create --name <org name> --slug <org-slug> --admin-email <email> --admin-name <name>';

function refuse(problems: string[]): never {
  for (const p of problems) console.error(`org:create: ${p}`);
  console.error(USAGE);
  process.exit(2);
}

function parse(argv: string[]): Record<Flag, string> {
  const values: Partial<Record<Flag, string>> = {};
  const problems: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    const eq = arg.indexOf('=');
    const flag = (eq > 0 ? arg.slice(0, eq) : arg) as Flag;
    if (!FLAGS.includes(flag)) {
      problems.push(`unknown argument ${JSON.stringify(arg)}`);
      continue;
    }
    if (eq > 0) {
      values[flag] = arg.slice(eq + 1);
    } else if (i + 1 < argv.length) {
      values[flag] = argv[++i]!;
    } else {
      values[flag] = '';
    }
  }
  for (const flag of FLAGS) {
    const value = values[flag];
    if (value === undefined) problems.push(`${flag} is missing`);
    else if (value.trim() === '') problems.push(`${flag} must not be empty`);
  }
  const slug = values['--slug'];
  if (slug && slug.trim() !== '' && !provisioning.SLUG.test(slug)) {
    problems.push('--slug must be lowercase letters and digits, joined by single hyphens (for example acme-corp)');
  }
  const email = values['--admin-email'];
  if (email && email.trim() !== '' && !provisioning.EMAIL.test(email)) {
    problems.push('--admin-email must look like name@example.com');
  }
  if (problems.length > 0) refuse(problems);
  return values as Record<Flag, string>;
}

const args = parse(process.argv.slice(2));
const missing = missingSettings();
if (missing.length > 0) {
  console.error(`org:create: missing settings (environment or .env): ${missing.join(', ')}`);
  process.exit(2);
}

const conn = await connect();
try {
  const { orgId } = await provisioning.provisionOrg(
    {
      name: args['--name'],
      slug: args['--slug'],
      admin: { email: args['--admin-email'], name: args['--admin-name'] },
    },
    conn.deps,
  );
  console.log(`Org ${args['--slug']} is ready. Org ID: ${orgId}`);
} catch (err) {
  console.error(`org:create: failed: ${describeError(err)}`);
  console.error('org:create: fix the cause and run the same command again; it finishes the missing steps.');
  process.exitCode = 1;
} finally {
  await conn.close();
}
