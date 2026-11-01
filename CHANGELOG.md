# Changelog

## Unreleased

There is now one conversation: new Claude and Codex sessions keep running on the server without choosing Background, and the task form with its test command moved to Tasks. Administrators can turn Full access on from Team and sharing after acknowledging the risk; the change is audited, members never get it, and they can only watch a session running under it. The composer shows the mode from the agent's real launch flags, always labels it on phones, and offers a restart when a change can't reach a running agent.

Ask before acting now really asks. Claude had been left on its configured mode, which can approve by itself, and Codex exited at startup on a rejected flag. Claude and Codex approvals appear as cards in the conversation, read from the real dialog and refused if the request has changed. Auto plans open as a conversation, with routing, handoffs, reviews, repairs and logs, and every plan is now reviewed, one-step plans included. Locked sessions ask for their PIN directly, and sharing is reachable on phones.

Conversations now outlive the browser and the dashboard, for Codex as well as Claude. Messages reach the right terminal on any tmux server; pane ids alone are only unique per server, which caused "can't find pane" and could have reached the wrong pane. Auto Mode honors explicit assignments, scores agents through a capability registry, keeps review independent, and repairs findings in bounded rounds. Adds team accounts, session sharing and PINs, and provider-accurate access modes. See docs/access-and-team.md.

Adds resuming existing Claude and Codex conversations, in a terminal or in the background, with checks that the conversation exists, its folder is approved and nothing else has it open. Background tasks gain follow-up messages, approval and rejection, copyable output and an audit log. Tasks are refused, with the reason, for empty projects, plain folders and invalid test commands. See docs/resuming-sessions.md.

Adds Auto Mode: one request becomes a validated plan, routed across Claude and Codex, run in dependency order in isolated worktrees, merged into an integration branch, tested independently, reviewed by a second agent, and held for your approval. Plans survive browser, dashboard and worker restarts. Planned tests run in a sandbox with no network or credentials. Operators can approve extra workspace folders at a shell. Background tasks can choose a model and reasoning effort. See docs/auto-mode.md.

Interactive sessions now start in any approved folder; the launcher previously refused everything outside task worktrees, which caused "Pane is dead (status 1)".

Rebuilt project selection, the run flow and the background task dashboard. Codex now starts from the dashboard by default, Claude can no longer exit at its folder trust question through the dashboard's own keystrokes, and startup failures say what to do. The workspace boundary is enforced at the API, permission bypass is refused and no longer offered, and approval, effort and model controls follow what each agent accepts. Auto is shown as unavailable. See docs/ui-audit.md.

## 3.0.0-beta.1

Initial portable source distribution for Ubuntu 24.04 LTS x86_64. Includes the MIT upstream agent-ui dashboard with retained attribution, a durable SQLite task queue, independently supervised systemd task units, managed worktree leases, explicit acceptance/review gates, lifecycle utilities, private authentication configuration and an optional reviewed HTTPS ingress plan.

This is a **prerelease**. Full host-reboot continuation, physical SSH logout acceptance, off-host disaster recovery, hostile-code multi-tenancy, other operating systems and universal provider-version compatibility are not verified. See docs/release-notes.md for test provenance and known limitations.

V3 release preparation retains sanitized public history, installation-specific policy paths, Bubblewrap checks, systemd unit validation and a deterministic concurrency barrier regression.
