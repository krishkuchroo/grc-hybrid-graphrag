# Agent monitor

One local page for watching and steering Claude Code agents: what each agent is doing, the task board, open questions, token use, system health and guard-rail blocks. From the page you can send notes to agents, answer open questions and launch agents.

It uses Node built-ins only, with no build step and nothing to install. It listens on 127.0.0.1 only.

```sh
node .claude/monitor/server.mjs      # then open http://127.0.0.1:4800
MONITOR_PORT=4801 node .claude/monitor/server.mjs
```

## What the page does

| Tab | What's there |
|---|---|
| Overview | What needs attention, open questions and blocked tasks (answer them there), system health, today's tokens and milestone progress. |
| Agents | One card per agent: its task, last steps, token use, notes and conversation. Filter the cards, select several agents and send them one note. |
| Launch | Start an agent from `.claude/agents/` with a prompt. It runs in its own git worktree, at most `launch.maxConcurrent` at a time, and the rest wait in a queue. You can reply at any time or stop a run. |
| Tokens | Tokens per milestone, agent type, task and agent, split into new input, cache write, cache read and output, plus the burn rate. |
| Activity | Search the agent steps and the guard-rail log. |
| Board | The task board. |

- **Notes** reach an agent at its next step. A note to a launched run that has finished continues its conversation (`claude --resume`).
- **Answers** to open questions are held until you next type in the main Claude Code session, and then arrive with that message.
- **Tokens** are read from Claude Code's saved conversations in `~/.claude/projects/`, with each reply counted once. The counts are cached in `logs/state/monitor-tokens.json`, so a restart doesn't re-read everything.
- **Updates** reach the page as they happen (server-sent events). The timers run only while a page is open.

## Using it in another project

1. Copy this folder to `<project>/.claude/monitor/`.
2. Add the hook to `<project>/.claude/settings.json`:

   ```json
   {
     "hooks": {
       "SessionStart":     [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/monitor/hook.mjs\"", "timeout": 15 }] }],
       "SubagentStart":    [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/monitor/hook.mjs\"", "timeout": 15 }] }],
       "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/monitor/hook.mjs\"", "timeout": 15 }] }],
       "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/monitor/hook.mjs\"", "timeout": 15 }] }],
       "SubagentStop":     [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/monitor/hook.mjs\"", "timeout": 15 }] }],
       "Stop":             [{ "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/monitor/hook.mjs\"", "timeout": 15 }] }]
     }
   }
   ```
3. Edit `monitor.config.json`. Any key you leave out keeps its default.
4. Add `logs/` and `.claude/worktrees/` to `.gitignore`.

Nothing in this folder imports from outside it.

## monitor.config.json

| Key | Default | Meaning |
|---|---|---|
| `port` | `4800` | The page's port (`MONITOR_PORT` overrides it). |
| `logsDir` | `"logs"` | Where the hook and the server keep their files. |
| `quietMinutes` | `10` | After this long without a step, an agent shows as "quiet". |
| `board.file` | `"TASKS.md"` | The Markdown file holding the task board: the first table whose first header is "ID". |
| `board.columns` | id, milestone, owner, status | Header text (lower case) → the field to show. `status: blocked` rows appear as open questions. `log` links a task to `logs/tasks/<ID>.md`. |
| `milestones` | `[]` | The order of the milestones. Empty means the order they appear on the board. |
| `agentColors` | `{}` | Agent type → `blue`, `purple`, `orange`, `green`, `cyan`, `yellow`, `red` or `pink`. |
| `guardRails` | `{}` | Rule → short label for guard-rail blocks, if the project logs them to `logs/guardrails.jsonl`. |
| `openQuestions` | `null` | `{ "file", "heading" }`: the bullets `- **Q12:** …` under that heading in that Markdown file. |
| `health.containers` | `[]` | Docker container name prefixes to show (`docker ps`, read-only). |
| `health.ports` | `[]` | `{ "label", "port", "host"? }`: ports to check. |
| `health.http` | `[]` | `{ "label", "url" }`: local addresses to check (127.0.0.1 or localhost only). |
| `health.dockerMemoryLimitGB` | `null` | The memory Docker is meant to have. The page warns when it differs. |
| `health.intervalSeconds` | `15` | How often the checks run while a page is open. |
| `launch.maxConcurrent` | `2` | How many launched runs work at once. |
| `launch.agentsDir` | `".claude/agents"` | The agents the Launch tab may start. |

## Launched runs and safety

The server fixes the command a launched run gets. It is:

```
claude -p --agent <name> --permission-mode auto --allowedTools 'Edit(./**)' --worktree <name> --session-id <id> --output-format stream-json --verbose
```

- **The prompt** goes in on stdin, so it can never be read as a flag.
- **Never allowed:** `--bare` and skipping permissions. So every hook in the project's settings runs.
- **Editing:** `Edit(./**)` allows file edits inside the run's own worktree only. That's needed because Claude Code protects `.claude/`, where worktrees live, and a headless run has nobody to approve.
- **Hooks:** a launched run reaches hooks with `agent_type` set and no `agent_id`. The monitor treats it as the agent `run-<session id>`. A project's own guard rails should do the same. In this project, `.claude/hooks/lib/hook-input.mjs` does (D158).
- **Records:** each run is kept in `logs/launches/<session id>/`: `run.json`, and for each round, the prompt, the output stream and the errors. Runs are separate processes, so they keep going if the monitor restarts, and it picks them up again.
- **Stop** ends only runs the monitor started, after checking that the process is really that run.

## Files it writes (all under `logs/`)

| File | What |
|---|---|
| `activity.jsonl` | Each agent's start, steps and stop. |
| `notes.jsonl`, `inbox/<agent>.jsonl` | Notes, and when they were delivered. |
| `answers.jsonl`, `inbox/main-session.jsonl` | Answers to open questions, and when the main session got them. |
| `launches/<session>/` | Launched runs. |
| `state/<agent>.task.json`, `state/<agent>.seen.json`, `state/monitor-tokens.json` | What the monitor remembers. |
| `guardrails.jsonl` | Only the monitor's own errors (rule `monitor`). A project's guard rails may log their blocks here too. |

## Tests

```sh
node --test '.claude/monitor/__tests__/*.test.mjs'
```
