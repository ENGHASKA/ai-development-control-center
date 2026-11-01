import type { RoutingMode } from "./agent-capabilities";

/* Auto Mode plans as bin/acc reports them. Labels are words for what's true now; nothing here estimates progress. */

export type PlanState = "planning" | "executing" | "validating" | "reviewing" | "ready" | "merged" | "blocked" | "failed" | "cancelled";
export type StepState = "planned" | "waiting_approval" | "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";

export type PlanStep = {
  key: string;
  title: string;
  description: string;
  agent: string;
  route_reason: string;
  depends: string[];
  capabilities: string[];
  acceptance: string[];
  test: string[];
  risk: "low" | "medium" | "high";
  /** the operator named the agent for this step */
  assigned?: boolean;
  /** present on a repair step: the problems it was given */
  repairs?: string[] | null;
  state: StepState;
  reason: string | null;
  task: string | null;
  phase: string | null;
  attempts: number;
  worktree: string | null;
  test_exit: number | null;
  handoff: { reported_by_agent?: { summary?: string; known_issues?: string[] }; changed?: string[]; commit?: string } | null;
};

export type PlanReport = {
  head?: string;
  commits?: string[];
  diff_stat?: string;
  validation?: { test?: string[]; acceptance?: string[]; exit?: number | null };
  review?: { approved: boolean; summary: string; findings: string[] } | null;
};

export type Plan = {
  id: string;
  request: string;
  repo: string;
  routing: RoutingMode;
  state: PlanState;
  reason: string | null;
  goal: string | null;
  branch: string | null;
  worktree: string | null;
  repairs?: number;
  planner_task: string | null;
  verify_task: string | null;
  review_task: string | null;
  created_at: number;
  updated_at: number;
  steps: PlanStep[];
  report: PlanReport | null;
  events?: { seq: number; step: string | null; state: string; detail: string; at: number }[];
};

export const PLAN_LABEL: Record<PlanState, string> = {
  planning: "Planning",
  executing: "Working",
  validating: "Testing the result",
  reviewing: "Reviewing",
  ready: "Ready for your review",
  merged: "Merged",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const STEP_LABEL: Record<StepState, string> = {
  planned: "Waiting",
  waiting_approval: "Needs your approval",
  queued: "Queued",
  running: "Running",
  completed: "Done",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const ROUTING_OPTIONS: { value: RoutingMode; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Each step goes to the agent suited to it" },
  { value: "prefer-claude", label: "Prefer Claude", hint: "Codex only if Claude is out" },
  { value: "prefer-codex", label: "Prefer Codex", hint: "Claude only if Codex is out" },
  { value: "claude", label: "Claude only", hint: "Claude can't run commands in the background" },
  { value: "codex", label: "Codex only", hint: "Waits if Codex is out" },
];

export const planOpen = (s: PlanState) => s === "planning" || s === "executing" || s === "validating" || s === "reviewing";
export const planStoppable = (s: PlanState) => s !== "merged" && s !== "cancelled";
export const planResumable = (s: PlanState) => s === "blocked" || s === "failed";
export const stepsDone = (p: Plan) => p.steps.filter((s) => s.state === "completed").length;
