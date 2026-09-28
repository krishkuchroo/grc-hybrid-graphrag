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
| SF-008 | Dependencies | Moderate | Old esbuild (GHSA-67mh-4wv8-2f99) via drizzle-kit | Open |
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
- **Review status:** Open
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
