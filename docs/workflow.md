# Build workflow: monitor, logs, guard-rail files and testing rules

Moved out of CLAUDE.md on 2026-10-15 (D225), word for word, so CLAUDE.md stays short for every agent turn. The decisions behind it are in `memory.md`.

## Agent monitor (D100–D103, v2: D148–D158, D161)
- Run `node .claude/monitor/server.mjs`, then open http://127.0.0.1:4800. How it works and how to reuse it: `.claude/monitor/README.md`.
- Tabs: Overview (attention, open questions, health, tokens today, milestones), Agents, Launch, Tokens, Activity (log search), Board.
- Notes reach an agent at its next step, to one agent or several. Answers to open questions reach the main session with the user's next message there (D155).
- Launched runs (D151–D154, D161): only `.claude/agents/`, auto mode plus edits in their own worktree, 2 at a time, reply anytime, Stop button. They count as agents in every guard rail (D158).
- Everything project-specific is in `.claude/monitor/monitor.config.json` (D149). The folder imports nothing from outside it.
- Pause or stop a workflow in `/workflows`.

## Logs (D92, D107)
Kept in `logs/`, which is git-ignored. Only the hooks and the monitor write there.
- `guardrails.jsonl`: blocks, and errors from hooks that failed.
- `activity.jsonl`: each agent's steps (the monitor's hook).
- `edits.jsonl`: who edited which file, for the hand-in backstop (the guard rails' `record-checkout.mjs`, D157).
- `notes.jsonl`, `answers.jsonl` and `inbox/`: notes to agents and answers to the main session.
- `launches/<session>/`: runs launched from the monitor.
- `state/`: what the hooks track about each agent.
- `tasks/<ID>.md`: each task's log.
- `build-errors.md`: the errors log.

## Where the guard rails live
- `.claude/hooks/`: one file per rule, with the shared code in `lib/`.
- Tests: `node --test '.claude/hooks/__tests__/*.test.mjs'`, and for the monitor `node --test '.claude/monitor/__tests__/*.test.mjs'`.
- Git's pre-commit secret scan is `.claude/githooks/pre-commit`. Switch it on at setup with `git config core.hooksPath .claude/githooks`.
- **Fail safe (D119):** a command the guard rails can't read is blocked. That covers a program name or file name built at run time (`$X`, `$(…)`), git and gh aliases, and an agent setting `COMPOSE_*` or `GIT_CONFIG_*`.

## Testing rules in full (locked 2026-09-28; D167, D168, D170–D180)
> **Paused by fast mode (D222, 2026-10-15):** no new tests and no test runs gate a task until the MVP demo works. D224 brings back one review-and-test round per slice. The rules below apply in full again when testing starts.
- **Test kinds, named by what they need (D177):**
  - `*.unit.test.ts`: nothing. The default kind.
  - `*.db.test.ts`: Postgres, Neo4j or SeaweedFS, through throwaway databases.
  - `*.stack.test.ts`: the running stack (containers, Caddy, the API).
  - `e2e/*.e2e.ts`: Playwright through `https://grc.localhost`.
  - Commands: `pnpm test:unit`, `test:db`, `test:stack`, `test:e2e`. `pnpm test` runs unit + db + stack.
- **Environment check (D180):** `pnpm test:env` checks the stack, migrations, Neo4j DENYs, `.env` keys (names only), Caddy's cert and the hosts line. It changes nothing, and db/stack runs call it first. Missing items go to the main session or the user.
- **Mac scripts (D170):** host-side scripts swap the container host for 127.0.0.1:5433 themselves. `.env` keeps one set of addresses.
- **Guard rail 4:**
  - The test writer's tests come after the code, so it hands in through the fix path (`fixReason`): the tests must pass, and only test files may change after the builder's code (D167, D219). New tests handed in without a fix reason must be red.
  - The check runs only in the task's own worktree, at the tip of `task/<ID>` (D168).
  - Builders' tests run 3 times (D171), until the user sets `BUILDER_RUNS` to 1 (D219).
  - A skipped test fails unless it's listed in `skips` (D173).
- **Flaky tests (D171):** no retries anywhere. A test that fails and then passes is a bug for the test writer. The integrator runs the full suite once before each push. The checkpoint runs it 3 times, plus every browser test.
- **Browser tests (D172):** the integrator runs `pnpm test:e2e` when a task touched the web app, the API or Caddy.
- **Agreement (D174):** a test writer names the earlier tests and decisions its tests agree with, and the code reviewer checks.
- **Security matrix (D175):** `packages/shared/src/access/security-matrix.ts` lists every record type and route. A test fails when the code has one the matrix lacks. The security reviewer checks it on every task.
- **Never** weaken live privileges, secrets, the certificate or the running stack to prove a test (D176).
