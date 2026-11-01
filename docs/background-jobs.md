# Background jobs

Each task runs in its own adcc-task@ID.service user unit. The dispatcher and browser are observers/controllers, not parents of agent lifetimes. User lingering keeps the manager alive without an active login. Logs and SQLite state remain after browser disconnect. `adcc task snapshot` returns the current persisted view.

States: queued, running, retrying, blocked, paused, failed, review, completed. Cancellation preserves the record as blocked with a cancellation reason. Pause terminates execution and retains files/checkpoints; resume is a bounded native-session/checkpoint continuation, not an in-memory process freeze.

Runtime defaults to one hour (maximum 24 hours); stall detection observes output and worktree progress. Maximum attempts is three. Transient exponential retry requires explicit retry_safe:true and an unchanged initially clean tree/HEAD. Authentication, quota, sandbox and permission problems never automatically replay. Provider blockers open a persistent owner circuit; clear it only after repair using `adcc task unblock-agent OWNER`, then resume individual tasks explicitly.

An executor crash defaults to blocked; auto_resume:true opts into bounded continuation. The dispatcher reconciles live PID start ticks and boot IDs to avoid restarting an existing process. Checkpoints retain useful Git/session context, not complete process memory. Actual host-reboot continuation remains unverified. Never use killall or terminate the whole user manager to cancel one task.
