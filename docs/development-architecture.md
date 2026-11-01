# Development architecture

dashboard/ retains the pinned MIT agent-ui source plus local policy and portable queue extensions. libexec/acc_runtime.py implements the standard-library SQLite queue; libexec/manage.py owns installation/lifecycle utilities; libexec/https_setup.py prepares reviewed optional ingress. bin/acc-agent enforces a whole-worktree flock lease shared with the executor.

SQLite WAL/FULL synchronization retains task states, events, attempts, native session IDs, PID identities, boot IDs and owner blockers. An atomic claim, idempotent systemd start and lease prevent duplicate managed concurrent execution. They cannot roll back external side effects or guarantee exactly-once operations after arbitrary failure.

The dispatcher is independent of adcc-task@ instances; neither dashboard nor dispatcher restart owns their lifetime. Resource limits apply at the adcc.slice and unit levels. CLI prompts travel over stdin, output is bounded/redacted, and checkpoints capture Git/work context. Test commands are trusted argv arrays, not untrusted shell strings.

Public releases start with sanitized history and contain only tracked source, licenses, docs and test fixtures. scripts/package.py never recursively archives an installation. CI actions have SHA pins and contents:read permissions, use no provider secrets, and test a disposable Ubuntu runner. Review both source and release inventory before publishing.
