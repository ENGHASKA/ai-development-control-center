# Auto Mode

Auto Mode turns one request into coordinated, tested work in Git. Choose a project, choose **Auto**, describe the result, and close the page. The work runs on the server until it needs you.

## What happens

1. **Plan.** An agent reads the project and writes a plan: goal, tasks, dependencies, acceptance criteria, tests, and risk. A small request becomes one task. The plan is validated as untrusted input; cycles, unknown dependencies, more than eight tasks, and unsafe test commands are refused.
2. **Route.** Each task gets an agent from a fixed set of rules (below).
3. **Run.** A task starts only when its dependencies are finished. It runs in its own Git worktree, from the integration branch, so it sees earlier work. Up to two tasks run at once, one per agent.
4. **Prove.** When an agent finishes, its test runs in a sandbox. If it fails, the agent gets one more attempt. An agent saying it's done counts for nothing.
5. **Integrate.** Passing work is committed and merged into `auto/<plan>`. A conflict stops the plan for you; nothing is forced.
6. **Hand off.** The next agent receives what Git shows changed and the test result, plus the previous agent's own report, labelled as a report.
7. **Validate.** The final test runs on the merged result in a fresh worktree.
8. **Review.** With two or more tasks, an independent agent reviews the result, and findings trigger bounded repair.
9. **Stop for you.** The plan waits on its own branch. **Merge into project** merges it into the checked-out branch after a confirmation. Nothing is ever pushed.

## Routing

Routing is a readable, fixed policy, not machine learning. The reason is recorded on each step.

1. **Your assignments come first.** "Claude designs the frontend, Codex builds the backend" is followed exactly. If a named agent is out, that step waits; it never quietly moves.
2. **Then the mode.** Claude only, Codex only, or a preferred agent.
3. **Then a score**, among available agents: how well the agent suits the task's main kind of work, its record once there are at least five finished tasks, and its current load.

Scores can be tuned in `~/.config/ai-control-center/routing.json`. Agent facts live in `libexec/acc_agents.py`; adding a provider means adding one adapter there.

## Review and repair

The agent that did the least of the work reviews the result, or the one you named. An agent that wrote everything can't be its own independent reviewer: if nobody else is available, the plan reaches you saying so.

When review or the final test finds a problem, a repair step goes to the agent that wrote most of the work, with the findings and evidence. The work is then retested and reviewed again. This repeats up to the limit you choose, 2 rounds by default. It stops early if the same finding comes back, and the plan reaches you with the findings. Passing tests and an approving review don't prove the work is secure.

## When something stops

| Stop | What happens |
|---|---|
| Usage limit or sign-in | The task is blocked, its work is kept, and that agent gets no new work. With the reassignment option on, and a mode that allows it, the other agent takes the step |
| Test failure | One automatic retry, then the plan fails. **Resume** continues after you've fixed the cause, and clears a recorded provider stop |
| Merge conflict | The merge is backed out and the conflicting files are listed |
| High-risk step | Waits for **Approve this step** |
| Review findings | The plan still reaches your review, with the findings shown. You decide |
| Server restart | Tasks run in their own systemd units, so restarting the dashboard or worker doesn't stop them. An interrupted task resumes from a checkpoint or is marked blocked, as with any background task |

## Boundaries

Planned tests run under bubblewrap with no network, no credentials, no view of other work, and write access only to their own worktree. Agents never push. Claude's background tools are file tools only; Codex runs in its workspace-write sandbox with no network. Full access is refused unless an operator enabled it, and plans never use it.

Limits: no network means nothing can be installed during a plan, so plans work best with the standard library or vendored dependencies. Codex's sandbox allows reading other files the same Unix user can read. This protects against mistakes and untrusted repository content, not against a hostile operator: the web terminal runs as the same user.

## Approved folders

Agents work inside the workspace. To allow another folder, run this at a shell; the web interface can't do it:

```sh
bin/acc roots add /home/you/projects/example
bin/acc roots list
```

The home folder itself and locations holding credentials or tools (`.ssh`, `.claude`, `.codex`, `.config` and similar) are refused. A prompt such as "Open the existing project at /home/you/projects/example" selects that project if it's approved, and explains how to approve it if it isn't.

## Command line

```sh
bin/acc plan-add request.json   # {"repo":"...","request":"...","routing":"auto"}
bin/acc plan-list
bin/acc plan-show ID
bin/acc plan-resume ID
bin/acc plan-cancel ID
bin/acc plan-approve-step ID KEY
bin/acc plan-merge ID --reviewer NAME
```

Plans are stored beside tasks in `tasks/state.sqlite3`. Reports are written to `reports/plan-<id>.json`.
