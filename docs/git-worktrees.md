# Git worktrees

Repositories and their Git common directories must reside below the configured workspace/projects. Worktrees are created below workspace/worktrees with branches task/ID. Do not concurrently launch an unmanaged CLI in a managed worktree; direct CLI invocation can bypass the advisory lease.

Use `git -C /path/to/repository worktree list` to inspect branches. Each task's handoff and checkpoint are retained under workspace/tasks. Review actual base commits before dependent work. Auto-commit only stages explicit safe output paths after passing tests and rejects unexpected changes.

Do not delete a worktree to cancel a live task. Cancel/pause through the queue, verify the unit/process stopped, then review whether removal is appropriate. Git history and retained branches support rollback; no force-reset, branch deletion or automatic merge is performed by the review gate.
