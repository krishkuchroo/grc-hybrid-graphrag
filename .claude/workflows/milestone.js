export const meta = {
  name: 'milestone',
  description: 'Run one GRC milestone or a list of slices: plan each if needed, build its tasks (builder → integrator in fast mode), rebuild and push once per slice, or tag it',
  whenToUse:
    'Fast mode (D222, D223, the default): give the slices in order, e.g. ["s2", "s3", "s4", "s5", "s6", "s8"], with step "build". Each slice is planned if the board has no tasks for it, built builder → integrator per task (merged locally, lint and type checks only), then rebuilt and pushed to GitHub once, before the next slice starts. A blocked task stops the run after its slice. Full chain (D219): `fast: false`, one milestone or a parallel group (D181), step "plan" first, "build" after the user OKs the task list (D111). "tag" after the user approves a checkpoint (D81). Args: "s1", or { milestone: "s2" | ["s2", "s3"], step: "build", fast?: false, notes?: { "<task ID>": "note" }, from?: { "<task ID>": "build" | "test" | "review" | "merge" }, only?: ["<task ID>"] }.',
  phases: [
    { title: 'Plan', detail: 'the planner splits a milestone into tasks and briefs' },
    { title: 'Build', detail: 'fast mode: builder → integrator (local merge, lint and type checks) per task; full chain: builder → test writer → reviewers → integrator (D219)' },
    { title: 'Real Gemma', detail: 'the real-Gemma steps, one at a time (D113)' },
    { title: 'Push', detail: 'fast mode: one stack rebuild, a start check and one push per finished slice (D223)' },
    { title: 'Tag', detail: 'the integrator tags the approved milestone' },
  ],
}

// One workflow per milestone, per list of slices run in order (fast mode,
// D222, D223), or per parallel group of slices (full chain, D109, D116,
// D181–D183). The chain, the retry limits and the stops come from D78, D86,
// D109–D118 and D219; CLAUDE.md ("Orchestration") has the summary.

const MILESTONES = ['m0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']
const BUILDERS = ['builder-platform', 'builder-backend', 'builder-frontend', 'builder-data']
const MAX_AT_ONCE = 4 // agents at once, shared by every slice in the run (D183, D219)
const MAX_ROUNDS = 3 // builder ↔ test-writer rounds, and reviewer send-backs (D78, D86)
const STAGES = ['build', 'test', 'review', 'merge']
// Fast mode (D222, D223): MVP first, test after. Each task is builder →
// integrator: the integrator merges into `main` locally and runs lint and
// type checks only. No test writer, no reviewers, no suite, no Docker
// rebuild and no push per task. When every task of a slice is merged, one
// integrator rebuilds the stack once, checks the app starts and pushes once;
// then the next slice in the list starts. Pass `fast: false` for the full
// chain.
const FAST = (typeof args === 'object' && args && !Array.isArray(args) && args.fast === false) ? false : true
const FAST_RULES = [
  'FAST MODE (D222): we are building a working MVP demo first and testing after. Do not write new tests and do not run the test suites. Skip any "Tests to write" or test-command parts of the brief.',
  'Still: the code must be complete and working end to end (API, worker and screens wired together, no stubs, no TODOs), it must pass `pnpm lint` and `pnpm typecheck`, and security decisions (org wall, roles, labels, audit) still apply.',
  'In `tests.run`, put "none (fast mode)".',
]
// The running stack is rebuilt from the main checkout only (CLAUDE.md), with
// the dev-only switch on so the Mac can reach Postgres (D61, D132).
const STACK_UP = 'docker compose -f packages/infra/compose.yaml -f packages/infra/compose.dev.yaml --env-file .env up -d --build'
const STACK_PS = 'docker compose -f packages/infra/compose.yaml -f packages/infra/compose.dev.yaml --env-file .env ps'

// Effort per agent (D219): xhigh where the work is judgement (building,
// testing, security), high everywhere else.
const EFFORT = { 'test-writer': 'xhigh', 'security-reviewer': 'xhigh', 'code-reviewer': 'high', integrator: 'high', planner: 'high' }
const effortOf = (agentType) => (BUILDERS.includes(agentType) ? 'xhigh' : EFFORT[agentType] ?? 'high')

const given = typeof args === 'string' || Array.isArray(args) ? { milestone: args } : args ?? {}
// One milestone, a list of slices run in order (fast mode), or a parallel
// group of slices built in one run (full chain, D181, D183).
const group = (Array.isArray(given.milestone) ? given.milestone : [given.milestone]).map((m) => String(m ?? '').trim().toLowerCase())
const milestone = group.join('+')
const step = given.step ?? 'plan'
// Optional { "<task ID>": "note" }: the note goes to that task's first agent
// only, and a task blocked on the board runs again.
const resumeNotes = given.notes ?? {}
// Optional { "<task ID>": "build" | "test" | "review" | "merge" }: restart a
// task at that stage, when its code (for "test"), its code and tests (for
// "review"), or both approvals (for "merge") are already on its branch. In
// fast mode "test" and "review" mean "merge": the code is on the branch.
const startFrom = given.from ?? {}
// Optional ["<task ID>", ...]: run only these tasks, so a second run can take
// them beside a run already going (D210). The others are left alone; a task
// they wait on must be done on the board.
const only = Array.isArray(given.only) && given.only.length ? new Set(given.only.map((x) => String(x).toUpperCase())) : null
const badMs = group.filter((m) => !MILESTONES.includes(m))
if (!group.length || badMs.length || new Set(group).size !== group.length) {
  return { error: `the milestone must be one of ${MILESTONES.join(', ')}, or a list of different ones; got ${JSON.stringify(given.milestone)}` }
}
if (group.length > 1 && group.includes('m0')) return { error: 'm0 runs on its own' }
if (!['plan', 'build', 'tag'].includes(step)) return { error: `the step must be plan, build or tag; got "${step}"` }
const MS = milestone.toUpperCase()
const up = (ms) => ms.map((x) => x.toUpperCase()).join(', ')

// The conflict rules for slices built side by side (full chain, D183), given
// to the planner and the integrator. Fast mode builds one slice at a time.
const parallelRules = (slices) => slices.length > 1
  ? [
      `This run builds ${up(slices)} side by side (D181, D183).`,
      'Each slice owns its own folders (for example S2 `frameworks/`, S3 `intake/`, S7 `admin/`). A task never changes another slice\'s folders; what it needs from another slice goes through a small shared interface, or the task waits on that slice\'s task (`dependsOn` may name tasks of the other slices in this run).',
    ]
  : []

// The hand-off object from CLAUDE.md ("Hand-off"), plus any extra fields.
const HANDOFF = {
  taskId: { type: 'string' },
  status: { type: 'string', enum: ['done', 'blocked', 'approved', 'sent-back'] },
  filesChanged: { type: 'array', items: { type: 'string' } },
  tests: { type: 'object', properties: { run: { type: 'string' }, passed: { type: 'number' }, failed: { type: 'number' } } },
  findings: { type: 'string' },
  // A test writer's fix to tests the code already meets (D167).
  fixReason: { type: 'string' },
  // Skipped tests, each with a reason for the reviewers to approve (D173).
  skips: { type: 'array', items: { type: 'object', properties: { test: { type: 'string' }, reason: { type: 'string' } }, required: ['test', 'reason'] } },
}
const handoffSchema = (extra = {}, required = []) => ({
  type: 'object',
  properties: { ...HANDOFF, ...extra },
  required: ['taskId', 'status', 'findings', ...required],
})
const TASK = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    owner: { type: 'string', enum: BUILDERS },
    dependsOn: { type: 'array', items: { type: 'string' } },
    boardStatus: { type: 'string' },
    // Files many tasks touch; only one task at a time changes each (D183).
    hotFiles: { type: 'array', items: { type: 'string' } },
    realGemma: {
      type: 'object',
      properties: { owner: { type: 'string', enum: BUILDERS }, run: { type: 'string' } },
      required: ['owner', 'run'],
    },
  },
  required: ['id', 'owner', 'dependsOn'],
}
const TASKS = { type: 'array', items: TASK }
const WORKTREE = { worktree: { type: 'string', description: 'the output of `pwd` in your worktree' } }
// A reviewer's send-back, split by who fixes it (D219).
const REVIEW_FIXES = {
  builderFixes: { type: 'string', description: 'what the builder must change in the code; empty if nothing' },
  testFixes: { type: 'string', description: 'what the test writer must change in the tests; empty if nothing' },
}

// Runs at most `n` jobs at once.
function limiter(n) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= n || !queue.length) return
    active += 1
    const { job, done, fail } = queue.shift()
    job().then(done, fail).finally(() => {
      active -= 1
      next()
    })
  }
  return (job) => new Promise((done, fail) => {
    queue.push({ job, done, fail })
    next()
  })
}
const slot = limiter(MAX_AT_ONCE)
const boardLock = limiter(1) // one planner edits TASKS.md at a time

// Hot-file locks (D183): a task holds its hot files from the builder until it
// is merged or blocked. Taken in sorted order, so two tasks can't wait on
// each other.
const hotLocks = new Map()
async function holdHotFiles(files) {
  const releases = []
  for (const f of [...new Set(files)].sort()) {
    if (!hotLocks.has(f)) hotLocks.set(f, limiter(1))
    releases.push(
      await new Promise((got) => {
        hotLocks.get(f)(() => new Promise((release) => got(release)))
      }),
    )
  }
  return () => releases.reverse().forEach((r) => r())
}

// Every brief starts with `Task: <ID>` (D91).
const brief = (id, lines) => [`Task: ${id}`, ...lines.filter(Boolean)].join('\n')

// An agent's hand-off; a skipped or dead agent counts as blocked.
// An agent that dies, hands in nothing or throws (for example the session
// model failing or out of capacity) is run once more on the fallback model
// (D223: Opus 5.5); only then does it count as blocked.
const FALLBACK_MODEL = 'opus'
async function handIn(id, agentType, lines, { label, phase: ph = 'Build', schema = handoffSchema(), isolation, model, effort } = {}) {
  const text = brief(id, lines)
  const opts = { agentType, label: label ?? `${agentType}:${id}`, phase: ph, schema, isolation, model, effort: effort ?? effortOf(agentType) }
  let h = null
  let why = ''
  try {
    h = await slot(() => agent(text, opts))
  } catch (err) {
    why = String(err)
  }
  if (!h && model !== FALLBACK_MODEL) {
    log(`${opts.label}: no hand-off${why ? ` (${why})` : ''}; running it again on ${FALLBACK_MODEL}`)
    try {
      h = await slot(() => agent(text, { ...opts, label: `${opts.label}:${FALLBACK_MODEL}`, model: FALLBACK_MODEL }))
    } catch (err) {
      why = String(err)
    }
  }
  return h ?? { taskId: id, status: 'blocked', findings: `${agentType} stopped without a hand-off${why ? `: ${why}` : ''}` }
}

// The planner records each task's result on the board once, when the task
// ends (D85, D219); the monitor shows the stages as they happen. The task
// doesn't wait for it; the workflow waits for all of them at the end of the
// slice (fast mode) or the run.
let boardUpdates = []
function record(id, from, h, boardStatus) {
  boardUpdates.push(
    boardLock(() =>
      handIn(
        id,
        'planner',
        [
          "Record a task's result on the board (your \"When you record a hand-off\" steps).",
          `From: ${from}. Its status: ${h.status}. Set the task's board status to "${boardStatus}".`,
          boardStatus === 'blocked' ? `Blocked notes: ${h.findings}` : '',
          'Hand off with status "done".',
        ],
        { label: `board:${id}` },
      ),
    ),
  )
}
async function boardSettled() {
  const pending = boardUpdates
  boardUpdates = []
  await Promise.all(pending)
}

// ---- plan -------------------------------------------------------------------
// One planner per slice. In a group they run one after another: they all
// edit TASKS.md, and each later one sees the tasks the earlier ones planned.
async function planSlice(m, slices) {
  const M = m.toUpperCase()
  const othersOf = slices.filter((x) => x !== m).map((x) => x.toUpperCase())
  const h = await handIn(
    M,
    'planner',
    [
      `Plan milestone ${M} (your "When you plan a milestone" steps).`,
      ...parallelRules(slices),
      othersOf.length ? `Plan only ${M}. The other slices of this run (${othersOf.join(', ')}) are planned separately; read their tasks on the board if they are there already.` : '',
      ...(FAST
        ? [
            'FAST MODE (D222, D223): we are building a working MVP demo first and testing after. Each task is builder → integrator: no test writer and no reviewers. Each brief describes the behaviour and the pass criteria the builder must meet, in plain words, not the shape of the code. Leave out the "Tests to write" part and test commands; the tests come after the MVP.',
            'Each task has one builder as its owner. The integrator merges each finished task into `main` locally (lint and type checks only); the slice is rebuilt and pushed once at its end.',
            'Keep waiting chains short so many tasks can run at once (D210): give each task only the `dependsOn` it truly needs, and where a feature has a backend part and a screen, make them separate tasks so the screen waits only on what it calls.',
            'Every task costs a builder, a merge and a board update, so fold a very small change (one file, or a few lines) into the neighbouring task that needs it rather than giving it its own task (D215).',
          ]
        : [
            'Each task has one builder as its owner; the test writer, the reviewers and the integrator take part in every task.',
            'The builder goes first and the test writer tests the finished code (D219). So each brief describes the behaviour and the pass criteria, not the shape of the code, and its "Tests to write" names behaviours to check, not code internals.',
            'Keep waiting chains short so many tasks can run at once (D210): give each task only the `dependsOn` it truly needs, and where a feature has a backend part and a screen, make them separate tasks so the screen waits only on what it calls.',
            'Every task costs five agent steps, so fold a very small change (one file, or a few lines) into the neighbouring task that needs it rather than giving it its own task (D215).',
          ]),
      'Also return every task in `tasks`: its ID, its owner, and the IDs of the tasks it waits on (`dependsOn`, [] if none).',
      "List each task's hot files in `hotFiles` and in its brief: files many tasks touch, such as the API app module, the generated API client, the web router and menu, the role table, the security matrix, and `package.json`/`pnpm-lock.yaml` when it adds a package. Only one task at a time may change each (D183).",
      'Never fix a database migration number in a brief. Say "a new migration"; the integrator gives it the next number when it merges (D183).',
      'If a pass criterion needs the real Gemma (D82, D113), add `realGemma` with the builder that runs it and the pnpm command. Leave it out otherwise.',
      'Put each open question for the user in `questions`, in plain words.',
    ],
    { label: `plan:${M}`, phase: 'Plan', schema: handoffSchema({ tasks: TASKS, questions: { type: 'array', items: { type: 'string' } } }, ['tasks']) },
  )
  return { milestone: m, status: h.status, tasks: h.tasks ?? [], questions: h.questions ?? [], findings: h.findings }
}

if (step === 'plan') {
  phase('Plan')
  const plans = []
  for (const m of group) plans.push(await planSlice(m, FAST ? [m] : group))
  return {
    milestone,
    step,
    plans,
    next: FAST
      ? 'Show the user the task lists and the questions. Then run step "build" with the slices in order; in fast mode the build plans any later slice itself when it reaches it (D223).'
      : 'Show the user the task lists and the questions, and get their OK and the skills approval (D88, D111). Then run step "build".',
  }
}

// ---- tag --------------------------------------------------------------------
if (step === 'tag') {
  phase('Tag')
  // One tag per slice, even after a combined checkpoint (D182).
  const h = await handIn(
    MS,
    'integrator',
    [
      `The user approved the ${MS} checkpoint. Tag \`main\` as ${group.map((m) => `\`${m}\``).join(', ')} and push each tag with a normal push: ${group.map((m) => `\`git push origin ${m}\``).join(', ')} (D81, D182).`,
      'Merge nothing. Hand off with status "done", or "blocked" with what stopped you.',
    ],
    { label: `tag:${milestone}`, phase: 'Tag' },
  )
  return { milestone, step, status: h.status, findings: h.findings }
}

// ---- build ------------------------------------------------------------------

// Lists a slice's (or a group's) tasks from the board. Empty when the board
// has none yet.
async function listTasks(slices) {
  const S = slices.map((m) => m.toUpperCase())
  const listing = await handIn(
    S.join('+'),
    'planner',
    [
      `List the tasks of ${S.map((M) => `milestone ${M}`).join(' and ')} from TASKS.md. Change nothing. If the board has no tasks for it yet, return an empty \`tasks\` list and say so.`,
      'Return every task in `tasks` with its board status in `boardStatus`, its owner, `dependsOn`, its `hotFiles` from its brief ([] if none), and `realGemma` where its brief has a real-Gemma step.',
      'Hand off with status "done".',
    ],
    { label: `list:${S.join('+')}`, schema: handoffSchema({ tasks: TASKS }, ['tasks']) },
  )
  return listing
}

// The merge queue (D183, D215). Finished tasks wait here. One integrator at
// a time takes everything waiting. Fast mode: merge into `main` locally, lint
// and type checks, no push (D223). Full chain: several tasks merge as one
// batch with one full suite and one push; if the batch fails, they merge one
// at a time.
const MERGE_LOCK = "Another run may be merging too (D210). Before you touch `main`, take the merge lock: `mkdir .git/grc-merge.lock` (it fails while another integrator holds it; then wait a minute and try again, and treat a lock older than 2 hours as stale and remove it). Hold it until your push is done or you hand in blocked, then `rmdir .git/grc-merge.lock`."
const MIGRATIONS = 'If a branch adds a database migration, give it the next free number on `main` at merge time and fix the migration journal to match; renumber only that task\'s own new migration (D183). Whenever `main` has a migration the live dev database lacks (after you merge into `main` or fast-forward it), run `pnpm db:migrate` in the main checkout before you run checks there (D220).'
const FAST_MIGRATIONS = 'If a branch adds a database migration, give it the next free number on `main` at merge time and fix the migration journal to match; renumber only that task\'s own new migration (D183). Do not apply it to the live dev database now: the slice-end step runs `pnpm db:migrate` before it rebuilds the stack (D223).'
const FAST_MERGE_RULES = [
  'FAST MODE (D222, D223): no test suite, no browser tests, no Docker rebuild and no push now. The slice is rebuilt and pushed once when all of its tasks are merged. Your steps here are: lock, merge, lint and type checks, hand in.',
  'After the merge, run `pnpm lint` and `pnpm typecheck` in the main checkout. If only formatting fails, fix it with `prettier --write` on those files and commit the fix on `main`. Otherwise hand in "blocked" with the failing output and leave `main` as it is (never reset it).',
  'Hand in "done" with the merge commit in your findings, and `tests.run` as "none (fast mode)".',
]
const cleanUp = (items) => {
  const trees = items.flatMap((x) => x.worktrees)
  return trees.length ? `When you are done, remove these worktrees that still exist: ${trees.map((w) => `\`git worktree remove --force ${w}\``).join(', ')}. Keep the branches (D118).` : ''
}
let building = group // the slices this merge queue serves right now
const mergeOne = (x) =>
  handIn(x.id, 'integrator', [
    `Merge \`${x.branch}\` into \`main\` in the main checkout${FAST ? '' : ' (your steps)'}.`,
    x.note,
    ...(FAST ? FAST_MERGE_RULES : []),
    MERGE_LOCK,
    'Merge the latest `main`.',
    FAST ? FAST_MIGRATIONS : MIGRATIONS,
    !FAST && building.length > 1 ? `Other slices (${up(building)}) are merging in this same queue, so \`main\` may have moved since the branch started: merge \`main\` in first and run the full suite on the result.` : '',
    cleanUp([x]),
  ])
function mergeBatch(items) {
  const ids = items.map((x) => x.id)
  const name = `batch/${ids.join('-')}`
  if (FAST) {
    return handIn(ids[0], 'integrator', [
      `Merge ${ids.join(', ')} into \`main\` in the main checkout, one after another with \`--no-ff\`, in this order: ${items.map((x) => `\`${x.branch}\``).join(', ')}. Resolve conflicts as usual.`,
      ...items.filter((x) => x.note).map((x) => `${x.id}: ${x.note}`),
      ...FAST_MERGE_RULES,
      'Run lint and type checks once, after the last merge. If they fail and you can tell which task broke them, name it in your findings.',
      MERGE_LOCK,
      FAST_MIGRATIONS,
      `Hand in "done" listing every task ID in findings. ${cleanUp(items)}`,
    ], { label: `integrator:${ids.join('+')}` })
  }
  return handIn(ids[0], 'integrator', [
    `Batch merge (D215) of ${ids.join(', ')}: each has both approvals. Merge them together, run the checks once and push once.`,
    ...items.filter((x) => x.note).map((x) => `${x.id}: ${x.note}`),
    MERGE_LOCK,
    `1. Make a batch branch in its own worktree: \`git worktree add .claude/worktrees/${name.replace('/', '-')} -b ${name} main\` (after taking the lock, from the latest \`main\`).`,
    `2. There, merge each branch in this order with \`--no-ff\`, resolving conflicts as usual: ${items.map((x) => `\`${x.branch}\``).join(', ')}.`,
    MIGRATIONS,
    '3. There, run lint, type checks and the full suite once, and the browser tests if any of these tasks touched the web app, the API or Caddy (D172).',
    `4. If everything passes: in the main checkout, \`git merge --ff-only ${name}\` on \`main\`, push once, and hand in "done" listing every task ID in findings.`,
    '5. If anything fails: push nothing and leave `main` as it was (never reset it). Hand in "blocked" with the failing output and, if you can tell, which task broke it; the tasks then merge one at a time.',
    `Remove the batch worktree when you're done. ${cleanUp(items)}`,
  ], { label: `integrator:${ids.join('+')}` })
}
const waitingToMerge = []
let merging = false
function queueMerge(item) {
  return new Promise((done) => {
    waitingToMerge.push({ ...item, done })
    pumpMerges()
  })
}
async function pumpMerges() {
  if (merging || !waitingToMerge.length) return
  merging = true
  const batch = waitingToMerge.splice(0)
  try {
    let hands = null
    if (batch.length > 1) {
      const h = await mergeBatch(batch)
      if (h.status === 'done') hands = batch.map(() => h)
      else log(`batch merge of ${batch.map((x) => x.id).join(', ')} failed; merging one at a time`)
    }
    if (!hands) {
      hands = []
      for (const x of batch) hands.push(await mergeOne(x))
    }
    batch.forEach((x, k) => x.done(hands[k]))
  } catch (err) {
    batch.forEach((x) => x.done({ taskId: x.id, status: 'blocked', findings: `the merge queue failed: ${err}` }))
  } finally {
    merging = false
    pumpMerges()
  }
}

// Fast mode (D223): when every task of a slice is merged, one integrator
// rebuilds the stack once, checks the app starts, and pushes `main` once.
async function pushSlice(m) {
  const M = m.toUpperCase()
  return handIn(
    M,
    'integrator',
    [
      `Slice ${M} is built: every task of it is merged into \`main\`. Finish the slice (D223): rebuild the running stack once, check the app starts, and push \`main\` to GitHub. Merge nothing.`,
      MERGE_LOCK,
      '1. In the main checkout, on `main`: `git status` must show a clean tree apart from `TASKS.md`, `RoughWork.md` and git-ignored files. If `TASKS.md` has changes (the board), commit them on `main` with the message `' + M + ': board`. Never commit `RoughWork.md` or `.env` (D81).',
      '2. Run `pnpm lint` and `pnpm typecheck`. If only formatting fails, fix it with `prettier --write` and commit; otherwise hand in "blocked" with the output and push nothing.',
      '3. If `main` has migrations the live dev database lacks, run `pnpm db:migrate` in the main checkout (D220).',
      `4. Rebuild and restart the stack from the main checkout: \`${STACK_UP}\`. Send the output to a file outside the repository and read only its end. Then check the app starts: within 2 minutes, \`${STACK_PS}\` shows grc-api and grc-worker running (not restarting), and \`curl -sk https://grc.localhost/api/v1/health\` returns 200 with Postgres and Neo4j reachable. If not, read \`docker logs grc-api --tail 100\`, hand in "blocked" with what it says, and push nothing.`,
      '5. Push `main` to `origin` with a normal push (`git push origin main`). Branches stay (D84).',
      '6. Hand in "done" with the pushed commit in your findings, and `tests.run` as "none (fast mode)".',
    ],
    { label: `push:${M}`, phase: 'Push' },
  )
}

// Builds one slice (fast mode) or a group of slices (full chain): lists the
// tasks, checks the list, runs every task through the chain, then the
// real-Gemma steps. Returns { tasks, results, gemma, error? }.
async function buildSlices(slices) {
  building = slices
  const S = up(slices)
  const listing = await listTasks(slices)
  let tasks = listing.tasks ?? []
  if (listing.status !== 'done') return { tasks, results: {}, gemma: [], error: 'the planner could not list the tasks', findings: listing.findings }
  if (!tasks.length) return { tasks, results: {}, gemma: [], error: `the board has no tasks for ${S}`, findings: listing.findings }
  const outside = tasks.filter((t) => !slices.some((m) => t.id.toUpperCase().startsWith(`${m.toUpperCase()}-`)))
  if (outside.length) return { tasks, results: {}, gemma: [], error: `the listing has tasks outside ${S}: ${outside.map((t) => t.id).join(', ')}` }

  // Check the list before anything runs: known owners, known dependencies, no loops.
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const problems = []
  if (byId.size !== tasks.length) problems.push('two tasks share an ID')
  for (const t of tasks) {
    for (const d of t.dependsOn) if (!byId.has(d)) problems.push(`${t.id} waits on ${d}, which isn't in ${S}`)
  }
  const visiting = new Set()
  const checked = new Set()
  const loops = (id) => {
    if (checked.has(id)) return false
    if (visiting.has(id)) return true
    visiting.add(id)
    const found = (byId.get(id)?.dependsOn ?? []).some(loops)
    visiting.delete(id)
    checked.add(id)
    return found
  }
  for (const t of tasks) if (loops(t.id)) problems.push(`the tasks around ${t.id} wait on each other in a loop`)
  const mine = (id) => slices.some((m) => id.toUpperCase().startsWith(`${m.toUpperCase()}-`))
  if (only) for (const id of only) if (mine(id) && !byId.has(id)) problems.push(`\`only\` names ${id}, which isn't in ${S}`)
  for (const [id, s] of Object.entries(startFrom)) {
    if (mine(id) && !byId.has(id)) problems.push(`\`from\` names ${id}, which isn't in ${S}`)
    if (!STAGES.includes(s)) problems.push(`\`from\` for ${id} must be ${STAGES.join(', ')}; got "${s}"`)
  }
  if (problems.length) return { tasks, results: {}, gemma: [], error: 'the task list needs fixing before the build', problems }

  const results = {}

  // One task through the chain. Fast mode (D222, D223): the builder writes
  // the code, then the merge queue. Full chain (D219): the builder writes the
  // code, the test writer tests the finished code, both reviewers check both,
  // then the merge queue. Returns { status, findings, worktrees }.
  async function runTask(t) {
    const id = t.id
    const branch = `task/${id}`
    const worktrees = []
    const blocked = (from, h) => {
      record(id, from, h, 'blocked')
      return { status: 'blocked', findings: `${from}: ${h.findings}`, worktrees }
    }
    const keep = (h) => {
      if (h.worktree) worktrees.push(h.worktree)
      return h
    }

    let stage = startFrom[id] ?? 'build'
    if (FAST && (stage === 'test' || stage === 'review')) stage = 'merge'
    let note = resumeNotes[id] ?? '' // for the task's first agent only
    const firstNote = () => {
      const n = note
      note = ''
      return n
    }
    let tested = stage === 'review' // the test writer has handed in
    let testCommand = '' // the task's tests, from the test writer's hand-off
    let codeNote = '' // tests that show the code is wrong: for the builder
    let testNote = '' // a test the builder shows is wrong: for the test writer
    let reviewNote = '' // the reviewers' fixes for the builder
    let reviewTestNote = '' // the reviewers' fixes for the test writer
    let testRounds = 0
    let sendBacks = 0
    let releaseHot = null
    try {
    // From the builder until the merge, this task alone changes its hot files (D183).
    releaseHot = await holdHotFiles(t.hotFiles ?? [])
    while (stage !== 'merge') {
      if (stage === 'build') {
        const b = keep(
          await handIn(
            id,
            t.owner,
            [
              `You work in a fresh worktree. Start with \`git switch ${branch}\` if the branch exists, otherwise \`git switch -c ${branch} main\` (D112, D118).`,
              firstNote(),
              ...(FAST ? FAST_RULES : []),
              codeNote && `The test writer's tests show the code is wrong. Fix the code, not the tests:\n${codeNote}`,
              reviewNote && `The reviewers sent it back. Fix these:\n${reviewNote}`,
              !codeNote && !reviewNote && (FAST
                ? 'Build the task from its brief. The integrator merges your finished code into `main` after you; nobody else looks at it before the MVP demo, so make it work end to end.'
                : 'Build the task from its brief. The test writer tests your finished code after you (D219).'),
              !FAST && (testCommand
                ? `The task's tests: \`${testCommand}\`. Put that in \`tests.run\`; they must pass.`
                : "In `tests.run`, name this task's tests if the branch already has them; otherwise the existing tests nearest your change (a package's `test:unit` if nothing is closer), to show nothing broke."),
              tested && 'If a test looks wrong, hand off as "blocked", set `testProblem` to true, and say why in your findings. It goes back to the test writer.',
              `Commit your code with a message starting "${id}:". Then run \`git switch --detach\`, so the next agent can take the branch.`,
              'Put the output of `pwd` in `worktree`.',
            ],
            { schema: handoffSchema({ ...WORKTREE, testProblem: { type: 'boolean' } }), isolation: 'worktree' },
          ),
        )
        codeNote = ''
        reviewNote = ''
        if (b.status === 'blocked' && b.testProblem && tested && testRounds < MAX_ROUNDS) {
          testNote = b.findings
          stage = 'test'
          continue
        }
        if (b.status !== 'done') return blocked(t.owner, b)
        if (FAST) {
          stage = 'merge'
          continue
        }
        stage = !tested || reviewTestNote ? 'test' : 'review'
        continue
      }

      if (stage === 'test') {
        testRounds += 1
        const tw = keep(
          await handIn(
            id,
            'test-writer',
            [
              `You work in a fresh worktree. Start with \`git switch ${branch}\`; the builder's code is committed there.`,
              firstNote(),
              !tested && "Write this task's tests now, after the code (D219): your \"Steps\".",
              testNote && `The builder says a test is wrong. Fix it if they're right, and say why in your findings either way:\n${testNote}`,
              reviewTestNote && `The reviewers want these test changes:\n${reviewTestNote}`,
              'Hand in with `fixReason` "tests written after the code (D219)", or your reason for a change: the finish check then expects your tests to pass, and allows test-file changes only (D167).',
              'If a test fails because the code is wrong, commit your tests, hand off as "blocked", set `codeProblem` to true, and name each failing test and what the code gets wrong. It goes to the builder.',
              `Commit your tests with a message starting "${id}:". Then run \`git switch --detach\`.`,
              'Put the output of `pwd` in `worktree`.',
            ],
            { schema: handoffSchema({ ...WORKTREE, codeProblem: { type: 'boolean' } }), isolation: 'worktree' },
          ),
        )
        testNote = ''
        reviewTestNote = ''
        if (tw.tests?.run) testCommand = tw.tests.run
        if (tw.status === 'blocked' && tw.codeProblem && testRounds < MAX_ROUNDS) {
          tested = true
          codeNote = tw.findings
          stage = 'build'
          continue
        }
        if (tw.status !== 'done') return blocked('test-writer', tw)
        tested = true
        stage = 'review'
        continue
      }

      // Both reviewers look at the same commit, side by side.
      const reviewNoteFirst = firstNote()
      const review = (who) =>
        handIn(
          id,
          who,
          [
            `You work in a fresh worktree. Start with \`git switch --detach ${branch}\`. The base is \`main\`.`,
            sendBacks ? `This is review round ${sendBacks + 1}; it was sent back ${sendBacks} time(s) before.` : '',
            reviewNoteFirst,
            who === 'code-reviewer'
              ? "The finish checks already ran lint, type checks and the task's tests on this commit (D97); trust them and rerun only the earlier tests you need for the agreement check (D174, D215)."
              : "The finish checks already ran lint, type checks and the task's tests on this commit (D97); rerun only the isolation and access tests the change touches, plus the security-matrix test (D175, D215).",
            'If you send it back, put what the builder must change in `builderFixes` and what the test writer must change in `testFixes` (D219).',
          ],
          { schema: handoffSchema(REVIEW_FIXES), isolation: 'worktree' },
        )
      const [code, security] = await Promise.all([review('code-reviewer'), review('security-reviewer')])
      for (const [who, h] of [['code-reviewer', code], ['security-reviewer', security]]) {
        if (h.status === 'blocked') return blocked(who, h)
      }
      if (code.status === 'approved' && security.status === 'approved') break

      sendBacks += 1
      if (sendBacks >= MAX_ROUNDS) {
        return blocked('reviewers', { status: 'blocked', findings: `sent back ${sendBacks} times, so it goes to the user (D78)` })
      }
      const back = [code, security].filter((h) => h.status === 'sent-back')
      reviewNote = back.map((h) => h.builderFixes || (h.testFixes ? '' : h.findings)).filter(Boolean).join('\n\n')
      reviewTestNote = back.map((h) => h.testFixes).filter(Boolean).join('\n\n')
      stage = reviewNote ? 'build' : 'test'
    }

    // The merge queue; then the task's worktrees go and the branch stays
    // (D118, D183, D215).
    const merged = await queueMerge({ id, branch, worktrees, note: firstNote() })
    if (merged.status !== 'done') return blocked('integrator', merged)
    record(id, 'integrator', merged, 'done')
    return { status: 'done', findings: merged.findings, worktrees }
    } finally {
      if (releaseHot) releaseHot()
    }
  }

  // Tasks start as soon as the ones they wait on are done. A blocked task holds
  // only the tasks that wait on it; the rest keep going (D117).
  const started = new Map()
  function start(t) {
    if (!started.has(t.id)) {
      started.set(
        t.id,
        (async () => {
          const board = String(t.boardStatus ?? '').toLowerCase()
          if (board === 'done') return (results[t.id] = { status: 'done', findings: 'already done' }).status
          if (only && !only.has(t.id)) return (results[t.id] = { status: 'waiting', findings: 'not in `only`; another run or a later one takes it' }).status
          const deps = await Promise.all(t.dependsOn.map((d) => start(byId.get(d))))
          const stuck = t.dependsOn.filter((_, k) => deps[k] !== 'done')
          if (stuck.length) return (results[t.id] = { status: 'waiting', findings: `waits on ${stuck.join(', ')}` }).status
          // A note for the task (args.notes) means the user sorted out its block.
          if (board === 'blocked' && !resumeNotes[t.id]) return (results[t.id] = { status: 'blocked', findings: 'blocked on the board; the user sorts it out first' }).status
          log(`${t.id} starts (${t.owner})`)
          results[t.id] = await runTask(t)
          log(`${t.id}: ${results[t.id].status}`)
          return results[t.id].status
        })(),
      )
    }
    return started.get(t.id)
  }
  await Promise.all(tasks.map(start))

  // Real-Gemma steps, collected at the end and run one at a time (D82, D113).
  const gemma = []
  const gemmaTasks = tasks.filter((x) => x.realGemma && results[x.id]?.status === 'done' && results[x.id].findings !== 'already done')
  if (gemmaTasks.length) phase('Real Gemma')
  for (const t of gemmaTasks) {
    const h = await handIn(
      t.id,
      t.realGemma.owner,
      [
        'Real-Gemma step (D82, D113). No other agent is running.',
        'You work in a fresh worktree. Start with `git switch --detach main`.',
        `Run: \`${t.realGemma.run}\``,
        'Hand off "done" if it passes, or "blocked" with the failing output in your findings.',
        FAST ? 'In `tests.run`, put "none (fast mode)".' : "In `tests.run`, put the task's everyday test command (saved AI answers), so the finish check doesn't load the models again.",
      ],
      { label: `gemma:${t.id}`, phase: 'Real Gemma', isolation: 'worktree' },
    )
    record(t.id, `${t.realGemma.owner} (real Gemma)`, h, h.status === 'done' ? 'done' : 'blocked')
    if (h.status !== 'done') results[t.id] = { status: 'blocked', findings: `real Gemma: ${h.findings}` }
    gemma.push({ id: t.id, status: h.status, findings: h.findings })
  }
  await boardSettled()
  return { tasks, results, gemma }
}

const pick = (tasks, results, status) =>
  tasks.filter((t) => results[t.id]?.status === status).map((t) => ({ id: t.id, owner: t.owner, findings: results[t.id].findings }))
const summary = (built) => ({
  done: pick(built.tasks, built.results, 'done'),
  blocked: pick(built.tasks, built.results, 'blocked'),
  waiting: pick(built.tasks, built.results, 'waiting'),
  realGemma: built.gemma,
  ...(built.error ? { error: built.error, problems: built.problems, findings: built.findings } : {}),
})

if (!FAST) {
  phase('Build')
  const built = await buildSlices(group)
  if (built.error) return { milestone, step, ...summary(built) }
  return {
    milestone,
    step,
    ...summary(built),
    next: 'Bring every blocked task to the user (D117). Then the checkpoint: run the full suite 3 times and every browser test (D171, D172), then the report, the demo steps, and the user records the walkthrough (D114, D115).',
  }
}

// Fast mode (D223): the slices in order. Each one is planned if the board has
// no tasks for it, built, then rebuilt and pushed once. A slice that ends with
// a blocked or waiting task is not pushed, and the run stops there so the user
// hears straight away (D117); the slices after it wait for the next run.
const slices = {}
for (const m of group) {
  const M = m.toUpperCase()
  phase('Build')
  let built = await buildSlices([m])
  if (built.error && built.error.startsWith('the board has no tasks')) {
    phase('Plan')
    const plan = await planSlice(m, [m])
    slices[m] = { plan }
    if (plan.status !== 'done' || !plan.tasks.length) {
      slices[m].error = `the planner could not plan ${M}`
      slices[m].findings = plan.findings
      break
    }
    phase('Build')
    built = await buildSlices([m])
  }
  slices[m] = { ...(slices[m] ?? {}), ...summary(built) }
  if (built.error) break
  const unfinished = [...slices[m].blocked, ...slices[m].waiting]
  if (unfinished.length) {
    slices[m].pushed = false
    slices[m].stoppedBecause = `${unfinished.map((t) => t.id).join(', ')} did not finish, so ${M} was not pushed and the run stops here`
    break
  }
  if (slices[m].done.every((t) => t.findings === 'already done')) {
    slices[m].pushed = 'nothing new to push'
    log(`${M}: every task was already done, so no rebuild and no push`)
    continue
  }
  phase('Push')
  const h = await pushSlice(m)
  slices[m].pushed = h.status === 'done'
  slices[m].push = h.findings
  if (h.status !== 'done') {
    slices[m].stoppedBecause = `the slice-end rebuild or push of ${M} failed, so the run stops here`
    break
  }
  log(`${M} is built and pushed`)
}
await boardSettled()
const stopped = Object.entries(slices).find(([, s]) => s.stoppedBecause || s.error)
return {
  milestone,
  step,
  fast: true,
  slices,
  next: stopped
    ? `Bring ${stopped[0].toUpperCase()} to the user: ${stopped[1].stoppedBecause ?? stopped[1].error} (D117). Fix the block (a note in \`notes\`, or \`from\`), then run again with the same slices; finished slices are skipped from the board.`
    : 'Every slice in the list is built and pushed. Start the next slices of the MVP (D222 order: S2, S3, S4, S5, S6, S8), or, when the MVP demo works, testing and the checkpoints (D114).',
}
