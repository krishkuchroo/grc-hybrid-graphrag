export const meta = {
  name: 'milestone',
  description: 'Run one GRC milestone, or a parallel group of slices: plan it, build its tasks through the agent chain, or tag it',
  whenToUse:
    'Start with the milestone ID (m0, s1 … s8), or a parallel group of slices (D181), e.g. ["s2", "s3", "s7"]. Step "plan" first; "build" after the user OKs the task list and skills (D111); "tag" after the user approves the checkpoint (D81, D182). Args: "s1", or { milestone: "s1" | ["s2", "s3", "s7"], step: "build", notes?: { "<task ID>": "note" }, from?: { "<task ID>": "build" | "review" } }.',
  phases: [
    { title: 'Plan', detail: 'the planner splits the milestone into tasks and briefs' },
    { title: 'Build', detail: 'test writer → builder → reviewers → integrator, per task' },
    { title: 'Real Gemma', detail: 'the real-Gemma steps, one at a time (D113)' },
    { title: 'Tag', detail: 'the integrator tags the approved milestone' },
  ],
}

// One workflow per milestone, or per parallel group of slices (D109, D116,
// D181–D183). The chain, the retry limits and the stops come from D78, D86,
// D109–D118; CLAUDE.md ("Orchestration") has the summary.

const MILESTONES = ['m0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']
const BUILDERS = ['builder-platform', 'builder-backend', 'builder-frontend', 'builder-data']
const MAX_AT_ONCE = 8 // agents at once, shared by every slice in the run (D79, D110, D183)
const MAX_ROUNDS = 3 // test-writer rounds, and reviewer send-backs (D78, D86)

const given = typeof args === 'string' || Array.isArray(args) ? { milestone: args } : args ?? {}
// One milestone, or a parallel group of slices built in one run (D181, D183).
const group = (Array.isArray(given.milestone) ? given.milestone : [given.milestone]).map((m) => String(m ?? '').trim().toLowerCase())
const milestone = group.join('+')
const step = given.step ?? 'plan'
// Optional { "<task ID>": "note" }: the note goes into that task's first
// test-writer brief only, and a task blocked on the board runs again.
const resumeNotes = given.notes ?? {}
// Optional { "<task ID>": "build" | "review" }: restart a task at that stage,
// when its tests (and, for review, its code) are already on its branch. Its
// note, if any, goes to the first agent of that stage.
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
const others = (m) => group.filter((x) => x !== m).map((x) => x.toUpperCase())

// The conflict rules for slices built side by side (D183), given to the
// planner and the integrator.
const PARALLEL_RULES = group.length > 1
  ? [
      `This run builds ${group.map((m) => m.toUpperCase()).join(', ')} side by side (D181, D183).`,
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
async function handIn(id, agentType, lines, { label, phase: ph = 'Build', schema = handoffSchema(), isolation, model, effort } = {}) {
  const h = await slot(() => agent(brief(id, lines), { agentType, label: label ?? `${agentType}:${id}`, phase: ph, schema, isolation, model, effort }))
  return h ?? { taskId: id, status: 'blocked', findings: `${agentType} stopped without a hand-off` }
}

// The planner records every hand-off on the board (D85). The task doesn't
// wait for it; the workflow waits for all of them at the end.
const boardUpdates = []
function record(id, from, h, boardStatus) {
  boardUpdates.push(
    boardLock(() =>
      handIn(
        id,
        'planner',
        [
          'Record a hand-off on the board (your "When you record a hand-off" steps).',
          `From: ${from}. Its status: ${h.status}. Set the task's board status to "${boardStatus}".`,
          boardStatus === 'blocked' ? `Blocked notes: ${h.findings}` : '',
          'Hand off with status "done".',
        ],
        // One status on one row: a small model on low effort is enough (D215).
        { label: `board:${id}`, model: 'haiku', effort: 'low' },
      ),
    ),
  )
}

// ---- plan -------------------------------------------------------------------
if (step === 'plan') {
  phase('Plan')
  // One planner per slice, one after another: they all edit TASKS.md, and
  // each later one sees the tasks the earlier ones planned.
  const plans = []
  for (const m of group) {
    const M = m.toUpperCase()
    const h = await handIn(
      M,
      'planner',
      [
        `Plan milestone ${M} (your "When you plan a milestone" steps).`,
        ...PARALLEL_RULES,
        others(m).length ? `Plan only ${M}. The other slices of this run (${others(m).join(', ')}) are planned separately; read their tasks on the board if they are there already.` : '',
        'Each task has one builder as its owner; the test writer, the reviewers and the integrator take part in every task.',
        'Keep waiting chains short so many tasks can run at once (D210): give each task only the `dependsOn` it truly needs, and where a feature has a backend part and a screen, make them separate tasks so the screen waits only on what it calls.',
        'Every task costs five agent steps, so fold a very small change (one file, or a few lines) into the neighbouring task that needs it rather than giving it its own task (D215).',
        'Also return every task in `tasks`: its ID, its owner, and the IDs of the tasks it waits on (`dependsOn`, [] if none).',
        "List each task's hot files in `hotFiles` and in its brief: files many tasks touch, such as the API app module, the generated API client, the web router and menu, the role table, the security matrix, and `package.json`/`pnpm-lock.yaml` when it adds a package. Only one task at a time may change each (D183).",
        'Never fix a database migration number in a brief. Say "a new migration"; the integrator gives it the next number when it merges (D183).',
        'If a pass criterion needs the real Gemma (D82, D113), add `realGemma` with the builder that runs it and the pnpm command. Leave it out otherwise.',
        'Put each open question for the user in `questions`, in plain words.',
      ],
      { label: `plan:${M}`, phase: 'Plan', schema: handoffSchema({ tasks: TASKS, questions: { type: 'array', items: { type: 'string' } } }, ['tasks']) },
    )
    plans.push({ milestone: m, status: h.status, tasks: h.tasks ?? [], questions: h.questions ?? [], findings: h.findings })
  }
  return {
    milestone,
    step,
    plans,
    next: 'Show the user the task lists and the questions, and get their OK and the skills approval (D88, D111). Then run step "build".',
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
phase('Build')
const listing = await handIn(
  MS,
  'planner',
  [
    `List the tasks of ${group.map((m) => `milestone ${m.toUpperCase()}`).join(' and ')} from TASKS.md. Change nothing.`,
    'Return every task in `tasks` with its board status in `boardStatus`, its owner, `dependsOn`, its `hotFiles` from its brief ([] if none), and `realGemma` where its brief has a real-Gemma step.',
    'Hand off with status "done".',
  ],
  { label: `list:${MS}`, schema: handoffSchema({ tasks: TASKS }, ['tasks']) },
)
const tasks = listing.tasks ?? []
if (listing.status !== 'done' || !tasks.length) return { milestone, step, error: 'the planner could not list the tasks', findings: listing.findings }
const outside = tasks.filter((t) => !group.some((m) => t.id.toUpperCase().startsWith(`${m.toUpperCase()}-`)))
if (outside.length) return { milestone, step, error: `the listing has tasks outside ${MS}: ${outside.map((t) => t.id).join(', ')}` }

// Check the list before anything runs: known owners, known dependencies, no loops.
const byId = new Map(tasks.map((t) => [t.id, t]))
const problems = []
if (byId.size !== tasks.length) problems.push('two tasks share an ID')
for (const t of tasks) {
  for (const d of t.dependsOn) if (!byId.has(d)) problems.push(`${t.id} waits on ${d}, which isn't in ${MS}`)
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
if (only) for (const id of only) if (!byId.has(id)) problems.push(`\`only\` names ${id}, which isn't in ${MS}`)
if (problems.length) return { milestone, step, error: 'the task list needs fixing before the build', problems }

const results = {}

// One task through the chain. Returns { status, findings, worktrees }.
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

  // Test writer, then builder. A test the builder shows is wrong goes back to
  // the test writer (D89), up to MAX_ROUNDS times.
  let testNote = ''
  let codeNote = ''
  let reviewNote = ''
  let rounds = 0
  let sendBacks = 0
  const startAt = startFrom[id]
  let needTests = !startAt
  let skipBuild = startAt === 'review'
  let releaseHot = null
  try {
  while (true) {
    if (needTests) {
      rounds += 1
      const tw = keep(
        await handIn(
          id,
          'test-writer',
          [
            `You work in a fresh worktree. Start with \`git switch ${branch}\` if the branch exists, otherwise \`git switch -c ${branch} main\` (D112, D118).`,
            rounds === 1 && resumeNotes[id],
            testNote && `The builder says a test is wrong. Fix it if they're right, and say why in your findings either way:\n${testNote}`,
            testNote && "If the builder's code is already on the branch, your corrected tests may pass at once: then hand in with `fixReason` saying why (D167). Never fake a red.",
            testNote && "If your fixed tests are right but a finish check fails only in the builder's code, commit your tests, hand off as \"blocked\", set `codeProblem` to true, and say what the builder must change. It goes back to the builder.",
            `Commit your tests with a message starting "${id}:". Then run \`git switch --detach\`, so the builder can take the branch.`,
            'Put the output of `pwd` in `worktree`.',
          ],
          { schema: handoffSchema({ ...WORKTREE, codeProblem: { type: 'boolean' } }), isolation: 'worktree' },
        ),
      )
      needTests = false
      // A check that fails only in the builder's code goes back to the builder.
      if (tw.status === 'blocked' && tw.codeProblem && testNote && rounds < MAX_ROUNDS) {
        record(id, 'test-writer', tw, 'in progress')
        codeNote = tw.findings
        skipBuild = false
      } else {
        if (tw.status !== 'done') return blocked('test-writer', tw)
        record(id, 'test-writer', tw, 'in progress')
      }
    }

    // From the builder until the merge, this task alone changes its hot files (D183).
    if (!releaseHot) releaseHot = await holdHotFiles(t.hotFiles ?? [])
    if (skipBuild) {
      skipBuild = false
    } else {
    const b = keep(
      await handIn(
        id,
        t.owner,
        [
          `You work in a fresh worktree. Start with \`git switch ${branch}\`; the tests are committed there (D112).`,
          startAt === 'build' && rounds === 0 && !reviewNote && resumeNotes[id],
          reviewNote && `The reviewers sent it back. Fix these:\n${reviewNote}`,
          codeNote && `The test writer fixed the tests, but a check fails in your code. Fix it:\n${codeNote}`,
          `Commit your code with a message starting "${id}:". Then run \`git switch --detach\`, so the reviewers can take the branch.`,
          'If a test looks wrong, hand off as "blocked", set `testProblem` to true, and say why in your findings. It goes back to the test writer.',
          'Put the output of `pwd` in `worktree`.',
        ],
        { schema: handoffSchema({ ...WORKTREE, testProblem: { type: 'boolean' } }), isolation: 'worktree' },
      ),
    )
    codeNote = ''
    if (b.status === 'blocked' && b.testProblem && rounds < MAX_ROUNDS) {
      record(id, t.owner, b, 'in progress')
      testNote = b.findings
      needTests = true
      continue
    }
    if (b.status !== 'done') return blocked(t.owner, b)
    record(id, t.owner, b, 'in review')
    }

    // Both reviewers look at the same commit, side by side.
    const review = (who) =>
      handIn(id, who, [
        `You work in a fresh worktree. Start with \`git switch --detach ${branch}\`. The base is \`main\`.`,
        sendBacks ? `This is review round ${sendBacks + 1}; it was sent back ${sendBacks} time(s) before.` : '',
        startAt === 'review' && sendBacks === 0 && resumeNotes[id],
        who === 'code-reviewer'
          ? "The finish check already ran lint, type checks and the task's tests on this commit (D97, D171); trust its result and rerun only the earlier tests you need for the agreement check (D174, D215)."
          : "The finish check already ran lint, type checks and the task's tests on this commit (D97, D171); rerun only the isolation and access tests the change touches, plus the security-matrix test (D59, D175, D215).",
      ], { isolation: 'worktree' })
    const [code, security] = await Promise.all([review('code-reviewer'), review('security-reviewer')])
    for (const [who, h] of [['code-reviewer', code], ['security-reviewer', security]]) {
      if (h.status === 'blocked') return blocked(who, h)
      record(id, who, h, h.status === 'approved' ? 'in review' : 'in progress')
    }
    if (code.status === 'approved' && security.status === 'approved') break

    sendBacks += 1
    if (sendBacks >= MAX_ROUNDS) {
      return blocked('reviewers', { status: 'blocked', findings: `sent back ${sendBacks} times, so it goes to the user (D78)` })
    }
    reviewNote = [code, security].filter((h) => h.status === 'sent-back').map((h) => h.findings).join('\n\n')
  }

  // The merge queue: merge, full suite, push; then the task's worktrees go
  // and the branch stays (D118, D183, D215).
  const merged = await queueMerge({ id, branch, worktrees })
  if (merged.status !== 'done') return blocked('integrator', merged)
  record(id, 'integrator', merged, 'done')
  return { status: 'done', findings: merged.findings, worktrees }
  } finally {
    if (releaseHot) releaseHot()
  }
}

// The merge queue (D183, D215). Approved tasks wait here. One integrator at a
// time takes everything waiting: several tasks merge as one batch with one
// full suite and one push; if the batch fails, they merge one at a time.
const MERGE_LOCK = "Another run may be merging too (D210). Before you touch `main`, take the merge lock: `mkdir .git/grc-merge.lock` (it fails while another integrator holds it; then wait a minute and try again, and treat a lock older than 2 hours as stale and remove it). Hold it until your push is done or you hand in blocked, then `rmdir .git/grc-merge.lock`. Push only after your checks pass."
const MIGRATIONS = 'If a branch adds a database migration, give it the next free number on `main` at merge time and fix the migration journal to match; renumber only that task\'s own new migration (D183).'
const cleanUp = (items) => {
  const trees = items.flatMap((x) => x.worktrees)
  return trees.length ? `After a successful push, remove these worktrees that still exist: ${trees.map((w) => `\`git worktree remove --force ${w}\``).join(', ')}. Keep the branches (D118).` : ''
}
const mergeOne = (x) =>
  handIn(x.id, 'integrator', [
    `Merge \`${x.branch}\` into \`main\` in the main checkout (your steps).`,
    MERGE_LOCK,
    'Merge the latest `main`.',
    MIGRATIONS,
    group.length > 1 ? `Other slices (${group.map((m) => m.toUpperCase()).join(', ')}) are merging in this same queue, so \`main\` may have moved since the branch started: merge \`main\` in first and run the full suite on the result.` : '',
    cleanUp([x]),
  ])
function mergeBatch(items) {
  const ids = items.map((x) => x.id)
  const name = `batch/${ids.join('-')}`
  return handIn(ids[0], 'integrator', [
    `Batch merge (D215) of ${ids.join(', ')}: each has both approvals. Merge them together, run the checks once and push once.`,
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
phase('Real Gemma')
const gemma = []
for (const t of tasks.filter((x) => x.realGemma && results[x.id]?.status === 'done' && results[x.id].findings !== 'already done')) {
  const h = await handIn(
    t.id,
    t.realGemma.owner,
    [
      'Real-Gemma step (D82, D113). No other agent is running.',
      'You work in a fresh worktree. Start with `git switch --detach main`.',
      `Run: \`${t.realGemma.run}\``,
      'Hand off "done" if it passes, or "blocked" with the failing output in your findings.',
      "In `tests.run`, put the task's everyday test command (saved AI answers), so the finish check doesn't load the models again.",
    ],
    { label: `gemma:${t.id}`, phase: 'Real Gemma', isolation: 'worktree' },
  )
  record(t.id, `${t.realGemma.owner} (real Gemma)`, h, h.status === 'done' ? 'done' : 'blocked')
  gemma.push({ id: t.id, status: h.status, findings: h.findings })
}

await Promise.all(boardUpdates)

const pick = (status) =>
  tasks.filter((t) => results[t.id]?.status === status).map((t) => ({ id: t.id, owner: t.owner, findings: results[t.id].findings }))
return {
  milestone,
  step,
  done: pick('done'),
  blocked: pick('blocked'),
  waiting: pick('waiting'),
  realGemma: gemma,
  next: 'Bring every blocked task to the user (D117). Then the checkpoint: run the full suite 3 times and every browser test (D171, D172), then the report, the demo steps, and the user records the walkthrough (D114, D115).',
}
