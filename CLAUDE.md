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
1–6. **Plan locked** (2026-09-24/25): shape and architecture (D1–D27), tech stack (D28–D35), system design (D36–D48), security (D49–D59), networking (D60–D65), data structures (D66–D73). ✅
7. **Stress test and benchmark.** ⏸ Deferred by the user on 2026-09-25. Resume from the Q73 proposal in memory.md ("Deferred phases").
8–9. **Orchestration layer and workflow** (D74–D121). ✅ Done 2026-09-27: 9 agents, the hooks, the monitor, the board and `milestone.js`.
10. **Build the MVP (fast mode, D222–D224).** Builder → integrator per task, one review-and-test round per slice, until the demo works end to end; then full testing. ← *current phase*

## Current state (updated 2026-10-15; resume from here)
- **FAST MODE (D222, D223, 2026-10-15): build a working MVP demo first, test after.** Each task goes builder → integrator, up to 4 builders at once. Per task: no new tests, no test writer, no reviewers, no 3× runs, no full suite (the test writer and both reviewers run once per slice instead, D224). The finish check is lint + type checks only (`FAST_MODE` in `.claude/hooks/lib/checks.mjs`). **Per task** the integrator merges into local `main` and runs lint and type checks: no Docker rebuild and no push. **Per slice**, once every task is merged, one integrator commits the board, rebuilds the stack once, checks the app starts, and pushes `main` to GitHub once. Existing tests stay in the repo. The other guard rails and the security decisions (D49–D59) still apply. An agent that dies or hands in nothing runs once more on Opus 5.5 before it counts as blocked.
- **Each slice (D224):** plan if needed → build (builder → integrator per task) → review and test the whole slice once (test writer ║ code reviewer ║ security reviewer; fixes to a builder; at most 3 rounds) → slice tests on `main`, rebuild, push. Pushes need no user OK (`.claude/settings.local.json` allows `git push origin main`; only the integrator pushes). S2 runs alone first: `{milestone: "s2", step: "build"}`.
- **How to run it:** one run for the whole MVP, `{milestone: ["s2", "s3", "s4", "s5", "s6", "s8"], step: "build"}`. The run takes the slices in order, plans a slice itself when the board has no tasks for it (no user OK between slices during the MVP, D223), builds it, pushes it, and moves on. A blocked task stops the run after its slice, with nothing pushed for that slice; fix it (`notes` or `from`) and run again with the same list, finished slices are skipped from the board. `fast: false` brings back the full chain (D219).
- **MVP order:** S2 frameworks → S3 uploads + generators → S4 processing → S5 Analyst review → S6 search + chat → S8 dashboard + benchmark. **S7 waits until after the MVP.** S4, S5, S6 and S8 get planned on the way (fast-mode briefs: behaviour only, no tests). Then testing and the checkpoints (D114) on the finished MVP.
- **M0 and S1 are done, approved and tagged** `m0` (D193) and `s1` (D218). Reports: `docs/checkpoints/m0.md`, `docs/checkpoints/s1.md`. The D160 history rewrite is done: old task branches carry the pre-rewrite history, so never merge them as they are.
- **S2:** in progress; `TASKS.md` has each task's status. Merged tasks go to GitHub with the S2 slice-end push. The Neo4j test-database fault (`logs/build-errors.md` item 37) only hits test runs, so it waits with the tests (D222); S7-027 is not run first. The failed database `org-e60975e8…` is gone: the user OK'd deleting it on 2026-10-15, and Neo4j no longer had it (all 6 databases online).
- **Save point (2026-10-06):** branch `save/2026-10-06-restart` and local tag `checkpoint-2026-10-06`. `RoughWork.md` is the user's and never committed. If `TASKS.md` loses the S2/S3/S7 briefs, restore it with `git checkout save/2026-10-06-restart -- TASKS.md`.
- **Cleanup (2026-10-09):** 88 old worktrees (Sep 27–29) removed; each one's last commit is kept as a local ref `refs/archive/worktrees/<name>`. The Mac hadn't restarted in weeks and swap was nearly full, which is what made builds crawl: restart it when it slows down.
- **Starting up:** start Docker Desktop (the `grc-*` containers come back on their own); start the GRC DBMS **from Neo4j Desktop**; `pnpm test:env` should be all OK; the monitor is `node .claude/monitor/server.mjs`.
- **How a build runs:** if a run dies, start a fresh one with the same args. A task stuck mid-stage restarts with `from: {"<ID>": "build" | "merge"}` and a note in `notes`. Watch it in the monitor (http://127.0.0.1:4800), `/workflows`, or the run's `journal.jsonl`.
- **Workflow:** `milestone.js` builds one slice per run (D221). Hot-file locks from build to merge; one integrator at a time, merging waiting tasks as one batch (D215); migration numbers given at merge.
- **Waiting on the user, not blocking the MVP:** before S7, S7-Q10 (the restore-test account) and where the off-site backup copy goes; whether an owner-only change resets reviewed evidence (S3).
- **Open, not blocking:**
  - The planner's S1 readings to confirm: the S1-Q6 split into S1-011/S1-012; names `POST /api/v1/links/remove`, `canLinkRecords`, `linkRemovedAudit`, `FIRST_NUMBER`, `MAP_*`; values stored lowercase with `_`.
  - Q39's context hand-off part.
- **Open security items:** SF-001…SF-007 in `SECURITY-FINDINGS.md`, left for the user (D184). S1-004 fixes SF-006.
- **Environment:**
  - Neo4j DBMS running (127.0.0.1), all 28 query roles have their DENYs.
  - Docker stack up (`grc-postgres`, `grc-seaweedfs`, `grc-dev-relay`, `grc-caddy`, `grc-api`, `grc-worker`). Start or recreate it from the main checkout only.
  - `.env` has BETTER_AUTH_SECRET and DEMO_USER_PASSWORD (the values the demo users were seeded with). `pnpm test:env` checks the test environment (D180).
  - Caddy's local root is trusted on the Mac; `127.0.0.1 grc.localhost` is in /etc/hosts.
  - Errors log: `logs/build-errors.md`. Security findings: `SECURITY-FINDINGS.md` (D169).

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
- **Runs inside Claude Code on this Mac.** There's no API key, and the agents need the local Docker, Neo4j Desktop and Ollama. Workflows run up to 4 agents at once (D219).
- **Git:**
  - A local repo plus a private GitHub repo: https://github.com/krishkuchroo/grc-hybrid-graphrag (the user created it on 2026-09-27, D122). The remote is `origin`.
  - Each builder works in its own worktree.
  - Only the integrator pushes, after every finished task that passes its checks. Each approved milestone gets a tag (`m0`, `s1`…`s8`).
  - Never pushed: `.env`, backups, generated test data, uploaded files and model files.
  - **Commit messages and PR text never mention Claude, Anthropic or AI tooling:** no `Co-Authored-By`, `Claude-Session` or "Generated with" lines (D159). The `commit-msg` git hook strips them if they slip in.
- **Agents** (`.claude/agents/`), all on the session model (Opus 5.5):
  - **Planner:** writes the tasks and pass criteria, keeps `TASKS.md`, and is the only agent that edits `memory.md`.
  - **Test writer:** tests each task's finished code on its own: behaviour tests from the brief, then probing the code (D219).
  - **Builders** (platform, backend, frontend, data): go first on each task, writing general code for the behaviour in the brief (D219). They **can't edit test files.** If a test looks wrong, it goes back to the test writer.
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
  - **One slice at a time (D221, D222):** S2 → S3 → S4 → S5 → S6 → S8 for the MVP, then S7. (D181's parallel groups were dropped on 2026-10-02.)
  - The user approves at the end of each milestone, with one checkpoint per slice (D114, D221). Each checkpoint has a demo and test results.
- **Done means** (paused by fast mode, D222: until the MVP works, done = lint + type checks pass and the integrator merged it):
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
- **Task board:** `TASKS.md`. Each task has an ID, milestone, owner, status, pass criteria and tests. Each task's brief sits under "Briefs" and starts with `Task: <ID>` (D91). Agents read theirs with `node .claude/scripts/brief.mjs <ID>`, never the whole board (D219).
- **Skills:** marketplace skills only, listed in `skills.md`. The user approves each agent's skills before every milestone.
- **Milestone workflow (D109–D118):** `.claude/workflows/milestone.js`, started with the milestone ID.
  1. Step `plan`: the planner splits the milestone. The user OKs the task list and skills (D111).
  2. Step `build`: each task goes builder → test writer → both reviewers → integrator, on branch `task/<ID>` (D219). Up to 4 agents run at once. A blocked task holds only the tasks that wait on it. Real-Gemma steps run one at a time at the end.
  3. The checkpoint (D114), including a whole-codebase `/insecure-defaults:audit` run (D128). Then step `tag`, after the user approves.
- **Monitor, logs and guard-rail files:** see `docs/workflow.md`. The monitor runs with `node .claude/monitor/server.mjs` at http://127.0.0.1:4800. Logs live in git-ignored `logs/`, and only the hooks and the monitor write there. The guard rails live in `.claude/hooks/`.
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
> **Paused by fast mode (D222, 2026-10-15):** no new tests and no test runs gate a task until the MVP demo works. D224 keeps one review-and-test round per slice. The full rules (guard rail 4, flaky tests, browser tests, agreement) are in `docs/workflow.md` and apply again when testing starts.
- **Test kinds (D177):** `*.unit.test.ts` (needs nothing, the default), `*.db.test.ts` (throwaway databases), `*.stack.test.ts` (the running stack), `e2e/*.e2e.ts` (Playwright through `https://grc.localhost`). Commands: `pnpm test:unit`, `test:db`, `test:stack`, `test:e2e`; `pnpm test` runs unit + db + stack.
- **Environment check (D180):** `pnpm test:env` checks the stack and changes nothing; db and stack runs call it first.
- **Security matrix (D175):** `packages/shared/src/access/security-matrix.ts` lists every record type and route. A test fails when the code has one the matrix lacks.
- **Never** weaken live privileges, secrets, the certificate or the running stack to prove a test (D176).
