# Task Board

The planner keeps this board current (D85), and only the planner edits it (D95). Status: to do · in progress · in review · blocked · done.

| ID | Milestone | Owner | Status | Pass criteria & tests | Blocked notes | Task log |
|----|-----------|-------|--------|------------------------|---------------|----------|
| M0-001 | M0 | builder-platform | done | pnpm monorepo (api, web, shared, generators, benchmark, infra), strict TS, ESLint + Prettier (D130), root `lint` / `typecheck` / `test` scripts, Vitest per package that never picks up `.claude/**`. Tests: `pnpm --filter infra test -- workspace` | | `logs/tasks/M0-001.md` |
| M0-002 | M0 | builder-platform | done | Compose file with `grc-` names, 127.0.0.1-only ports, internal network for Postgres and SeaweedFS, dev switch (off by default) that opens Postgres on 5433 and SeaweedFS on 127.0.0.1 (D132), secrets setup script. Tests: `pnpm --filter infra test -- compose` | | `logs/tasks/M0-002.md` |
| M0-003 | M0 | builder-platform | done | Postgres 18.6 + pgvector 0.8.x wired through Drizzle, migration account vs restricted app account (no RLS bypass), per-transaction org context. Tests: `pnpm --filter api test -- db` | Earlier: security reviewer blocked (task/M0-003 at 1acd444). Everything else holds: grc_app and grc_migrator are NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE, grc_app has no CREATE anywhere, the migration URL never reaches the api or worker, passwords go through format(%L) and are stored as scram-sha-256, pgvector is trusted but grc_app can't install it (D142), and withOrgContext validates its inputs and uses set_config(..., true) with bound parameters. `db` 54/54 and `infra` 140/140 passed. **Issue (needs a user decision):** the dev-only `grc-dev` network (`packages/infra/compose.dev.yaml:21-26`, `enable_ip_masquerade: 'false'`; grc-postgres joins it at lines 10-12, grc-seaweedfs at 16-18) does not stop outgoing traffic on Docker Desktop 4.40.0 / Engine 28.0.4. With the dev switch on, grc-postgres's default route is via eth1 to 172.26.0.1 and a TCP connect to 1.1.1.1:443 succeeded. Docker Desktop's gvisor-tap-vsock opens the outbound connection itself, so the no-masquerade setting has no effect (D141(a), D62/D63). Evidence is the TCP connect and the route table; a full HTTP fetch was refused by the classifier. Test gap: the D141 block in `packages/infra/tests/compose/compose.test.ts` only checks the config, not behaviour. Scope: dev switch only (off by default); the builder followed D141(a) as written. **Question for the user:** with the dev switch on, Postgres and SeaweedFS can reach the internet. Is that acceptable for the dev-only switch, or should it be blocked another way (e.g. keep them internal-only and reach them through a small port-forwarding container, or a firewall rule)? Notes for later tasks: after a withOrgContext transaction, `current_setting('app.org_id', true)` returns '' (not NULL) on the pooled connection, so the RLS policies must treat '' as "no org" and fail closed; grc_app can CONNECT to the `postgres` database (PUBLIC default) but has no CREATE there. | `logs/tasks/M0-003.md` |
| M0-004 | M0 | builder-platform | done | Neo4j driver, `grc_admin` and `grc_writer` accounts, one database per org created on demand (idempotent). Tests: `pnpm --filter api test -- graph` |  | `logs/tasks/M0-004.md` |
| M0-005 | M0 | builder-platform | done | 28 read-only Neo4j accounts (role × clearance): read-only, time-limited, see only allowed types and labels, outbox hidden; our code refuses any AI-written graph query that names a database (D131). Tests: `pnpm --filter api test -- graph-accounts` | | `logs/tasks/M0-005.md` |
| M0-006 | M0 | builder-platform | done | SeaweedFS behind a small `FileStore` interface, one bucket per org, backend-only service key; tests on the Mac reach it through the dev switch (D132). Tests: `pnpm --filter api test -- storage` | Earlier: security reviewer blocked (task/M0-006 at 5d7ecad, 4 commits, 16 files; first review, 0 send-backs). The FileStore code meets the decisions it touches: D53 (`bucketForOrg` accepts only a lowercase UUID; `checkKey` refuses empty keys, leading `/`, `\`, `.`/`..` segments; anonymous S3 GET/list/PUT/bucket create refused, wrong secret or unknown key refused), D55/D59 (every ordered pair of 3 orgs, same key in two orgs, `../grc-org-<A>/` escape all pass), D57 (key only from `.env`, committed `packages/infra/seaweedfs/s3.json` has placeholders, `sed` fill is safe with base64url values, `storage.module.ts` refuses to start without the three variables), D61 (dev switch publishes only 127.0.0.1:8333 and 127.0.0.1:5433; suspected filer on 127.0.0.1:8888 was a false positive, an unrelated local Python process). `storage` 79/79 and `compose` 69/69 passed. **Issue (needs a user decision, same as M0-003):** the dev-only `grc-dev` network (`packages/infra/compose.dev.yaml:22-26`, `enable_ip_masquerade: 'false'`) does not stop outgoing traffic on Docker Desktop 4.40.0 / Engine 28.0.4. With the dev stack running, grc-seaweedfs's default route is via grc-dev (172.26.0.1), `wget` to 1.1.1.1 and example.com succeeded, and ifconfig.me returned a public IP; grc-postgres on the same network resolves outside names. Docker Desktop's VM networking NATs the traffic itself, so this breaks D141 ("outgoing traffic off") and D63 while the dev switch is on. Test gap: `packages/infra/tests/compose/compose.test.ts:391` only checks the option string. **Question for the user:** (a) accept internet access for Postgres and SeaweedFS while the dev-only switch is on, (b) block it another way (a small port-forwarder container on grc-internal plus a publish-only network, or a firewall drop rule), or (c) something else? After the choice, the test writer should add a live egress check. | `logs/tasks/M0-006.md` |
| M0-007 | M0 | builder-platform | done | One NestJS/Fastify codebase, two programs (API, worker); `/api/v1`, health, OpenAPI from Zod, one error format with reference ID, paging helper, pino, security headers, 1 MB cap, 300/min limit, pg-boss with 3 retries. Tests: `pnpm --filter api test -- platform` | | `logs/tasks/M0-007.md` |
| M0-008 | M0 | builder-platform | done | D50 role table and D51 labels as shared data + checks; every table cell and every clearance × label pair tested; NestJS guard. Tests: `pnpm --filter shared test -- access` and `pnpm --filter api test -- access-guard` | | `logs/tasks/M0-008.md` |
| M0-009 | M0 | builder-platform | done | Identity and grant tables (Better Auth schema + role/clearance + auditor grants, parent links, break-glass sessions), RLS with FORCE on every org table; every org pair isolated; no org context = no rows. Tests: `pnpm --filter api test -- org-wall` | | `logs/tasks/M0-009.md` |
| M0-010 | M0 | builder-platform | done | Better Auth login: 12-char passwords, MFA required for everyone, 30 min idle / 12 h max, 5 fails = 15 min lock, every attempt audited, `/api/v1/me`. Tests: `pnpm --filter api test -- auth` |  | `logs/tasks/M0-010.md` |
| M0-011 | M0 | builder-platform | done | Machine API keys: one org + one role, expiry, revocable, shown once, stored hashed, audited. Tests: `pnpm --filter api test -- api-keys` |  | `logs/tasks/M0-011.md` |
| M0-012 | M0 | builder-platform | done | Postgres audit trail: per-org sequence and hash chain, add-only for the app account, nightly chain check. Tests: `pnpm --filter api test -- audit` | | logs/tasks/M0-012.md |
| M0-013 | M0 | builder-platform | done | Neo4j audit outbox: change + audit entry in one transaction; the worker copies to Postgres within 5 s, exactly once, even after a crash. Tests: `pnpm --filter api test -- outbox` | | logs/tasks/M0-013.md |
| M0-014 | M0 | builder-platform | done | Org provisioning (Postgres org + audit partition + Neo4j database + bucket + first Admin) through a command-line setup command run by the platform operator (D133), safe to re-run; demo seed of 2 orgs with one user per role. Tests: `pnpm --filter api test -- provision` | | `logs/tasks/M0-014.md` |
| M0-015 | M0 | builder-frontend | done | Web shell: Vite + React + shadcn + TanStack Router/Query, typed client from OpenAPI, sign-in, MFA setup and check, sign-out, idle and lock messages, header with org/user/role. Tests: `pnpm --filter web test -- auth` | | `logs/tasks/M0-015.md` |
| M0-016 | M0 | builder-platform | done | Caddy at `https://grc.localhost`: local HTTPS, 80→443, web app + `/api/v1` proxy, headers, 25 MB cap; Playwright sign-in with MFA through the front door; written demo steps. Tests: `pnpm --filter infra test -- front-door` and `pnpm --filter web playwright test e2e/sign-in` | **Latest (builder-platform, blocked on a worktree `.env` with the sign-in secrets):** The D166 code change is finished and committed on task/M0-016 as 63d7c02 (worktree detached). The certificate is no longer the problem. Code change: tsx pinned at 4.23.15 in packages/api dependencies (already in the lockfile); `start:api` is `tsx src/main.api.ts` and `start:worker` is `tsx src/main.worker.ts`; `packages/api/src/ts-resolve.ts` deleted (nothing else used it); the grc-app image installs tsx through its existing `pnpm install --frozen-lockfile`. Results: grc-app:local rebuilt from the worktree; grc-api and grc-worker recreated in compose project `grc` with `--no-deps`, no other containers touched; start command still `pnpm --filter @grc/api start:api` (and start:worker). Both containers start and Nest boots; through https://grc.localhost, /api/v1/health returns `{"status":"ok","postgres":"up","neo4j":"up"}` and the OpenAPI address returns 401 as expected. `pnpm --filter infra test -- front-door` 71/71; lint (eslint, prettier) and typecheck clean. `pnpm audit --prod`: 1 moderate, GHSA-67mh-4wv8-2f99 (esbuild <=0.24.2 via better-auth > drizzle-kit > @esbuild-kit; not from tsx, which uses esbuild 0.28.2). Certificate trust in place: System keychain has "Caddy Local Authority - 2026 ECC Root" (SHA-256 47EA0156…5F1D), matching logs/caddy-root.crt; curl verifies https://grc.localhost with no exceptions. **What blocks it:** the builder passed the main checkout's `.env` to compose, which has no BETTER_AUTH_SECRET and no DEMO_USER_PASSWORD (the earlier builder used wf_4417b0d5-4c5-4/.env, the main `.env` plus those two keys). The recreated grc-api has an empty BETTER_AUTH_SECRET and fails safe: createAuth throws, so POST /api/v1/auth/sign-in/email returns 500 with a reference ID; no fallback secret. Copying that worktree's `.env` was refused by the auto-mode permission check as credential exploration, and the builder did not look for another way round. `pnpm setup:secrets` was not run (it would make new secrets that don't match the seeded demo users or the running databases). Playwright e2e/sign-in: 2 passed, 2 failed (certificate and http→https redirect pass; Acme and Globex sign-in fail in the test helper with "DEMO_USER_PASSWORD is not set", and sign-in would return 500 anyway until the secret is set). No test pins the old start command; tests only check for main.api and main.worker. **To unblock:** the user (or someone with permission) gives this worktree a `.env` holding BETTER_AUTH_SECRET and DEMO_USER_PASSWORD (for example the one from wf_4417b0d5-4c5-4), then runs (1) `docker compose -f packages/infra/compose.yaml --env-file .env up -d --no-deps --no-build --force-recreate grc-api grc-worker` and (2) `pnpm --filter web playwright test e2e/sign-in`. **Earlier (builder-platform, blocked on the user's D65 setup step):** The code isn't the problem. The Mac doesn't trust Caddy's current local root certificate yet. No code changes and no commit; task/M0-016 still at 1cbb4b2, worktree detached. The running stack (grc-api, grc-worker, grc-caddy under compose project `grc`) matches the branch (compose.yaml, packages/api/src, packages/web/src, Caddyfile, web Dockerfile identical), so nothing was restarted. The worktree `.env` is a git-ignored copy of the one the running API was started with (same BETTER_AUTH_SECRET and DEMO_USER_PASSWORD; no values printed). Database migrated (6/6 in drizzle.__drizzle_migrations). `pnpm seed:demo` ran and printed the Acme and Globex login lists; its first try failed with ENOTFOUND because DATABASE_URL_* in `.env` points at grc-postgres:5432, so it was re-run through a scratchpad wrapper that changes only the host to 127.0.0.1:5433 (dev relay) for that run. Results: `pnpm --filter infra test -- front-door` 71 passed, 0 failed (8 files); `pnpm --filter web playwright test e2e/sign-in` 0 passed, 4 failed, all at page.goto with net::ERR_CERT_AUTHORITY_INVALID for https://grc.localhost. Running Caddy root: "Caddy Local Authority - 2026 ECC Root", SHA-256 47:EA:01:56:…:5F:1D, created Sep 28 02:15 UTC (when grc-caddy was recreated, so any root trusted earlier no longer matches); no "Caddy Local Authority" certificate or trust settings in the System or login keychain; hosts line `127.0.0.1 grc.localhost` present. Diagnostic only, not a pass: the same spec with a scratchpad config setting ignoreHTTPSErrors: true passed 4/4 (HTTPS serve, 80→443 redirect, Acme sign-in with MFA set-up and sign-out, Globex user sees only their own org). `pnpm lint` and `pnpm typecheck` clean. **What unblocks it:** the user trusts Caddy's current root (`/data/caddy/pki/authorities/local/root.crt` inside grc-caddy, fingerprint above) in the macOS System keychain (sudo; D65 makes it the user's step), then re-runs `pnpm --filter web playwright test e2e/sign-in`; that is all that's left for criterion 6. **Note for the main `.env`:** besides BETTER_AUTH_SECRET and DEMO_USER_PASSWORD after the merge, host-side scripts like seed:demo need 127.0.0.1:5433 URLs, not the container host grc-postgres. Q45 (ts-resolve.ts) not touched. **Earlier (test-writer, blocked only by the finish check):** The builder was right; the test is fixed at 1cbb4b2 on task/M0-016 (HEAD detached so the builder can take the branch). Guard rail 4 (D97) refused the test writer's `done` because the tests "should fail until the code exists (red)", but this send-back came after the builder's code (d9d02b1), so the corrected test is meant to pass; the test writer won't fake a red. **Whoever runs the workflow should move the task back to the builder, or on to review.** Old test in `packages/infra/tests/front-door/api-proxy.test.ts` expected 200 for `GET /api/v1/openapi.json` with no session, which contradicts merged M0-010 (`packages/api/tests/auth/mfa.test.ts`: 401 with no session, 403 `mfa_required` without MFA) and isn't in the M0-016 brief (criterion 3 only asks that `/api/v1` is forwarded to grc-api). New test "GET /api/v1/openapi.json without a session reaches the API and gets its 401 in the error format" checks: status 401; body is the API error format with `code` and `referenceId`; no OpenAPI document in the body; the API's own log shows the `/api/v1/openapi.json` request (proves Caddy forwarded it). Against the builder's running stack `pnpm --filter infra test -- front-door` passes 71/71; ESLint and Prettier clean. Open items: (1) builder's `packages/api/src/ts-resolve.ts` (instead of tsx or a build step) needs a reviewer or user decision; (2) main `.env` still lacks `BETTER_AUTH_SECRET` and `DEMO_USER_PASSWORD` (user runs `pnpm setup:secrets`); (3) builder ran `drizzle-kit migrate` on the shared dev `grc` database; (4) Playwright `e2e/sign-in` not run yet (needs `pnpm seed:demo`). **Earlier (builder-platform, 2026-09-28T03:33Z, sent back to the test writer):** D165 wiring done at d9d02b1 on task/M0-016 (detached): `.env.example` lists `BETTER_AUTH_SECRET=` so setup:secrets fills it; grc-api and grc-worker get `HOST: 0.0.0.0` and `BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}` via the app-env anchor, no ports; `start:api`/`start:worker` run `node --experimental-transform-types --import ./src/ts-resolve.ts src/main.{api,worker}.ts`; new `packages/api/src/ts-resolve.ts` maps `./x.js` imports to `./x.ts` (no new dependency; **builder asks the user to confirm this over tsx or a build step**). wiring 21/21, front-door 70/71, infra 243/244, lint and typecheck clean. Dev stack changes: a git-ignored worktree `.env` (main `.env` still lacks `BETTER_AUTH_SECRET` and `DEMO_USER_PASSWORD`; the user needs to run `pnpm setup:secrets` there), `drizzle-kit migrate` run as grc_migrator on the dev `grc` database via 127.0.0.1:5433, grc-app:local built and grc-api/grc-worker started with `--no-deps`. Playwright `e2e/sign-in` not run (needs `pnpm seed:demo`). **Red test looks wrong:** `packages/infra/tests/front-door/api-proxy.test.ts` "the API's OpenAPI document is reachable through the door" expects 200 for `GET /api/v1/openapi.json` with no session, but the API returns 401, which the merged M0-010 tests require (`packages/api/tests/auth/mfa.test.ts` 60-70: 401 with no session; 116-121: 403 `mfa_required` without MFA). Suggested fix: sign in with MFA first, or expect the API's 401 error format (still proves the request went through Caddy). **Earlier:** Builder blocked (task/M0-016 at f72f41d; worktree detached). The front door is built: 39 of 50 front-door tests pass with grc-caddy running (80→443 with 308, `tls internal` cert trusted by its root only, web app at `/` with `index.html` fallback, D64 headers once on web answers and on the door's own 413, uploads over 25 MB get a D47-format 413 at the door before proxying, `docs/demo/m0.md` 8/8). `packages/web/Dockerfile` is two stages (`vite build`, then `caddy:2.11.4-alpine` with Caddyfile and `dist`); in `compose.yaml` only grc-caddy changed (builds `grc-caddy:local`); compose tests 104/104; `/api/v1` and `/api/v1/*` go to `grc-api:3000` and the door doesn't add a second copy of the API's headers; CSP `script-src 'self'`, `object-src 'none'`, `style-src 'unsafe-inline'` (Radix style tags); Playwright has one worker, chromium, no certificate exceptions; lint and typecheck clean; grc-caddy was started alone (`up -d --no-deps grc-caddy`) and is still running. **Blocking:** the other 11 tests (4 api-proxy, 5 body-size, the API 413 headers test, the unknown `/api/v1` 404 test) need a running grc-api, which can't start in its container for three reasons outside the brief's "grc-caddy service only": (1) the compose command `pnpm --filter @grc/api start:api` (and `start:worker`) has no matching script in `packages/api/package.json`; (2) `main.api.ts` listens on `process.env.HOST \|\| '127.0.0.1'` and compose doesn't set `HOST=0.0.0.0` for grc-api, so Caddy can't reach it; (3) the API needs `BETTER_AUTH_SECRET` (`identity/auth.ts`), which isn't in compose, `.env.example` or `.env`. The Playwright run (criterion 6) also needs `DEMO_USER_PASSWORD` in `.env` (missing), a migrated database, `pnpm seed:demo`, and a working Neo4j login (D140 reset). **Question for the user:** may M0-016 (or a new task) add the `start:api`/`start:worker` scripts, set `HOST: 0.0.0.0` and `BETTER_AUTH_SECRET` on grc-api/grc-worker in `compose.yaml`, and have `setup:secrets` fill `BETTER_AUTH_SECRET`? Or should another task own this? The builder expects no further door changes once the API runs behind Caddy, but couldn't confirm. | `logs/tasks/M0-016.md` |
| TEST-001 | TEST | builder-platform | to do | Every test file in packages/* renamed by what it needs (`.unit` / `.db` / `.stack` `.test.ts`, `e2e/*.e2e.ts`) with `git mv`; `test:unit` / `test:db` / `test:stack` per package and at the root, `test:e2e` at the root, `test` = unit + db + stack; db and stack runs call `pnpm test:env` first and stop if it fails; a check fails on any test file with no type; `retries: 0` in Vitest and Playwright (D177, D171). Merges last. Tests: `pnpm --filter infra test -- test-names` | | |
| TEST-002 | TEST | builder-platform | to do | `pnpm test:env` doctor: one OK/missing line per item (stack and dev relay, migrations, 28 grc_ro_* DENYs, `.env` key names, Caddy root trusted, hosts line), non-zero exit if anything's missing, changes nothing (D180); `seed:demo`, `org:create` and their env loader swap the container host for 127.0.0.1:5433 themselves (D170). Tests: `pnpm --filter infra test -- test-env` and `pnpm --filter infra test -- org-script-env` | | |
| TEST-003 | TEST | builder-platform | to do | `packages/shared/src/access/security-matrix.ts` lists every record type and every `/api/v1` route with its role rule, org wall and label rule; a unit test fails if the code has a record type or route not in the matrix, or the matrix lists one the code doesn't have (D175, D59, D50, D51). Tests: `pnpm --filter api test -- security-matrix` | | |

**Moved out of M0 (planned with slice 7, no task yet):**
- SSO (OIDC/SAML) is planned for S7, with the Admin screens. Its tests will use a small stand-in sign-in provider that runs locally (D134).
- Nightly backups and the monthly restore test are planned for S7, with the admin tools (D135).

## Briefs

### M0 shared notes (every M0 brief includes these)
- **Layout (D46, CLAUDE.md hand-off example):** `packages/api` (the one NestJS codebase: API + worker), `packages/web`, `packages/shared`, `packages/generators`, `packages/benchmark`, `packages/infra` (Compose, Caddy, setup scripts).
- **Tests belong to the test writer (D89, D96).** Tests live in `packages/<pkg>/tests/**` or as `*.test.ts(x)`; end-to-end tests in `packages/web/e2e/`; test data in `tests/fixtures/`. Builders never edit them.
- **Throwaway test databases (D82):** each test run creates its own Postgres database and its own Neo4j databases, named with a `test-` prefix plus a random suffix, and drops them at the end. Tests on the Mac reach Postgres at `127.0.0.1:5433` through the dev switch (D61), and Neo4j Desktop at `bolt://127.0.0.1:7687`.
- **Before tests that need the running stack:** the Neo4j Desktop DBMS is running (settings from D125 applied), `grc-postgres` is up, and the user has stopped other projects' containers (D35). Never touch `orion-neo4j` or `sentry-neo4j` (D98, D106).
- **One test process per agent (D82).** No real Gemma or bge-m3 anywhere in M0.
- **Names used across tasks** (keep them exactly):
  - Roles: `admin`, `risk_manager`, `compliance_manager`, `control_owner`, `auditor`, `analyst`, `viewer`.
  - Labels / clearances, low to high: `public`, `internal`, `confidential`, `restricted`.
  - Neo4j org database: `org-<orgId>` (orgId is a lowercase UUID). Storage bucket: `grc-org-<orgId>`.
  - Postgres session settings for RLS: `app.org_id`, `app.user_id`, `app.role`, `app.clearance`.

---

Task: M0-001

**Goal:** Create the pnpm workspaces monorepo that every later task builds in.

**Decisions:** D6, D33, D36, D46, D78 (lint and type checks clean), D82 (one test process), D97 (finish checks use root `lint`, `typecheck`, `test`), D130 (lint and format tool: ESLint + Prettier), memory.md setup item "keep Vitest away from the hook tests".

**Files:**
- Create: `package.json` (root, private, `"packageManager": "pnpm@11.1.3"`, `"engines": {"node": ">=24"}`), `pnpm-workspace.yaml` (`packages/*`), `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, ES2024, NodeNext), `eslint.config.js` (ESLint flat config with TypeScript support, D130), `.prettierrc` and `.prettierignore` (Prettier, D130), `.nvmrc` (`24`), `.env.example`.
- Create for each of `api`, `web`, `shared`, `generators`, `benchmark`, `infra`: `packages/<pkg>/package.json` (name `@grc/<pkg>`, scripts `test`, `typecheck`, `lint`), `packages/<pkg>/tsconfig.json`, `packages/<pkg>/vitest.config.ts`, `packages/<pkg>/src/index.ts`.
- Modify: `.gitignore` only if a new build-output path appears.

**Pass criteria:**
1. `pnpm install` succeeds from a clean clone.
2. Root scripts: `lint` (ESLint plus a Prettier check, D130, over the whole repo, excluding `.claude/**`, `logs/**`, `dist/**`), `typecheck` (`pnpm -r typecheck`), `test` (`pnpm -r test`). Each exits 0 on the empty packages.
3. The root has no Vitest config, and no package's Vitest config includes anything under `.claude/`. `node --test '.claude/hooks/__tests__/*.test.mjs'` still passes.
4. `pnpm --filter <pkg> test -- <name>` runs only the matching test files in that package, as one process (`pool: 'forks'`, `singleFork: true`, or the equivalent).
5. `packages/shared` can be imported from `api` and `web` as `@grc/shared`.

**Tests to write (test writer):** `packages/infra/tests/workspace.test.ts`. It checks that the six packages exist with the right names and scripts, that the root scripts exist, that the TS base config has `strict: true`, that an ESLint config and a Prettier config exist at the root and the root `lint` script runs both (D130), that no Vitest config includes `.claude`, and that `@grc/shared` resolves from `packages/api`.

**Test command:** `pnpm --filter infra test -- workspace`

---

Task: M0-002

**Goal:** Write the Docker Compose stack and the secrets setup script.

**Decisions:** D5, D13, D21, D28, D35, D57 (secrets in the git-ignored `.env`, generated by a setup script), D60, D61, D63, D82 (4 GB Docker), D98, D106, D132 (the dev switch also opens SeaweedFS on 127.0.0.1, off by default).

**Files:**
- Create: `packages/infra/compose.yaml`, `packages/infra/compose.dev.yaml` (the dev switch), `packages/infra/scripts/setup-secrets.ts`, `packages/api/Dockerfile` (one image; the API and worker differ only in their start command).
- Modify: `.env.example` (every variable name, no values), `package.json` (root script `setup:secrets`).

**Pass criteria:**
1. Project name `grc`. Services `grc-postgres` (`pgvector/pgvector:pg18`), `grc-seaweedfs`, `grc-caddy`, `grc-api`, `grc-worker`. Every `container_name`, volume and network starts with `grc-` or `grc_`.
2. Networks: `grc-internal` (`internal: true`), which holds Postgres, SeaweedFS, API and worker; `grc-edge`, which holds Caddy, API and worker. Postgres and SeaweedFS are on no other network (D63).
3. Only `grc-caddy` publishes ports: `127.0.0.1:443:443` and `127.0.0.1:80:80`. API, worker, Postgres and SeaweedFS publish none (D61).
4. `compose.dev.yaml` is the dev switch (off by default: used only when named with `-f`). It adds only two things: `127.0.0.1:5433:5432` to `grc-postgres` (D61), and SeaweedFS's S3 port on `127.0.0.1` to `grc-seaweedfs` (D132; `127.0.0.1:8333:8333`, SeaweedFS's standard S3 port). Both bind to 127.0.0.1 only. Without the switch, neither is published.
5. API and worker have `extra_hosts: ["host.docker.internal:host-gateway"]` and get Neo4j and Ollama addresses via `host.docker.internal` (D5).
6. Memory limits keep the stack's total under 4 GB (D82).
7. `pnpm setup:secrets` writes `.env` with random values for every secret listed in `.env.example`. It never overwrites an existing value, never prints secrets, and sets file mode 600. The one exception is `NEO4J_DESKTOP_PASSWORD`, which the user supplies (see the M0 questions). The script leaves it empty and says so.
8. `docker compose -f packages/infra/compose.yaml config` validates.

**Tests to write:** `packages/infra/tests/compose.test.ts` parses the YAML and checks criteria 1–6, including that `compose.dev.yaml` publishes exactly the two 127.0.0.1 ports in criterion 4 and nothing else (D132). `packages/infra/tests/setup-secrets.test.ts` runs the script in a temp folder and checks criterion 7, including a second run that keeps the existing values.

**Test command:** `pnpm --filter infra test -- compose`

---

Task: M0-003

**Goal:** Wire Postgres through Drizzle with the two accounts and the per-request org context that RLS relies on.

**Decisions:** D13, D29, D33, D57 (restricted app account + separate migration account, never used at runtime), D71 (pgvector), D73 (FORCE RLS; app connects as the restricted account), D82.

**Files:**
- Create: `packages/api/src/db/db.module.ts`, `packages/api/src/db/client.ts`, `packages/api/src/db/org-context.ts`, `packages/api/drizzle.config.ts`, `packages/api/src/db/migrations/0000_roles_and_extensions.sql`, `packages/infra/postgres/init/01-roles.sql`.

**Interfaces (produces):**
- `createDb(url: string): Db`
- `withOrgContext<T>(db: Db, ctx: { orgId: string; userId: string; role: Role; clearance: Label }, fn: (tx) => Promise<T>): Promise<T>`. It runs `fn` in one transaction after `SET LOCAL app.org_id`, `app.user_id`, `app.role` and `app.clearance`.
- Env vars: `DATABASE_URL_APP` (role `grc_app`), `DATABASE_URL_MIGRATE` (role `grc_migrator`).

**Pass criteria:**
1. `grc_migrator` owns every table. `grc_app` can log in, is `NOSUPERUSER` and `NOBYPASSRLS`, owns nothing, and has only the grants each migration gives it.
2. Migrations run with `grc_migrator` only, and running them twice changes nothing.
3. The `vector` extension is installed at 0.8.x, and `SHOW server_version` starts with `18.`.
4. Inside `withOrgContext`, `current_setting('app.org_id')` equals the given org. After the transaction, the setting is gone (it doesn't leak into the next pooled use).
5. Invalid input to `withOrgContext` (a non-UUID org ID, an unknown role or label) throws before any SQL runs.

**Tests to write:** `packages/api/tests/db/*.test.ts` against a throwaway database: criteria 1–5, including two back-to-back `withOrgContext` calls on a one-connection pool that check the settings don't carry over.

**Test command:** `pnpm --filter api test -- db`

---

Task: M0-004

**Goal:** Wire the Neo4j driver and create one database per org, on demand.

**Decisions:** D14, D22, D45.2 (graph access behind a small interface), D57 (the admin account only creates databases), D73 (one writer account, one admin account), D125.

**Before running:** the user adds `NEO4J_DESKTOP_PASSWORD` (the Neo4j Desktop `neo4j` account's password) to `.env` themselves before this task runs (Q7). `pnpm setup:secrets` leaves it empty. If it's still empty, hand off `blocked` saying so; never guess or reset the password.

**Files:**
- Create: `packages/api/src/graph/graph.module.ts`, `packages/api/src/graph/graph.service.ts`, `packages/api/src/graph/org-database.ts`, `packages/infra/scripts/setup-neo4j.ts` (root script `setup:neo4j`).

**Interfaces (produces):**
- `orgDatabaseName(orgId: string): string` returns `org-<orgId>`. It throws for anything that isn't a lowercase UUID.
- `GraphService.createOrgDatabase(orgId): Promise<void>` (admin account; does nothing if the database exists and is online).
- `GraphService.write<T>(orgId, fn: (tx) => Promise<T>): Promise<T>` (writer account, one transaction, in `org-<orgId>` only).
- `GraphService.read<T>(orgId, fn): Promise<T>` (writer account, read transaction; the per-role accounts arrive in M0-005).
- Env vars: `NEO4J_URI` (default `bolt://127.0.0.1:7687`; containers use `bolt://host.docker.internal:7687`), `NEO4J_ADMIN_PASSWORD`, `NEO4J_WRITER_PASSWORD`, `NEO4J_DESKTOP_PASSWORD` (used only by `setup:neo4j`).

**Pass criteria:**
1. `pnpm setup:neo4j` uses the Desktop `neo4j` account once to create `grc_admin` (may create databases, nothing else) and `grc_writer` (read and write on `org-*` databases only, no admin rights). Running it twice changes nothing.
2. `createOrgDatabase` makes `org-<orgId>` and waits until it's online. Calling it twice, or twice at the same time, ends with one online database and no error.
3. `write(orgA, …)` can't create or read nodes in `org-<orgB>`.
4. `grc_writer` can't run `CREATE DATABASE`, `DROP DATABASE`, or user and role management.
5. A bad org ID throws before any query runs.

**Tests to write:** `packages/api/tests/graph/*.test.ts` against throwaway `test-…` orgs, cleaned up afterwards: criteria 1–5, including the parallel `createOrgDatabase` race.

**Test command:** `pnpm --filter api test -- graph`

---

Task: M0-005

**Goal:** Create the 28 read-only Neo4j accounts (7 roles × 4 clearances) that AI graph queries run as.

**Decisions:** D15, D22, D23, D50, D51 (a link is visible only if both ends are), D52.2, D57, D73 (28 read-only accounts; the audit outbox is hidden from query accounts), D131 (our code refuses any AI-written graph query that names a database; the 28 shared read-only accounts stay).

**Why D131:** a Neo4j query can name a different database inside its own text (for example `USE org-<other>` or a `db.`-qualified call). The 28 accounts are shared by every org, so the database privileges alone don't stop an AI-written query reaching another org's database. Our code checks the query text before it runs and refuses it.

**Files:**
- Create: `packages/api/src/graph/query-accounts.ts`, `packages/api/src/graph/privileges.ts` (built from `ROLE_TABLE` in `@grc/shared`, M0-008), `packages/api/src/graph/query-guard.ts` (D131).
- Modify: `packages/infra/scripts/setup-neo4j.ts` (adds the 28 accounts and their privileges, safe to re-run).

**Interfaces (produces):**
- `queryAccountName(role: Role, clearance: Label): string` returns `grc_ro_<role>_<clearance>`.
- `GraphService.readAs<T>(orgId, role, clearance, fn, { timeoutMs }): Promise<T>`: a read-only session in `org-<orgId>` as that account, with a transaction timeout.
- `assertNoDatabaseReference(cypher: string): void` (D131): throws a `GraphQueryRefused` error, before anything is sent to Neo4j, when the query text names a database in any form (a `USE` clause, a composite or database-qualified name, or a call that targets another database). S6's chat Path B runs every AI-written query through it before `readAs`.

**Pass criteria:**
1. 28 accounts exist, each with read-only privileges.
2. Every write (`CREATE`, `MERGE`, `SET`, `DELETE`) fails for every account.
3. A node type the role can't view (D50 row `—`) is invisible to that role's accounts, for example `Incident` for `control_owner` and `viewer`.
4. A node whose `sensitivity` is above the account's clearance is invisible, and so is every relationship that touches it.
5. `AuditOutbox` nodes are invisible to all 28 accounts.
6. A query that runs past `timeoutMs` is stopped.
7. D131: `assertNoDatabaseReference` refuses every query that names a database (`USE org-B`, `USE` in any letter case or spacing, a `USE` inside a subquery, a backtick-quoted database name), and lets through ordinary read queries that don't. A refused query never reaches Neo4j, so a query meant for `org-A` that names `org-B` gets nothing from `org-B`.

**Tests to write:** `packages/api/tests/graph-accounts/*.test.ts`: criteria 1–7, looping over all 28 accounts, with fixture nodes of every type and every label in two throwaway org databases. For criterion 7 (D131), a table of refused and allowed query texts, plus a check that a refused query sends nothing to Neo4j.

**Test command:** `pnpm --filter api test -- graph-accounts`

---

Task: M0-006

**Goal:** Wire SeaweedFS behind a small file-store interface, with one bucket per org.

**Decisions:** D21, D45.2, D53 (a bucket per org; downloads only through the API), D57 (one backend-only service key), D63, D132 (the dev-only switch that opens Postgres on 5433 also opens SeaweedFS on 127.0.0.1; off by default).

**How tests reach storage (D132):** tests on the Mac reach SeaweedFS's S3 API at `http://127.0.0.1:8333`, published only by the dev switch `packages/infra/compose.dev.yaml` (M0-002). Without the switch, SeaweedFS publishes no port (D61). The endpoint comes from an env var (`S3_ENDPOINT`), so the containers keep using the internal address.

**Files:**
- Create: `packages/api/src/storage/file-store.ts` (interface), `packages/api/src/storage/seaweed-file-store.ts`, `packages/api/src/storage/storage.module.ts`, `packages/infra/seaweedfs/s3.json` (the service key's identity config, filled from `.env`).

**Interfaces (produces):**
- `interface FileStore { ensureBucket(orgId): Promise<void>; put(orgId, key, body: Buffer, contentType): Promise<void>; get(orgId, key): Promise<Buffer>; exists(orgId, key): Promise<boolean> }`
- The bucket is `grc-org-<orgId>`.

**Pass criteria:**
1. `ensureBucket` is safe to run twice.
2. `put`/`get`/`exists` round-trip bytes exactly.
3. An object put for org A can't be read through org B's calls.
4. Requests without the service key are refused. Anonymous access is off.
5. A bad org ID throws before any request.

**Tests to write:** `packages/api/tests/storage/*.test.ts` for criteria 1–5, run against `127.0.0.1:8333` with the dev switch on (D132).

**Test command:** `pnpm --filter api test -- storage`

---

Task: M0-007

**Goal:** Build the NestJS on Fastify skeleton that runs as two programs (API and worker), with the API conventions and the base protections.

**Decisions:** D28, D29, D30, D36, D45, D46, D47, D64 (300 requests/min per person, 1 MB cap, security headers, "try again in N s"), D72 (3 retries with growing waits, then the failed-jobs list).

**Files:**
- Create: `packages/api/src/main.api.ts`, `packages/api/src/main.worker.ts`, `packages/api/src/app.module.ts`, `packages/api/src/worker.module.ts`, `packages/api/src/common/errors.ts`, `packages/api/src/common/paging.ts`, `packages/api/src/common/openapi.ts`, `packages/api/src/common/rate-limit.ts`, `packages/api/src/common/security-headers.ts`, `packages/api/src/health/health.controller.ts`, `packages/api/src/jobs/jobs.module.ts`.
- Modules as empty folders with a module file: `identity`, `access`, `audit`, `records`, `frameworks`, `intake`, `processing`, `review`, `search`, `chat`, `ai` (D46).

**Interfaces (produces):**
- Error body: `{ "error": { "code": string, "message": string, "referenceId": string } }` for every error, including 404, validation and unexpected errors. `referenceId` also appears in the pino log line.
- `Paged<T> = { items: T[]; page: number; pageSize: number; total: number }`, plus `pageQuerySchema` (Zod: `page` ≥ 1, `pageSize` 1–100, default 25, `sort`).
- `GET /api/v1/health` returns `{ status, postgres, neo4j }`. `GET /api/v1/openapi.json` is generated from the Zod schemas.
- `JobsService.send(queue, data, { singletonKey })` with the D72 retry defaults.

**Pass criteria:**
1. Every route is under `/api/v1`. Anything else returns 404 in the error format.
2. Unexpected errors return 500 in the error format, with no stack trace in the body.
3. Bodies over 1 MB get 413 in the error format.
4. Request number 301 within one minute from one person (session user, else client IP) gets 429 with `Retry-After` and "try again in N s".
5. Every response carries `X-Frame-Options: DENY`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` and a strict `Content-Security-Policy`.
6. The OpenAPI document lists the health route with its Zod-derived schema.
7. The worker program starts pg-boss and the API program doesn't process jobs. A job that throws is retried 3 times with growing waits, then lands in the failed state. Sending the same `singletonKey` twice queues one job.

**Tests to write:** `packages/api/tests/platform/*.test.ts` using Nest's testing module with Fastify `inject`, plus a pg-boss test against a throwaway database.

**Test command:** `pnpm --filter api test -- platform`

---

Task: M0-008

**Goal:** Encode the role table (D50) and labels (D51) once, in `@grc/shared`, and enforce them in the API with a guard.

**Decisions:** D10, D17, D23, D50, D51, D59 (a test for every cell and every clearance × label pair).

**Files:**
- Create: `packages/shared/src/access/roles.ts`, `packages/shared/src/access/labels.ts`, `packages/shared/src/access/role-table.ts`, `packages/shared/src/access/index.ts`, `packages/api/src/access/access.guard.ts`, `packages/api/src/access/requires.decorator.ts`.

**Interfaces (produces):**
- `ROLES`, `LABELS` (ordered low to high), `type Role`, `type Label`.
- `RECORD_TYPES = ['asset','risk','control','policy','incident','framework_mapping','evidence','audit_finding']` and `FUNCTIONS = ['uploads','review_queue','audit_trail','admin','chat']`.
- `ROLE_TABLE`: exactly the D50 table. Cell values: `edit`, `view`, `edit_own`, `upload_own`, `approve`, `work`, `yes`, `evidence_only`, `none`.
- `can(role, subject, action: 'view'|'edit'|'approve'|'work'|'upload'|'use', ctx?: { isOwner?: boolean; recordType?: string }): boolean`. `edit_own` and `upload_own` need `ctx.isOwner`.
- `isVisible(clearance: Label, label: Label): boolean`, `isLinkVisible(viewer, from, to): boolean` (both ends visible by type and by label).
- `defaultLabel(recordType, attrs?: { dataClassification?: Label }): Label` (assets take their data classification, incidents and evidence are `confidential`, all else `internal`).
- `canChangeLabel(role, from: Label, to: Label): boolean` (editors may raise, only `admin` may lower).
- `@Requires(subject, action)` + `AccessGuard`: 403 in the M0-007 error format when refused.

**Pass criteria:**
1. Every one of the 13 × 7 = 91 D50 cells gives the expected answer for every action, including `edit_own` with and without ownership.
2. All 16 clearance × label pairs are correct.
3. Links: visible only when both ends are visible.
4. Label defaults and the raise/lower rule match D51.
5. The guard refuses a request the table refuses, and lets through one it allows.

**Tests to write:** `packages/shared/tests/access/*.test.ts` (table-driven: the expected D50 table is written out in the test, not imported). `packages/api/tests/access-guard/*.test.ts`.

**Test command:** `pnpm --filter shared test -- access` (the `access-guard` API tests run in the full suite; put `pnpm --filter shared test -- access` in `tests.run`)

---

Task: M0-009

**Goal:** Build the Postgres side of the org wall: identity and grant tables, with RLS forced on every org table.

**Decisions:** D4, D9, D13, D49, D55 (the grant shapes), D57, D59 (every org pair), D73 (RLS on every org table: your org plus orgs you hold an active read-only grant or parent link for; FORCE RLS).

**Files:**
- Create: `packages/api/src/identity/schema.ts` (Better Auth tables from its Drizzle adapter: user, session, account, verification, organization, member, invitation, twoFactor; plus `member.role` limited to the 7 roles and `member.clearance`, default `internal`), `packages/api/src/identity/grants.schema.ts` (`auditor_grants`, `parent_links`, `break_glass_sessions`), `packages/api/src/db/migrations/0001_identity_and_rls.sql`, `packages/api/src/db/rls.sql.ts` (one helper that writes the standard policy for an org table).

**Interfaces (produces):**
- SQL function `app_visible_org(org uuid) returns boolean`: true for `app.org_id`, or for an org with an active, unexpired, unrevoked auditor grant for `app.user_id`, an approved parent link to `app.org_id`, or an active break-glass session for `app.user_id`.
- Standard policy for every org table: SELECT where `app_visible_org(org_id)`; INSERT/UPDATE/DELETE only where `org_id = current_setting('app.org_id')::uuid`.
- The rule for later tasks: every new org table gets `org_id uuid not null`, `ENABLE` and `FORCE ROW LEVEL SECURITY`, and the standard policy.

**Pass criteria:**
1. With three orgs, for every ordered pair (A, B), `grc_app` in A's context sees none of B's rows in any org table, and can't insert, update or delete them.
2. With no `app.org_id` set, every org table returns zero rows (not an error that leaks, and never all rows).
3. An active auditor grant lets the auditor SELECT the other org's rows and nothing else. An expired or revoked grant (even by one second) shows nothing.
4. An approved parent link gives the parent read-only access. A requested but unapproved link gives nothing.
5. Every table with an `org_id` column has RLS enabled and forced (checked from `pg_class` across the schema, so later tables are caught too).
6. `grc_app` can't `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, and can't `SET row_security = off` to get around it.
7. If Better Auth can't sign in with RLS on `organization`/`member`, the builder hands off `blocked` with the details instead of loosening a policy.

**Tests to write:** `packages/api/tests/org-wall/*.test.ts` against a throwaway database with three seeded orgs: criteria 1–6.

**Test command:** `pnpm --filter api test -- org-wall`

---

Task: M0-010

**Goal:** Sign-in with Better Auth inside the API, with the D54 rules, and the org context set on every request.

**Decisions:** D10, D49, D54, D56 (sign-ins and failures are logged), D59, D64.

**Files:**
- Create: `packages/api/src/identity/auth.ts` (Better Auth config: email/password, organization plugin, 2FA plugin), `packages/api/src/identity/identity.module.ts`, `packages/api/src/identity/session.guard.ts` (sets `withOrgContext` from the session and member row), `packages/api/src/identity/lockout.ts`, `packages/api/src/identity/me.controller.ts`.

**Interfaces (produces):**
- Better Auth mounted at `/api/v1/auth/*`.
- `GET /api/v1/me` returns `{ user: { id, email, name }, org: { id, name }, role, clearance, mfaEnrolled }`.
- `SessionGuard` (global): every route except `/api/v1/auth/*` and `/api/v1/health` needs a session with MFA completed. A signed-in user without MFA gets 403 `mfa_required` on everything except the 2FA setup routes and `/api/v1/me`.
- Audit events (through `AuditService.append` from M0-012): `auth.sign_in`, `auth.sign_in_failed`, `auth.locked`, `auth.sign_out`, `auth.mfa_enrolled`.

**Notes from M0-009's security review:**
- Better Auth's `user`, `session`, `account`, `verification` and `two_factor` tables have no RLS by design. This task must never expose them through the API.
- Before using `session.active_organization_id` as the org context, check that the user is a member of that org.

**Pass criteria:**
1. Passwords under 12 characters are refused. Passwords are stored hashed, never in plain text.
2. MFA with TOTP and backup codes. No route beyond the allowed list works before MFA is set up and checked.
3. A session ends after 30 min without requests, and after 12 h regardless of activity.
4. The 5th wrong password in a row locks the account for 15 min, and even the right password is refused while locked. Email case doesn't matter (`Alice@x.test` and `alice@x.test` count as one account).
5. Every sign-in attempt, good or bad, writes one audit event. A failed attempt for an unknown email is also logged, and the response doesn't reveal whether the email exists.
6. A user in org A can't make any request run in org B's context, including by sending another org ID in a header or body.
7. `/api/v1/me` returns the member's role and clearance.

**Tests to write:** `packages/api/tests/auth/*.test.ts` with Fastify `inject` and a fake clock for criteria 3 and 4. TOTP codes are generated in the test from the enrolment secret.

**Test command:** `pnpm --filter api test -- auth`

---

Task: M0-011

**Goal:** API keys for machines (connectors, generators, benchmark).

**Decisions:** D11, D54 (one org and one role per key, expiry, revocable, shown once, stored hashed), D56.

**Files:**
- Create: `packages/api/src/identity/api-keys.service.ts`, `packages/api/src/identity/api-keys.controller.ts`, `packages/api/src/identity/api-key.guard.ts`, `packages/api/src/identity/api-keys.schema.ts` (an org table following the M0-009 rule).

**Interfaces (produces):**
- `POST /api/v1/api-keys` (admin only) `{ name, role, expiresAt }` returns `{ id, key }`. The key is shown only in this response.
- `GET /api/v1/api-keys` (paged, never shows the key), `DELETE /api/v1/api-keys/:id` (revokes).
- `Authorization: Bearer grc_<…>` authenticates as the key's org and role, with clearance `internal`.

**Pass criteria:**
1. Only an Admin of the org can create, list or revoke keys.
2. The stored value is a hash; the plain key can't be recovered from the database.
3. Expired and revoked keys get 401 at once.
4. A key never works for another org, and its role limits what it can do (M0-008 guard).
5. Create, revoke and each refused use write audit events.
6. Expiry is required and must be in the future.

**Tests to write:** `packages/api/tests/api-keys/*.test.ts`.

**Test command:** `pnpm --filter api test -- api-keys`

---

Task: M0-012

**Goal:** The Postgres audit trail: add-only, one hash chain per org, checked nightly.

**Decisions:** D37, D45.4, D56, D72 (nightly chain check), D73 (events with a per-org sequence number and hash chain, add-only, partitioned by org).

**Files:**
- Create: `packages/api/src/audit/audit.schema.ts`, `packages/api/src/audit/audit.service.ts`, `packages/api/src/audit/chain.ts`, `packages/api/src/audit/verify-chain.job.ts`, `packages/api/src/db/migrations/0003_audit.sql` (not `0002`: `0001_pgboss.sql` and `0002_identity_and_rls.sql` already exist).

**Interfaces (produces):**
- `AuditEventInput = { orgId, actorType: 'user'|'api_key'|'system', actorId, action: string, targetType?, targetId?, before?, after?, meta?, sourceId? }`. `sourceId` is unique per org and makes a repeat append a no-op (the outbox relay uses it).
- `AuditService.append(e: AuditEventInput): Promise<{ seq: number; hash: string }>`.
- `hashEntry(prevHash: string, entry): string`: SHA-256 over the previous hash plus a canonical JSON of the entry (sorted keys).
- `verifyChain(orgId): Promise<{ ok: true } | { ok: false; brokenAtSeq: number }>`.
- `createAuditPartition(orgId)`: called by org provisioning (M0-014).
- Queue `audit.verify-chains` runs nightly and writes an `audit.chain_broken` event and an error log line when a chain breaks.

**Pass criteria:**
1. Sequence numbers per org start at 1 with no gaps. Each entry stores the previous entry's hash.
2. 50 appends at once for one org give 50 entries, seq 1–50, one unbroken chain (no forks, no duplicates).
3. `grc_app` can't UPDATE, DELETE or TRUNCATE audit rows. A trigger also refuses changes by the owner at runtime.
4. `verifyChain` passes on an intact chain and reports the exact seq when a row is tampered with (tampering done in the test as the migration account with the trigger off).
5. Org A's context can't read org B's audit rows (RLS).
6. Appending the same `sourceId` twice stores one entry.

**Tests to write:** `packages/api/tests/audit/*.test.ts`.

**Test command:** `pnpm --filter api test -- audit`

---

Task: M0-013

**Goal:** Save each graph change and its audit entry in one Neo4j transaction, and have the worker copy entries to Postgres within 5 s.

**Decisions:** D26, D37, D45.4, D45.5, D48 (zero lost audit entries; Postgres catches up within 5 s; no lost or duplicated jobs after a kill), D73 (outbox entries deleted after the copy, hidden from query accounts).

**Files:**
- Create: `packages/api/src/audit/outbox.ts`, `packages/api/src/audit/outbox-relay.job.ts`.

**Interfaces (consumes):** `GraphService.write` (M0-004), `AuditService.append` (M0-012).
**Interfaces (produces):**
- `withAuditedWrite<T>(orgId, actor, fn: (tx) => Promise<{ result: T; audit: Omit<AuditEventInput,'orgId'|'actorType'|'actorId'> }>): Promise<T>`. It creates an `(:AuditOutbox {id, orgId, payload, createdAt})` node in the same transaction.
- Relay: every 2 s for each org database, reads outbox nodes oldest first, appends with `sourceId = outbox id`, then deletes the node.

**Pass criteria:**
1. If `fn` throws, neither the change nor the outbox node is saved.
2. After a successful write, the audit row is in Postgres within 5 s.
3. Killing the relay between the Postgres append and the Neo4j delete, then restarting it, leaves exactly one audit row.
4. Entries are copied in the order they were written, per org.
5. With Postgres down, entries stay in the outbox and are copied once it's back.

**Tests to write:** `packages/api/tests/outbox/*.test.ts`, with a crash injected between the two steps.

**Test command:** `pnpm --filter api test -- outbox`

---

Task: M0-014

**Goal:** Create an org everywhere at once, safely re-runnable, plus a demo seed for the checkpoint.

**Decisions:** D4, D22, D45.5, D53, D57, D73, D114 (a clickable demo at the checkpoint), D133 (a command-line setup command run by the platform operator creates an org and its first Admin, for now).

**Entry point (D133):** a command-line setup command, run by the platform operator (the user) on the Mac. There's no web screen or API route for creating orgs in M0.

**Files:**
- Create: `packages/api/src/identity/provision-org.ts`, `packages/infra/scripts/create-org.ts` (root script `org:create`, taking `--name`, `--slug`, `--admin-email`, `--admin-name`; D133), and `packages/infra/scripts/seed-demo.ts` (root script `seed:demo`).

**Interfaces (consumes):** `createOrgDatabase` (M0-004), `ensureBucket` (M0-006), `createAuditPartition` (M0-012), the M0-009 tables.
**Interfaces (produces):** `provisionOrg({ name, slug, admin: { email, name } }): Promise<{ orgId }>`.

**Pass criteria:**
1. One call creates the Postgres org, its audit partition, `org-<orgId>` in Neo4j, `grc-org-<orgId>` in storage, and the first Admin (clearance `restricted`, required to set a password and MFA at first sign-in).
2. Re-running with the same slug finishes the missing steps and duplicates nothing. A failure part-way through can be fixed by re-running.
3. An `org.created` audit event lands in the new org's chain.
4. `pnpm seed:demo` creates two orgs, each with one user per role (7), at mixed clearances, with a printed login list (passwords from `.env`, never hard-coded).
5. D133: `pnpm org:create --name … --slug … --admin-email … --admin-name …` calls `provisionOrg` and prints the new org ID. Missing or invalid arguments exit non-zero with a clear message and create nothing. Running it again with the same slug is safe (criterion 2).

**Tests to write:** `packages/api/tests/provision/*.test.ts`, including a failure injected after the Neo4j step and a re-run, and the `org:create` command's argument checks and re-run (D133).

**Test command:** `pnpm --filter api test -- provision`

---

Task: M0-015

**Goal:** The web app shell and the sign-in screens, so the product looks finished from the first screen.

**Decisions:** D1, D7, D27 (the screens that come later hang off this shell), D30 (a typed client generated from the OpenAPI spec), D33, D54.

**Files:**
- Create: `packages/web/index.html`, `packages/web/vite.config.ts`, `packages/web/src/main.tsx`, `packages/web/src/router.tsx`, `packages/web/src/api/client.ts` (generated from `/api/v1/openapi.json`; the generator command is the root script `gen:api-client`), `packages/web/src/features/auth/SignInPage.tsx`, `MfaSetupPage.tsx`, `MfaCheckPage.tsx`, `packages/web/src/app/AppShell.tsx` (header with org name, user, role and sign-out; ServiceNow-style left navigation), `packages/web/src/app/HomePage.tsx`, the shadcn/ui setup (`components.json`, `src/components/ui/*`).

**Pass criteria:**
1. Sign-in form with field errors (for example "at least 12 characters").
2. A user without MFA is taken to MFA setup (QR code, then backup codes shown once and a confirm step). A user with MFA gets the 6-digit check, with a "use a backup code" option.
3. The lock message says when to try again. The idle-timeout message appears when a 401 arrives on an expired session, and returns the user to sign-in.
4. After sign-in, the shell shows the org name, the user's name and role, and sign-out works.
5. All API calls go through the generated typed client, with relative `/api/v1` URLs (no hard-coded host).

**Tests to write:** `packages/web/tests/auth/*.test.tsx` (Vitest + Testing Library, with the API mocked at the client boundary) for criteria 1–5.

**Test command:** `pnpm --filter web test -- auth`

---

Task: M0-016

**Goal:** Caddy as the one front door at `https://grc.localhost`, proven end to end with a real sign-in, plus the written demo steps for the checkpoint.

**Decisions:** D60, D61, D64 (headers; 25 MB uploads and 1 MB other requests), D65, D114 (clickable demo with written steps), D115.

**Before running:** the user has trusted Caddy's local certificate and added `127.0.0.1 grc.localhost` to the hosts file (D65), and restarted Docker Desktop for the 4 GB limit (D127). If either is missing, hand off `blocked` saying which.

**Files:**
- Create: `packages/infra/caddy/Caddyfile`, `packages/web/Dockerfile` or a build step that puts `packages/web/dist` into the Caddy image, `packages/web/playwright.config.ts`, `docs/demo/m0.md` (the written demo steps).
- Modify: `packages/infra/compose.yaml` (the `grc-caddy` service only).

**Pass criteria:**
1. `http://grc.localhost` redirects to `https://grc.localhost`. The certificate comes from Caddy's local CA (`tls internal`).
2. `/` serves the built web app; unknown non-API paths fall back to `index.html`.
3. `/api/v1/*` is forwarded to `grc-api`, and `GET https://grc.localhost/api/v1/health` returns 200.
4. The D64 security headers are on every response, the web app's included.
5. Uploads over 25 MB are refused at the door. Other requests over 1 MB are refused by the API (M0-007).
6. Playwright, through `https://grc.localhost`: a demo user signs in, sets up MFA, sees the shell, signs out. A second demo user from the other org signs in and sees only their own org.
7. `docs/demo/m0.md` lists the click-through steps and the demo logins' source (`pnpm seed:demo`).

**Tests to write:** `packages/infra/tests/front-door/*.test.ts` (HTTP checks with Caddy's root CA) and `packages/web/e2e/sign-in.spec.ts`.

**Test command:** `pnpm --filter infra test -- front-door`

---

### TEST shared notes (every TEST brief includes these)
TEST is a small test-approach milestone, not a slice (D178, D179). The M0 shared notes above (layout, test ownership, throwaway databases, one test process, names) still apply.
- **Git (D112, D159):** branch `task/<ID>`, in its own worktree. Commit messages start with the task ID. Never mention Claude, Anthropic or AI tooling in commits.
- **Test file names (D177):** every new test file is named by what it needs to run:
  - `*.unit.test.ts` (or `.tsx`): needs nothing.
  - `*.db.test.ts`: needs Postgres, Neo4j or SeaweedFS.
  - `*.stack.test.ts`: needs the running stack (containers, Caddy, the API).
  - Browser tests: `e2e/*.e2e.ts`.
- **Never weaken live state to prove a test (D176):** never grant, revoke or weaken live Neo4j or Postgres privileges, or change any other shared state, to show a test can fail. Prove red in the worktree's code only.
- **Addresses and secrets (D57, D61):** services stay on 127.0.0.1. Secrets live only in the git-ignored `.env` and are never printed.
- **Running side by side (D179):** the three tasks run at the same time. TEST-002 and TEST-003 only **add** files (plus the few existing files named in their brief). They don't rename or edit existing test files, because TEST-001 renames them. The integrator merges TEST-002, then TEST-003, then TEST-001 last.

---

Task: TEST-001

**Goal:** Give every test file a name that says what it needs to run, and give each kind its own command, with no automatic retries anywhere.

**Decisions:** D177 (names and commands), D171 (`retries: 0`; a test that fails then passes is a bug), D180 (db and stack runs call the doctor first), D82 (one test process per run), D96 (renaming test files is test-writer work), D179 (merges last).

**Depends on:** TEST-002's root `test:env` script. The builder may rebase `task/TEST-001` onto `main` once TEST-002 is merged. Until then, the builder can wire the scripts to `pnpm test:env` and prove the "stops if the doctor fails" behaviour with a stand-in script in the worktree only (not committed).

**Files:**
- Rename (test writer, with `git mv` so history follows): every existing test file under `packages/*/` outside `node_modules`. At planning time that's 88 files: api 66, infra 13, shared 3, web 6. Sort each by what it needs:
  - Needs nothing → `.unit.test.ts(x)`.
  - Talks to Postgres, Neo4j or SeaweedFS (throwaway databases, 127.0.0.1:5433, 7687, 8333) → `.db.test.ts`.
  - Needs running containers, Caddy or the API → `.stack.test.ts`. Existing names like `dev-relay.live.test.ts` get a D177 type too.
  - `packages/web/e2e/sign-in.spec.ts` → `packages/web/e2e/sign-in.e2e.ts`.
  - Fix import paths in test files if a rename breaks them. Helper files (`helpers.ts` and the like) aren't tests and keep their names.
- Create (test writer): `packages/infra/tests/test-names.unit.test.ts`. The test writer may pick another file name. If so, it states the name and test command in its hand-off.
- Modify (builder): the root `package.json` and each `packages/<pkg>/package.json` (scripts), every `packages/<pkg>/vitest.config.ts`, `packages/web/playwright.config.ts`.

**Pass criteria:**
1. Every test file under `packages/*` (outside `node_modules`) ends in `.unit.test.ts(x)`, `.db.test.ts(x)` or `.stack.test.ts(x)`, or is `e2e/*.e2e.ts`. Nothing is left as a plain `.test.ts`, `.spec.ts` or `.live.test.ts`.
2. The test writer's hand-off lists each renamed file with its kind, and gives a one-line reason for any file that could fit two kinds.
3. Each package has `test:unit`, `test:db` and `test:stack` scripts. Each one accepts `-- <pattern>` the way today's `test` does, and runs only files of its own kind. Each package's `test` runs all three kinds.
4. Root scripts:
   - `pnpm test:unit`, `pnpm test:db` and `pnpm test:stack` run that kind across all packages.
   - `pnpm test:e2e` runs Playwright in `packages/web`.
   - `pnpm test` runs unit, then db, then stack. It does not run e2e.
5. `test:db` and `test:stack` (root and per package) run `pnpm test:env` first. If it fails, they stop right away, show its list, and run no tests. Unit runs never call the doctor and never need the stack.
6. `pnpm --filter <pkg> test -- <pattern>` still works for every task's existing test command on the board. It fails if the pattern matches no test file of any kind. A kind with no matching files is skipped quietly and doesn't call the doctor.
7. Every Vitest config and the Playwright config set `retries: 0`. Playwright's `testMatch` picks up `*.e2e.ts` only. Vitest never picks up `e2e/**` or `.claude/**`. Each run is still one process (D82).
8. After the renames, the same number of tests pass as before on `main` (the full suite with the stack up), with none skipped (D173). The test writer records the before and after counts in its hand-off.

**Tests to write:** `packages/infra/tests/test-names.unit.test.ts`:
- It walks `packages/*` (skipping `node_modules` and `dist`) and fails, naming the file, if any test file has no D177 type.
- It fails if a `.spec.ts` or `.e2e.ts` file sits outside `packages/web/e2e/`.
- It checks that the root and each package declare the scripts in criteria 3–5, and that `test:db` and `test:stack` call `test:env` before Vitest.
- It checks that every Vitest config and the Playwright config have `retries: 0` (or no retries setting, if the file's default is provably 0), and that Playwright's `testMatch` is `*.e2e.ts`.

**Test command:** `pnpm --filter infra test -- test-names`

---

Task: TEST-002

**Goal:** One check-only command, `pnpm test:env`, that says what the live tests are missing. Also, the Mac-side scripts find the databases by themselves.

**Decisions:** D180 (the check-only doctor), D170 (Mac scripts swap the host themselves; fixes build-errors 25), D57 (never print secrets), D61 (127.0.0.1 only), D65 (Caddy root and hosts line), D73 (the 28 read-only Neo4j accounts; built in M0-005), D164 (script errors), D176.

**Files:**
- Create: `packages/infra/scripts/test-env.ts` (the command). Its decision logic, which turns probe results into lines and an exit code, goes in a pure module the unit test can import without touching anything, for example `packages/infra/scripts/test-env-checks.ts`.
- Create: a small pure function for the host swap, for example `toHostAddress(url: string): string` in `packages/infra/scripts/host-address.ts`. `org-script-env.ts` loads the api code at import time, so the unit test must not need to import it.
- Modify: the root `package.json` (add `"test:env"`), `packages/infra/scripts/org-script-env.ts` (use the swap for every `DATABASE_URL_*` it reads), and `packages/infra/scripts/seed-demo.ts` and `create-org.ts` only if they read `DATABASE_URL_*` directly.
- Don't change `.env`, `.env.example`, `compose.yaml` or any existing test file.

**Pass criteria:**
1. `pnpm test:env` prints one line per item, `OK` or `missing`, with a short reason. It exits 0 only if every item is OK. The items:
   - The grc-* containers and the dev relay are up: 127.0.0.1:5433 (Postgres) and 127.0.0.1:8333 (SeaweedFS) answer.
   - Postgres migrations are applied: every entry in `packages/api/src/db/migrations/meta/_journal.json` is in `drizzle.__drizzle_migrations`. This is a read-only query.
   - Neo4j answers on `bolt://127.0.0.1:7687`, and each of the 28 `grc_ro_*` roles still has every DENY that `setup:neo4j` gives it. The doctor reads them with read-only `SHOW ... PRIVILEGES` and compares them with `queryAccountPrivileges` / `QUERY_ACCOUNTS` in `packages/api/src/graph/`. A missing role or DENY is named.
   - The required `.env` keys are present. Only key names are printed, never values, including in errors.
   - Caddy's local root is trusted in the Mac's keychain, and `/etc/hosts` has `127.0.0.1 grc.localhost`.
2. An item it can't check (for example, no permission to read the keychain, or Neo4j refuses the login) is marked `missing` with the reason. The doctor doesn't crash and doesn't guess OK.
3. It changes nothing. It never grants, revokes, starts, stops, migrates or writes anything: no database, container, file, keychain or hosts change. It only reads and connects.
4. D170: `seed:demo`, `org:create` and their shared env loader replace the container host (for example `grc-postgres:5432`) in every `DATABASE_URL_*` with `127.0.0.1:5433` themselves, the way `packages/api/tests/db/helpers.ts` does (`TEST_HOST`, `TEST_PORT`). User, password, database name and query string stay unchanged, and a URL already on 127.0.0.1:5433 is left as it is. `.env` keeps one set of addresses (the container ones).
5. Script errors still follow D164: error type or code and IDs only, never the database message or any URL with a password.

**Tests to write (new files only, D177 names):**
- `packages/infra/tests/test-env/test-env-checks.unit.test.ts`: the decision logic with fake probes. It covers all OK → exit 0, each single item missing → that line says `missing` and the exit is non-zero, a probe that throws → `missing` with a reason, one DENY missing on one of the 28 roles → that role named, and `.env` values never appearing in the output (use a sentinel value).
- `packages/infra/tests/test-env/test-env.stack.test.ts`: runs `pnpm test:env` against the real stack, read-only, and expects exit 0 and one line per item. It also checks that nothing changed, for example by comparing the Neo4j privilege list and the migrations row count before and after.
- `packages/infra/tests/org-script-env/host-address.unit.test.ts`: the host swap. It covers container host → 127.0.0.1:5433, an address already local left unchanged, and credentials, database and query kept (including a password with URL-encoded characters).

**Test commands:** `pnpm --filter infra test -- test-env` and `pnpm --filter infra test -- org-script-env`

---

Task: TEST-003

**Goal:** A single table of every record type and every API route with its access rules, and a test that fails as soon as the code and the table disagree. New features then can't skip the D59 tests.

**Decisions:** D175 (the matrix and its completeness test), D59 (proof: every role cell, org pair, clearance × label), D50 (role × record-type table), D51 (labels), D55 (org wall), D30 (every route under `/api/v1`).

**Files:**
- Create: `packages/shared/src/access/security-matrix.ts`. It exports the matrix (for example `SECURITY_MATRIX`), with two lists:
  - `recordTypes`: one entry per row of `ROLE_TABLE` in `packages/shared/src/access/role-table.ts`, giving its D50 cells by reference to the role table (don't copy the cells), whether it's org-walled, and whether labels apply (D51).
  - `routes`: one entry per API route, with `method`, the full `path` under `/api/v1`, `access` (a D50 cell reference, `"any signed-in"` or `"public"`), `orgWalled` (true/false) and `labels` (true/false).
- Create: `packages/api/tests/security/security-matrix.unit.test.ts` (test writer).
- Modify: `packages/shared/src/index.ts` (or the access barrel) to export the matrix. Export anything else the test needs from `packages/api/src`, such as the controllers list or the directly registered route paths. That's the only change allowed in `packages/api/src`.
- Don't edit, move or rename any existing test file (TEST-001 renames them).

**Pass criteria:**
1. The matrix lists every record type in the shared role table and every route the API serves today. That includes the routes Nest controllers declare (health, `/me`, API keys, `openapi.json`) and the routes registered straight on Fastify (the Better Auth wildcard under `AUTH_BASE_PATH`, `/api/v1/auth/*`). Each entry has the fields above.
2. The test collects the routes from the Nest controllers' route metadata (the controller path plus the method decorators, and the global `/api/v1` prefix), plus the exported directly registered paths. It uses no database, no running server and no `.env`.
3. The test fails and names the item if:
   - a record type or route in the code is missing from the matrix;
   - the matrix lists a record type or route the code doesn't have;
   - a route is duplicated;
   - a route has an unknown `access` value.
4. Adding a new controller method without a matrix entry makes the test fail. The test writer proves this with a throwaway controller defined inside the test, not by editing app code.
5. The security reviewer checks this table on every task from now on (D175). The file's header comment says so and points to D59.

**Tests to write:** `packages/api/tests/security/security-matrix.unit.test.ts`, covering criteria 2–4.

**Test command:** `pnpm --filter api test -- security-matrix`
