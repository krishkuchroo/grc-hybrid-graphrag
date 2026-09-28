# Security findings

Every security issue found while building the project, kept here for review.

**How entries get here**
- **Automatically:** the `record-security-findings` hook adds an entry when a security reviewer sends work back, raises a question, or approves with a non-blocking point (`Security notes:`). It also catches any agent's `Security notes:`.
- **By hand:** the main session adds the results of each checkpoint's `/insecure-defaults:audit` scan and anything else found outside the agents.

**Review status** is one of: Open · Fixed (with the commit) · Accepted (with the reason and who decided) · Won't fix.
Change the status line when an entry is dealt with; don't delete entries.

## Summary (updated at each checkpoint)

| ID | Where | Severity | What | Status |
|---|---|---|---|---|
| SF-001 | Login (M0-010) | Low | MFA codes can be guessed too fast once a password is stolen | Open |
| SF-002 | Rate limits (M0-007) | Low | Behind Caddy, every visitor shares one rate-limit counter | Open |
| SF-003 | API keys (M0-011) | Medium | A key change and its audit entry aren't saved together | Open |
| SF-004 | Audit trail (M0-012) | Low | Deleting the newest audit entries isn't detected | Open |
| SF-005 | Audit trail (M0-012) | Low | The table owner can drop a company's part of the trail | Open |
| SF-006 | API error handler | Low | Would log audit entry contents once routes write audit entries | Open |
| SF-007 | `org:create` | Low | Echoes a mistyped option's value to the terminal | Open |
| SF-008 | Dependencies | Moderate | Old esbuild (GHSA-67mh-4wv8-2f99) via drizzle-kit | Accepted (D192) |
| SF-009 | API errors (M0-013/14) | — | Audit data in error logs and script output | Fixed (e457601, cce97a2; D163, D164) |
| SF-010 | Login (M0-010) | — | Guesses sent at the same time could pass the 5-try lock | Fixed (M0-010 merge 389fd27) |
| SF-011 | Login (M0-010) | — | A right password with no MFA step wasn't in the audit trail | Fixed (389fd27; D162) |
| SF-012 | Neo4j query accounts (M0-005) | — | SHOW commands and file loading reachable by the AI's accounts | Fixed (5c87e71, c877243) |

## Entries

### SF-001 · M0 checkpoint · insecure-defaults audit
- **Found:** 2026-09-28 by the `/insecure-defaults:audit` scan (run wf_0a9ee486-35f). Severity LOW.
- **Review status:** Open
- **Details:** `packages/api/src/identity/auth.ts:72` turns Better Auth's rate limiter off, which also removes the two-factor plugin's rule of 3 requests per 10 s on `/two-factor/*`. The TOTP and backup-code step has no lockout (`auth-routes.ts:193-202`), and a correct password resets `SignInLockout` (`auth-routes.ts:158`). Someone who already has a user's password can guess about 250 MFA codes a minute, an expected bypass in about a day instead of weeks.
- **Fix:** restore the per-path limit on `/two-factor/*` (or add a lockout to the code step that a correct password doesn't reset), and set `trustProxy` (SF-002).

### SF-002 · M0-007 · security review
- **Found:** 2026-09-27, M0-007 security review; confirmed by the M0 audit.
- **Review status:** Open
- **Details:** the 300 requests/min limit keys on `request.ip` with no `trustProxy` and runs before sign-in (`rate-limit.ts:44-47`, `main.api.ts:45`). Behind Caddy every visitor has Caddy's address, so all users share one counter: one busy user can lock everyone out, and per-user limits don't exist.
- **Fix:** trust Caddy as the proxy and key limits on the real client, or on the signed-in user where there is one (D64).

### SF-003 · M0-011 · code review
- **Found:** 2026-09-28, M0-011 code review (non-blocking).
- **Review status:** Open
- **Details:** `api-keys.service.ts:99` and `:163-164` write the `api_key.*` audit event in a separate transaction after the key change. If the audit write fails after a revoke, the key is revoked but no audit entry exists, which breaks design principle 4 (the audit entry is written in the same step as the change). Also: no test that a request made with an API key can't manage keys (`api-keys.controller.ts:19`), and the DELETE route is missing from the OpenAPI document.
- **Fix:** write the key change and its audit event in one transaction.

### SF-004 · M0-012 · security review
- **Found:** 2026-09-27, M0-012 security review (non-blocking).
- **Review status:** Open
- **Details:** the per-org hash chain proves nothing was changed or removed in the middle, but deleting the newest entries from the end of the chain isn't detected by the nightly check.
- **Fix idea:** record each org's latest sequence number somewhere the app account can't change (for example with the nightly check's result).

### SF-005 · M0-012 · security review
- **Found:** 2026-09-27, M0-012 security review (non-blocking).
- **Review status:** Open
- **Details:** the app account can only add audit entries, but the table owner (the migration account) can drop or detach a company's audit partition.
- **Fix idea:** keep the migration account's password out of the running app (already the case) and treat partition drops as an operator action that the audit check reports.

### SF-006 · M0-013 · security review (D163 follow-up)
- **Found:** 2026-09-28.
- **Review status:** Open (for the S1 briefs)
- **Details:** `packages/api/src/common/errors.ts:102` logs the whole error (`err: exception`). No route writes audit entries yet; once S1's record edits do, a failed audit write would log the entry's values here, against D163/D164.
- **Fix:** the S1 briefs make that handler log only the error type, code and IDs.

### SF-007 · M0-014 · security review (D164 follow-up)
- **Found:** 2026-09-28.
- **Review status:** Open
- **Details:** `packages/infra/scripts/create-org.ts:31` repeats unknown arguments on stderr, so a mistyped flag echoes the value after it (for example an org name) to the operator's own terminal. Happens before any write; outside D164.

### SF-008 · M0-016 · dependency scan
- **Found:** 2026-09-28, `pnpm audit --prod` during M0-016.
- **Review status:** Accepted (D192, the user, 2026-09-28): the flaw is only in esbuild's dev server, which we never run; drizzle-kit is the migration tool. Rechecked at each checkpoint.
- **Details:** 1 moderate advisory, GHSA-67mh-4wv8-2f99: esbuild <=0.24.2 (its dev server can be read by any website), pulled in through better-auth → drizzle-kit → @esbuild-kit. Not from tsx (esbuild 0.28.2). We never run esbuild's dev server.

### SF-009 · M0-013, M0-014 · security reviews
- **Review status:** Fixed. e457601 (relay logs, D163) and cce97a2 (operator scripts, D164).
- **Details:** failed audit copies logged the whole error, which held the entry's values; `org:create` and `seed:demo` printed Drizzle's message with the org's name, slug and first Admin ID. Both now print only the error type, code and IDs.

### SF-010 · M0-010 · security review
- **Review status:** Fixed in the M0-010 merge (389fd27).
- **Details:** many wrong passwords sent at the same moment could all be checked before the lock counted them. The lock now reserves a slot before each check.

### SF-011 · M0-010 · security review
- **Review status:** Fixed (389fd27, D162).
- **Details:** a correct password followed by an MFA step that was never finished left nothing in the audit trail. `auth.password_verified` is now written at once.

### SF-012 · M0-005 · security review
- **Review status:** Fixed (5c87e71, c877243).
- **Details:** the 28 read-only Neo4j accounts needed DENY on LOAD and the APOC load/import/export procedures (D52.2), and the query guard had to refuse SHOW commands (D55). Both are in place and tested live for all 28 accounts.

<!-- New entries are added below by the record-security-findings hook. -->

### SF-013 · TEST-003 · Sent back
- **Found:** 2026-09-28T05:20:48.519Z by security-reviewer (aad65150ebd9f0eb1)
- **Review status:** Open
- **Details:** Sent back (1 of 3; after 3 it goes to the user, D78). D51/D73/D23/D52: packages/shared/src/access/security-matrix.ts:43 sets labels=isRecordType(subject), so uploads, review_queue and chat get labels=false. Decisions say labels apply to documents and uploads (memory.md:168,294,301), to review findings (memory.md:301) and to chat (memory.md:61,164; D52.1). Set them true and keep admin false. Confirmed correct: openapi.json orgWalled=false/labels=false; /me, api-keys, health and auth/* labels=false; admin row labels=false. Question for the user (D78): should the audit-trail viewer hide entries about records above the reader's clearance? audit_trail stays labels=false until the user answers. Security notes: security-matrix.ts:69-70 the auth/* wildcard covers organization/set-active (tested at org-context.test.ts:103), and new OPEN_ROUTES (auth-routes.ts:32-37) need their own D59 tests; security-matrix.unit.test.ts:377-381 doesn't check that a route's labels matches its row's labels; security-matrix.ts:47 /me is AllowWithoutMfa, so 'any signed-in' doesn't imply MFA. Isolation runs: shared role-table/labels 239/239, api access 253/253, api org-context 59/59, none skipped.

### SF-014 · TEST-003 · Note (approved)
- **Found:** 2026-09-28T05:24:28.666Z by security-reviewer (a29e7c334c9b1f7a0)
- **Review status:** Open
- **Details:** Round-1 fix confirmed at 49adb3e: labels true for uploads, review_queue and chat, false for admin (security-matrix.ts:47-52); the 13 rows are listed by hand with cells pointing at ROLE_TABLE; audit_trail labels=false left open for the user. Routes match the controllers and auth-routes.ts:219. Isolation tests pass with 0 skipped: shared access 244/244, api access-guard 85/85; tsc clean. Security notes: security-matrix.unit.test.ts:341-348 does not pin the label values for the uploads, review_queue, chat and admin rows, so a revert of security-matrix.ts:47,48,52 would not be caught. Follow-up for the test writer, non-blocking.

### SF-015 · TEST-002 · Note (approved)
- **Found:** 2026-09-28T05:26:24.354Z by security-reviewer (a08f3ff85fae9c955)
- **Review status:** Open
- **Details:** Approved. Checks only: Postgres read in a READ ONLY transaction, Neo4j read with SHOW only in a READ session, the keychain read with dump-trust-settings only; the stack test's before/after snapshots are identical. No secret, URL or error message is printed (D57, D164); every probe goes to 127.0.0.1 (D61); the fixture holds no secrets. The DENY check was mutation-tested: removing any one of the 196 DENYs (28 roles x 7) makes neo4j show missing with the role named. pnpm test:env: 6 OK, exit 0. No skipped tests. Security notes: packages/infra/scripts/host-address.ts:13-20 a ?host= query parameter or a URL with no scheme skips the 127.0.0.1 swap (operator .env only, and the live .env has neither); packages/infra/scripts/test-env-checks.ts:138-158 only DENYs are compared, so an extra GRANT on a grc_ro_* role would still show OK; packages/infra/scripts/test-env.ts:113-116 the doctor uses the migration account (as the brief says; read-only transaction).

### SF-016 · TEST-001 · Note (approved)
- **Found:** 2026-09-28T05:57:54.917Z by security-reviewer (a4084cb5bc8204719)
- **Review status:** Open
- **Details:** No security test lost or silently excluded: 92 test files before, 93 after, every rename kept; per-file counts reconcile exactly (2269 builder baseline + 92 test-names + 64 TEST-002 = 2425; 0 skipped). D59 isolation tests (org-wall, graph-accounts, storage org-isolation, access-guard, api-keys org-and-role, shared role-table/labels/links) all ran and passed under the new scripts. db/stack runs call pnpm test:env first; the sandbox only uses node_modules/.cache with a stand-in doctor and was cleaned up; no secrets printed. Security notes: packages/api/package.json:8 (same in every package): extra args are passed to vitest, so test:unit -- --project db (and test -- --project db) runs db tests without the doctor; hand-typed only, the doctor only checks, non-blocking. packages/api/vitest.config.ts:18: passWithNoTests (already there) lets a per-kind script with a mistyped filter pass with 0 tests; the test wrapper catches it, so tests.run should use test -- <pattern>. TEST-003's security-matrix.unit.test.ts is on main only: the integrator should run pnpm --filter api test -- security-matrix after merging.

### SF-017 · TEST-005 · Note (approved)
- **Found:** 2026-09-28T06:31:46.527Z by security-reviewer (aa00cdbca5f088b88)
- **Review status:** Open
- **Details:** Approved. audit_trail labels:true matches D186/D56; uploads, review_queue and chat true and admin false match D51/D66/D50; orgWalled and role cells unchanged (D55, D50). Nothing reads SECURITY_MATRIX at runtime, so no access decision changes. The new test is red before the fix (only audit_trail fails) and green after; 30/30 pass, 0 skipped. Security notes: security-matrix.unit.test.ts:375-381 only forces labels:true on record-type routes, so S7 should pin labels on audit_trail, uploads, review_queue and chat routes. security-matrix.ts:52 is not enforced until S7, whose brief must test that contents are hidden for each clearance x label pair (D186, D59).

### SF-018 · TEST-004 · Note (approved)
- **Found:** 2026-09-28T06:48:51.945Z by security-reviewer (a47f6836384dd5185)
- **Review status:** Open
- **Details:** Test-only change; nothing shared touched (D176). Size-cap proof intact (D53/D64): exact 25 MB passes the door (API log marker); 25 MB+1 and 40 MB get 413 and never reach the API; the 1 MB API cap still gives 413 payload_too_large. Live probe with cutShortOk forced on over-cap uploads: 413 and marker absent, so the option can't make a refusal look accepted. body-size 3x 6/6; front-door unit 33/33 and stack 38/38, none skipped; security-matrix 25/25. Security notes: Caddyfile:32-34 request_body max_size isn't pinned by a unit test and the 25 MB stack test can't catch it being lowered (was so before this change); helpers.ts:84 cutShortOk must never be used by a status-checking test.

### SF-019 · TEST-006 · Note (approved)
- **Found:** 2026-09-28T14:32:55.868Z by security-reviewer (a781dce705c39fa3a)
- **Review status:** Open
- **Details:** Approved. No blocking issues. The keep-alive onError hook (errors.ts:66-70) matches only FST_ERR_CTP_BODY_TOO_LARGE. Framing is enforced by llhttp: a probe with a request hidden in a 1.1 MB body never reached the API. Chunked bodies are bounded by Fastify's 1 MB collect cap and Caddy's request_body max_size 26214400; 5 MB and 30 MB chunked probes got the API's D47 413. The API has no published ports. BODY_LIMIT_BYTES and the Caddyfile are unchanged. The D47 format and the D64 headers are checked on all 60 requests. No new routes or record types (security-matrix 30/30). Only grc-api and grc-worker were recreated (D176). No secrets. Also passed: api limits.db 7/7. Security notes: errors.ts:60-64, the 25 MB bound holds only behind Caddy; the API has no requestTimeout (Fastify default 0), so a client on grc-edge could drain a chunked body without limit, which isn't new exposure (phase 7 item). errors.ts:66-70, the fix relies on Node draining the unread body, and the 60-request stack test guards against a future upgrade changing that.

### SF-020 · TEST-008 · Note (approved)
- **Found:** 2026-09-28T15:01:26.693Z by security-reviewer (ad588792aec91ac0d)
- **Review status:** Open
- **Details:** Diff c70157d..6114c28 changes only packages/infra/tests/front-door/headers.stack.test.ts (+6: expectContinue: true at line 107 and a comment). Size still UPLOAD_CAP_BYTES+1, status still exactly 413, no cutShortOk, expectD64Headers still requires HSTS/XFO/XCTO/CSP each sent once with value checks (D53, D64). expectContinue can't hide a pass-through: on 100 Continue the full body is sent and the upstream's own answer is checked; no answer means the 60 s timeout fails the test; a write error before an answer still fails (helpers.ts:113,150,178-183). No skips (D173), no secrets, nothing live changed (D176), no new routes or record types so no security-matrix rows (D175). The headers test ran once: 8/8 passed, 0 skipped. Security notes: headers.stack.test.ts:109 does not prove the 413 came from the door rather than the API. body-size.stack.test.ts:57 covers that with API log checks. Not caused by this change and not blocking. First review, no earlier send-backs (D78).

### SF-021 · TEST-007 · Note (approved)
- **Found:** 2026-09-28T15:29:26.186Z by security-reviewer (a7e0b19fed1f2ca56)
- **Review status:** Open
- **Details:** Approved. Each (role, clearance) maps to exactly its own account name, and the name is the cache key; no collisions (only role names contain underscores, clearances are a fixed set) and no default account. Unknown role or clearance throws. READ mode, executeRead with the checked timeout, and the USE-refusing guarded tx are unchanged (graph.service.ts:118-121). Credentials come from the same place, are not logged, and are kept only in each driver. close() releases all query drivers. No D175 rows needed; security-matrix passes 30/30. No secrets in the diff; D176 held (only grc-api and grc-worker recent). graph-accounts: unit 82/82, db 668/668, none skipped. Send-backs: 0 of 3 (D78). Security notes: graph.service.ts:131-151 a readAs after close() creates a new driver that is never closed (shutdown only); graph.service.ts:23-25 with graph.module.ts:13 the API and worker together can open 280 query connections, to check against the Neo4j Bolt limits in phase 7; graph.service.ts:146-148 each driver keeps its account's password in memory for the life of the process (acceptable under D57).
