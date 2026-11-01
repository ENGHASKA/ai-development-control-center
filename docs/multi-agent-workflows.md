# Multi-agent workflows

Break a project into independently testable tasks manually. Typical assignments are Claude for architecture/UI/documentation and Codex for backend/API/data/tests; adapt to the actual work. Every task owns a branch/worktree and has a real acceptance argv. The dispatcher allows two tasks total and at most one running task per owner.

Dependencies list task IDs. Children wait for reviewed completed parents, but dependency completion does not merge branches or update a child's base. Inspect and incorporate approved predecessor commits before running dependent implementation. These rules describe manually submitted tasks. Auto Mode separately supports validated planning, deterministic routing and integration into an isolated plan branch; see auto-mode.md.

Passing tests moves to review. Inspect actual diff, logs, files and commits. Commit reviewed outputs if not using an explicit auto-commit output list; then `adcc task approve ID --reviewer YOUR_NAME` reruns tests, requires a clean tree and checks merge conflicts. Merge and deployment remain separate explicit actions.

If a task changes files before a transient failure, automatic retry is refused. Inspect side effects before manual resume. External side effects are not transactionally deduplicated, so do not promise exactly-once execution.
