# Project Skills

We only use skills from the plugin marketplaces (D80) and write no custom skills. **Ask the user before invoking any skill.**

During a workflow run, each agent uses only the skills the user approved for that milestone (D88). A guard rail blocks the rest (D84).

## Approved skills (D87, 2026-09-26)
| Agent | Skill | Plugin (marketplace) | What it's for |
|---|---|---|---|
| Planner | `writing-plans` | superpowers (claude-plugins-official) | Turns the plan into small, step-by-step tasks, written into `TASKS.md` |
| Test writer, builders | `test-driven-development` | superpowers (claude-plugins-official) | Tests first, watch them fail, then write the code |
| Builders | `systematic-debugging` | superpowers (claude-plugins-official) | Finds the real cause of a failure before fixing it |
| Builders | `verification-before-completion` | superpowers (claude-plugins-official) | Runs the checks and shows the output before saying "done" |
| Frontend builder | `frontend-design` | frontend-design (claude-plugins-official) | The finished-product look for the screens |
| Frontend builder | `shadcn` | vercel (claude-plugins-official) | shadcn/ui components and theming |
| Backend builder | `ai-sdk` | vercel (claude-plugins-official) | The Vercel AI SDK, our link to Gemma |
| Code reviewer | `code-review` | mattpocock-skills (claude-plugins-official) | Checks a change against the coding standards and against what the task asked for |
| Security reviewer | `fp-check` | fp-check (trailofbits) | Double-checks a suspected security bug, so false alarms don't block work |
| Security reviewer | `insecure-defaults` | insecure-defaults (trailofbits), **not installed yet** | Finds hard-coded passwords, fallback secrets and weak login settings |
| Security reviewer | `differential-review` | differential-review (trailofbits), **not installed yet** | A security review of each change and what it could affect |
| Integrator | `resolving-merge-conflicts` | mattpocock-skills (claude-plugins-official) | Combines work when two agents changed the same files |
| Main session, at setup | `git-guardrails-claude-code` | mattpocock-skills (claude-plugins-official) | Sets up the git guard rails (D84). It isn't registered in its plugin, so its steps are read from the plugin files instead of invoked. |
| Main session | `writing-for-agents` | mattpocock-skills (claude-plugins-official) | Writing the agents' instructions |
| Main session | `feature-dev` | feature-dev (claude-plugins-official) | Guided feature workflow, used for the phase 8 configuration (D90) |

## Allowed exception
- Claude Code's built-in **workflow guide** (`workflow-authoring`). It isn't from a marketplace, but Claude Code requires it before any workflow is written (phase 9). Ask the user each time.

## Not skills
- Our own how-to notes (for example, how to add a record type) live inside each agent's instructions in `.claude/agents/`.
