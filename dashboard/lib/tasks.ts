/* Background task states as bin/acc reports them, grouped for scanning. Labels say what the person should understand;
 * the state itself always comes from the server. */

export type TaskState = "queued" | "running" | "blocked" | "retrying" | "paused" | "cancelled" | "failed" | "review" | "completed" | "waiting_input" | "waiting_approval";
export type TaskGroup = "active" | "queued" | "attention" | "done";

export const STATE_LABEL: Record<TaskState, string> = {
  queued: "Queued",
  running: "Running",
  blocked: "Blocked",
  retrying: "Retrying",
  paused: "Paused",
  cancelled: "Cancelled",
  failed: "Failed",
  review: "Needs review",
  completed: "Completed",
  waiting_input: "Waiting for your message",
  waiting_approval: "Needs your approval",
};

export const GROUP_OF: Record<TaskState, TaskGroup> = {
  running: "active",
  retrying: "active",
  queued: "queued",
  paused: "queued",
  blocked: "attention",
  failed: "attention",
  review: "attention",
  waiting_input: "attention",
  waiting_approval: "attention",
  completed: "done",
  cancelled: "done",
};

export const GROUP_LABEL: Record<TaskGroup, string> = { active: "Active", queued: "Queued", attention: "Needs you", done: "Finished" };

/** Whether a message can go to this task's agent now, or would have to wait for the running turn. */
export const acceptsMessages = (state: TaskState) => state !== "completed" && state !== "cancelled";
export const messageWaits = (state: TaskState) => state === "running" || state === "queued" || state === "retrying";

/** Actions bin/acc accepts in each state. */
export function taskActions(state: TaskState): ("pause" | "cancel" | "resume" | "retry")[] {
  if (state === "queued" || state === "running" || state === "retrying") return ["pause", "cancel"];
  if (state === "blocked" || state === "failed" || state === "paused") return ["resume"];
  if (state === "waiting_input" || state === "waiting_approval") return ["cancel"];
  return [];
}

const ERROR_TEXT: Record<string, string> = {
  approval_before_start: "This task waits for your approval before it starts.",
  permission_requested: "The agent stopped because it needs permission to make changes. Approving lets it edit files in this task.",
  rejected_by_operator: "Rejected. Its work is kept in the worktree.",
  acceptance_tests_failed: "The test command failed. Check the output, then resume or fix the task.",
  cancelled_before_start: "Cancelled before it started.",
  executor_heartbeat_lost_checkpoint_retained: "The task's process stopped reporting. Its work so far was kept; inspect it before resuming.",
  executor_heartbeat_stale: "The task's process stopped reporting. Its work so far was kept; inspect it before resuming.",
  executor_interrupted_checkpoint_retained: "The task was interrupted. Its work so far was kept; inspect it before resuming.",
  operator_paused: "Paused by you.",
  systemd_dispatch_failed: "The server couldn't start this task. Check the worker service.",
  worktree_already_owned: "Another agent is using this task's worktree.",
  provider_authentication: "The agent isn't signed in. Sign in on the server, then allow the agent again.",
  provider_quota: "The agent hit a usage limit. Resume after it resets.",
  provider_sandbox: "The agent's sandbox blocked it. Repair the sandbox; don't bypass it.",
};

/** The queue's error code in words; anything it doesn't recognize is shown as the queue wrote it. */
export const taskErrorText = (error: string) => ERROR_TEXT[error] ?? error;

export function formatElapsed(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const testResult = (exit: number | null) => (exit === null ? "Not run yet" : exit === 0 ? "Passed" : `Failed, exit code ${exit}`);
