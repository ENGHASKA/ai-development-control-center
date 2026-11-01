import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { modeFromArgs } from "@/lib/effective-mode";
import { capabilitiesFor } from "@/lib/agent-capabilities";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "full-access-"));
process.env.ACC_FILE_ROOT = dir;
process.env.ACC_POLICY_FILE = path.join(dir, "policy.json");
process.env.AGENT_U_HOME = dir;

const { mayUseFullAccess, permittedMode, requestedMode } = await import("@/lib/server/http");
const { setFullAccessPolicy, bypassRefused } = await import("@/lib/server/workspace");

const { addUser, levelOf, noteFullAccess, unlock, update, accessOf } = await import("@/lib/server/access");

const admin = { role: "admin" };
const member = { role: "member" };

beforeEach(() => fs.rmSync(process.env.ACC_POLICY_FILE!, { force: true }));

describe("who may use Full access", () => {
  it("is off until the policy says otherwise, for everyone", () => {
    expect(bypassRefused()).toBe(true);
    expect(requestedMode("bypassPermissions", admin)).toBeNull();
    expect(requestedMode("bypassPermissions", member)).toBeNull();
  });

  it("with the policy on, only an administrator gets it", () => {
    setFullAccessPolicy(true);
    expect(mayUseFullAccess(admin)).toBe(true);
    expect(requestedMode("bypassPermissions", admin)).toBe("bypassPermissions");
    expect(requestedMode("bypassPermissions", member)).toBeNull();
    expect(requestedMode("bypassPermissions", null)).toBeNull();
  });

  it("a saved mode can't bring it back", () => {
    setFullAccessPolicy(true);
    expect(permittedMode("bypassPermissions", member)).toBeNull();
    setFullAccessPolicy(false);
    expect(permittedMode("bypassPermissions", admin)).toBeNull();
    expect(permittedMode("acceptEdits", member)).toBe("acceptEdits");
  });

  it("writes the policy file with private permissions", () => {
    setFullAccessPolicy(true);
    expect(JSON.parse(fs.readFileSync(process.env.ACC_POLICY_FILE!, "utf8"))).toEqual({ full_access: true });
    expect(fs.statSync(process.env.ACC_POLICY_FILE!).mode & 0o777).toBe(0o600);
  });
});

describe("a session running under Full access", () => {
  it("holds a member with Interact, and one with a PIN, to viewing", async () => {
    const one = await addUser("fa-one", "correct horse battery");
    const two = await addUser("fa-two", "correct horse battery");
    await update("sess", "admin", { member: { id: one, level: "interact" } });
    await update("sess", "admin", { pin: "2468", mode: "pin", pinLevel: "interact" });
    for (const id of [one, two]) expect((await unlock("sess", id, "test", "2468")).ok).toBe(true);
    expect(levelOf(one, "sess")).toBe("interact");
    expect(levelOf(two, "sess")).toBe("interact");
    noteFullAccess("sess", true);
    expect(accessOf("sess").fullAccess).toBe(true);
    expect(levelOf(one, "sess")).toBe("view");
    expect(levelOf(two, "sess")).toBe("view");
    expect(levelOf("admin", "sess")).toBe("manage");
    noteFullAccess("sess", false);
    expect(levelOf(one, "sess")).toBe("interact");
  });
});

describe("what the composer is told", () => {
  it("shows an administrator the way to turn it on, and a member nothing", () => {
    expect(capabilitiesFor("codex", { bypassRefused: true, admin: true }).fullAccess).toBe("off");
    expect(capabilitiesFor("codex", { bypassRefused: false, admin: true }).fullAccess).toBe("on");
    const m = capabilitiesFor("claude", { bypassRefused: false, admin: false });
    expect(m.fullAccess).toBe("hidden");
    expect(m.modes).not.toContain("bypassPermissions");
  });
});

describe("the mode a running agent really has", () => {
  it("reads each agent's flags", () => {
    expect(modeFromArgs(["claude", "--permission-mode", "manual"])).toBe("default");
    expect(modeFromArgs(["claude", "--session-id", "x", "--permission-mode", "bypassPermissions"])).toBe("bypassPermissions");
    expect(modeFromArgs(["codex", "-a", "on-request", "-s", "read-only"])).toBe("default");
    expect(modeFromArgs(["codex", "-a", "on-request", "-s", "workspace-write"])).toBe("acceptEdits");
    expect(modeFromArgs(["codex", "-a", "never", "-s", "read-only"])).toBe("plan");
    expect(modeFromArgs(["codex", "-a", "never", "-s", "danger-full-access"])).toBe("bypassPermissions");
  });

  it("names nothing when the flags don't say", () => {
    expect(modeFromArgs(["claude"])).toBeNull();
    expect(modeFromArgs(["claude", "--permission-mode", "auto"])).toBeNull();
    expect(modeFromArgs(["codex", "-a", "never", "-s", "workspace-write"])).toBeNull();
  });
});
