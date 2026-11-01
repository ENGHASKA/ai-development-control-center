import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { liveTarget, paneScreen, parsePanes, TerminalGone, tmuxSocket, typeIntoTerminal, verifyPane } from "@/lib/server/input";

/* Real tmux on private sockets. Each server is told apart only by its socket, as the dashboard's and an operator's are. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acc-tmux-"));
/* fresh for each test: a server whose last session just closed can still be shutting down on its socket */
let round = 0;
let sockets: string[] = [];
beforeEach(() => {
  round++;
  sockets = [path.join(dir, `operator-${round}`), path.join(dir, `dashboard-${round}`)];
});
const env = { ...process.env, TMUX: undefined, TMUX_PANE: undefined, TMUX_TMPDIR: dir };
const tm = (socket: string, ...args: string[]) => execFileSync("tmux", ["-u", "-S", socket, "-f", "/dev/null", ...args], { env, encoding: "utf8" });
const started: [string, string][] = [];

function start(socket: string, name: string, command = "cat") {
  tm(socket, "new-session", "-d", "-s", name, "-x", "80", "-y", "24", command);
  started.push([socket, name]);
  const [pane] = parsePanes(tm(socket, "list-panes", "-t", name, "-F", "#{pane_id}\t#{pane_pid}\t#{pane_dead}"));
  return pane;
}

afterEach(() => {
  for (const [socket, name] of started.splice(0)) spawnSync("tmux", ["-S", socket, "kill-session", "-t", name], { env });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("tmuxSocket", () => {
  it("takes the socket from TMUX", () => {
    expect(tmuxSocket("/tmp/tmux-1001/default,114448,0")).toBe("/tmp/tmux-1001/default");
    expect(tmuxSocket(null)).toBeNull();
    expect(tmuxSocket("relative,1,0")).toBeNull();
  });
});

describe("reaching a terminal", () => {
  it("finds %0 on the server the process is really on, not the dashboard's (the reported failure)", async () => {
    const pane = start(sockets[0], "agent");
    expect(pane.id).toBe("%0");
    /* the same environment the agent's process would carry; the dashboard's own tmux has no such pane */
    const target = { kind: "tmux" as const, pane: pane.id, socket: sockets[0], panePid: pane.pid };
    await expect(verifyPane(target)).resolves.toBeUndefined();
    await typeIntoTerminal(target, "hello", { checkPrompt: false });
    await new Promise((r) => setTimeout(r, 200));
    expect(await paneScreen(target)).toContain("hello");
  });

  it("with %0 on two servers, text only reaches the right one", async () => {
    const mine = start(sockets[0], "mine");
    const other = start(sockets[1], "other");
    expect([mine.id, other.id]).toEqual(["%0", "%0"]);
    const target = { kind: "tmux" as const, pane: "%0", socket: sockets[0], panePid: mine.pid };
    await typeIntoTerminal(target, "private", { checkPrompt: false });
    await new Promise((r) => setTimeout(r, 200));
    expect(await paneScreen(target)).toContain("private");
    expect(await paneScreen({ kind: "tmux", pane: "%0", socket: sockets[1] })).not.toContain("private");
  });

  it("refuses an id that now belongs to a different pane", async () => {
    const pane = start(sockets[0], "reused");
    await expect(typeIntoTerminal({ kind: "tmux", pane: pane.id, socket: sockets[0], panePid: pane.pid + 1 }, "x", { checkPrompt: false })).rejects.toBeInstanceOf(TerminalGone);
  });

  it("reports a closed pane in plain words, sending nothing", async () => {
    const pane = start(sockets[0], "closing");
    const target = { kind: "tmux" as const, pane: pane.id, socket: sockets[0], panePid: pane.pid };
    tm(sockets[0], "kill-session", "-t", "closing");
    started.pop();
    const err = await typeIntoTerminal(target, "lost?", { checkPrompt: false }).catch((e) => e);
    expect(err).toBeInstanceOf(TerminalGone);
    expect(err.message).not.toContain("%");
    expect(err.message).toContain("Your message is still here");
  });

  it("treats a dead pane as closed", async () => {
    start(sockets[0], "keep");
    tm(sockets[0], "new-session", "-d", "-s", "ended", "-x", "80", "-y", "24", "sh -c 'sleep 0.3; exit 3'", ";", "set-option", "-w", "-t", "ended", "remain-on-exit", "on");
    started.push([sockets[0], "ended"]);
    await new Promise((r) => setTimeout(r, 700));
    const pane = parsePanes(tm(sockets[0], "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{pane_dead}")).find((p) => p.dead);
    expect(pane).toBeTruthy();
    await expect(verifyPane({ kind: "tmux", pane: pane!.id, socket: sockets[0] })).rejects.toBeInstanceOf(TerminalGone);
  });

  it("reports a server that has gone the same way", async () => {
    await expect(verifyPane({ kind: "tmux", pane: "%0", socket: path.join(dir, "absent") })).rejects.toBeInstanceOf(TerminalGone);
  });

  it("keeps concurrent sends whole and in order", async () => {
    const pane = start(sockets[0], "order");
    const target = { kind: "tmux" as const, pane: pane.id, socket: sockets[0], panePid: pane.pid };
    await Promise.all(["alpha", "bravo", "charlie"].map((t) => typeIntoTerminal(target, t, { checkPrompt: false })));
    await new Promise((r) => setTimeout(r, 300));
    const lines = (await paneScreen(target)).split("\n").filter(Boolean);
    expect(lines.filter((l) => /^(alpha|bravo|charlie)$/.test(l)).length).toBeGreaterThanOrEqual(3);
    expect(lines.indexOf("alpha")).toBeLessThan(lines.indexOf("charlie"));
  });
});

describe("a process finding its own pane", () => {
  it("resolves through the environment it really has, including the socket", async () => {
    const pane = start(sockets[0], "env", "sleep 30");
    const target = await liveTarget(pane.pid);
    expect(target).toMatchObject({ kind: "tmux", pane: pane.id, socket: sockets[0], panePid: pane.pid });
  });

  it("isn't fooled by another server's pane with the same id", async () => {
    const decoy = start(sockets[1], "decoy");
    const pane = start(sockets[0], "real", "sleep 30");
    expect(decoy.id).toBe(pane.id);
    expect(await liveTarget(pane.pid)).toMatchObject({ socket: sockets[0], panePid: pane.pid });
  });
});
