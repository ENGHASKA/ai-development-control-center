# Dashboard guide — v3

Choose an approved project, use New worktree for concurrent work, or Resume session to continue an existing Claude/Codex conversation. The server checks saved context, folder approvals and exclusive ownership. A missing or unavailable conversation is refused rather than replaced.

Conversations run in kept terminals. Input targets carry a verified tmux socket and pane identity. Closing the browser or restarting the dashboard does not intentionally terminate a running turn. Messages sent while busy wait for delivery; a provider can still stall and require operator attention. Do not restart the terminal/tmux service as a browser reconnect remedy.

Choose a single background task or Auto Mode. Auto validates an agent plan, scores routing against capabilities and explicit assignments, runs offline sandboxed tests in separate worktrees, integrates into its own branch, and performs independent review with bounded repair. Project merge remains an explicit operator action. Read findings before merging.

Approval cards answer one current provider request. Stale replies are refused and decisions audited. Always allow stays in the terminal. Changing access mode requires restarting the agent process; the composer displays the running process's mode rather than claiming a mode changed retroactively.

Team and sharing creates trusted member accounts and grants per-session View, Interact or Manage. Private sessions remain private; PINs and grants are revocable. Members cannot use administrative terminals, files, tasks, plans or account management. These are application permissions inside one Unix account, not a hostile-tenant security boundary.

Full Access is off by default, administrator-only and explicitly confirmed. It disables agent sandboxing and can reach files outside the project as the server user. Never enable it as a workaround for a failed gate. See [access controls](access-and-team.md), [session resumption](resuming-sessions.md), [Auto Mode](auto-mode.md), and [security](security.md).

Task/plan state, output and audit history persist server-side. Use explicit pause/cancel actions, inspect tests and review states, and reconnect to the same records. Screenshots show labeled disposable fixtures, not production data. Physical phones, host reboot and SSH logout remain unverified by this release run.
