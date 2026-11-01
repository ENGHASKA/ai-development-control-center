import { randomUUID } from "node:crypto";
import type { PermissionMode } from "@/lib/types";
import { CLAUDE_WEB_DRIVER } from "./config";
import { paneScreen, pressKey, type InputTarget } from "./input";
import type { ResolvedProfile } from "./profiles";
import { findSessionFile, liveTerminals } from "./sessions";
import { killTerminal, launchAgent, listTerminals } from "./terminals";
import { launcherProblem } from "./workspace";

/* Web-started Claude sessions run Claude's own TUI in a kept tmux session, like a session someone
 * opened in zellij: it survives app restarts, opens interactively from the web, attaches from a
 * shell (`tmux attach -t agentu-…`), takes every terminal command (/goal included), and further
 * messages are typed into its pane (lib/server/input.ts). */

let tmuxSeen: { at: number; ok: boolean } | null = null;

/** Whether web turns for Claude go to a TUI in tmux (else the Agent SDK). */
export async function claudeInTmux() {
  if (CLAUDE_WEB_DRIVER !== "tmux") return false;
  if (tmuxSeen && Date.now() - tmuxSeen.at < 60_000) return tmuxSeen.ok;
  const ok = await listTerminals()
    .then((t) => t.tmux)
    .catch(() => false);
  tmuxSeen = { at: Date.now(), ok };
  return ok;
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TRUST_KEY_MS = 3000;
/** the slowest a trust dialog has been seen to take to appear after launch */
const DIALOG_APPEARS_MS = 6000;

/** Which row of an agent's folder trust dialog has focus; null when no dialog is on screen. Claude's and Codex's both count. */
export function trustFocus(screen: string): "yes" | "other" | null {
  const plain = screen.replace(ANSI, "");
  if (!/Yes, I trust this folder|Trust and continue/.test(plain)) return null;
  const focused = plain.split("\n").find((l) => /^\s*[❯›]/.test(l));
  return focused && /Yes, I trust|Trust and continue/.test(focused) ? "yes" : "other";
}

const readTrust = async (target: InputTarget) => trustFocus(await paneScreen(target).catch(() => ""));

async function settleTrust(target: InputTarget, done: (focus: "yes" | "other" | null) => boolean) {
  const deadline = Date.now() + TRUST_KEY_MS;
  let focus = await readTrust(target);
  while (!done(focus) && Date.now() < deadline) {
    await sleep(100);
    focus = await readTrust(target);
  }
  return focus;
}

/**
 * Answers the folder trust dialog a TUI shows in a folder it hasn't seen (the web user picked the folder, which is the
 * trust). The dialog may focus "No, exit" and hide option numbers, so the selection is moved onto "Yes, I trust" first.
 * It has two rows and Down wraps, so Down waits for the screen to change before it can be sent again, and Enter goes
 * only on a frame read just now that shows "Yes" focused: Enter on "No, exit" ends Claude with status 1.
 * Returns whether the dialog was on screen.
 */
async function answerTrust(target: InputTarget) {
  let focus = await readTrust(target);
  if (focus === null) return false;
  if (focus === "other") {
    await pressKey(target, "Down").catch(() => undefined);
    focus = await settleTrust(target, (f) => f !== "other");
    if (focus !== "yes") return true;
  }
  await pressKey(target, "Enter").catch(() => undefined);
  await settleTrust(target, (f) => f === null);
  return true;
}

/**
 * For a terminal someone opened: picking an approved folder was the trust. This runs before the terminal goes back to the
 * browser, because a browser attaching sends terminal escape sequences, and Codex's dialog reads one as "back" and exits with
 * status 1. Enter on Claude's default row does the same. Returns once the agent is past its dialog, or has none.
 */
export async function settleStartup(terminal: string, waitMs = 8000) {
  const target: InputTarget = { kind: "tmux", pane: terminal };
  const deadline = Date.now() + waitMs;
  const dialogBy = Date.now() + DIALOG_APPEARS_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    /* a TUI can drop a key sent as it starts, so answering counts only once the dialog has really gone */
    if ((await answerTrust(target)) && (await readTrust(target)) === null) return true;
    /* an input box means no dialog is coming, though Codex draws one for a moment before its dialog appears */
    if (Date.now() >= dialogBy && /Ask Codex to do anything|^\s*❯\s*$|Try "/m.test((await paneScreen(target).catch(() => "")).replace(ANSI, ""))) return false;
  }
  return false;
}

/** The kind of failure, for logs and for code that reacts to it. */
export function exitCategory(screen: string) {
  const text = screen.replace(ANSI, "");
  if (/Yes, I trust this folder/.test(text)) return "trust_declined";
  if (/outside the approved workspace folders/i.test(text)) return "folder_not_allowed";
  if (/Another agent owns this worktree/i.test(text)) return "worktree_in_use";
  if (/not logged in|please run \/login|auth login/i.test(text)) return "not_signed_in";
  if (/usage limit|rate limit|quota|out of (usage|credits)/i.test(text)) return "usage_limit";
  return "exited";
}

/** Why a TUI ended before its session opened, from the last thing on its screen. */
export function tuiExitMessage(screen: string, code: number | null) {
  const lines = screen.replace(ANSI, "").split("\n").map((l) => l.trim()).filter((l) => l && !/^Pane is dead/.test(l));
  const text = lines.join(" ");
  if (/Yes, I trust this folder/.test(text)) return "Claude exited at its folder trust question because \"No, exit\" was chosen. Start the session again and it will be answered for this folder.";
  if (/outside the approved workspace folders/i.test(text)) return "That folder isn't approved for agents. Choose a project in the workspace, or approve its folder at a shell with: acc roots add PATH";
  if (/Another agent owns this worktree/i.test(text)) return "Another agent is already working in this worktree. Reconnect to it, or start in a different worktree.";
  if (/not logged in|please run \/login|auth login/i.test(text)) return "Claude isn't signed in on the server. Run `claude auth login` over SSH, then start the session again.";
  if (/usage limit|rate limit|quota|out of (usage|credits)/i.test(text)) return `Claude reported a usage limit: ${lines.slice(-2).join(" / ").slice(0, 200)}`;
  const status = code ? ` (exit code ${code})` : "";
  if (!lines.length) return `Claude exited before it started${status} and printed nothing. Run \`claude\` in that folder over SSH to see why.`;
  return `Claude exited before it started${status}: ${lines.slice(-4).join(" / ").slice(0, 240)}`;
}

/**
 * Starts or resumes Codex in its own TUI in a kept terminal, the same way Claude runs: the process belongs to the terminal
 * service's tmux, not to this one, so a dashboard restart or a closed browser doesn't touch a running turn. Codex takes no
 * session id up front, so its id is the one that appears for a process that wasn't there before.
 */
export async function startCodexTui(o: { profile: ResolvedProfile; cwd: string; text: string; model?: string | null; effort?: string | null; permissionMode: PermissionMode; resume?: string | null; sessions: () => Promise<{ id: string; cwd: string }[]>; tag: (pid: number, session: string) => Promise<void> }) {
  const refused = launcherProblem(o.profile.binPath, o.cwd);
  if (refused) throw new TuiStartError(refused, undefined, { provider: "codex", category: "folder_not_allowed", exitCode: null, session: o.resume ?? null, cwd: o.cwd });
  const before = new Set((await o.sessions().catch(() => [])).map((s) => s.id));
  const t = await launchAgent({ profile: o.profile, cwd: o.cwd, session: o.resume ?? null, sessionKey: o.resume ? `codex:${o.resume}` : null, model: o.model, effort: o.effort, permissionMode: o.permissionMode, prompt: o.text, backing: "tmux" });
  await settleStartup(t.id, 15_000);
  if (o.resume) return { id: o.resume, terminal: t.id };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    /* on a busy machine the dialog can come after settleStartup gave up, and it would hold the session there for good */
    await answerTrust({ kind: "tmux", pane: t.id });
    /* this folder holds one agent at a time (the launcher's lease), so a new record for it is this conversation */
    const fresh = (await o.sessions().catch(() => [])).find((s) => s.cwd === o.cwd && !before.has(s.id));
    const kept = (await listTerminals().catch(() => null))?.terminals.find((x) => x.id === t.id);
    if (fresh) {
      if (kept?.pid) await o.tag(kept.pid, fresh.id);
      return { id: fresh.id, terminal: t.id };
    }
    if (kept?.exited) {
      const screen = await paneScreen({ kind: "tmux", pane: t.id }).catch(() => "");
      await killTerminal(t.id).catch(() => undefined);
      throw new TuiStartError(tuiExitMessage(screen, kept.exited.code ?? null).replace(/Claude/g, "Codex"), undefined, { provider: "codex", category: exitCategory(screen), exitCode: kept.exited.code ?? null, session: null, cwd: o.cwd });
    }
    await sleep(500);
  }
  throw new TuiStartError("Codex didn't start within 90 seconds. It may be waiting on a question in its terminal.", t.id);
}

export class TuiStartError extends Error {
  /** a terminal still running that the user can look at; a finished one is cleaned up and left out */
  readonly terminal: string | undefined;
  /** what a person or a log needs to place the failure; never the screen itself, which can hold anything */
  readonly diagnostic: { provider: string; category: string; exitCode: number | null; session: string | null; cwd: string; at: string } | undefined;
  constructor(message: string, terminal?: string, diagnostic?: Omit<NonNullable<TuiStartError["diagnostic"]>, "provider" | "at"> & { provider?: string }) {
    super(message);
    this.terminal = terminal;
    this.diagnostic = diagnostic && { provider: diagnostic.provider ?? "claude", at: new Date().toISOString(), ...diagnostic };
  }
}

/**
 * Starts (or resumes) a Claude session in a TUI with `text` as its first message, and waits until
 * Claude has the session open: the transcript exists (new) or its live status file names it (resume).
 */
export async function startClaudeTui(o: { profile: ResolvedProfile; cwd: string; text: string; model?: string | null; effort?: string | null; permissionMode: PermissionMode; resume?: string | null }) {
  const refused = launcherProblem(o.profile.binPath, o.cwd);
  if (refused) throw new TuiStartError(refused, undefined, { category: "folder_not_allowed", exitCode: null, session: null, cwd: o.cwd });
  const id = o.resume ?? randomUUID();
  const t = await launchAgent({
    profile: o.profile,
    cwd: o.cwd,
    session: o.resume ?? null,
    newSession: o.resume ? null : id,
    sessionKey: id,
    model: o.model,
    effort: o.effort,
    permissionMode: o.permissionMode,
    prompt: o.text,
    backing: "tmux",
  });
  const target: InputTarget = { kind: "tmux", pane: t.id };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (await answerTrust(target)) continue;
    const ready = o.resume ? (await liveTerminals(0)).has(id) : Boolean(await findSessionFile(id));
    if (ready) return { id, terminal: t.id };
    const kept = (await listTerminals().catch(() => null))?.terminals.find((x) => x.id === t.id);
    if (kept?.exited) {
      const screen = await paneScreen(target).catch(() => "");
      /* the reason goes in the error, so a dead pane isn't left behind to be opened or listed */
      await killTerminal(t.id).catch(() => undefined);
      const code = kept.exited.code ?? null;
      throw new TuiStartError(tuiExitMessage(screen, code), undefined, { category: exitCategory(screen), exitCode: code, session: id, cwd: o.cwd });
    }
  }
  throw new TuiStartError("Claude didn't start within 90 seconds. It may be waiting on a question in its terminal.", t.id);
}
