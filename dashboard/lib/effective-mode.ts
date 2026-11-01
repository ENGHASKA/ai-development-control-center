import type { PermissionMode } from "@/lib/types";

/** The access mode a running agent was really started with, read from its own arguments. Null when they don't name one we offer. */
export function modeFromArgs(args: string[]): PermissionMode | null {
  const after = (flag: string) => {
    const i = args.indexOf(flag);
    return i < 0 ? null : (args[i + 1] ?? null);
  };
  const claude = after("--permission-mode");
  if (claude) return ({ manual: "default", default: "default", acceptEdits: "acceptEdits", plan: "plan", bypassPermissions: "bypassPermissions" } as Record<string, PermissionMode>)[claude] ?? null;
  const approval = after("-a");
  const sandbox = after("-s");
  if (approval === "on-request" && sandbox === "read-only") return "default";
  if (approval === "on-request" && sandbox === "workspace-write") return "acceptEdits";
  if (approval === "never" && sandbox === "read-only") return "plan";
  if (approval === "never" && sandbox === "danger-full-access") return "bypassPermissions";
  return null;
}
