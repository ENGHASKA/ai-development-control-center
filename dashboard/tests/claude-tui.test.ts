import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedProfile } from "@/lib/server/profiles";

/* Web-started Claude sessions in a kept tmux TUI (lib/server/claude-tui.ts): the launch argv, the folder trust
 * dialog, and a TUI that exits before it starts. The pane, the transcript and the terminal service are fakes. */

const screen = { text: "" };
const keys: string[] = [];
const launches: Record<string, unknown>[] = [];
const killed: string[] = [];
const NO_FOCUSED = "Quick safety check\n❯ No, exit\n  Yes, I trust this folder\n";
const YES_FOCUSED = "Quick safety check\n  No, exit\n❯ Yes, I trust this folder\n";
const state = { transcript: false, exited: false, declined: false, renderMs: 0 };

vi.mock("@/lib/server/input", () => ({
  paneScreen: async () => screen.text,
  pressKey: async (_t: unknown, key: string) => {
    keys.push(key);
    /* answering the dialog clears it; Enter on "No, exit" is what ends a real TUI with status 1 */
    if (key === "Enter") {
      if (/❯ (\d\. )?No, exit/.test(screen.text)) state.declined = true;
      screen.text = "";
    }
    /* two rows: Down wraps, and the frame shows it `renderMs` later */
    if (key === "Down") {
      const flip = () => (screen.text = screen.text.replace(/^(❯| ) /gm, (_, c) => (c === "❯" ? "  " : "❯ ")));
      if (state.renderMs) setTimeout(flip, state.renderMs);
      else flip();
    }
  },
}));
vi.mock("@/lib/server/sessions", () => ({
  findSessionFile: async () => (state.transcript ? "/x/session.jsonl" : null),
  liveTerminals: async () => new Map(),
}));
vi.mock("@/lib/server/terminals", () => ({
  launchAgent: async (l: Record<string, unknown>) => (launches.push(l), { id: "agentu-abcd", backing: "tmux" }),
  listTerminals: async () => ({ tmux: true, terminals: [{ id: "agentu-abcd", exited: state.exited ? { code: 1 } : null }] }),
  killTerminal: async (id: string) => (killed.push(id), { ok: true }),
}));

const { startClaudeTui, startCodexTui, TuiStartError, trustFocus, tuiExitMessage } = await import("@/lib/server/claude-tui");
const { interactiveArgs } = await vi.importActual<typeof import("@/lib/server/terminals")>("@/lib/server/terminals");

const profile = { id: "claude", label: "Claude", agent: "claude", bin: "", args: [], env: {}, models: [], fallback: [], builtin: true } as unknown as ResolvedProfile;

beforeEach(() => {
  screen.text = "";
  keys.length = 0;
  launches.length = 0;
  killed.length = 0;
  state.transcript = false;
  state.exited = false;
  state.declined = false;
  state.renderMs = 0;
});

describe("Claude's TUI argv", () => {
  it("starts a new session under a given id with model, effort and approval mode", () => {
    expect(interactiveArgs("claude", { newSession: "u1", model: "claude-opus-5-5", effort: "high", permissionMode: "plan", cwd: "/w" })).toEqual([
      "--session-id", "u1", "--model", "claude-opus-5-5", "--effort", "high", "--permission-mode", "plan",
    ]);
  });

  it("Bypass skips the one-time confirmation screen; resume wins over a new id; Ask First asks", () => {
    const a = interactiveArgs("claude", { session: "s1", newSession: "u1", permissionMode: "bypassPermissions", cwd: "/w" });
    expect(a.slice(0, 4)).toEqual(["--resume", "s1", "--permission-mode", "bypassPermissions"]);
    expect(JSON.parse(a[a.indexOf("--settings") + 1])).toEqual({ skipDangerousModePermissionPrompt: true });
    expect(interactiveArgs("claude", { permissionMode: "default", cwd: "/w" })).toEqual(["--permission-mode", "manual"]);
  });
});

describe("starting a Codex session in tmux", () => {
  it("answers a trust dialog that appears after the startup check gave up", async () => {
    const sessions = [{ id: "old", cwd: "/w" }];
    setTimeout(() => (screen.text = "Trust this folder?\n› 1. Trust and continue\n  2. Back\n"), 8200);
    const r = await startCodexTui({ profile, cwd: "/w", text: "hi", permissionMode: "default", sessions: async () => (keys.includes("Enter") ? [...sessions, { id: "new", cwd: "/w" }] : sessions), tag: async () => undefined });
    expect(keys).toEqual(["Enter"]);
    expect(r.id).toBe("new");
  }, 30000);
});

describe("starting a Claude session in tmux", () => {
  it("moves off 'No, exit' onto 'Yes, I trust', then returns once the transcript exists", async () => {
    screen.text = "Do you trust the files in this folder?\n  1. Yes, I trust this folder\n❯ 2. No, exit\n";
    setTimeout(() => (screen.text = screen.text.replace("  1. Yes", "❯ 1. Yes").replace("❯ 2. No", "  2. No")), 700);
    setTimeout(() => (state.transcript = true), 1600);
    const r = await startClaudeTui({ profile, cwd: "/w", text: "hi", effort: "low", permissionMode: "acceptEdits" });
    expect(keys).toEqual(["Down", "Enter"]);
    expect(r.terminal).toBe("agentu-abcd");
    expect(launches[0]).toMatchObject({ newSession: r.id, sessionKey: r.id, session: null, prompt: "hi", effort: "low", permissionMode: "acceptEdits", backing: "tmux" });
  });

  it("never presses Down twice on a slow frame, which would wrap back onto 'No, exit'", async () => {
    screen.text = NO_FOCUSED;
    state.renderMs = 900;
    setTimeout(() => (state.transcript = true), 2200);
    await startClaudeTui({ profile, cwd: "/w", text: "hi", permissionMode: "default" });
    expect(keys).toEqual(["Down", "Enter"]);
    expect(state.declined).toBe(false);
  });

  it("presses Enter straight away when 'Yes' already has focus", async () => {
    screen.text = YES_FOCUSED;
    setTimeout(() => (state.transcript = true), 900);
    await startClaudeTui({ profile, cwd: "/w", text: "hi", permissionMode: "default" });
    expect(keys).toEqual(["Enter"]);
  });

  it("reports a TUI that exits before it starts and clears the dead pane", async () => {
    screen.text = "Error: disk full\n";
    state.exited = true;
    const err = await startClaudeTui({ profile, cwd: "/w", text: "hi", permissionMode: "default" }).catch((e) => e);
    expect(err).toBeInstanceOf(TuiStartError);
    expect(err.message).toBe("Claude exited before it started (exit code 1): Error: disk full");
    expect(err.terminal).toBeUndefined();
    expect(killed).toEqual(["agentu-abcd"]);
    expect(err.diagnostic).toMatchObject({ provider: "claude", category: "exited", exitCode: 1, cwd: "/w" });
  });

  it("refuses a guarded launcher outside approved folders without launching anything", async () => {
    const guarded = { ...profile, binPath: "/opt/bin/acc-claude" };
    process.env.ACC_ROOT = "/w";
    const err = await startClaudeTui({ profile: guarded, cwd: "/etc", text: "hi", permissionMode: "default" }).catch((e) => e);
    delete process.env.ACC_ROOT;
    expect(err).toBeInstanceOf(TuiStartError);
    expect(err.message).toContain("outside the development workspace");
    expect(launches).toHaveLength(0);
  });
});

describe("Codex access flags", () => {
  it("each mode says what it does to the real CLI", () => {
    expect(interactiveArgs("codex", { cwd: "/w", permissionMode: "default" })).toEqual(["-a", "on-request", "-s", "read-only"]);
    expect(interactiveArgs("codex", { cwd: "/w", permissionMode: "acceptEdits" })).toEqual(["-a", "on-request", "-s", "workspace-write"]);
    expect(interactiveArgs("codex", { cwd: "/w", permissionMode: "plan" })).toEqual(["-a", "never", "-s", "read-only"]);
    expect(interactiveArgs("codex", { cwd: "/w", permissionMode: "bypassPermissions" })).toEqual(["-a", "never", "-s", "danger-full-access"]);
    expect(interactiveArgs("codex", { cwd: "/w", session: "s1", permissionMode: "plan" }).slice(0, 2)).toEqual(["resume", "s1"]);
  });
});

describe("trustFocus", () => {
  it("reads both agents' dialogs", () => {
    expect(trustFocus(YES_FOCUSED)).toBe("yes");
    expect(trustFocus(NO_FOCUSED)).toBe("other");
    expect(trustFocus("  Trust this folder?\n› 1. Trust and continue\n  2. Quit\n  enter continue · esc quit\n")).toBe("yes");
    expect(trustFocus("  1. Trust and continue\n› 2. Quit\n")).toBe("other");
  });
  it("leaves an agent at work alone, even when it's talking about trust", () => {
    expect(trustFocus("› Ask Codex to do anything\n")).toBeNull();
  });
});

describe("tuiExitMessage", () => {
  it("turns each known ending into something to act on", () => {
    expect(tuiExitMessage(`${NO_FOCUSED}Pane is dead (status 1, Sat Oct 31 06:11:44 2026)`, 1)).toContain('"No, exit" was chosen');
    expect(tuiExitMessage("/x is outside the approved workspace folders. Choose a project inside /w", 1)).toContain("acc roots add");
    expect(tuiExitMessage("Another agent owns this worktree; use a separate task worktree", 1)).toContain("already working");
    expect(tuiExitMessage("Error: not logged in", 1)).toContain("claude auth login");
    expect(tuiExitMessage("You have hit your usage limit", 1)).toContain("usage limit");
  });
  it("says so when there's nothing to go on, without quoting tmux's status line", () => {
    expect(tuiExitMessage("Pane is dead (status 1, Sat Oct 31 08:31:42 2026)\n", 1)).toBe("Claude exited before it started (exit code 1) and printed nothing. Run `claude` in that folder over SSH to see why.");
  });
});
