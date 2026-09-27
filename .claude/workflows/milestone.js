export const meta = {
  name: 'milestone',
  description: 'Run one GRC milestone: plan it, build its tasks through the agent chain, or tag it',
  whenToUse:
    'Start with the milestone ID (m0, s1 … s8). Step "plan" first; "build" after the user OKs the task list and skills (D111); "tag" after the user approves the checkpoint (D81). Args: "m0", or { milestone: "m0", step: "build", notes?: { "<task ID>": "note for its first test writer" } }.',
  phases: [
    { title: 'Plan', detail: 'the planner splits the milestone into tasks and briefs' },
    { title: 'Build', detail: 'test writer → builder → reviewers → integrator, per task' },
    { title: 'Real Gemma', detail: 'the real-Gemma steps, one at a time (D113)' },
    { title: 'Tag', detail: 'the integrator tags the approved milestone' },
  ],
}

// One workflow per milestone (D109, D116). The chain, the retry limits and
// the stops come from D78, D86, D109–D118; CLAUDE.md ("Orchestration") has
// the summary.

const MILESTONES = ['m0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']
const BUILDERS = ['builder-platform', 'builder-backend', 'builder-frontend', 'builder-data']
const MAX_AT_ONCE = 8 // agents at once (D79, D110)
const MAX_ROUNDS = 3 // test-writer rounds, and reviewer send-backs (D78, D86)

const given = typeof args === 'string' ? { milestone: args } : args ?? {}
const milestone = String(given.milestone ?? '').trim().toLowerCase()
const step = given.step ?? 'plan'
// Optional { "<task ID>": "note" }: the note goes into that task's first
// test-writer brief only, and a task blocked on the board runs again.
const resumeNotes = given.notes ?? {}
if (!MILESTONES.includes(milestone)) return { error: `the milestone must be one of ${MILESTONES.join(', ')}; got "${given.milestone}"` }
if (!['plan', 'build', 'tag'].includes(step)) return { error: `the step must be plan, build or tag; got "${step}"` }
const MS = milestone.toUpperCase()

// The hand-off object from CLAUDE.md ("Hand-off"), plus any extra fields.
const HANDOFF = {
  taskId: { type: 'string' },
  status: { type: 'string', enum: ['done', 'blocked', 'approved', 'sent-back'] },
  filesChanged: { type: 'array', items: { type: 'string' } },
  tests: { type: 'object', properties: { run: { type: 'string' }, passed: { type: 'number' }, failed: { type: 'number' } } },
  findings: { type: 'string' },
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
const mainLock = limiter(1) // one integrator in the main checkout at a time

// Every brief starts with `Task: <ID>` (D91).
const brief = (id, lines) => [`Task: ${id}`, ...lines.filter(Boolean)].join('\n')

// An agent's hand-off; a skipped or dead agent counts as blocked.
async function handIn(id, agentType, lines, { label, phase: ph = 'Build', schema = handoffSchema(), isolation } = {}) {
  const h = await slot(() => agent(brief(id, lines), { agentType, label: label ?? `${agentType}:${id}`, phase: ph, schema, isolation }))
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
        { label: `board:${id}` },
      ),
    ),
  )
}

// ---- plan -------------------------------------------------------------------
if (step === 'plan') {
  phase('Plan')
  const h = await handIn(
    MS,
    'planner',
    [
      `Plan milestone ${MS} (your "When you plan a milestone" steps).`,
      'Each task has one builder as its owner; the test writer, the reviewers and the integrator take part in every task.',
      'Also return every task in `tasks`: its ID, its owner, and the IDs of the tasks it waits on (`dependsOn`, [] if none).',
      'If a pass criterion needs the real Gemma (D82, D113), add `realGemma` with the builder that runs it and the pnpm command. Leave it out otherwise.',
      'Put each open question for the user in `questions`, in plain words.',
    ],
    { label: `plan:${MS}`, phase: 'Plan', schema: handoffSchema({ tasks: TASKS, questions: { type: 'array', items: { type: 'string' } } }, ['tasks']) },
  )
  return {
    milestone,
    step,
    status: h.status,
    tasks: h.tasks ?? [],
    questions: h.questions ?? [],
    findings: h.findings,
    next: 'Show the user the task list and the questions, and get their OK and the skills approval (D88, D111). Then run step "build".',
  }
}

// ---- tag --------------------------------------------------------------------
if (step === 'tag') {
  phase('Tag')
  const h = await handIn(
    MS,
    'integrator',
    [
      `The user approved the ${MS} checkpoint. Tag \`main\` as \`${milestone}\` and push the tag with a normal push: \`git push origin ${milestone}\` (D81).`,
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
    `List milestone ${MS}'s tasks from TASKS.md. Change nothing.`,
    'Return every task in `tasks` with its board status in `boardStatus`, its owner, `dependsOn`, and `realGemma` where its brief has a real-Gemma step.',
    'Hand off with status "done".',
  ],
  { label: `list:${MS}`, schema: handoffSchema({ tasks: TASKS }, ['tasks']) },
)
const tasks = listing.tasks ?? []
if (listing.status !== 'done' || !tasks.length) return { milestone, step, error: 'the planner could not list the tasks', findings: listing.findings }

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
  let reviewNote = ''
  let rounds = 0
  let sendBacks = 0
  let needTests = true
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
            `Commit your tests with a message starting "${id}:". Then run \`git switch --detach\`, so the builder can take the branch.`,
            'Put the output of `pwd` in `worktree`.',
          ],
          { schema: handoffSchema(WORKTREE), isolation: 'worktree' },
        ),
      )
      if (tw.status !== 'done') return blocked('test-writer', tw)
      record(id, 'test-writer', tw, 'in progress')
      needTests = false
    }

    const b = keep(
      await handIn(
        id,
        t.owner,
        [
          `You work in a fresh worktree. Start with \`git switch ${branch}\`; the tests are committed there (D112).`,
          reviewNote && `The reviewers sent it back. Fix these:\n${reviewNote}`,
          `Commit your code with a message starting "${id}:". Then run \`git switch --detach\`, so the reviewers can take the branch.`,
          'If a test looks wrong, hand off as "blocked", set `testProblem` to true, and say why in your findings. It goes back to the test writer.',
          'Put the output of `pwd` in `worktree`.',
        ],
        { schema: handoffSchema({ ...WORKTREE, testProblem: { type: 'boolean' } }), isolation: 'worktree' },
      ),
    )
    if (b.status === 'blocked' && b.testProblem && rounds < MAX_ROUNDS) {
      record(id, t.owner, b, 'in progress')
      testNote = b.findings
      needTests = true
      continue
    }
    if (b.status !== 'done') return blocked(t.owner, b)
    record(id, t.owner, b, 'in review')

    // Both reviewers look at the same commit, side by side.
    const review = (who) =>
      handIn(id, who, [
        `You work in a fresh worktree. Start with \`git switch --detach ${branch}\`. The base is \`main\`.`,
        sendBacks ? `This is review round ${sendBacks + 1}; it was sent back ${sendBacks} time(s) before.` : '',
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

  // Merge, full suite, push; then the task's worktrees go and the branch stays (D118).
  const merged = await mainLock(() =>
    handIn(id, 'integrator', [
      `Merge \`${branch}\` into \`main\` in the main checkout (your steps).`,
      worktrees.length ? `After a successful push, remove this task's worktrees that still exist: ${worktrees.map((w) => `\`git worktree remove --force ${w}\``).join(', ')}. Keep the branch (D118).` : '',
    ]),
  )
  if (merged.status !== 'done') return blocked('integrator', merged)
  record(id, 'integrator', merged, 'done')
  return { status: 'done', findings: merged.findings, worktrees }
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
  next: 'Bring every blocked task to the user (D117). Then the checkpoint: the report, the demo steps, and the user records the walkthrough (D114, D115).',
}
