# Dashboard UI and functional audit

Audit of the dashboard at commit `2ca2ad5`, on 2026-10-31, run against an isolated instance in Chromium (phone and desktop). Every Critical and High item was reproduced before being fixed. Before and after images are in [screenshots](screenshots/).

## Critical

| # | Finding | Evidence | Status |
|---|---|---|---|
| 1 | A default Codex start from the dashboard could not succeed | The new-session screen sent `bypassPermissions` for every non-Claude agent. The server refuses that mode for Codex, so the exact request returned HTTP 500 | Fixed; real session passes |
| 2 | Claude died with "Pane is dead (status 1)" and an unusable message | Two production causes, see [below](#claude-startup-failures) | Fixed; real session passes |
| 3 | The workspace boundary was only enforced in the terminal service | `POST /api/sessions` with `cwd=/etc` reached the Codex adapter, and could create a worktree first | Fixed; refused with 403 before anything touches the folder |

## High

| # | Finding | Status |
|---|---|---|
| 4 | The default folder was the home folder, outside the workspace, so a first session started somewhere the terminal service refuses | Fixed; only allowed folders are offered |
| 5 | Project selection was a small chip under the composer, on phones 12px text | Fixed; a large project control states name, type and branch |
| 6 | Git repositories, worktrees and plain folders looked identical, and missing folders gave no signal | Fixed |
| 7 | Background tasks were reached through a fixed pill that collided with the phone composer | Fixed; in the sidebar, and as a run mode |
| 8 | New background tasks needed hand-written JSON, and failures said only "Task action refused" | Fixed; a validated form, and the queue's real reason |
| 9 | The Approvals menu offered Bypass, which this install forbids | Fixed; the menu follows the server's policy |
| 10 | Codex's effort menu ignored what the selected model supports | Fixed; it follows the CLI's model data |
| 11 | "New worktree" targeted a folder outside the workspace | Fixed; `worktrees/.sessions` on managed installs |

## Medium

| # | Finding | Status |
|---|---|---|
| 12 | The tasks page had no relationship to the rest of the app: raw `<select>`, underlined links, its own colors | Rebuilt on the app's tokens |
| 13 | Task state relied on color alone, and raw codes such as `acceptance_tests_failed` were shown | Fixed; icon and word for each state, codes read as sentences |
| 14 | Five equal cards filled the phone screen with "Unknown" before any task | Fixed; the task list leads, service facts sit in one line below |
| 15 | No loading state or empty-state guidance on tasks | Fixed |
| 16 | Losing the connection left stale data with no explanation | Fixed; a Reconnecting state, stale-data notice and automatic recovery |
| 17 | Dead panes piled up and stayed listed | Fixed for new failures; old panes remain until killed |
| 18 | Duplicate `/api/agents` requests on each load | Fixed |
| 19 | `/api/fs` called a refused folder "No folder at /etc" | Fixed; states the boundary |
| 20 | The product name differed between the docs and the interface | Interface now reads Control Center; agent-u attribution stays in the licenses and notices |

## Claude startup failures

"Claude exited before it started" and "Pane is dead (status 1)" had two separate causes on production.

- **Panes that died within a second, up to the most recent failures.** The dashboard's `claude` and `codex` profiles pointed at `bin/acc-claude` and `bin/acc-codex`, which refused every folder outside `worktrees/<task>` with exit 1, so interactive sessions failed in every ordinary project folder. An earlier version of this audit wrongly said a configuration change had ended this: that setting didn't apply, because the profiles took precedence, and failures continued. The launcher now accepts approved folders and keeps its rule of one agent per working tree.
- **06:11, the pane died on the folder trust dialog** with `No, exit` focused. Reproduced by hand: the dialog has two rows and Down wraps, and Enter on `No, exit` ends Claude with status 1. The old code could send Down again on a stale frame, and sent Enter based on an earlier read. Now Down waits for the screen to change, and Enter requires a frame read just before it showing Yes focused. **What triggered that specific run is not proven**: it may also have been a person pressing Enter in the terminal after the 90-second start timeout. A normal start succeeded on the unmodified code too, so this is a race, not a constant failure.

## Rejected suggestions

The UI UX Pro Max design-system generator proposed an FAQ landing pattern, a green accent and all-monospace headings. None fit an operations tool that already has a coherent token system, so only its UX rules were used: target sizes, error recovery, loading feedback, focus and color-only rules.
