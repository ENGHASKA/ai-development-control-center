import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";
import { capabilitiesFor } from "@/lib/agent-capabilities";
import { formatElapsed, GROUP_OF, STATE_LABEL, taskActions, testResult } from "@/lib/tasks";
import { parseCommand, pathInPrompt } from "@/lib/workspace";
import { ADMIN_ID, allows, effectiveLevel, legacyAccess, levelFor, memberMayCall, nextAttempt, validPin } from "@/lib/access-policy";
import { PLAN_LABEL, planResumable, planStoppable, STEP_LABEL } from "@/lib/plans";
import { parseClaudeStatus, parseCodexStatus } from "@/lib/server/agents/readiness";
import { approvedRoots, folderKind, launcherProblem, workspaceProblem } from "@/lib/server/workspace";

/* The control center's boundary: which folders agents may start in, what a folder is, what each agent may be asked for. */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acc-boundary-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("workspaceProblem", () => {
  const inside = path.join(root, "projects", "app");
  fs.mkdirSync(inside, { recursive: true });

  it("allows the workspace and folders inside it", () => {
    expect(workspaceProblem(root, root)).toBeNull();
    expect(workspaceProblem(inside, root)).toBeNull();
  });
  it("refuses a folder outside, naming the workspace", () => {
    expect(workspaceProblem(os.homedir(), root)).toContain("outside the development workspace");
    expect(workspaceProblem("/etc", root)).toContain(root);
  });
  it("isn't fooled by a sibling sharing the root's prefix", () => {
    const sibling = `${root}-other`;
    fs.mkdirSync(sibling);
    expect(workspaceProblem(sibling, root)).toContain("outside");
    fs.rmSync(sibling, { recursive: true });
  });
  it("follows symlinks to where a folder really is", () => {
    const link = path.join(root, "escape");
    fs.symlinkSync("/etc", link);
    expect(workspaceProblem(link, root)).toContain("outside");
  });
  it("reports a folder that's gone as gone", () => {
    expect(workspaceProblem(path.join(root, "nope"), root)).toContain("Folder not found");
  });
  it("applies no boundary on an install without one", () => {
    expect(workspaceProblem("/etc", null)).toBeNull();
  });
});

describe("launcherProblem", () => {
  const tasks = path.join(root, "worktrees");
  it("spots the guarded launcher outside approved folders, before it leaves a dead pane", () => {
    expect(launcherProblem("/opt/bin/acc-claude", "/etc", root)).toContain("outside the development workspace");
  });
  it("allows it in any workspace folder, and leaves the agents' own binaries alone", () => {
    fs.mkdirSync(path.join(tasks, "abc"), { recursive: true });
    expect(launcherProblem("/opt/bin/acc-claude", path.join(tasks, "abc"), root)).toBeNull();
    expect(launcherProblem("/opt/bin/acc-claude", root, root)).toBeNull();
    expect(launcherProblem("/usr/bin/claude", "/etc", root)).toBeNull();
  });
});

describe("folderKind", () => {
  it("tells repositories, worktrees, folders and missing paths apart", () => {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "x"]);
    const linked = path.join(root, "linked");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "side", linked]);
    expect(folderKind(repo)).toBe("git");
    expect(folderKind(linked)).toBe("worktree");
    expect(folderKind(root)).toBe("folder");
    expect(folderKind(path.join(root, "gone"))).toBe("missing");
  });
});

describe("capabilitiesFor", () => {
  it("never offers bypass where the install refuses it", () => {
    for (const agent of ["claude", "codex"] as const) expect(capabilitiesFor(agent, { bypassRefused: true }).modes).toEqual(["default", "acceptEdits", "plan"]);
  });
  it("lists bypass only where it's allowed", () => {
    expect(capabilitiesFor("codex", { bypassRefused: false }).modes).toContain("bypassPermissions");
  });
  it("says where each agent's model list comes from", () => {
    expect(capabilitiesFor("claude", { bypassRefused: true }).models).toBe("documented");
    expect(capabilitiesFor("codex", { bypassRefused: true }).models).toBe("cli");
  });
});

describe("sign-in status", () => {
  it("reads Claude's JSON", () => {
    expect(parseClaudeStatus('{"loggedIn":true,"email":"a@b"}')).toBe("signed-in");
    expect(parseClaudeStatus('{"loggedIn":false}')).toBe("signed-out");
    expect(parseClaudeStatus("oops")).toBe("unknown");
  });
  it("reads Codex's wording", () => {
    expect(parseCodexStatus("Logged in using ChatGPT", false)).toBe("signed-in");
    expect(parseCodexStatus("Not logged in", true)).toBe("signed-out");
    expect(parseCodexStatus("error", true)).toBe("unknown");
  });
});

describe("parseCommand", () => {
  it("splits on spaces and keeps quoted words whole", () => {
    expect(parseCommand("python3 -m unittest")).toEqual(["python3", "-m", "unittest"]);
    expect(parseCommand(`pytest -k "a b" 'c d'`)).toEqual(["pytest", "-k", "a b", "c d"]);
    expect(parseCommand(`sh -c ""`)).toEqual(["sh", "-c", ""]);
  });
  it("refuses an open quote", () => {
    expect(parseCommand(`echo "oops`)).toBeNull();
  });
});

describe("task states", () => {
  it("files every state in a group with a label", () => {
    for (const s of Object.keys(STATE_LABEL) as (keyof typeof STATE_LABEL)[]) expect(GROUP_OF[s]).toBeTruthy();
  });
  it("offers only what the queue accepts in that state", () => {
    expect(taskActions("running")).toEqual(["pause", "cancel"]);
    expect(taskActions("blocked")).toEqual(["resume"]);
    expect(taskActions("review")).toEqual([]);
    expect(taskActions("completed")).toEqual([]);
  });
  it("reads elapsed time and test results plainly", () => {
    expect(formatElapsed(45)).toBe("45s");
    expect(formatElapsed(125)).toBe("2m 5s");
    expect(formatElapsed(3700)).toBe("1h 1m");
    expect(testResult(null)).toBe("Not run yet");
    expect(testResult(0)).toBe("Passed");
    expect(testResult(2)).toBe("Failed, exit code 2");
  });
});

describe("worktrees for sessions", () => {
  it("are created inside the workspace on a managed install, apart from the queue's task worktrees", async () => {
    vi.resetModules();
    vi.stubEnv("ACC_FILE_ROOT", "/w");
    vi.stubEnv("AGENT_U_WORKTREES", "");
    const { WORKTREE_ROOT } = await import("@/lib/server/git");
    vi.unstubAllEnvs();
    expect(WORKTREE_ROOT).toBe("/w/worktrees/.sessions");
  });
});

describe("approved roots", () => {
  const file = path.join(root, "roots.json");
  const home = fs.mkdtempSync(path.join(os.homedir(), ".acc-root-test-"));
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));
  it("adds folders an operator approved, and ignores protected ones written into the file by hand", () => {
    vi.stubEnv("ACC_ROOTS_FILE", file);
    fs.writeFileSync(file, JSON.stringify({ roots: [home, "/etc", os.homedir(), path.join(os.homedir(), ".ssh"), path.join(os.homedir(), ".claude")] }));
    expect(approvedRoots(root)).toEqual([root, fs.realpathSync(home)]);
    expect(workspaceProblem(home, root)).toBeNull();
    expect(workspaceProblem("/etc", root)).toContain("acc roots add");
    vi.unstubAllEnvs();
  });
  it("survives a missing or broken file", () => {
    vi.stubEnv("ACC_ROOTS_FILE", path.join(root, "absent.json"));
    expect(approvedRoots(root)).toEqual([root]);
    vi.stubEnv("ACC_ROOTS_FILE", __filename);
    expect(approvedRoots(root)).toEqual([root]);
    vi.unstubAllEnvs();
  });
});

describe("pathInPrompt", () => {
  it("finds the folder a request names", () => {
    expect(pathInPrompt("Open the existing project at /home/me/projects/example-project and continue development.")).toBe("/home/me/projects/example-project");
    expect(pathInPrompt("work in the repo at `/srv/app/`, please")).toBe("/srv/app");
    expect(pathInPrompt("Fix the folder in /opt/site.")).toBe("/opt/site");
  });
  it("finds a path on the line after a label, as a pasted brief writes it", () => {
    expect(pathInPrompt('Original project:\n\n"/home/me/projects/ai-control-center"\n\nExisting release worktree:')).toBe("/home/me/projects/ai-control-center");
  });
  it("leaves paths that are only mentioned alone", () => {
    expect(pathInPrompt("why does /etc/hosts break this?")).toBeNull();
    expect(pathInPrompt("add a /health route")).toBeNull();
  });
});

describe("plan labels", () => {
  it("say something for every state", () => {
    for (const label of [...Object.values(PLAN_LABEL), ...Object.values(STEP_LABEL)]) expect(label.length).toBeGreaterThan(0);
  });
  it("offer only actions the server accepts", () => {
    expect(planResumable("blocked")).toBe(true);
    expect(planResumable("ready")).toBe(false);
    expect(planStoppable("merged")).toBe(false);
  });
});

describe("session access", () => {
  const base = { owner: "ann", pinLevel: "view" as const, version: 1, pinHash: "h", members: { bob: { level: "interact" as const, trusted: true }, cat: { level: "view" as const } } };
  it("private is the owner alone, even for a listed member", () => {
    const a = { ...base, mode: "private" as const };
    expect(effectiveLevel("ann", a, false)).toBe("manage");
    expect(effectiveLevel("bob", a, true)).toBe("none");
  });
  it("a PIN opens only what was chosen, and never Manage", () => {
    const a = { ...base, mode: "pin" as const };
    expect(effectiveLevel("dan", a, false)).toBe("none");
    expect(effectiveLevel("dan", a, true)).toBe("view");
    expect(effectiveLevel("dan", { ...a, pinLevel: "interact" }, true)).toBe("interact");
  });
  it("trusted members skip the PIN, others don't", () => {
    const a = { ...base, mode: "trusted" as const };
    expect(effectiveLevel("bob", a, false)).toBe("interact");
    expect(effectiveLevel("cat", a, false)).toBe("none");
    expect(effectiveLevel("cat", a, true)).toBe("view");
  });
  it("PIN for everyone includes the owner", () => {
    const a = { ...base, mode: "pin_all" as const };
    expect(effectiveLevel("ann", a, false)).toBe("none");
    expect(effectiveLevel("bob", a, false)).toBe("none");
    expect(effectiveLevel("ann", a, true)).toBe("manage");
  });
  it("sessions from before accounts stay the admin's and private", () => {
    expect(effectiveLevel(ADMIN_ID, legacyAccess(), false)).toBe("manage");
    expect(effectiveLevel("ann", legacyAccess(), true)).toBe("none");
  });
  it("each action needs the right level, and anything unknown needs Manage", () => {
    expect(levelFor("events", "POST")).toBe("view");
    expect(levelFor("", "GET")).toBe("view");
    expect(levelFor("", "DELETE")).toBe("manage");
    expect(levelFor("message", "POST")).toBe("interact");
    expect(levelFor("respond", "POST")).toBe("interact");
    expect(levelFor("fork", "POST")).toBe("manage");
    expect(levelFor("something-new", "POST")).toBe("manage");
    expect(allows("view", "interact")).toBe(false);
  });
  it("members reach only what's listed", () => {
    for (const [p, m] of [["/api/terminals", "POST"], ["/api/terminals", "GET"], ["/api/files", "GET"], ["/api/fs", "GET"], ["/api/tasks", "GET"], ["/api/plans", "POST"], ["/api/resume", "POST"], ["/api/projects", "POST"], ["/api/settings", "POST"], ["/api/git", "GET"], ["/api/workspace", "POST"]]) expect(memberMayCall(p, m), p).toBe(false);
    expect(memberMayCall("/api/sessions", "GET")).toBe(true);
  });
  it("PIN guesses slow down, then stay slow", () => {
    let a = { fails: 0, until: 0 };
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      a = nextAttempt(a, 0);
      waits.push(a.until);
    }
    expect(waits.slice(0, 3)).toEqual([0, 0, 0]);
    expect(waits[3]).toBeGreaterThan(0);
    expect(waits[5]).toBeGreaterThan(waits[4]);
    expect(Math.max(...waits)).toBe(60 * 60_000);
  });
  it("only 4 to 6 digits are a PIN", () => {
    for (const ok of ["1234", "123456"]) expect(validPin(ok)).toBe(true);
    for (const bad of ["123", "1234567", "12a4", 1234, null, "1234\n"]) expect(validPin(bad)).toBe(false);
  });
});
