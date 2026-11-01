import { execFile } from "node:child_process";
import type { SignIn } from "@/lib/agent-capabilities";
import { childEnv } from "../child-env";

/* Whether a CLI says it's signed in, through its own status command. Only the verdict leaves here: the commands' output
 * can carry the account's email address. A stale login can still fail on its first request. */

const TTL = 60_000;
const cache = new Map<string, { at: number; value: Promise<SignIn> }>();

/** `claude auth status` prints JSON with `loggedIn`. */
export function parseClaudeStatus(stdout: string): SignIn {
  try {
    const { loggedIn } = JSON.parse(stdout) as { loggedIn?: unknown };
    return loggedIn === true ? "signed-in" : loggedIn === false ? "signed-out" : "unknown";
  } catch {
    return "unknown";
  }
}

/** `codex login status` prints "Logged in using …" and exits 0, or "Not logged in" and exits 1. */
export function parseCodexStatus(stdout: string, failed: boolean): SignIn {
  if (/not logged in/i.test(stdout)) return "signed-out";
  if (/logged in/i.test(stdout) && !failed) return "signed-in";
  return "unknown";
}

const check = (bin: string, args: string[], read: (stdout: string, failed: boolean) => SignIn) =>
  new Promise<SignIn>((resolve) =>
    execFile(bin, args, { env: childEnv({ NO_COLOR: "1" }), timeout: 8000, maxBuffer: 1 << 16 }, (err, stdout, stderr) =>
      resolve((err as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "unknown" : read(`${stdout}\n${stderr}`.trim(), Boolean(err))),
    ),
  );

export function signInState(agent: "claude" | "codex", bin: string) {
  const key = `${agent}:${bin}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = agent === "claude" ? check(bin, ["auth", "status"], (out) => parseClaudeStatus(out)) : check(bin, ["login", "status"], parseCodexStatus);
  cache.set(key, { at: Date.now(), value });
  return value;
}
