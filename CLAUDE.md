# GRC Project — Enterprise IRM Engine (Hybrid GraphRAG)

A clone of a next-gen GRC (Governance, Risk, Compliance) platform, styled after ServiceNow IRM. The core is a dual-path Hybrid GraphRAG engine: vector search plus graph traversal, fused with Reciprocal Rank Fusion (RRF).

It's a portfolio project and research prototype. It **must look like a finished product**, and it has to **prove with benchmarks that hybrid search beats plain vector search**.

## Source docs (read these first)
- `memory.md`: **the source of truth.** It holds the decision log (D1…), open questions, known risks, environment facts and research findings.
- `enterprise_integrated_risk_management_irm_architecture_specification.md`: the original architecture spec.
- `hybrid_graphrag_research_papers_literature_index.md`: the research grounding (GraphRAG, RAPTOR, GRAG, LLM KG construction, RRF math).
- `skills.md`: the approved marketplace skills (D80).

## Working rules (non-negotiable)
1. **Do what the user says.** Don't deviate from the agreed plan.
2. **Don't "improve" anything unless asked.** No unrequested refactors, features, or tech swaps.
3. **Plain-language questions.** When grilling or clarifying, skip the jargon and ask one clear question at a time.
4. Record every decision in `memory.md` as it is made. Treat `memory.md` as the source of truth for what has been decided.
5. **Skills:** use only skills from the plugin marketplaces, and **ask the user before invoking any skill** (D80). `skills.md` lists the approved ones.

## Roadmap (do the phases in this order)
1. **Shape the project / decide the architecture.** ✅ Locked 2026-09-24 (D1–D27).
2. **Architecture and tech stack.** ✅ Locked 2026-09-24 (D28–D35).
3. **System design.** ✅ Locked 2026-09-24 (D36–D48).
4. **Security.** ✅ Locked 2026-09-24 (D49–D59).
5. **Networking.** ✅ Locked 2026-09-25 (D60–D65).
6. **Data structures.** ✅ Locked 2026-09-25 (D66–D73).
7. **Stress test and benchmark.** Run against datasets. Targets: consistent, concurrent, scalable, durable. ⏸ **Deferred by the user on 2026-09-25.** Resume later from the Q73 proposal in memory.md ("Deferred phases").
8. **Orchestration layer.** A multi-agent setup that is configured from the finished plan. ✅ Decisions locked 2026-09-26 (D74–D107). ✅ Done 2026-09-27: 9 agents, the hooks, the monitor and the board, verified by smoke tests, with the review's findings fixed (D119).
9. **Workflow generation.** Build workflows that support the orchestration layer and build out the solid project layer. Decided 2026-09-27 (D109–D121). The milestone workflow is written, and gets a real test after setup. ← *current phase*

## Current state (saved 2026-09-28; resume from here)
- **M0 is done, approved and tagged `m0`** (D193). All 16 M0 tasks and TEST-001…008 are merged and pushed. The report is `docs/checkpoints/m0.md`.
- **Checkpoint results:** lint and typecheck clean; `pnpm test` 2,457/2,457 in each of 3 runs (none skipped, none flaky); e2e 4/4; insecure-defaults audit 0 findings; the esbuild advisory is accepted (SF-008, D192).
- **Open security items:** SF-001…SF-007 in `SECURITY-FINDINGS.md`, left for the user (D184).
- **D160 history rewrite:** runs right after the tag (D194). The user runs the one force-push from the prompt.
- **Next: S1**, planned in another session (D195). Then the parallel groups (D181–D183). The user OKs the S1 task list and skills first (D111).
- **Open:** Q39's context hand-off part.
- **Environment:**
  - Neo4j DBMS running (127.0.0.1), all 28 query roles have their DENYs.
  - The Docker stack is up (`grc-postgres`, `grc-seaweedfs`, `grc-dev-relay`, `grc-caddy`, `grc-api`, `grc-worker`). Start or recreate it from the main checkout only.
  - Monitor at http://127.0.0.1:4800.
  - Errors log: `logs/build-errors.md`.
  - 21 unmerged worktrees are kept (`monitor-v2` and 20 old M0 workflow attempts, D190).

## Non-functional requirements
Consistent · Concurrent · Scalable · Durable · Follows good design principles.

## Architecture (locked 2026-09-24; the reasons are in memory.md)
```
 Browser: React SPA (Vite + TS + shadcn/ui), 13 screens, chat side panel
        │
        ▼
 Backend API: TypeScript (Node). Security is checked here and again in the databases.
   ├─ Intake: file upload + push API  ◄── synthetic data generators (dummy connectors)
   ├─ Extraction (Gemma 4): confident → live; uncertain → Analyst queue
   ├─ Chat: Path A vector search + Path B AI-written graph query → RRF → Gemma answer
   └─ Access checks: org wall + role × record-type table + sensitivity labels
        │                   │                        │               │
        ▼                   ▼                        ▼               ▼
 Neo4j Enterprise      Postgres + pgvector       SeaweedFS         Ollama
 (Desktop, native)     (Docker)                  (Docker)          (native, GPU)
 one database per org  users, orgs, roles,       uploaded files    Gemma 4 (LLM)
 MASTER copy of        grants, audit trail,                        bge-m3 (embeddings)
 GRC records           text chunks + vectors
```
- **Org wall (enforced by the databases):** each org gets its own Neo4j database. Postgres row-level security applies everywhere, including vector search.
- **Cross-org access:** only for auditors (read-only, time-limited), parent companies viewing their subsidiaries, and platform break-glass. Every crossing is logged and revocable.
- **Inside an org:** a role × record-type table plus sensitivity labels matched against the user's clearance. Hidden records never reach the AI.
- **Graph queries:** the AI writes them. They run only inside the org's own database, read-only, with a time limit.
- **Neo4j is the master copy** of Assets, Risks, Controls, Policies and Incidents. Postgres holds identity, permissions, the audit trail, text chunks and vectors.
- **AI findings:** confident ones go live, uncertain ones wait for the Analyst, and false positives are hidden but kept.
- **Frameworks:** NIST 800-53 and CSF 2.0 in full. ISO 27001 and SOC 2 as IDs and titles plus our own descriptions. No SCF.
- **Kept from the spec:**
  - The ontology: Asset, Risk, Control, Policy and Incident, with the edges HOSTS|RUNS, EXPOSED_TO, MITIGATED_BY, GOVERNED_BY, IMPACTS and EXPOSES.
  - Chunks of 500 tokens with 50 overlap, and RRF with k=60.
  - Strict `<GRAPH_CONTEXT>` (ground truth) and `<UNSTRUCTURED_DOCUMENT_CONTEXT>` sections in the LLM context.
- **Environment:** a Mac with an M4 and 16 GB RAM. Neo4j Desktop (Enterprise, development-only licence) and Ollama run natively, and everything else runs in Docker.
  - **Never touch the `orion-neo4j` or `sentry-neo4j` containers.** They belong to other projects.

## Tech stack (locked 2026-09-24; the reasons are in memory.md D6–D35)
- **Language and repo:** TypeScript on Node 24, in a pnpm workspaces monorepo.
- **Backend:** NestJS on Fastify. REST with an OpenAPI spec generated from Zod. pg-boss for background jobs, pino for logs.
- **Postgres 18.6 + pgvector 0.8.6** (`pgvector/pgvector:pg18`), accessed through Drizzle ORM and drizzle-kit.
- **Neo4j Enterprise 2026.05** (Neo4j Desktop, native, Bolt 7687), accessed through the official neo4j-driver.
- **Files:** SeaweedFS (S3 API).
- **AI:** Vercel AI SDK v7 talking to Ollama (native, `ollama serve`). The LLM is **gemma4:12b** and embeddings use **bge-m3** (1024 dims).
- **Parsing and test data:** unpdf + mammoth. @faker-js/faker with fixed seeds.
- **Frontend:** React + Vite + shadcn/ui, TanStack Router/Query/Table, React Hook Form, shadcn charts, React Flow.
- **Testing:** Vitest, Playwright, k6.
- **Runtime:** Docker Compose. Neo4j Desktop and Ollama run natively, and containers reach them through `host.docker.internal`.
- **Before running the stack,** ask the user to stop other projects' containers (for example `orion-neo4j`). Never stop them ourselves.

## System design (locked 2026-09-24; details in memory.md D36–D48)
- **Programs:**
  - One NestJS codebase runs as two programs: the **API** and the **worker** (pg-boss jobs).
  - Alongside them: the web app, plus command-line tools for `generators` and `benchmark`. The generators have a full-pipeline mode and a fast-load mode. The benchmark compares hybrid against vector-only search.
- **Modules:**
  - API/worker modules: identity, access, audit, records, frameworks, intake, processing, review, search, chat, ai.
  - Packages: web, shared, generators, benchmark, infra.
- **Uploads:**
  - Files are stored in SeaweedFS and identified by their content, so a repeat upload is ignored.
  - Asset lists go through saved column mappings straight into Neo4j, with no Gemma.
  - Documents, tickets and audit findings:
    1. The text is chunked, and bge-m3 turns each chunk into a vector.
    2. Gemma extracts the links.
    3. Duplicate matching runs: exact, then close spelling, then close meaning.
    4. The rule checks run: same sentence, ontology fit, both ends known.
    5. Confident links go to Neo4j, and the rest wait in the Postgres review queue.
- **Edits:**
  1. The API checks the org, role and label.
  2. One Neo4j transaction saves the change **and** its audit entry.
  3. The worker copies audit entries to Postgres within 5 s.
- **Review:**
  - Approved findings go to Neo4j, with an audit entry.
  - False positives stay hidden in Postgres and are kept.
  - A live fact later found to be false is removed from Neo4j and recorded in Postgres.
- **Chat:**
  1. Path A is vector search in Postgres, limited to the user's org and the records they can see.
  2. Path B is a graph query written by Gemma. It runs read-only, with a time limit, in the org's own database and under the user's role.
  3. The results are merged with RRF (k=60) and passed through the entity filter.
  4. Gemma answers with citations, streamed as it writes.
  - If the graph query fails, the chat answers from documents only and says so.
  - Conversations are saved per user. When several people chat at once, they queue for Gemma.
- **Principles:**
  1. Clear modules.
  2. Swappable parts behind small interfaces.
  3. Security checked in both the API and the databases.
  4. Audit entries written in the same step as the change.
  5. Re-runs are safe.
  6. The AI proposes, and our code decides.
  7. Fail safe.
  8. Repeatable results.
- **API conventions:**
  - Every address starts with `/api/v1`.
  - Lists are paged.
  - One error format, with a reference ID.
  - The push API ignores batches it has already received.
  - Long tasks return job IDs.
  - Chat streams its answer.
- **Targets** (full list in D48):
  - Pages: 95% under 300 ms with 50 users.
  - Search: 95% under 500 ms.
  - Chat: first words within 25 s, full answer within 60 s.
  - Zero cross-org leaks and zero lost audit entries.

## Security (locked 2026-09-24; details in memory.md D49–D59)
- **Login:** Better Auth runs inside the API and stores its data in Postgres through Drizzle.
  - MFA for everyone.
  - Passwords of at least 12 characters.
  - Sessions end after 30 min idle, or after 12 h at most.
  - 5 failed attempts lock the account for 15 min.
  - SSO (OIDC/SAML) is optional per org.
  - Machines use expiring, revocable API keys, each limited to one org and one role.
- **Permissions:** the role × record-type table (D50), plus sensitivity labels matched against user clearance (D51). A link is visible only if both of its ends are visible.
- **Org wall:**
  - Per-org Neo4j databases.
  - Postgres RLS, with a restricted app account and FORCE RLS on.
  - A storage bucket per org.
  - A Neo4j account for each role × clearance combination. AI queries run as the person asking, read-only.
- **Cross-org access:**
  - Auditors: read-only, up to 90 days.
  - Parent links: read-only, approved by the subsidiary.
  - Break-glass: read-only for 1 h, needs a reason, and alerts the org's Admins instantly.
  - Every crossing is logged in both orgs.
- **Data:**
  - Uploads: only PDF, DOCX, CSV, JSON and TXT, up to 25 MB, opened only by the worker. No zip files.
  - Data at rest is covered by FileVault.
  - Nightly backups are kept for 7 days, and a restore is tested monthly.
  - Secrets live in a git-ignored `.env`, with a secret scan on commits.
  - Neo4j telemetry is off.
  - All AI runs locally.
- **AI:** the 6 prompt-injection defences in D52.
- **Audit:**
  - Add-only and hash-chained per org, with a nightly check. Entries are kept forever.
  - It logs changes, logins, grants, cross-org reads, break-glass sessions, uploads and downloads, Analyst decisions, and chat questions with the records they cited.
- **Proof:**
  - Tests cover every role-table cell, every org pair and every clearance × label combination.
  - The injection test set runs, along with a dependency scan on every build.
  - All of it reruns under load in phase 7.

## Networking (locked 2026-09-25; details in memory.md D60–D65)
- **Front door:** Caddy at `https://grc.localhost`, with local HTTPS. It serves the web app and forwards `/api/v1` to the API.
  - The user's one-time setup: trust Caddy's local certificate, and add the hosts line `127.0.0.1 grc.localhost`.
- **Ports (all on 127.0.0.1 only):**
  - 443 for Caddy, with 80 redirecting to 443.
  - 7687 for Neo4j Bolt, 7474 for the Neo4j UI, and 7689 for Neo4j routing (moved from 7688).
  - 11434 for Ollama.
  - 5433 for Postgres, behind a dev-only switch that's off by default.
  - The API, worker, Postgres and SeaweedFS publish no ports.
- **Networks:**
  - Postgres and SeaweedFS sit on an internal Docker network with no internet.
  - The API and worker can also reach the Mac through `host.docker.internal` (for Neo4j and Ollama), and the internet (for SSO only).
  - The browser never talks to the databases, storage or Ollama.
  - Internal connections aren't encrypted, because the traffic never leaves the Mac.
- **Limits:**
  - Rate limits: 300 requests/min per person, 10 chat questions/min, 60 push batches/min per key, 20 uploads/min.
  - Size caps: 25 MB for uploads, 1 MB for other requests.
  - Security headers on every response.

## Data model (locked 2026-09-25; full detail in memory.md D66–D73)
- **Graph (Neo4j, one database per org):**
  - Records: Asset, Risk, Control, Policy, Incident, plus Framework, Requirement, Evidence and AuditFinding.
  - The framework catalogs are copied into every org database.
  - Links: HOSTS|RUNS, EXPOSED_TO, MITIGATED_BY, GOVERNED_BY, IMPACTS and EXPOSES, plus SATISFIES, MAPS_TO, SUPPORTS and CONCERNS.
- **Every record carries:**
  - An internal ID (the same in Postgres), a ServiceNow-style number (`RSK0001014`) and source IDs as aliases.
  - A label, status (active/retired, never deleted), owner, version (stale saves are refused), origin, and a name embedding.
- **AI links record where they came from:** source doc, chunk and sentence, plus the model and prompt version. History lives in the audit trail.
- **Neo4j indexes:**
  - Unique ID and number.
  - A full-text index and a vector index on names, which handle duplicate matching.
  - Lookups on type, framework, status, label and owner.
  - An index on each link's source document.
- **Neo4j accounts:** 28 read-only accounts (role × clearance), one writer account and one admin account.
- **Postgres tables:**
  - Better Auth tables (plus role and clearance), parent links, grants, and break-glass sessions.
  - Hash-chained audit events.
  - Documents, and chunks with `vector(1024)`, partitioned by org with HNSW (cosine) and iterative scan on. Plus a chunk↔record link table.
  - Review findings, import mappings, push batches, chat conversations and messages, benchmark runs and results, and pg-boss.
  - RLS is on every org table.
- **Job queues** (pg-boss): read file ×4, embed ×2, Gemma extraction ×1, duplicate matching ×4, continuous audit copy, and nightly chain check and backups.
  - Failed jobs retry 3 times with backoff, then go to a failed-jobs list.
  - Job keys prevent duplicates.

## Orchestration (locked 2026-09-26; details in memory.md D74–D107, D119)
- **Runs inside Claude Code on this Mac.** There's no API key, and the agents need the local Docker, Neo4j Desktop and Ollama. Workflows run up to 8 agents at once.
- **Git:**
  - A local repo plus a private GitHub repo: https://github.com/krishkuchroo/grc-hybrid-graphrag (the user created it on 2026-09-27, D122). The remote is `origin`.
  - Each builder works in its own worktree.
  - Only the integrator pushes, after every finished task that passes its checks. Each approved milestone gets a tag (`m0`, `s1`…`s8`).
  - Never pushed: `.env`, backups, generated test data, uploaded files and model files.
  - **Commit messages and PR text never mention Claude, Anthropic or AI tooling:** no `Co-Authored-By`, `Claude-Session` or "Generated with" lines (D159). The `commit-msg` git hook strips them if they slip in.
- **Agents** (`.claude/agents/`), all on the session model (Opus 5.5):
  - **Planner:** writes the tasks and pass criteria, keeps `TASKS.md`, and is the only agent that edits `memory.md`.
  - **Test writer:** writes each task's tests before any code exists.
  - **Builders** (platform, backend, frontend, data): **can't edit test files.** If a test looks wrong, it goes back to the test writer.
  - **Security reviewer:** checks against D49–D59 and runs the isolation tests.
  - **Code reviewer:** checks against the plan and the code standards.
  - **Integrator:** merges approved work, runs the full suite, resolves conflicts and pushes.
- **Order:**
  - Milestone 0, the foundation: repo, Docker, database wiring, Caddy, login, the org wall, roles and labels, audit.
  - Then 8 slices:
    1. Records and the risk register.
    2. Frameworks and mappings.
    3. Uploads, import mapping and generators.
    4. Processing.
    5. Analyst review.
    6. Search and chat.
    7. Admin, grants, break-glass and the audit viewer.
    8. The dashboard and the benchmark.
  - **Run in parallel groups (D181):** S1 alone → S2, S3 and S7 together → S4 alone → S5 and S6 together → S8. Conflict rules for parallel slices: D183 (shared agent cap of 8, a merge queue, folders owned per slice, hot files one task at a time, migration numbers given at merge).
  - The user approves at the end of each milestone, with one combined checkpoint per parallel group (D182). Each checkpoint has a demo and test results.
- **Done means:**
  - The test writer's tests pass.
  - The code and security reviewers approve. After 3 send-backs, it goes to the user.
  - Lint, type checks, the secret scan and the dependency scan are clean.
  - `TASKS.md` is updated. **No new decision is made without the user.**
- **Stuck:** after 3 attempts the task is marked blocked, with notes. The others continue, and the user hears straight away.
- **Memory plan (16 GB):**
  - Docker is limited to 4 GB.
  - Everyday tests use saved AI answers.
  - Real-Gemma steps run alone.
  - One test process per agent.
  - Throwaway test databases per agent.
- **Guard rails (hooks):**
  1. Nothing touches `orion-neo4j`, `sentry-neo4j` or other projects' containers.
  2. No commits with secrets.
  3. No force-push, branch deletion or hard reset. Only the integrator pushes or changes the GitHub repository, and that includes the main session.
  4. Lint, type checks and tests must pass before an agent can finish.
  5. Only the planner edits `memory.md`, and no agent edits `CLAUDE.md`.
  6. Only approved skills can be used.
  7. Builders can't edit test files.
- **Task board:** `TASKS.md`. Each task has an ID, milestone, owner, status, pass criteria and tests. Each task's brief sits under "Briefs" and starts with `Task: <ID>` (D91).
- **Skills:** marketplace skills only, listed in `skills.md`. The user approves each agent's skills before every milestone.
- **Milestone workflow (D109–D118):** `.claude/workflows/milestone.js`, started with the milestone ID.
  1. Step `plan`: the planner splits the milestone. The user OKs the task list and skills (D111).
  2. Step `build`: each task goes test writer → builder → both reviewers → integrator, on branch `task/<ID>`. Up to 8 agents run at once. A blocked task holds only the tasks that wait on it. Real-Gemma steps run one at a time at the end.
  3. The checkpoint (D114), including a whole-codebase `/insecure-defaults:audit` run (D128). Then step `tag`, after the user approves.
- **Agent monitor (D100–D103, v2: D148–D158, D161):**
  - Run `node .claude/monitor/server.mjs`, then open http://127.0.0.1:4800. How it works and how to reuse it: `.claude/monitor/README.md`.
  - Tabs: Overview (attention, open questions, health, tokens today, milestones), Agents, Launch, Tokens, Activity (log search), Board.
  - Notes reach an agent at its next step, to one agent or several. Answers to open questions reach the main session with the user's next message there (D155).
  - Launched runs (D151–D154, D161): only `.claude/agents/`, auto mode plus edits in their own worktree, 2 at a time, reply anytime, Stop button. They count as agents in every guard rail (D158).
  - Everything project-specific is in `.claude/monitor/monitor.config.json` (D149). The folder imports nothing from outside it.
  - Pause or stop a workflow in `/workflows`.
- **Logs (D92, D107):** kept in `logs/`, which is git-ignored. Only the hooks and the monitor write there.
  - `guardrails.jsonl`: blocks, and errors from hooks that failed.
  - `activity.jsonl`: each agent's steps (the monitor's hook).
  - `edits.jsonl`: who edited which file, for the hand-in backstop (the guard rails' `record-checkout.mjs`, D157).
  - `notes.jsonl`, `answers.jsonl` and `inbox/`: notes to agents and answers to the main session.
  - `launches/<session>/`: runs launched from the monitor.
  - `state/`: what the hooks track about each agent.
  - `tasks/<ID>.md`: each task's log.
- **Where the guard rails live:**
  - `.claude/hooks/`: one file per rule, with the shared code in `lib/`.
  - Tests: `node --test '.claude/hooks/__tests__/*.test.mjs'`, and for the monitor `node --test '.claude/monitor/__tests__/*.test.mjs'`.
  - Git's pre-commit secret scan is `.claude/githooks/pre-commit`. Switch it on at setup with `git config core.hooksPath .claude/githooks`.
  - **Fail safe (D119):** a command the guard rails can't read is blocked. That covers a program name or file name built at run time (`$X`, `$(…)`), git and gh aliases, and an agent setting `COMPOSE_*` or `GIT_CONFIG_*`.

### Hand-off
Every agent ends its report with one hand-off block (D91). The hooks read it at hand-in (guard rails 4, 5 and 7).
```handoff
{"taskId":"S1-003","status":"done","filesChanged":["packages/api/src/records/records.service.ts"],"tests":{"run":"pnpm --filter api test -- records","passed":12,"failed":0},"findings":"…"}
```
- **Status values:**
  - The planner, test writer, builders and integrator use `done` or `blocked`.
  - The reviewers use `approved` or `sent-back`.
- **Blocked:** a `blocked` hand-off needs findings that say what was tried and what's blocking. It can always finish (D86).
- **Test command:** the test writer and builders put the task's test command in `tests.run`, as a pnpm test run. The finish check runs it (D97).
- **Optional fields:**
  - `fixReason`: a test writer's reason for a fix to tests the code already meets (D167).
  - `skips`: `[{"test": "…", "reason": "…"}]`, each skipped test for the reviewers to approve (D173).
- **Workflows:** a workflow that runs our agents gives them this object as their output schema.

## Testing (locked 2026-09-28; details in memory.md D167, D168, D170–D180)
- **Test kinds, named by what they need (D177):**
  - `*.unit.test.ts`: nothing. The default kind.
  - `*.db.test.ts`: Postgres, Neo4j or SeaweedFS, through throwaway databases.
  - `*.stack.test.ts`: the running stack (containers, Caddy, the API).
  - `e2e/*.e2e.ts`: Playwright through `https://grc.localhost`.
  - Commands: `pnpm test:unit`, `test:db`, `test:stack`, `test:e2e`. `pnpm test` runs unit + db + stack.
- **Environment check (D180):** `pnpm test:env` checks the stack, migrations, Neo4j DENYs, `.env` keys (names only), Caddy's cert and the hosts line. It changes nothing, and db/stack runs call it first. Missing items go to the main session or the user.
- **Mac scripts (D170):** host-side scripts swap the container host for 127.0.0.1:5433 themselves. `.env` keeps one set of addresses.
- **Guard rail 4:**
  - New tests must be red. A **fix** (`fixReason`) may be green, but only when the builder's code is already on the branch and the test writer changed test files only (D167).
  - The check runs only in the task's own worktree, at the tip of `task/<ID>` (D168).
  - Builders' tests run 3 times (D171).
  - A skipped test fails unless it's listed in `skips` (D173).
- **Flaky tests (D171):** no retries anywhere. A test that fails and then passes is a bug for the test writer. The integrator runs the full suite once before each push. The checkpoint runs it 3 times, plus every browser test.
- **Browser tests (D172):** the integrator runs `pnpm test:e2e` when a task touched the web app, the API or Caddy.
- **Agreement (D174):** a test writer names the earlier tests and decisions its tests agree with, and the code reviewer checks.
- **Security matrix (D175):** `packages/shared/src/access/security-matrix.ts` lists every record type and route. A test fails when the code has one the matrix lacks. The security reviewer checks it on every task.
- **Never** weaken live privileges, secrets, the certificate or the running stack to prove a test (D176).
