import type { AgentId, PermissionMode } from "./types";

/* What the dashboard can truthfully offer for each agent. Controls read this instead of guessing, so a setting that
 * would be refused or ignored is shown as unavailable with its reason. */

export type SignIn = "signed-in" | "signed-out" | "unknown";

export type AgentCapabilities = {
  /** whether this person is offered Full access */
  fullAccess: "on" | "off" | "hidden";
  /** approval modes this person may use here; Full access is left out unless they may */
  modes: PermissionMode[];
  /** where the model list comes from: "cli" is what the installed CLI reports, "documented" a fixed list of model names
   * the CLI accepts, which the account may or may not be able to use */
  models: "cli" | "documented";
  /** background tasks can run this agent */
  background: boolean;
};

const SAFE_MODES: PermissionMode[] = ["default", "acceptEdits", "plan"];

export function capabilitiesFor(agent: AgentId, opts: { bypassRefused: boolean; admin?: boolean }): AgentCapabilities {
  const canAsk = agent === "claude" || agent === "codex";
  const admin = opts.admin ?? true;
  return {
    modes: canAsk ? (opts.bypassRefused || !admin ? SAFE_MODES : [...SAFE_MODES, "bypassPermissions"]) : ["bypassPermissions"],
    models: agent === "claude" ? "documented" : "cli",
    background: canAsk,
    /* an administrator sees it even while it's off, with the way to turn it on; nobody else sees it */
    fullAccess: !admin ? "hidden" : opts.bypassRefused ? "off" : "on",
  };
}

/* Where a piece of work runs. "auto" sends a request to the planner in libexec/acc_auto.py, which picks agents per step. */
export type ExecutionAgent = "claude" | "codex" | "auto";
export type ExecutionMode = "interactive" | "background";
export type RoutingMode = "auto" | "claude" | "codex" | "prefer-claude" | "prefer-codex";
