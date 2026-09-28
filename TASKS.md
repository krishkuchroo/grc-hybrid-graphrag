# Task Board

The planner keeps this board current (D85), and only the planner edits it (D95). Status: to do · in progress · in review · blocked · done.

| ID | Milestone | Owner | Status | Pass criteria & tests | Blocked notes | Task log |
|----|-----------|-------|--------|------------------------|---------------|----------|
| M0-001 | M0 | builder-platform | done | pnpm monorepo (api, web, shared, generators, benchmark, infra), strict TS, ESLint + Prettier (D130), root `lint` / `typecheck` / `test` scripts, Vitest per package that never picks up `.claude/**`. Tests: `pnpm --filter infra test -- workspace` | | `logs/tasks/M0-001.md` |
| M0-002 | M0 | builder-platform | done | Compose file with `grc-` names, 127.0.0.1-only ports, internal network for Postgres and SeaweedFS, dev switch (off by default) that opens Postgres on 5433 and SeaweedFS on 127.0.0.1 (D132), secrets setup script. Tests: `pnpm --filter infra test -- compose` | | `logs/tasks/M0-002.md` |
| M0-003 | M0 | builder-platform | done | Postgres 18.6 + pgvector 0.8.x wired through Drizzle, migration account vs restricted app account (no RLS bypass), per-transaction org context. Tests: `pnpm --filter api test -- tests/db/` | Earlier: security reviewer blocked (task/M0-003 at 1acd444). Everything else holds: grc_app and grc_migrator are NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE, grc_app has no CREATE anywhere, the migration URL never reaches the api or worker, passwords go through format(%L) and are stored as scram-sha-256, pgvector is trusted but grc_app can't install it (D142), and withOrgContext validates its inputs and uses set_config(..., true) with bound parameters. `db` 54/54 and `infra` 140/140 passed. **Issue (needs a user decision):** the dev-only `grc-dev` network (`packages/infra/compose.dev.yaml:21-26`, `enable_ip_masquerade: 'false'`; grc-postgres joins it at lines 10-12, grc-seaweedfs at 16-18) does not stop outgoing traffic on Docker Desktop 4.40.0 / Engine 28.0.4. With the dev switch on, grc-postgres's default route is via eth1 to 172.26.0.1 and a TCP connect to 1.1.1.1:443 succeeded. Docker Desktop's gvisor-tap-vsock opens the outbound connection itself, so the no-masquerade setting has no effect (D141(a), D62/D63). Evidence is the TCP connect and the route table; a full HTTP fetch was refused by the classifier. Test gap: the D141 block in `packages/infra/tests/compose/compose.test.ts` only checks the config, not behaviour. Scope: dev switch only (off by default); the builder followed D141(a) as written. **Question for the user:** with the dev switch on, Postgres and SeaweedFS can reach the internet. Is that acceptable for the dev-only switch, or should it be blocked another way (e.g. keep them internal-only and reach them through a small port-forwarding container, or a firewall rule)? Notes for later tasks: after a withOrgContext transaction, `current_setting('app.org_id', true)` returns '' (not NULL) on the pooled connection, so the RLS policies must treat '' as "no org" and fail closed; grc_app can CONNECT to the `postgres` database (PUBLIC default) but has no CREATE there. | `logs/tasks/M0-003.md` |
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
| TEST-001 | TEST | builder-platform | done | Every test file in packages/* renamed by what it needs (`.unit` / `.db` / `.stack` `.test.ts`, `e2e/*.e2e.ts`) with `git mv`; `test:unit` / `test:db` / `test:stack` per package and at the root, `test:e2e` at the root, `test` = unit + db + stack; db and stack runs call `pnpm test:env` first and stop if it fails; a check fails on any test file with no type; `retries: 0` in Vitest and Playwright (D177, D171). Merges last. Tests: `pnpm --filter infra test -- test-names` | | `logs/tasks/TEST-001.md` |
| TEST-002 | TEST | builder-platform | done | `pnpm test:env` doctor: one OK/missing line per item (stack and dev relay, migrations, 28 grc_ro_* DENYs, `.env` key names, Caddy root trusted, hosts line), non-zero exit if anything's missing, changes nothing (D180); `seed:demo`, `org:create` and their env loader swap the container host for 127.0.0.1:5433 themselves (D170). Tests: `pnpm --filter infra test -- test-env` and `pnpm --filter infra test -- org-script-env` | | `logs/tasks/TEST-002.md` |
| TEST-003 | TEST | builder-platform | done | `packages/shared/src/access/security-matrix.ts` lists every record type and every `/api/v1` route with its role rule, org wall and label rule; a unit test fails if the code has a record type or route not in the matrix, or the matrix lists one the code doesn't have (D175, D59, D50, D51). Tests: `pnpm --filter api test -- security-matrix` | open: user decides on the flaky body-size test (keep push + fix task?) | `logs/tasks/TEST-003.md` |
| TEST-004 | TEST | builder-platform | done | The front-door test "an upload of exactly 25 MB passes the door and reaches the API" gives the same result every time and in any order: the test writer finds the cause from the code (not by changing shared state), fixes the existing test only, with no retries and no sleeps as waits, and hands in with `fixReason` (D185, D171, D176). A cause in the app or Caddy code, not the test, is a question for the user (blocked). Tests: `pnpm --filter infra test -- body-size` (3 runs green) and `pnpm --filter infra test:stack` | merged as d56f2f9; pushed with TEST-006 (origin/main 21ad9c5..257da61, D187) | `logs/tasks/TEST-004.md` |
| TEST-005 | TEST | builder-platform | to do | In `packages/shared/src/access/security-matrix.ts` the `audit_trail` record type has `labels: true` (D186); a new unit test pins the label value of every non-record row: uploads, review_queue, chat and audit_trail true, admin false (D175, D51). Red until the builder flips audit_trail. Tests: `pnpm --filter api test -- security-matrix` | Tests cced565 (pins the label rule of the matrix rows that aren't records); builder a940cb7 (audit_trail labels: true, D186), 30/30 green 3 runs. Code and security reviewers approved. Merged 21ad9c5, pushed (origin/main b115b47..21ad9c5, with the earlier local commits incl. efbe0d0, D186 notes for S7); integrator: lint and typecheck clean, `pnpm test` 2,455/2,455. Security note for S7: pin labels on the audit_trail, uploads, review_queue and chat routes, and test hidden contents for each clearance x label pair (D186, D59). | `logs/tasks/TEST-005.md` |
| TEST-006 | TEST | builder-platform | done | The three size-cap tests in `front-door/body-size.stack.test.ts` (25 MB + 1 byte → 413 at the door, 40 MB → 413 at the door, JSON just over 1 MB → the API's 413 in the D47 format) give the same answer every time (D187, D171). The test writer finds each cause from the code, never by changing shared state (D176), and says whether a real person could get 502 instead of 413. Test-only cause: fix the existing tests with `fixReason`, same checks, no retries, sleeps, longer timeouts or `cutShortOk` on status checks (D185). Real cause: a reliably red test, then the smallest Caddy or API change so the answer is always 413 in the D47 format; limits stay 25 MB at the door and 1 MB at the API (D188, D53, D64). Tests: `pnpm --filter infra test -- body-size` (3 runs green) and `pnpm --filter infra test:stack`, none skipped; integrator pushes main (with TEST-004's d56f2f9 and 7c8199b) only after one clean full `pnpm test` | Tests 7470dcc (`expectContinue` in the door helpers, new `body-size-502.stack.test.ts`); API fix cf5cca1 by builder-backend (onError hook in `packages/api/src/common/errors.ts` drops `Connection: close` for FST_ERR_CTP_BODY_TOO_LARGE, so over-limit JSON always gets the API's 413, not Caddy's 502). Code and security reviewers approved. Merged 257da61, pushed (origin/main 21ad9c5..257da61); integrator: lint and typecheck clean, `pnpm test` 2,456/2,456, e2e 4/4. The finish check's rerun of `pnpm test` then failed one unrelated test, now TEST-007. Reviewer notes, none blocking: grc-worker was recreated with grc-api (shared image); the cast at errors.ts:67 may not be needed; security, phase 7: the API has no requestTimeout (Fastify default 0), so the 25 MB drain bound holds only behind Caddy. | `logs/tasks/TEST-006.md` |
| TEST-007 | TEST | test-writer | done | Flaky (D171): `packages/api/tests/graph-accounts/accounts.db.test.ts`, "grc_ro_auditor_restricted holds read-only privileges (criterion 1) > logs in through GraphService.readAs" failed once with `Neo4jError: Connection was closed by server` during Bolt login. The test writer finds the cause from the code, never by changing live Neo4j privileges, passwords or settings (D176). Test-only cause: fix the existing test with `fixReason`, same checks (D167, D185). Real cause: a reliably red test, then the smallest builder fix. No retries or longer timeouts to hide it. Tests: `pnpm --filter api test -- graph-accounts` (3 runs green), none skipped | Cause: a Neo4j Bolt server race when a pooled connection is logged in again as another account (NullPointerException in AuthenticationTimeoutConnectionListener, seen in debug.log); a real user could hit it through chat Path B. Red test 6f7e707 (`one-account-per-connection.db.test.ts`); fix 39d46a2 by builder-platform: one driver per query account, cached by account name, maxConnectionPoolSize 5 (QUERY_POOL_SIZE), all closed in close(). Code and security reviewers approved. Merged af08458, pushed with TEST-008 (origin/main 257da61..af08458); integrator: grc-api and grc-worker recreated from the main checkout, lint and typecheck clean, `pnpm test` 2,457/2,457 in one run with none skipped, e2e 4/4. Reviewer notes, none blocking, for phase 7: worst case 280 query connections across the API and worker (check against Neo4j's Bolt limits); a 6th concurrent query for the same account waits for a free connection (load-test it); a readAs after close() creates a new driver (shutdown only); each driver keeps its account's password in memory, acceptable under D57. | `logs/tasks/TEST-007.md` |
| TEST-008 | TEST | test-writer | done | `packages/infra/tests/front-door/headers.stack.test.ts:96` ("the door's own 413 for an upload over 25 MB") uses the `expectContinue` option, so the client's EPIPE can't race the door's 413 (same race TEST-006 fixed in `body-size.stack.test.ts`). Test-only fix with `fixReason`; still checks status 413 and the D64 headers, nothing loosened (D171, D185). Tests: `pnpm --filter infra test -- headers` (3 runs green) and `pnpm --filter infra test:stack`, none skipped | Test-only fix 6114c28 by the test writer, with `fixReason`: `expectContinue` added to the 25 MB + 1 byte test in `headers.stack.test.ts`. Code and security reviewers approved. Merged cd7aa0f, pushed with TEST-007 (origin/main 257da61..af08458); integrator: grc-api and grc-worker recreated from the main checkout, lint and typecheck clean, `pnpm test` 2,457/2,457 in one run with none skipped, e2e 4/4. Security note, not blocking: this test doesn't prove the 413 came from the door; `body-size.stack.test.ts` covers that. | `logs/tasks/TEST-008.md` |
| S1-001 | S1 | builder-backend | to do | Shared record and link model in `@grc/shared`: Zod schemas for Asset, Risk, Control, Policy and Incident (common D73 fields plus each type's own), the D197 value lists, record numbers RSK/AST/CTL/POL/INC + 7 digits (D196), the 5×5 risk rating with Low/Medium/High/Critical bands (D197), and the ontology table of allowed links (the spec's six). Tests (unit): `pnpm --filter shared test -- records` | | `logs/tasks/S1-001.md` |
| S1-002 | S1 | builder-platform | to do | Every org's Neo4j database gets the D73 schema: unique ID and number per type, lookups on type, framework, status, label and owner, a full-text index on names and source IDs, a 1024-dim cosine vector index on name embeddings, and a source-document index on every link type. Made by org provisioning and by `pnpm graph:schema` for existing orgs; safe to re-run. Tests (unit + db): `pnpm --filter api test -- org-schema` | | `logs/tasks/S1-002.md` |
| S1-003 | S1 | builder-backend | to do | Records service for the five types: create (number from 0001001 per org and type, default label, owner), read and list (paged, filtered, sorted) through the role x clearance read-only accounts, update with a version check (stale save refused), label rules (no label above the saver's clearance, D198), retire; Control Owners edit only their own controls and can't create (D199); every change and its audit entry in one Neo4j transaction. Tests (db): `pnpm --filter api test -- records-service` | | `logs/tasks/S1-003.md` |
| S1-004 | S1 | builder-backend | to do | REST routes for the five types (`/api/v1/assets`, `/risks`, `/controls`, `/policies`, `/incidents`: list, get, create, update, retire) plus `GET /api/v1/people`; "own" cells pass the guard and are checked in the service; security-matrix rows; every role cell, org pair and clearance x label pair tested (D59); error log carries no record or audit values (D164, SF-006). Tests (db + unit): `pnpm --filter api test -- records-api` | | `logs/tasks/S1-004.md` |
| S1-005 | S1 | builder-backend | to do | Links: `POST /api/v1/links` (ontology check, both ends visible, the D200 rule: can edit either end and see both, audited in the same transaction), `GET /api/v1/<type>/:id/links` (only links whose both ends are visible), and `GET /api/v1/assets/:id/map` (HOSTS/RUNS around one asset, depth 1–3, default 2, cap 200 assets with `truncated`, D204); security-matrix rows and D59 tests. Tests (unit + db): `pnpm --filter api test -- links` | | `logs/tasks/S1-005.md` |
| S1-006 | S1 | builder-frontend | to do | Web records kit (paged, sortable, filterable table; detail; create and edit forms from the shared schemas; stale-save message; retire; label and owner pickers; buttons follow the role table) and the Risk register at `/risks` with its rating. Tests (unit): `pnpm --filter web test -- records` | | `logs/tasks/S1-006.md` |
| S1-007 | S1 | builder-frontend | to do | Controls, Policies, Assets and Incidents screens built on the kit (lists with each type's columns and filters, detail, create and edit); a Control Owner sees only their own controls; Incidents hidden from roles with no access. Tests (unit): `pnpm --filter web test -- record-screens` | | `logs/tasks/S1-007.md` |
| S1-008 | S1 | builder-frontend | to do | Related records on every detail page (for example "Controls that treat this risk"), and an "Add link" dialog that offers only the link types the ontology allows and only to people allowed to add them. Tests (unit): `pnpm --filter web test -- record-links` | | `logs/tasks/S1-008.md` |
| S1-009 | S1 | builder-frontend | to do | Asset dependency map (React Flow) on the asset page: HOSTS and RUNS around the asset, depth picker 1–3 (default 2), click-through, a notice when the map is cut short at 200 assets (D204). Tests (unit): `pnpm --filter web test -- asset-map` | | `logs/tasks/S1-009.md` |
| S1-010 | S1 | builder-platform | to do | `seed:demo` adds a fixed, re-runnable set of records and links to each demo org (audited, mixed labels, controls owned by the demo Control Owner); `docs/demo/s1.md` click-through; Playwright journeys through `https://grc.localhost` (risk register, adding and removing a link, stale save, own controls, other org and low clearance see nothing). Tests (db + unit + e2e): `pnpm --filter api test -- seed-records`, `pnpm --filter infra test -- demo-doc`, `pnpm test:e2e` | | `logs/tasks/S1-010.md` |
| S1-011 | S1 | builder-backend | to do | Removing a link added by mistake (D201): `POST /api/v1/links/remove` with `{ type, fromId, toId }`; the D200 rule (can edit either end and see both); the link is deleted from Neo4j and a `link.removed` audit entry holding a copy of it is written in the same transaction; hidden or missing link 404; re-adding afterwards works; security-matrix row and D59 tests. Tests (unit + db): `pnpm --filter api test -- link-removal` | | `logs/tasks/S1-011.md` |
| S1-012 | S1 | builder-frontend | to do | "Remove" on each row of the related-records groups (D201), shown only to people the D200 rule allows, with a confirmation that says the removal is recorded; 404 and 403 answers give clear messages; the group refreshes after a removal. Tests (unit): `pnpm --filter web test -- link-removal` | | `logs/tasks/S1-012.md` |

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

---

Task: TEST-004

**Goal:** Make the front-door test "an upload of exactly 25 MB passes the door and reaches the API" give the same result every time, in any order, alone or in the full suite.

**Decisions:** D185 (this fix task; a fix to an existing test whose code is on main), D171 (no retries; a test that fails then passes is a bug), D176 (never weaken live or shared state to prove a test), D167 (fix hand-ins with `fixReason`), D174 (new tests agree with older ones), D53 and D64 (25 MB upload cap at the door, 1 MB API cap, 20 uploads/min), D177 (test kinds).

**Background:** The test is in `packages/infra/tests/front-door/body-size.stack.test.ts` (line 34). It failed once in a full-suite rerun after TEST-003, and passed alone and in every other run. TEST-001 is merged, so the D177 names and `test:stack` scripts are in place. The likely cause is another agent's run using the shared stack at the same moment. Candidates to check against the code (not guesses to act on):
- The API's rate limits (D64: 300 requests/min per person, 20 uploads/min) and how the API keys them for an unsigned-in caller behind Caddy (per IP? the same bucket for every test run?).
- `apiLogged` in `packages/infra/tests/front-door/helpers.ts`: it polls `docker logs --since` for 5 s (`waitMs = 5_000`), with `since` set 1 s before the send. Consider whether a 25 MB body under load, the container clock versus the Mac clock, or `docker logs` taking up to 30 s can make the marker land outside the window.
- The request's 90 s client timeout versus Vitest's test timeout for stack tests.
- Caddy buffering or timing for a body of exactly `UPLOAD_CAP_BYTES`.

**Who does what:** The test writer does this task. A builder is needed only if the cause is in the app or Caddy code **and** the user agrees to fix it there.

**Files:**
- Modify (test writer): `packages/infra/tests/front-door/body-size.stack.test.ts`, and `packages/infra/tests/front-door/helpers.ts` if the fix belongs in a shared helper. Change only test files that already exist on `main`. The `fixReason` finish check refuses a fix hand-in that adds new files or touches non-test files (D185).
- Don't touch app code, `compose.yaml`, the Caddyfile, `.env` or any other test file.

**Pass criteria:**
1. The test writer's hand-off names the cause it found, with the file and line in the code that explains it, and how the fix removes it.
2. The fixed test still checks what it checked before: an upload of exactly 25 MB passes the door and its marker reaches the API log. It doesn't loosen the check (for example, it doesn't accept a 413 or drop the log check).
3. No retries, no sleeps used as waits, and no longer timeouts used to paper over the cause (D171). A bounded wait for a condition is fine only if the hand-off explains why its limit covers the worst case.
4. It gives the same result alone, in the full infra stack run, and in any order within `body-size.stack.test.ts`.
5. Nothing shared is changed to prove the cause or the fix (D176): no rate-limit settings, no container restarts, no privilege changes. Any experiment happens in the worktree's test code only.
6. If the cause is in the app or Caddy code, not the test: don't change that code. Hand in `blocked`, with the cause and a plain question for the user (fix it in the code, or accept and adjust the test?).
7. Every other test in `packages/infra/tests/front-door/` still passes, with none skipped (D173). The hand-off says which earlier tests it agrees with (D174).

**Tests to write:** No new test file. Fix the existing test (kind: `stack`, it needs the running stack and Caddy). Run `pnpm --filter infra test -- body-size` 3 times in a row (all green), then `pnpm --filter infra test:stack` once, and record the counts in the hand-off. Hand in with `fixReason` (for example "the 25 MB marker check raced the shared stack's …; fixed by …"). The finish check then expects green.

**Test command:** `pnpm --filter infra test -- body-size`

---

Task: TEST-005

**Goal:** The audit trail is marked as label-checked in the security matrix, and a test pins the label rule for every row that isn't a record type, so a later change can't flip one unnoticed.

**Decisions:** D186 (the audit viewer hides the contents of entries above the reader's clearance: who, when, record number and action stay visible, before/after contents don't), D175 (the security matrix and its tests), D51 (labels and clearance), D56 (audit trail), D59 (proof).

**Background:** TEST-003's security review found that the matrix's label values for the non-record rows (uploads, review_queue, audit_trail, admin, chat) aren't pinned by any test. Today `audit_trail` has `labels: false` (`packages/shared/src/access/security-matrix.ts:50`), which D186 changes.

**Files:**
- Create (test writer): `packages/api/tests/security/security-matrix-labels.unit.test.ts`. Don't edit TEST-003's `security-matrix.unit.test.ts` unless it's needed, and say why if so.
- Modify (builder): `packages/shared/src/access/security-matrix.ts`. Set the `audit_trail` entry to `labels: true`, and update the file's header comment (lines 11-12, which list where labels apply) to include the audit trail, citing D186. Nothing else changes.

**Pass criteria:**
1. The `audit_trail` record type in `SECURITY_MATRIX` has `labels: true`.
2. A unit test pins the label value of each non-record row by name: `uploads`, `review_queue`, `chat` and `audit_trail` are `true`, and `admin` is `false`. The test fails and names the row if any value differs, or if one of these rows is missing from the matrix.
3. The test is red before the builder's change (only `audit_trail` fails) and green after.
4. TEST-003's `security-matrix.unit.test.ts` still passes, with none skipped (D173).
5. This task only changes the matrix. It doesn't build the audit viewer's hiding of contents (that comes with the audit viewer in S7). The security reviewer checks the matrix row against D186.

**Tests to write:** `packages/api/tests/security/security-matrix-labels.unit.test.ts` (kind: `unit`; it imports the matrix only, with no database, server or `.env`). It covers criterion 2. Security-matrix rows: no new record type or route, so no new rows; the row that changes is `audit_trail` (labels false → true).

**Test command:** `pnpm --filter api test -- security-matrix`

---

Task: TEST-006

**Goal:** The three size-cap tests in `packages/infra/tests/front-door/body-size.stack.test.ts` give the same answer every time. If a real person sending a slightly-too-big request can get 502 instead of 413, that's fixed too, so the answer is always the clear 413.

**Decisions:** D187 (fix the size-cap race before anything more is pushed; push TEST-004 and TEST-006 together after one clean full run), D188 (if the 502 is real, the smallest change in Caddy or the API, no need to ask the user again), D185 (fix to existing tests on main, handed in with `fixReason`), D171 (no retries; a test that fails then passes is a bug), D176 (never weaken live or shared state to prove a test), D53 and D64 (25 MB upload cap at the door, 1 MB API cap), D47 (one error format with a reference ID), D173 (none skipped), D174 (new tests agree with older ones), D177 (test kinds). Read the TEST shared notes above.

**Background:**
- TEST-004's integrator saw one full run fail: `body-size.stack.test.ts:76`, "a JSON request just over 1 MB passes the door and is refused by the API with 413 in its error format", got **502** instead of 413.
- TEST-004's reviewers found the same race in two more tests: "an upload of 25 MB + 1 byte gets 413 from the door" (line 45, status check at :50) and "a 40 MB upload gets 413 from the door" (line 57, status check at :62).
- The race: the server (Caddy for the uploads, the API for the JSON request) answers and closes while the client is still sending the body. The order in which the client sees the answer, its own write error (EPIPE or ECONNRESET), or Caddy's upstream error varies from run to run.
- TEST-004 (merged locally as `d56f2f9`, not pushed) handled this for the exactly-25-MB test only, with `cutShortOk` in `packages/infra/tests/front-door/helpers.ts` (`SendOptions.cutShortOk`, `collect()` at about lines 91-170). That option lets a write error end the exchange with no answer, so it must not be used where the test checks the status.
- Where the caps live: Caddy's door cap in `packages/infra/caddy/Caddyfile`; the API's 1 MB cap (`BODY_LIMIT_BYTES`) in `packages/api/src/main.api.ts`, and its 413 `payload_too_large` answer in `packages/api/src/common/errors.ts`.

**Who does what:**
1. **Test writer** finds the cause of each of the three failures from the code (the test helper, the Caddyfile, the API's body-limit handling), never by changing shared state (D176). It decides, and says in its hand-off with file and line, whether a real person (a normal HTTP client that sends a body over the cap) could get 502 instead of 413.
   - A 502 on the JSON request most likely comes from Caddy, when the API closes the connection before Caddy has finished forwarding the body. Check that against the Caddyfile and how the API answers an over-limit body. It's a candidate, not a finding.
2. **If the cause is only in the test** (the client's own read or write ordering): the test writer fixes the existing tests and hands in with `fixReason`, green. No builder.
3. **If the cause is real** (Caddy or the API can answer 502 to a slightly-too-big request): the test writer writes a test that reproduces it **every time** (red on every run, for example by controlling how the client sends the body or when it reads the answer), and hands in red. Then **builder-platform** makes the smallest change in the Caddyfile or the API so the answer is always 413 in the D47 error format (D188). No need to ask the user. Both reviewers check the change.

**Files:**
- Modify (test writer): `packages/infra/tests/front-door/body-size.stack.test.ts` and `packages/infra/tests/front-door/helpers.ts`. For the real-cause route only, the test writer may add one new `*.stack.test.ts` file under `packages/infra/tests/front-door/` for the reproducing test, or put it in `body-size.stack.test.ts`. Note that a `fixReason` hand-in can't add new files or touch non-test files (D185), so the real-cause route is handed in as a normal red hand-in, not a fix.
- Modify (builder, real-cause route only): `packages/infra/caddy/Caddyfile`, or the API's body-limit handling (`packages/api/src/main.api.ts`, `packages/api/src/common/errors.ts`). Only the smallest change that fixes the cause.
- Don't touch `compose.yaml`, `.env`, the rate limits or any other test file.

**Pass criteria:**
1. The test writer's hand-off names the cause of each of the three failures, with the file and line that explains it, and says whether a real person could get 502 (yes or no, and why).
2. The three tests still check what they checked before:
   - 25 MB + 1 byte and 40 MB: status 413 from the door, and the API log never shows the marker (with the control request proving the log is read).
   - JSON just over 1 MB: status 413, body in the D47 format with `code` `payload_too_large`, and the marker in the API log.
   - Nothing is loosened: no accepting 502 or status 0, no dropped log check, and no `cutShortOk` on a test that checks the status.
3. No retries, no sleeps used as waits, and no longer timeouts to hide the cause (D171). A bounded wait for a condition is fine only if the hand-off explains why its limit covers the worst case.
4. Nothing shared is changed to prove the cause or the fix (D176): no container restarts to test a theory, no rate-limit or privilege changes. Experiments happen only in the worktree's test code. If the builder changes the Caddyfile or the API, rebuilding and recreating only `grc-caddy` or `grc-api` with `--no-deps` from the main checkout's compose project is the deploy step, not an experiment. The builder says in its hand-off exactly what it recreated.
5. Real-cause route only:
   - The reproducing test is red on every run before the builder's change and green on every run after it.
   - The limits don't move: 25 MB (`UPLOAD_CAP_BYTES`) at the door and 1 MB (`BODY_LIMIT_BYTES`) at the API (D53, D64).
   - The 413 keeps the D47 format (`code`, `referenceId`) and the D64 security headers.
6. `pnpm --filter infra test -- body-size` passes 3 times in a row, then `pnpm --filter infra test:stack` passes once, with nothing skipped (D173). The hand-off records the counts, and names the earlier tests it agrees with (D174), including TEST-004's exactly-25-MB test.
7. Security-matrix rows: no new record type or route, so no new rows (D175).

**Tests to write:** kind `stack` (they need the running stack and Caddy). Test-only cause: fix the three existing tests; no new file. Real cause: one reproducing test (new or in `body-size.stack.test.ts`) that is red every time until the builder's change.

**Test command:** `pnpm --filter infra test -- body-size`

**Integrator:** merge `task/TEST-006` into `main` locally. Then run one full `pnpm test` (unit, db, stack) with the stack up. Push `main` only if it's clean. That push also carries TEST-004's `d56f2f9` and `7c8199b` (D187). If the full run fails, don't push; hand in `blocked` with the failing test.

---

Task: TEST-007

**Goal:** Make the Neo4j login test "grc_ro_auditor_restricted holds read-only privileges (criterion 1) > logs in through GraphService.readAs" give the same result every time, alone or in the full suite. If the cause is in the code rather than the test, fix it there.

**Decisions:** D171 (no retries; a test that fails then passes is a bug; builders' tests run 3 times), D176 (never weaken live privileges or shared state to prove a test), D167 and D185 (a fix to existing tests is handed in with `fixReason`), D173 (none skipped), D174 (new tests agree with older ones), D177 (test kinds), D57 and D73 (the 28 read-only Neo4j accounts, passwords only in `.env`), D131 (the query accounts). Read the TEST shared notes above.

**Background:**
- The test is in `packages/api/tests/graph-accounts/accounts.db.test.ts` (the `describe.each(ACCOUNTS)` block at line 166, the test at line 193). It calls `requireReadAs(graph).readAs(org.orgId, 'auditor', 'restricted', …)` and runs `RETURN 1`.
- It passed in TEST-006's integrator full run, then failed on the next full `pnpm test` on the same code (the finish check's rerun) with `Neo4jError: Connection was closed by server`, thrown during Bolt login (`BoltProtocol._onLoginError`). So the DBMS refused or dropped the connection at login, before the query ran.
- The file was last changed in `06e45da` (TEST-001, the rename to `.db.test.ts`).
- Candidates to check against the code and the DBMS's own logs and settings (read them, never change them). They're candidates, not findings:
  - **Auth throttling or failed-login lockout.** Neo4j limits failed logins per account (`dbms.security.auth_max_failed_attempts`, `auth_lock_time`). Does any test in the full run log in as a `grc_ro_*` account with a wrong password on purpose, or before `pnpm setup:neo4j` has set the password?
  - **Several test files running `pnpm setup:neo4j` at once.** `beforeAll` in this file calls `runSetupNeo4j()` (line 86), and so do `query-guard-live`, `writes`, `timeout`, `outside-access` and `visibility` in the same folder, plus `packages/api/tests/graph/setup-neo4j.db.test.ts`, `graph/org-database.db.test.ts` and `outbox/helpers.ts`. If Vitest runs these files in parallel, can one run's setup briefly change or recreate the account, its password or its roles while another file logs in? Check `packages/infra/scripts/setup-neo4j.ts` for what a re-run actually does to an existing user.
  - **Too many connections.** Does each `readAs` open a new driver or a new session per account, and are they all closed? Compare the total against the DBMS's connection limits during a full run.
  - **Another process using the DBMS at the same time** (another agent's run, the running grc-api or grc-worker).
  - **A driver or session not closed** in this file's helpers (`packages/api/tests/graph-accounts/helpers.ts`, `newGraph`) or in `GraphService.readAs` itself.

**Who does what:**
1. **Test writer** finds the cause from the code and from read-only looks at the DBMS (its logs, `SHOW USERS`, settings), and says in its hand-off, with file and line, whether a real user of the app could hit the same failed login.
2. **If the cause is only in the test** (for example test files racing each other's setup, or a test helper that leaks connections): fix the existing test files and hand in with `fixReason`, green. No builder.
3. **If the cause is real** (for example `GraphService.readAs` leaks connections, or the app logs in in a way the DBMS can throttle): write a test that reproduces it **every time** and hand in red. Then **builder-platform** (M0-005 owner) makes the smallest change in the app code that removes the cause. Both reviewers check it.

**Files:**
- Modify (test writer, test-only route): `packages/api/tests/graph-accounts/accounts.db.test.ts`, and `packages/api/tests/graph-accounts/helpers.ts` or other existing test files if the fix belongs there. A `fixReason` hand-in can't add new files or touch non-test files (D185).
- Real-cause route: the test writer may add one new `*.db.test.ts` file under `packages/api/tests/graph-accounts/` for the reproducing test (a normal red hand-in, not a fix). The builder modifies only the app code that holds the cause (for example `packages/api/src/graph/`).
- Don't touch `.env`, `packages/infra/scripts/setup-neo4j.ts` (unless it's the real cause and the builder's smallest fix), `compose.yaml` or Neo4j's settings.

**Pass criteria:**
1. The hand-off names the cause, with the file and line (or the DBMS log line) that explains it, and how the fix removes it.
2. The fixed test still checks what it checked before: each of the 28 accounts logs in through `GraphService.readAs` with the password in `.env` and gets `[1]` back from `RETURN 1`. Nothing is loosened: no skipping accounts, no catching the login error.
3. No retries, and no longer timeouts or sleeps to hide the cause (D171). A bounded wait for a condition is fine only if the hand-off explains why its limit covers the worst case.
4. Never change live Neo4j privileges, passwords, lockout or connection settings, and never restart the DBMS, to prove the cause or the fix (D176). Experiments happen only in the worktree's test code.
5. Real-cause route only: the reproducing test is red on every run before the builder's change and green on every run after it. The 28 accounts keep exactly their read-only privileges (M0-005, D73).
6. `pnpm --filter api test -- graph-accounts` passes 3 times in a row, with nothing skipped (D171, D173), then the whole `pnpm --filter api test:db` passes once. The hand-off records the counts, and names the earlier tests it agrees with (D174), including M0-005's graph-accounts tests and `graph/setup-neo4j.db.test.ts`.
7. Security-matrix rows: no new record type or route, so no new rows (D175).

**Tests to write:** kind `db` (they need the running Neo4j DBMS). Test-only cause: fix the existing test; no new file. Real cause: one reproducing test that is red every time until the builder's change.

**Test command:** `pnpm --filter api test -- graph-accounts`

---

Task: TEST-008

**Goal:** Make the front-door test "the door's own 413 for an upload over 25 MB" in `packages/infra/tests/front-door/headers.stack.test.ts` read the door's answer every time, the way TEST-006 fixed the same race in `body-size.stack.test.ts`.

**Decisions:** D171 (no retries; a test that fails then passes is a bug), D185 and D167 (a fix to an existing test, handed in with `fixReason`), D176 (never weaken shared state to prove a test), D53 and D64 (25 MB door cap, security headers on every response, including the door's own 413), D173 (none skipped), D174 (new tests agree with older ones), D177 (test kinds). Read the TEST shared notes above.

**Background:**
- The test is at `packages/infra/tests/front-door/headers.stack.test.ts:96`. It streams `UPLOAD_CAP_BYTES + 1` bytes to `/api/v1/intake/uploads` and checks status 413 and the D64 headers (`expectD64Headers`).
- Caddy refuses the declared size and closes while the client is still writing the body. Whether the client sees the 413 or its own write error (EPIPE or ECONNRESET) first varies from run to run. TEST-006 found this race in `body-size.stack.test.ts` (commit 7470dcc).
- TEST-006's fix is the `expectContinue` option in `packages/infra/tests/front-door/helpers.ts` (`SendOptions.expectContinue`, about lines 87-95; used in `collect()` and `headersFor()`). The client sends `Expect: 100-continue` and holds the body back, so a door that refuses the size answers before any body byte is sent. If the door asks for the body instead, the whole body is sent, so a door that lets the request through is still caught. `body-size.stack.test.ts` uses it as `REFUSED_BY_SIZE` (line 33).

**Who does what:** The test writer only. No builder.

**Files:**
- Modify (test writer): `packages/infra/tests/front-door/headers.stack.test.ts` only. Add `expectContinue: true` to that one request. `helpers.ts` needs no change. If it does, say why.
- Don't touch the Caddyfile, app code, `compose.yaml`, `.env` or any other test.

**Pass criteria:**
1. The test sends its 25 MB + 1 byte request with `expectContinue: true`, and still checks status 413 and every D64 header on the answer. Nothing is loosened: no accepting 0 or 502, no `cutShortOk`, no dropped header check, and the size stays `UPLOAD_CAP_BYTES + 1`.
2. No retries, and no sleeps or longer timeouts (D171).
3. Nothing shared is changed (D176): no container restarts, and no Caddy or rate-limit changes.
4. `pnpm --filter infra test -- headers` passes 3 times in a row, then `pnpm --filter infra test:stack` passes once, with nothing skipped (D173). The hand-off records the counts and names the earlier tests it agrees with (D174): TEST-006's size-cap tests in `body-size.stack.test.ts` and M0-016's header tests.
5. Hand in with `fixReason` (for example "the door's 413 raced the client's EPIPE on the 25 MB + 1 body; fixed by sending Expect: 100-continue so no body is written before the answer"). The finish check then expects green.
6. Security-matrix rows: no new record type or route, so no new rows (D175).

**Tests to write:** No new test file. Fix the existing test (kind: `stack`; it needs the running stack and Caddy).

**Test command:** `pnpm --filter infra test -- headers`

---

### S1 shared notes (every S1 brief includes these)
S1 is slice 1, "Records and the risk register" (D76). It runs alone, before the S2+S3+S7 group (D181). The M0 shared notes above (layout, test ownership, throwaway databases, one test process, names) still apply.

- **Scope (planner's reading, D27, D76):** the five core record types of the spec's ontology (Asset, Risk, Control, Policy, Incident), their links, and their screens: the Risk register (screen 2), Controls (3), Policies (4), Assets with the dependency map (5) and Incidents (6). No other slice owns screens 3–6. Framework, Requirement, SATISFIES and MAPS_TO come with S2. Evidence and AuditFinding come with S3 (D202). There's no real Gemma or bge-m3 anywhere in S1.
- **The user's S1 answers (2026-09-28):** D196 (record numbers), D197 (field values and risk rating), D198 (no label above one's own clearance), D199 (Control Owners don't create controls), D200 (who may add a link), D201 (removing a link added by mistake), D202 (Evidence and Audit findings in S3), D203 (name embedding left empty), D204 (the asset map), D205 (the plan, readings, names and skills).
- **Folders S1 owns (D183):** `packages/api/src/records/`, `packages/shared/src/records/`, `packages/web/src/features/records/`, plus the files each brief names.
- **Code style already in the repo:**
  - Nest decorators are applied as plain calls, not `@` syntax. Copy `packages/api/src/identity/me.controller.ts` and `api-keys.controller.ts`.
  - Each route is documented with `documentRoute` (`packages/api/src/common/openapi.ts`). Inputs and outputs are Zod schemas.
  - Errors use `ApiError(status, code, message)` and leave in the one D47 format (`packages/api/src/common/errors.ts`).
  - Lists use `pageQuerySchema` and `Paged<T>` (`packages/api/src/common/paging.ts`).
- **The graph (D26, D37, D45.4, D73):**
  - Every write goes through `AuditOutbox.withAuditedWrite(orgId, actor, fn)` (`packages/api/src/audit/outbox.ts`), as `grc_writer`, in `org-<orgId>`. The change and its audit entry land in one Neo4j transaction, and the worker's relay copies the entry to Postgres within 5 s.
  - Reads go through `GraphService.readAs(orgId, role, clearance, fn, { timeoutMs })`. That runs as the role × clearance read-only account, so Neo4j itself hides record types the role can't view and records above the clearance, and it hides every link with a hidden end. That's the second check D45.3 and D59 ask for.
  - **One exception, the "own" cells:** `packages/api/src/graph/privileges.ts` gives the `control_owner` accounts no MATCH on `Control`, because a shared account can't know who owns what. So a Control Owner's control reads run as the writer, always with `owner = <their user ID>` **and** `sensitivity IN <labels at or below their clearance>` in the query.
  - Never pass Cypher with `USE`, and never change Neo4j privileges or accounts (D131, D144, D176).
- **Record properties in Neo4j (D68, D69, D73):**
  - The node labels are `Asset`, `Risk`, `Control`, `Policy` and `Incident`.
  - Every record has these properties:
    - `id`: a lowercase UUID, the internal ID and the same one Postgres uses.
    - `number`: the on-screen number, for example `RSK0001014`.
    - `sourceIds`: a list of strings, empty for records made by hand.
    - `name`.
    - `sensitivity`: the D51 label. The query accounts filter on this exact property name, and a node without it is invisible.
    - `status`: `active` or `retired`.
    - `owner`: a user ID.
    - `version`: an integer that starts at 1 and goes up by 1 on every change.
    - `createdAt`, `createdBy`, `updatedAt` and `updatedBy`.
    - `origin`: `manual`, `import` or `ai`. S1 only makes `manual` records.
    - `nameEmbedding`: a list of 1024 floats. S1 never sets it and never loads bge-m3; S4's embedding step fills it for new and changed records (D203).
  - Each type's own fields. They're renamed where they would clash with the record's own `status`, `version` or type:

    | Type | Fields |
    |---|---|
    | Asset | `assetType`, `criticality`, `dataClassification` |
    | Risk | `impact`, `likelihood`, `financialExposure` |
    | Control | `code`, `framework` (plain text until S2), `controlStatus`, `lastTestedDate` |
    | Policy | `policyVersion`, `effectiveDate` |
    | Incident | `severity`, `incidentStatus`, `occurredAt` |

  - Links carry `createdAt`, `createdBy` and `origin`. AI links come later (S4) with `sourceDocId`, `chunkId`, `sentence`, `model` and `promptVersion`.
- **Audit entries (D56, D69, D186):**
  - Action names are `record.created`, `record.updated`, `record.retired`, `link.created` and `link.removed` (D201, S1-011).
  - `targetType` is the record type (`asset` … `incident`) or `link`, and `targetId` is the record's `id`.
  - `before` and `after` hold only the changed fields.
  - `meta` holds `{ number, label }`. The label is kept so that S7's viewer can hide the contents of entries above the reader's clearance (D186).
- **No record values in logs (D163, D164):** a log line or error output about a record or an audit entry names only the error type or code and the IDs. It never includes names, field values or before/after contents.
- **API paths (D47):** the plural type names `/api/v1/assets`, `/api/v1/risks`, `/api/v1/controls`, `/api/v1/policies` and `/api/v1/incidents`. A record the caller can't see (another org, a type their role can't view, a label above their clearance, or a control they don't own) gets **404** `not_found`, the same as a record that doesn't exist, so nothing leaks. A type the role can never view gets 403 on its list route.
- **Security matrix (D175, D59):** every new route gets its row in `packages/shared/src/access/security-matrix.ts` in the same task. The security reviewer checks the rows and their D59 tests.
- **Tests (D96, D171, D173, D174, D176, D177):**
  - Test files belong to the test writer.
  - Name each file by what it needs: `*.unit.test.ts(x)`, `*.db.test.ts`, `*.stack.test.ts`, or `e2e/*.e2e.ts`. Prefer `unit`.
  - API route tests run an in-process Nest app against the throwaway databases, which makes them `db`. The M0 examples are in `packages/api/tests/api-keys/`.
  - Builders' tests run 3 times, all green. Skipped tests count as failures. New tests must agree with the older ones.
  - Never weaken live privileges, accounts, settings or shared state to prove a test; prove red in the worktree's code only.
- **Migrations (D183):** S1 is expected to need no Postgres migration. If one turns out to be needed, the brief's "a new migration" applies: never pick its number, because the integrator numbers it at merge.
- **Hot files (D183):** each brief lists its hot files, and only one task at a time changes each one.
- **Git (D112, D159):** branch `task/<ID>`, in its own worktree. Commit messages start with the task ID and never mention Claude, Anthropic or AI tooling.

---

Task: S1-001

**Goal:** One shared definition of the five record types and their links, used by the API, the web app and (later) the generators, so every part of the product agrees on fields, allowed values, numbers and which links make sense.

**Decisions:** D66–D69, D73 (fields), D68 (numbers like `RSK0001014`), D51 (default labels, `defaultLabel` already in `packages/shared/src/access/labels.ts`), the spec's ontology (`enterprise_integrated_risk_management_irm_architecture_specification.md` §2), D30 (Zod), D45.2, **D196** (record numbers), **D197** (field values and risk rating), D202 (no Evidence or AuditFinding here), D203 (no embeddings). Read the S1 shared notes.

**The user's answers this task uses:**
- **Numbers (D196):** `NUMBER_PREFIX` is `{ risk: 'RSK', asset: 'AST', control: 'CTL', policy: 'POL', incident: 'INC' }`, followed by 7 digits. Counting is per org and per type and starts at 1001 (`RSK0001001`); S1-003 owns the counter. `formatNumber` itself still accepts any n from 1 to 9,999,999.
- **Values (D197).** Stored values are lowercase, with `_` between words; the web shows the plain words:
  - `RISK_SCALE = [1, 2, 3, 4, 5]` for `impact` and `likelihood`. `riskRating` gives `score = impact × likelihood` and the band `low` for 1–4, `medium` for 5–9, `high` for 10–16 and `critical` for 17–25.
  - `financialExposure`: a whole number of dollars (no cents), not negative.
  - `ASSET_TYPES = ['server', 'application', 'database', 'network_device', 'cloud_service', 'endpoint']`.
  - `CRITICALITIES = ['low', 'medium', 'high', 'critical']`.
  - `CONTROL_STATUSES = ['not_implemented', 'planned', 'implemented']`.
  - `INCIDENT_SEVERITIES = ['low', 'medium', 'high', 'critical']`.
  - `INCIDENT_STATUSES = ['new', 'investigating', 'contained', 'resolved', 'closed']`.

**Hot files:** `packages/shared/src/index.ts`.

**Files:**
- Create: `packages/shared/src/records/types.ts` (the five record types, `RecordKind = 'asset' | 'risk' | 'control' | 'policy' | 'incident'`, and the plural API names), `schemas.ts`, `values.ts`, `numbers.ts`, `rating.ts`, `links.ts` and `index.ts`.
- Modify: `packages/shared/src/index.ts`, to export `./records/index.js`.

**Interfaces (produces), exact names:**
- `RECORD_KINDS`, `RecordKind`, `RECORD_PATHS: Record<RecordKind, 'assets'|'risks'|'controls'|'policies'|'incidents'>`, and `NODE_LABELS: Record<RecordKind, 'Asset'|'Risk'|'Control'|'Policy'|'Incident'>`.
- Per kind, three schemas:
  - `createSchemas[kind]`: the input to create a record. It has `name`, an optional `owner`, an optional `label` and the type's own fields. The server sets `id`, `number`, `status`, `version` and the timestamps, so they aren't in it.
  - `updateSchemas[kind]`: every editable field optional, plus a required `version: number`.
  - `recordSchemas[kind]`: the full record as the API returns it. It has the common fields from the shared notes, with `label` (the API's name for `sensitivity`), plus the type's own fields.
- The D197 value lists above, as `as const` arrays with their types: `ASSET_TYPES`, `CRITICALITIES`, `CONTROL_STATUSES`, `INCIDENT_SEVERITIES`, `INCIDENT_STATUSES`, `RISK_SCALE` (the allowed impact and likelihood numbers). `dataClassification` uses `LABELS`.
- `formatNumber(kind, n: number): string`, `parseNumber(text): { kind, n } | null`, `NUMBER_PREFIX: Record<RecordKind, string>` and `FIRST_NUMBER = 1001` (D196).
- `riskRating(impact, likelihood): { score: number; band: 'low'|'medium'|'high'|'critical' }` (D197).
- `LINK_TYPES`: the spec's six, as `{ type, from, to }`:
  - `HOSTS` and `RUNS`: asset → asset.
  - `EXPOSED_TO`: asset → risk.
  - `MITIGATED_BY`: risk → control.
  - `GOVERNED_BY`: control → policy.
  - `IMPACTS`: incident → asset.
  - `EXPOSES`: incident → risk.
- `isAllowedLink(type, fromKind, toKind): boolean`, and `linkTypesBetween(fromKind, toKind)`.

**Pass criteria:**
1. Each create schema accepts a valid record and refuses, with a field-named message:
   - a missing or empty `name`;
   - an unknown value from a list;
   - an impact or likelihood outside 1–5 or not a whole number (D197);
   - a `financialExposure` that is negative or has cents (D197);
   - an unknown field;
   - a label that isn't one of `public`, `internal`, `confidential` or `restricted`.
2. Each update schema needs `version` (a whole number of at least 1), and refuses `id`, `number`, `status` and `version`-less bodies.
3. `formatNumber('risk', 1014)` is `RSK0001014`, and `formatNumber` gives `AST`, `CTL`, `POL` and `INC` for the other kinds (D196). It pads to 7 digits and refuses numbers below 1 or above 9,999,999. `parseNumber` round-trips every kind and returns `null` for anything else (a wrong prefix, lowercase, 6 or 8 digits). `FIRST_NUMBER` is 1001.
4. `riskRating` gives the D197 score and band for every pair on the scale: a table-driven test of all 25 pairs, including the scores on each side of a band edge (4 and 5, 9 and 10, 16 and 20; no pair makes 17). It refuses numbers off the scale.
5. `isAllowedLink` is true for exactly the six rows above in their stated direction. It's false for the reverse direction, for unknown types and for unknown kinds.
6. Nothing in `packages/shared/src/records/` imports from `packages/api` or `packages/web`, or touches the network, the filesystem or the environment.

**Tests to write (kind `unit`):** `packages/shared/tests/records/schemas.unit.test.ts`, `numbers.unit.test.ts`, `rating.unit.test.ts` and `links.unit.test.ts`. The existing `packages/shared/tests/access/*.unit.test.ts` must still pass. Security-matrix rows: none (no route; the five record types already have rows).

**Test command:** `pnpm --filter shared test -- records`

---

Task: S1-002

**Goal:** Every org's graph database carries the D73 constraints and indexes. Numbers and IDs are then unique, list filters are fast, and duplicate matching (S4) has its full-text and vector indexes ready.

**Decisions:** D73 (the index list), D70 (full-text and vector indexes in Neo4j do the duplicate matching), D71 (1024 dimensions, cosine), D22 (one database per org), D45.5 (re-runs are safe), D133 (org provisioning), D170 (Mac scripts swap the database host themselves), D57, D176. Read the S1 shared notes.

**Hot files:** `package.json` (root; adds the `graph:schema` script).

**Files:**
- Create: `packages/api/src/graph/org-schema.ts`, with two exports:
  - `orgSchemaStatements(): string[]`: pure, and returns every statement in order.
  - `ensureOrgSchema(graph, orgId): Promise<void>`: runs them as `grc_admin` or `grc_writer` in `org-<orgId>`, every statement `IF NOT EXISTS`.
- Create: `packages/infra/scripts/graph-schema.ts` (root script `graph:schema`). It applies `ensureOrgSchema` to every existing org, finding the orgs the way the outbox relay does (`AuditService.orgIds()`), and uses the D170 host swap from `org-script-env.ts` or `host-address.ts`. It prints only org IDs and OK or failed per org, never values (D164).
- Modify: `packages/api/src/identity/provision-org.ts`, to call `ensureOrgSchema` right after `createOrgDatabase`. A re-run is still safe.
- Modify: `package.json` (root script only).

**What the statements create.** This covers all nine record labels from `NODE_RECORD_TYPES` in `packages/api/src/graph/privileges.ts`, so S2 and S3 don't need to touch this file for their types:
1. A uniqueness constraint on `id`, and one on `number`, for each of the nine labels.
2. Range indexes on these fields:
   - `status`, `sensitivity` and `owner` on each label;
   - `assetType` on Asset;
   - `framework` on Control and on Requirement.
3. One full-text index, `record_names`, over `name` and `sourceIds` on all nine labels.
4. Vector indexes on `nameEmbedding`, one per label, with 1024 dimensions and cosine similarity.
5. A relationship property index on `sourceDocId` for each of the 10 link types: HOSTS, RUNS, EXPOSED_TO, MITIGATED_BY, GOVERNED_BY, IMPACTS, EXPOSES, SATISFIES, MAPS_TO, SUPPORTS and CONCERNS.
6. Index and constraint names are fixed and readable, for example `asset_id_unique`, so re-runs match.

**Pass criteria:**
1. `orgSchemaStatements()` returns the statements above, each with `IF NOT EXISTS`, and none contains `USE` (D144).
2. After `ensureOrgSchema` on a throwaway org database, `SHOW CONSTRAINTS` and `SHOW INDEXES` list every expected name, and each one is `ONLINE`.
3. Running it twice changes nothing and throws nothing.
4. Two nodes with the same label and the same `number` (or `id`) are refused by the database.
5. `provisionOrg` gives a new org the schema, and a re-run of `provisionOrg` stays safe. The existing provision tests still pass.
6. `pnpm graph:schema` applies the schema to every org and exits 0. With one org's database missing, it names that org as failed, carries on with the others, and exits non-zero.
7. The query accounts' privileges don't change. The M0-005 `graph-accounts` tests and `pnpm test:env`'s DENY check still pass.

**Tests to write:**
- `packages/api/tests/org-schema/statements.unit.test.ts` (unit): criterion 1.
- `packages/api/tests/org-schema/ensure.db.test.ts` (db, a throwaway Neo4j database): criteria 2–5.
- `packages/infra/tests/graph-schema/graph-schema-script.db.test.ts` (db): criterion 6. Use a throwaway org only; never drop or break a real org's database.
- Security-matrix rows: none (no route, no new record type).

**Test command:** `pnpm --filter api test -- org-schema` (the builder also runs `pnpm --filter infra test -- graph-schema`)

---

Task: S1-003

**Goal:** The records service. It creates, reads, lists, updates and retires the five record types with every rule the plan sets, and puts each change and its audit entry in one Neo4j transaction.

**Decisions:** D26, D37 (outbox), D45.3, D45.4, D45.6 (our code decides), D50 (role table; "own" means assigned to that user), D51 (labels and clearance; defaults; editors may raise a label, only an Admin may lower one), D59, D68 (numbers), D69 (version check, retire not delete, history in the audit trail), D73. Also **D196** (numbers start at 1001 per org and type), **D197** (risk rating), **D198** and **D199**. Read the S1 shared notes.

**The user's answers this task uses:**
- **D198:** a create or update whose label is above the caller's own clearance is refused with 403 `forbidden`, and nothing is saved. This holds for every role, Admin included, and for API keys (their clearance is the key's).
- **D199:** a Control Owner (`edit_own` on controls) may update and retire only the controls whose `owner` is their user ID. Creating a control needs the full `edit` cell (Admin, Compliance Manager); a Control Owner's create is 403.
- **D196:** the first record of each type in each org gets 1001 (`RSK0001001`), then 1002, and so on.

**Hot files:** `packages/api/src/records/records.module.ts`.

**Files:**
- Create: `packages/api/src/records/records.service.ts`, `packages/api/src/records/record-numbers.ts`, `packages/api/src/records/record-queries.ts` (the Cypher; the list and filter building), and `packages/api/src/records/owners.ts` (checks an owner is a member of the org).
- Modify: `packages/api/src/records/records.module.ts`, to provide `RecordsService` and export it.

**Interfaces:**
- Consumes:
  - `AuditOutbox.withAuditedWrite` and `GraphService.readAs` / `read`.
  - `withOrgContext` and the `member` table (`packages/api/src/identity/schema.ts`).
  - From `@grc/shared`: `can`, `isVisible`, `defaultLabel`, `canChangeLabel`, and S1-001's schemas, `formatNumber` and `riskRating`.
- Produces:
  - `RecordsService`, where `Caller = { orgId, userId, role, clearance, apiKeyId? }`:
    - `create(caller, kind, input): Promise<RecordOut>`
    - `get(caller, kind, id): Promise<RecordOut>`
    - `list(caller, kind, query): Promise<Paged<RecordOut>>`
    - `update(caller, kind, id, input): Promise<RecordOut>`
    - `retire(caller, kind, id, version): Promise<RecordOut>`
  - A risk's `RecordOut` includes `rating: { score, band }`.
  - Errors: `ApiError(404,'not_found')`, `ApiError(403,'forbidden')`, `ApiError(409,'stale_version', 'This record changed since you opened it. Reload it and try again.')`, and `ApiError(400,'validation_failed')`.
  - `RECORD_READ_TIMEOUT_MS = 5000`.

**Pass criteria:**
1. **Create:**
   - Gives a new lowercase UUID, and the next number for that org and type, taken from a counter node (`:RecordCounter {kind}`) in the same write transaction. The first number is `FIRST_NUMBER` (1001, D196). 50 creates at once in one org give 50 different numbers with no gaps. Two orgs count separately, and so do two types.
   - Sets `status` `active` and `version` 1.
   - Sets the label from `defaultLabel` unless one is given. The label is saved as `sensitivity`.
   - Sets `owner` to the caller unless one is given. The owner must be a member of the same org, or the call gets 400. An API-key caller must name an owner.
2. **Permissions:**
   - Create, update and retire need the D50 cell `edit` for that type.
   - For `edit_own` (a Control Owner on controls), update and retire are allowed only on controls they own. Create is 403 (D199).   - Anything else gets 403. For a record the caller can't see, it's 404.
3. **Reads:**
   - `get` and `list` run through `readAs` with the caller's role and clearance, except the Control Owner's control reads (see the shared notes).
   - A record hidden by type, label, org or ownership is 404 on `get`, and never appears in `list`. `list`'s `total` counts only visible records.
4. **List:**
   - It pages with `pageQuerySchema`.
   - It filters by `status` (`active` by default, or `retired` or `all`), `owner` and `label`, by each type's list fields (`assetType`, `criticality`, `controlStatus`, `framework`, `severity`, `incidentStatus`, and the risk `band`), and by `q`, a case-insensitive "contains" on name or number.
   - It sorts by `number` (the default), `name` or `updatedAt`, and by `score` for risks, ascending or descending.
   - An unknown filter or sort field is 400.
5. **Update:**
   - A body whose `version` isn't the stored one gets 409 `stale_version`, and nothing changes.
   - Otherwise only the given fields change, `version` goes up by 1, and `updatedAt` and `updatedBy` are set. Two updates at once with the same version: exactly one wins, and the other gets 409.
6. **Labels:**
   - A label change follows `canChangeLabel` (raise: editors; lower: Admin only).
   - A label above the caller's own clearance is refused on create and on update, for every role (D198).
   - A refused label is 403, and nothing changes.
7. **Retire:**
   - Sets `status` `retired`, with the same version check. Nothing is ever deleted (D69).
   - A retired record still opens with `get`, and appears in `list` only with `status=retired` or `all`.
8. **Audit:**
   - Every create, update and retire writes its entry through `withAuditedWrite` in the same transaction, with the action names, targets, before/after (changed fields only) and `meta { number, label }` from the shared notes.
   - If the transaction fails, neither the change nor its entry is kept.
   - The entry reaches the Postgres audit trail through the existing relay, with `actorType` `user` or `api_key`.
9. **Nothing leaks into logs:** a failing write logs only the error type or code and the IDs (D163, D164).

**Tests to write (kind `db`: throwaway Postgres and Neo4j databases, schema from S1-002's `ensureOrgSchema`):** `packages/api/tests/records-service/*.db.test.ts`. They cover each criterion, including:
- the 50-at-once numbering;
- the two-writers version race;
- every role × kind × action from `ROLE_TABLE` at the service level;
- every clearance × label pair on `get` and `list`;
- an org pair (a record of org B is 404 from org A);
- Control Owner own and not-own, and a Control Owner's create refused (D199);
- every clearance × label pair on create and on a label change: allowed at or below the caller's clearance, 403 above it (D198);
- the first number of each type in a fresh org is `…0001001` (D196).

A unit test for the query building (`record-queries.ts`) is welcome as `*.unit.test.ts`. Security-matrix rows: none (no route in this task).

**Test command:** `pnpm --filter api test -- records-service`

---

Task: S1-004

**Goal:** The record routes. People and machines can list, open, create, edit and retire the five record types through `/api/v1`, with every D59 proof in place. The owner picker also gets its people list.

**Decisions:** D30, D47 (paging, filters, sorting, one error format), D50, D51, D54 (API keys: one org, one role), D55 (org wall), D59, D69, D163 and D164 (SF-006: the error handler must not log audit or record values once routes write them), D175, D176. Read the S1 shared notes.

**Hot files:** `packages/shared/src/access/security-matrix.ts`, `packages/api/src/records/records.module.ts`.

**Files:**
- Create: `packages/api/src/records/records.controller.ts`. It makes one controller per kind, from a small factory (for example `recordsController(kind)`), so each route has a fixed `@Requires(<kind>, 'view'|'edit')`. Also create `packages/api/src/identity/people.controller.ts`.
- Modify:
  - `packages/api/src/records/records.module.ts` (the controllers);
  - `packages/api/src/identity/identity.module.ts` (the people controller);
  - `packages/api/src/access/access.guard.ts` and `requires.decorator.ts` (the "own" pass-through below);
  - `packages/api/src/common/errors.ts` (log only the type, code and reference ID for unexpected errors);
  - `packages/shared/src/access/security-matrix.ts` (the new rows).

**Routes.** For each kind, `P` is its plural path:

| Route | Needs | Body or query | Answer |
|---|---|---|---|
| `GET /api/v1/P` | `view` | the S1-003 list query | `Paged<Record>` |
| `GET /api/v1/P/:id` | `view` | | 404 when not visible |
| `POST /api/v1/P` | `edit` | the create schema | 201 with the record |
| `PATCH /api/v1/P/:id` | `edit` | the update schema, with `version` | the record, or 409 `stale_version` |
| `POST /api/v1/P/:id/retire` | `edit` | `{ version }` | the record |

`GET /api/v1/people` needs any signed-in user. It's paged and returns the caller's org members as `{ id, name, role }` only, with no email and no clearance, for the owner picker.

**The "own" cells:** today `AccessGuard` calls `can(role, subject, action)` with no owner, so a Control Owner is refused on every control route. Extend the requirement with an opt-in flag, for example `Requires('control', 'edit', { own: true })`, set on the control routes only:
- If the cell is `edit_own` and the flag is on, the guard lets the request through and sets `request.ownOnly = true`.
- The service then applies the ownership rule, 404 on anything not owned.
- Every other cell behaves exactly as before. The M0 `access-guard` tests must still pass unchanged.

**Pass criteria:**
1. The 25 record routes and `GET /api/v1/people` exist under `/api/v1`, are in the OpenAPI document with their Zod schemas, and each has its row in `SECURITY_MATRIX`:
   - The record routes: access `{ subject: <kind>, action: 'view'|'edit' }`, `orgWalled: true`, `labels: true`.
   - People: `'any signed-in'`, `orgWalled: true`, `labels: false`.
   - The TEST-003 completeness test passes.
2. **D59, every role cell:** for each of the 7 roles × 5 kinds × 5 routes, the answer matches `ROLE_TABLE`: allowed, 403, or for "own", allowed only on owned controls (update and retire), with `POST /api/v1/controls` 403 for a Control Owner (D199). A create or update with a label above the caller's clearance is 403 (D198).
3. **D59, every org pair:** with 3 orgs, for each ordered pair (A, B), A's users get 404 on B's record IDs for every route, and B's records never appear in A's lists.
4. **D59, every clearance × label pair:** for 4 × 4, `GET :id` is 200 or 404, and `GET` list includes or leaves out the record as `isVisible` says.
5. API keys follow the same rules with their one role and one org (D54). A key of org A can't reach org B.
6. Stale save gives 409 `stale_version` in the D47 format, and the record is unchanged. Retire keeps the record; it's never deleted.
7. After a create, update and retire, the Postgres audit trail has the three entries with `meta { number, label }` within 5 s (relay).
8. **SF-006:** an unexpected error on a record route logs only the error type or code, the reference ID, the method and the URL. A test forces a failure with a sentinel record name and checks that the sentinel isn't in the log (D163, D164).
9. Lint and type checks are clean. Existing tests (`access-guard`, `api-keys`, `security-matrix`, `platform`) still pass.

**Tests to write:**
- `packages/api/tests/records-api/*.db.test.ts` (db, in-process Nest app like `packages/api/tests/api-keys/`): criteria 2–8. Generate the role, org-pair and clearance × label cases from `ROLE_TABLE`, `ROLES` and `LABELS` rather than writing them out, so the matrix can't drift.
- `packages/api/tests/records-api/guard-own.unit.test.ts` (unit): the guard's `own` flag, with a fake execution context.
- New security-matrix rows: the 25 record routes and `GET /api/v1/people` (list them in the hand-off).

**Test command:** `pnpm --filter api test -- records-api`

---

Task: S1-005

**Goal:** Links between records. A person can say "this risk is mitigated by that control", see a record's related records, and open the dependency map around an asset. The ontology and the visibility rules are enforced by our code and by Neo4j.

**Decisions:** the spec's six links (S1-001's `LINK_TYPES`), D45.3, D45.4, D51 (a link is visible only if both ends are, `isLinkVisible`), D59, D69 (links record who and when; history in the audit trail), D73. Also **D200** (who may add a link) and **D204** (the asset map). Removing links isn't part of this task: it's S1-011 (D201), which builds on this task's rule function and service. Read the S1 shared notes.

**The user's answers this task uses:**
- **D200:** a person may add a link when they can **edit either** of the two records (the D50 `edit` cell for that record's type, or `edit_own` on a control they own) **and** can **see both** (type, org, clearance, and for a Control Owner, ownership of any control end). Export the rule as a pure function, `canLinkRecords(caller, from, to): boolean` in `packages/shared/src/records/link-rules.ts` (exported from `packages/shared/src/records/index.ts`), where `caller` is `{ userId, role, clearance }` and `from` and `to` are `{ kind, label, owner }`. It uses `can` and `isVisible`. The service, S1-011 and the web (S1-008, S1-012) all use this one function.
- **D204:** the map is centred on one asset. `depth` is 1, 2 or 3 and defaults to 2. It follows HOSTS and RUNS in both directions. It stops at 200 assets (the centre included) and then returns `truncated: true`. `MAP_DEFAULT_DEPTH = 2`, `MAP_MAX_DEPTH = 3` and `MAP_MAX_NODES = 200` live in `@grc/shared` (`packages/shared/src/records/links.ts`, added by this task) so S1-009 uses the same numbers.

**Hot files:** `packages/shared/src/access/security-matrix.ts`, `packages/api/src/records/records.module.ts`.

**Files:**
- Create: `packages/api/src/records/links.service.ts`, `packages/api/src/records/links.controller.ts`, `packages/api/src/records/asset-map.ts` and `packages/shared/src/records/link-rules.ts`.
- Modify: `records.module.ts`, `security-matrix.ts`, `packages/shared/src/records/links.ts` (the three map constants only) and `packages/shared/src/records/index.ts` (the new export).

**Routes:**
- `POST /api/v1/links`, with body `{ type, fromId, toId }`, answers 201 with the link. Access is `'any signed-in'`: the service does the checks, because the rule depends on both ends.
- `GET /api/v1/P/:id/links` for each of the five kinds, with access `{ subject: kind, action: 'view' }`. It returns `{ items: [{ type, direction: 'out'|'in', other: { id, kind, number, name, label, status } , createdAt, createdBy }] }`.
- `GET /api/v1/assets/:id/map?depth=<n>`, with access `{ subject: 'asset', action: 'view' }`. It returns `{ nodes: [{ id, number, name, assetType, criticality, label }], edges: [{ type: 'HOSTS'|'RUNS', fromId, toId }], truncated: boolean }`, with the D204 depth (1–3, default 2) and cap (200 assets).

**Pass criteria:**
1. **Creating a link:**
   - Both ends must exist in the caller's org and be visible to the caller. Otherwise it's 404, the same answer whichever end is missing.
   - `isAllowedLink(type, fromKind, toKind)` must hold, or it's 400 `link_not_allowed`. So must `canLinkRecords` (D200: can edit either end), or it's 403. For example, a Risk Manager may link their risk to a control they can only view; a Viewer may link nothing.
   - A link to itself is 400. The same type, from and to twice is 409 `link_exists`.
2. **What a link saves:** `createdAt`, `createdBy` and `origin: 'manual'`, plus one `link.created` audit entry in the same transaction. The entry has `meta { type, fromNumber, toNumber, label }`, where the label is the higher of the two ends' labels.
3. **Listing links:**
   - `GET …/:id/links` runs through `readAs`, so a link with a hidden end is never returned, not even as a count.
   - The Control Owner path applies ownership and label to both ends.
   - The record itself not visible is 404.
4. **The map:**
   - It follows only HOSTS and RUNS, both directions, from the given asset, to the chosen depth (1–3; 2 when none is given).
   - It returns only visible assets and edges between them.
   - It stops at 200 assets with `truncated: true`, and `truncated` is `false` whenever nothing was left out. The same data gives the same nodes every time (D45.8).
   - A depth of 0, 4, a fraction or text is 400.
5. **D59:** every role × link route (from `ROLE_TABLE`), an org pair (A can't link to, list or map B's records, even by guessing IDs), and every clearance × label pair on list and map. That includes a link between a visible and a hidden record, which is invisible to the lower-clearance user.
6. The security-matrix rows for the 7 new routes are there, and the TEST-003 completeness test passes.

**Tests to write:**
- `packages/api/tests/links/*.db.test.ts` (db): criteria 1–5.
- `packages/api/tests/links/rules.unit.test.ts` (unit): `canLinkRecords` for every role × pair of kinds from `ROLE_TABLE` (D200), including Control Owner own and not-own control ends, and the ontology check, with no databases.
- `packages/api/tests/links/map-limits.db.test.ts` (db): the default depth, each depth 1–3, and a chain or star larger than 200 assets giving exactly 200 nodes and `truncated: true` (D204).
- New security-matrix rows: `POST /api/v1/links`, the five `GET /api/v1/P/:id/links` routes, and `GET /api/v1/assets/:id/map`.

**Test command:** `pnpm --filter api test -- links`

---

Task: S1-006

**Goal:** The reusable web pieces for records, and the first real screen, the **Risk register**. It has to look finished (D1): a ServiceNow-style list with the rating, a record page, and create and edit forms.

**Decisions:** D1, D2 (ServiceNow IRM look), D7, D27 (screen 2), D30 (typed client from OpenAPI), D33 (TanStack Router, Query, Table; React Hook Form; shadcn/ui), D47 (paging, filters, sorting), D50 and D51 (the web only hides buttons; the API decides, D7), D69 (stale-save message). Read the S1 shared notes.

**Hot files:** `packages/web/src/api/client.ts` (regenerated), `packages/web/src/router.tsx`, `packages/web/package.json` and `pnpm-lock.yaml` (adds `@tanstack/react-table`).

**Files:**
- Regenerate `packages/web/src/api/client.ts` with `pnpm gen:api-client`, after S1-004's routes are on `main`.
- Create in `packages/web/src/features/records/`:
  - `RecordTable.tsx`: server-side paging, sorting, filters and search, with the filters in the URL search params.
  - `RecordPage.tsx`: the detail view.
  - `RecordForm.tsx`: React Hook Form with the S1-001 Zod schemas.
  - `LabelBadge.tsx`, `OwnerPicker.tsx` (from `GET /api/v1/people`) and `RetireDialog.tsx`.
  - `useRecords.ts`: TanStack Query hooks around the client.
  - `permissions.ts`: uses `can` from `@grc/shared` with the signed-in user's role and ownership.
  - `risks/RiskRegister.tsx`, `risks/RiskPage.tsx` and `risks/RatingBadge.tsx`.
- Modify: `packages/web/src/router.tsx`. `/risks` becomes the register, and it adds `/risks/new` and `/risks/$id`. The other screens stay on `ScreenPage` until S1-007.

**Pass criteria:**
1. The register shows these columns: number, name, owner name, impact, likelihood, rating (score and a coloured band from `riskRating`), label and updated. It pages, sorts and filters through the API: by band, owner, label, status, and a search on name or number. The filters survive a page reload (URL).
2. The empty state keeps the M0 wording. The loading and error states show the API's message and reference ID.
3. The record page shows every field, the number as its title, the label badge, and owner and dates. "Edit" and "Retire" show only when `can(role, 'risk', 'edit')`. The API's 403 or 404 still show a clear message if the buttons were wrong.
4. **Create and edit forms:**
   - They validate with the shared schemas, showing field errors before sending.
   - The label chooser offers only the changes `canChangeLabel` allows, and never a label above the person's own clearance (D198).
   - The owner picker lists org members.
   - Save sends `version`.
5. **A 409 `stale_version`** shows "This record changed since you opened it", with a Reload button that loads the latest version. The person's typed changes are not silently thrown away: the message says they need to re-apply them.
6. Retire asks for confirmation, sends `version`, and the record drops out of the default list.
7. A 404 on `/risks/$id` shows "This record doesn't exist or you can't see it", the same for every cause.
8. All calls go through the generated client with relative `/api/v1` URLs (the M0-015 rule).

**Tests to write (kind `unit`, Vitest + Testing Library, API mocked at the client boundary like `packages/web/tests/auth/helpers.tsx`):** `packages/web/tests/records/*.unit.test.tsx`, covering criteria 1–8, with at least one test per role class: an editor, a viewer, and a role with no risk access, which isn't in D50 since every role can view risks, so use a mocked 403. Security-matrix rows: none (web only).

**Test command:** `pnpm --filter web test -- records`

---

Task: S1-007

**Goal:** The Controls, Policies, Assets and Incidents screens, built on S1-006's kit, so all five record screens work and look alike.

**Decisions:** D27 (screens 3–6), D50 (Incidents: no access for Control Owner and Viewer; Controls: Control Owner sees and edits only their own), D51, D69, D7. Read the S1 shared notes and S1-006's brief (the kit it builds).

**Hot files:** `packages/web/src/router.tsx`.

**Files:**
- Create in `packages/web/src/features/records/`: `controls/`, `policies/`, `assets/` and `incidents/`. Each holds a list and a page component that configure the kit: columns, filters and form fields.
- Modify: `packages/web/src/router.tsx` (`/controls`, `/policies`, `/assets` and `/incidents`, each with `/new` and `/$id`).
- Modify the kit only where a type needs something the risk register didn't, and say what in the hand-off.

**Pass criteria:**
1. **Each list's columns and filters:**
   - Controls: number, code, name, framework, `controlStatus`, owner, last tested. Filters: `controlStatus`, framework, owner.
   - Policies: number, name, `policyVersion`, effective date, owner.
   - Assets: number, name, `assetType`, criticality, data classification, owner. Filters: `assetType`, criticality.
   - Incidents: number, name, severity, `incidentStatus`, occurred at. Filters: severity, `incidentStatus`.
2. The forms carry each type's own fields with the S1-001 value lists.
3. A Control Owner's Controls list shows only their controls, with a note saying so, and they can edit those. They see no "New control" button (D199: creating a control needs full Edit, Admin or Compliance Manager).
4. A Control Owner or a Viewer who opens Incidents gets the "you don't have access" screen: the API answers 403, and the nav item stays visible but leads to that message. Other roles see the list.
5. The stale-save, retire, 404 and label rules from S1-006 work on all four screens.

**Tests to write (kind `unit`):** `packages/web/tests/record-screens/*.unit.test.tsx`, covering criteria 1–5 with the API mocked. Security-matrix rows: none.

**Test command:** `pnpm --filter web test -- record-screens`

---

Task: S1-008

**Goal:** Related records on every record page, and a way to add a link, so the risk register shows "the controls that treat it" (the M0 screen summary) and each record shows its neighbours.

**Decisions:** the spec's six links, D51 (a link is visible only if both ends are), D50, **D200** (who may add a link: anyone who can edit either record and can see both; use `canLinkRecords` from `@grc/shared`), D7. The "Remove" action on each row comes later, in S1-012 (D201); leave room for a per-row action but don't build it. Read the S1 shared notes and S1-005's brief (the routes).

**Hot files:** `packages/web/src/api/client.ts` (regenerated with S1-005's routes).

**Files:**
- Regenerate `packages/web/src/api/client.ts` (`pnpm gen:api-client`).
- Create: `packages/web/src/features/records/links/RelatedRecords.tsx` and `packages/web/src/features/records/links/AddLinkDialog.tsx`.
- Modify: the five record page components, to show `RelatedRecords`.

**Pass criteria:**
1. Each record page shows its links grouped with plain titles:
   - Risk: "Assets exposed to this risk" (EXPOSED_TO in), "Controls that treat this risk" (MITIGATED_BY out), "Incidents that exposed this risk" (EXPOSES in).
   - Control: "Risks it treats", "Policies that govern it".
   - Policy: "Controls it governs".
   - Asset: "Hosts / Hosted by", "Runs / Runs on", "Risks it is exposed to", "Incidents that impacted it".
   - Incident: "Assets impacted", "Risks exposed".
   - Each row shows the number (a link to that record's page), name, label and status.
2. Only what `GET …/:id/links` returns is shown. There's no count or placeholder for hidden links.
3. "Add link" shows only to people who can edit this record, or who can edit some record type this one may link to (D200). Each other end offered must pass `canLinkRecords`. The dialog offers only the link types `linkTypesBetween` allows from this record, and searches the other end by name or number through that type's list route. Only records the person can see appear.
4. The API's `link_not_allowed`, `link_exists`, 403 and 404 answers show clear messages. A successful add refreshes the group.

**Tests to write (kind `unit`):** `packages/web/tests/record-links/*.unit.test.tsx`, covering criteria 1–4 with the API mocked. Security-matrix rows: none.

**Test command:** `pnpm --filter web test -- record-links`

---

Task: S1-009

**Goal:** The asset dependency map (screen 5, "with a dependency map"): a picture of what hosts and runs what around one asset.

**Decisions:** D27 (screen 5), D33 (React Flow), D51 (only visible assets and links), D45.8, and **D204** (the map's shape: centred on one asset, opened from its page, depth 1–3 with 2 by default, capped at 200 assets with a notice). Use `MAP_DEFAULT_DEPTH`, `MAP_MAX_DEPTH` and `MAP_MAX_NODES` from `@grc/shared` rather than writing the numbers. Read the S1 shared notes and S1-005's brief (`GET /api/v1/assets/:id/map`).

**Hot files:** `packages/web/package.json` and `pnpm-lock.yaml` (adds `@xyflow/react`, exact version pinned).

**Files:**
- Create: `packages/web/src/features/records/assets/DependencyMap.tsx` and `packages/web/src/features/records/assets/map-layout.ts`. The layout is pure: nodes and edges in, positions out.
- Modify: `packages/web/src/features/records/assets/AssetPage.tsx` (a "Dependency map" tab or section).

**Pass criteria:**
1. The map shows the asset in the centre and its HOSTS and RUNS neighbours to the chosen depth. The depth picker offers 1, 2 and 3, starts at 2, and asks the API again when changed.
2. Nodes show number, name and type, with a mark for criticality. Edges are labelled HOSTS or RUNS with direction arrows.
3. Clicking a node opens that asset's page.
4. With `truncated: true`, a notice says the map was cut short at 200 assets. With `truncated: false` there's no notice.
5. An asset with no links shows a friendly empty state. An API error shows the message and reference ID.
6. The layout is the same for the same input (D45.8), and nodes don't overlap for up to 200 assets (`MAP_MAX_NODES`).

**Tests to write (kind `unit`):**
- `packages/web/tests/asset-map/*.unit.test.tsx`: criteria 1–5, with the API mocked. React Flow may need jsdom stubs (ResizeObserver); put them in the test setup.
- `map-layout.unit.test.ts`: criterion 6.
- Security-matrix rows: none.

**Test command:** `pnpm --filter web test -- asset-map`

---

Task: S1-010

**Goal:** The S1 checkpoint can be demonstrated. Each demo org has realistic records and links, the demo steps are written out, and browser tests walk the main journeys through the front door.

**Decisions:** D114 (clickable demo with written steps), D115, D172 (browser tests before a push when the web, API or Caddy change; the full set at checkpoints), D45.5 (re-runs are safe), D45.8 (repeatable), D170 (Mac scripts swap the database host), D57 (passwords only from `.env`), D164, D176. Read the S1 shared notes.

**Depends on:** S1-005, S1-009 and S1-012 (the journeys and demo steps use the finished screens, including link removal).

**Hot files:** none.

**Files:**
- Modify: `packages/infra/scripts/seed-demo.ts`. After the orgs and users, it adds each org's records and links through `RecordsService` and `LinksService`, so they're audited like any change.
- Create: `packages/infra/scripts/demo-records.ts`, holding the fixed demo data as plain objects. Each record has a fixed `sourceIds` entry, for example `demo:RSK-01`, so a re-run finds it and adds nothing.
- Create: `docs/demo/s1.md`.

**Pass criteria:**
1. **What `pnpm seed:demo` adds:**
   - About 12 assets, 8 risks, 10 controls, 4 policies and 5 incidents per demo org, with links of all six types.
   - A spread of labels from `public` to `restricted`, so the demo users' mixed clearances see different lists.
   - At least 3 controls owned by the org's demo Control Owner.
   - The two orgs' data differ, so the org wall is visible.
2. Running `pnpm seed:demo` twice adds nothing the second time: the same record count, numbers and links.
3. Every demo record and link has its audit entry in Postgres.
4. **`docs/demo/s1.md`** gives click-through steps:
   - the Risk Manager's register, rating and filters;
   - creating a risk and linking a control;
   - removing a link added by mistake (D201);
   - the stale-save message in two tabs;
   - the Control Owner's own controls;
   - the Viewer's read-only screens;
   - a low-clearance user missing a restricted risk;
   - the other org seeing none of it;
   - an asset's dependency map.
   It names `pnpm seed:demo` as the source of the logins, and prints no passwords.
5. **Playwright** (`packages/web/e2e/records.e2e.ts`, through `https://grc.localhost` with the seeded users):
   - the Risk Manager creates a risk, sees its rating, and links a control;
   - the Risk Manager links a wrong control to that risk and removes it again, and the link is gone after a reload (D201);
   - the Viewer sees the register with no Edit button;
   - the Control Owner sees only their own controls and edits one;
   - a stale save in two browser contexts shows the message;
   - a Globex user opening an Acme risk URL gets the "doesn't exist or you can't see it" page;
   - an internal-clearance user doesn't see a restricted risk.

**Tests to write:**
- `packages/api/tests/provision/seed-records.db.test.ts` (db): criteria 1–3, on throwaway databases.
- `packages/infra/tests/demo/s1-demo-doc.unit.test.ts` (unit): criterion 4's steps and that no password appears.
- `packages/web/e2e/records.e2e.ts` (e2e): criterion 5.
- Security-matrix rows: none.

**Who runs the browser tests:** they need the new API and web code running behind Caddy. The builder doesn't rebuild the shared stack from its worktree (the stack is started or recreated from the main checkout only). The builder runs the db and unit tests. The **integrator**, after merging, rebuilds and recreates `grc-api`, `grc-worker` and `grc-caddy` with `--no-deps` from the main checkout, runs `pnpm seed:demo`, then `pnpm test:e2e` (D172). A red browser test goes back through the normal chain.

**Test command:** `pnpm --filter api test -- seed-records` (the builder also runs `pnpm --filter infra test -- demo-doc`; the integrator runs `pnpm test:e2e`)

---

Task: S1-011

**Goal:** A person who added a link by mistake can take it away again. The link leaves the graph, and the audit trail keeps a copy of it and says who removed it and when.

**Decisions:** **D201** (removal allowed; the same people who may add; the removal and a copy in the audit trail; action `link.removed`; separate from false-positive handling), **D200** (who may add, so who may remove), D51 (a link is visible only if both ends are), D45.4 and D37 (the change and its audit entry in one step), D56 and D186 (audit `meta` carries the label), D59, D69, D163 and D164 (no values in logs), D175, D176. Read the S1 shared notes and S1-005's brief (the links routes, `canLinkRecords`, the `link.created` entry).

**Depends on:** S1-005 (the links service, controller and `canLinkRecords`).

**Hot files:** `packages/shared/src/access/security-matrix.ts`.

**Not in this task:** false-positive handling of AI links (D24, D38, S5), which hides a finding but keeps it in Postgres. S1 makes only manual links, so the tests use manual links. Don't add any rule about a link's `origin`.

**Files:**
- Create: `packages/api/src/records/link-audit.ts`, with a pure `linkRemovedAudit(link, from, to)`. It returns the audit entry: `action: 'link.removed'`, `targetType: 'link'`, the same `targetId` rule S1-005 uses for `link.created` (so the two entries pair up in the history), `before` holding the copy of the link `{ type, fromId, toId, fromNumber, toNumber, createdAt, createdBy, origin }`, `after: null`, and `meta { type, fromNumber, toNumber, label }` where `label` is the higher of the two ends' labels, as for `link.created`.
- Modify: `packages/api/src/records/links.service.ts` (add `remove(caller, { type, fromId, toId })`), `packages/api/src/records/links.controller.ts` (the route) and `packages/shared/src/access/security-matrix.ts` (its row).

**Route:** `POST /api/v1/links/remove`, body `{ type, fromId, toId }` (a strict Zod schema; `type` is one of the six link types, the IDs are lowercase UUIDs). Access `'any signed-in'`, like `POST /api/v1/links`: the service does the checks, because the rule depends on both ends. It answers 200 with the removed link `{ type, fromId, toId }`. Documented with `documentRoute`.

**Pass criteria:**
1. **Who may remove (D200, D201):** both ends must exist in the caller's org and be visible to the caller, and the link must exist. Otherwise it's 404 `not_found`, the same answer whether an end is missing, an end is hidden, or there's no such link. Then `canLinkRecords(caller, from, to)` must hold, or it's 403 `forbidden`. A Viewer can remove nothing; a Risk Manager can remove a MITIGATED_BY link from their risk to a control they can only view; a Control Owner can remove a link only through a control they own.
2. A body with an unknown link type, a bad ID, a missing field or an extra field is 400 `validation_failed`.
3. **What removal does:** that one relationship is deleted from Neo4j. Other links between the same two records (another type, or the reverse direction) stay. The two records themselves are unchanged: same fields, same `version`.
4. **Audit (D201, D45.4):** the removal and its `link.removed` entry (from `linkRemovedAudit`) are written through `AuditOutbox.withAuditedWrite` in the same Neo4j transaction. If the transaction fails, the link stays and no entry is kept. The entry reaches the Postgres audit trail through the relay within 5 s, with `actorType` `user` or `api_key`, and its `before` holds the full copy of the link.
5. **Two removals at once** of the same link: exactly one gets 200 and the other 404, and there's exactly one `link.removed` entry.
6. **After removal:** the link no longer appears in `GET /api/v1/P/:id/links` for either end, nor in `GET /api/v1/assets/:id/map`. Adding the same link again with `POST /api/v1/links` works (201, not `link_exists`) and writes a new `link.created` entry.
7. **D59:** every role × pair of record kinds allowed by the ontology (generated from `ROLE_TABLE` and `LINK_TYPES`); an org pair with 3 orgs (org A can't remove org B's link even with the right IDs: 404, and B's link and B's audit trail are untouched); every clearance × label pair (a link with an end above the caller's clearance is 404 and stays). API keys follow their one role and one org.
8. **No values in logs (D163, D164):** a failing removal logs only the error type or code, the reference ID and IDs, never record names or the link copy.
9. **Security matrix (D175):** `POST /api/v1/links/remove` has its row, with the same access, `orgWalled` and `labels` values as the `POST /api/v1/links` row. The TEST-003 completeness test passes. The S1-005 `links` tests still pass.

**Tests to write:**
- `packages/api/tests/link-removal/audit-entry.unit.test.ts` (unit): `linkRemovedAudit` gives the action, target, full `before` copy, `after: null` and `meta` with the higher label, for each label pair (4 × 4).
- `packages/api/tests/link-removal/*.db.test.ts` (db, in-process Nest app against throwaway Postgres and Neo4j databases, like `packages/api/tests/links/`): criteria 1–8. Generate the role, org-pair and clearance × label cases from `ROLE_TABLE`, `ROLES`, `LABELS` and `LINK_TYPES`.
- New security-matrix row: `POST /api/v1/links/remove`.
- Never weaken live privileges or shared state to prove a test (D176).

**Migrations:** none expected. If one turns out to be needed, it's "a new migration", numbered by the integrator at merge (D183).

**Test command:** `pnpm --filter api test -- link-removal`

---

Task: S1-012

**Goal:** The "Remove" action on related records, so a person who linked the wrong record can fix it from the record page.

**Decisions:** **D201** (who may remove, recorded in the audit trail), **D200** (`canLinkRecords` from `@grc/shared`), D51, D7 (the web only hides buttons; the API decides), D30 (typed client). Read the S1 shared notes, S1-008's brief (`RelatedRecords`) and S1-011's brief (the route).

**Depends on:** S1-008 (the related-records groups) and S1-011 (the route).

**Hot files:** `packages/web/src/api/client.ts` (regenerated with S1-011's route).

**Files:**
- Regenerate `packages/web/src/api/client.ts` (`pnpm gen:api-client`) after S1-011 is on `main`.
- Create: `packages/web/src/features/records/links/RemoveLinkDialog.tsx`.
- Modify: `packages/web/src/features/records/links/RelatedRecords.tsx` (the per-row action) and the links query hooks S1-008 made (a remove mutation that refreshes the group).

**Pass criteria:**
1. Each related-record row shows "Remove" only when `canLinkRecords(user, thisRecord, otherRecord)` holds. A Viewer never sees it.
2. "Remove" opens a confirmation that names the link in plain words (the group title and the other record's number and name) and says the removal is recorded in the audit trail. Cancel changes nothing.
3. Confirm sends `POST /api/v1/links/remove` with the link's real direction: for an "in" row, the other record is `fromId`.
4. On success, the row disappears, the group refreshes, and a short message confirms it.
5. A 404 shows "This link no longer exists or you can't see it" and refreshes the group. A 403 shows "You can't remove this link". Other errors show the API's message and reference ID.
6. All calls go through the generated client with relative `/api/v1` URLs (the M0-015 rule).
7. The S1-008 `record-links` tests still pass.

**Tests to write (kind `unit`, Vitest + Testing Library, API mocked at the client boundary):** `packages/web/tests/link-removal/*.unit.test.tsx`, covering criteria 1–6, with at least an editor of this record, an editor of only the other end (a Risk Manager on a control page), a Viewer, and a Control Owner on an owned and a not-owned control. Security-matrix rows: none (web only).

**Test command:** `pnpm --filter web test -- link-removal`
