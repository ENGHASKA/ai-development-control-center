import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { childEnv } from "./child-env";

const execFileAsync = promisify(execFile);

/* Types into the terminal a session is already open in, by writing keys into
 * its multiplexer pane: zellij `write-chars`, tmux `send-keys`. The pane is
 * found in the process environment, checked up the parent chain because a
 * wrapped claude can lose its own env. Before typing, the pane is read to make
 * sure Claude's own prompt is focused and empty, so text never lands in a
 * dialog, another agent's prompt, or half-typed input. */

function envOf(raw: string | null, key: string) {
  const m = new RegExp(`(?:^|\0)${key}=([^\0]*)`).exec(raw ?? "");
  return m?.[1] || null;
}

/** For callers with one answer for every "can't reach it" case. */
export const inputTarget = (pid: number) =>
  liveTarget(pid).catch((err) => {
    if (err instanceof TerminalGone) return null;
    throw err;
  });

const procPpid = async (pid: number) => {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  return stat ? Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) : 0;
};

/** `socket` names the tmux server: pane ids like %0 mean nothing without it, since each server numbers its own from zero. */
export type InputTarget = { kind: "zellij"; session: string; pane: string } | { kind: "tmux"; pane: string; socket?: string; panePid?: number };

/** The terminal a session was in has gone. Said in place of tmux's error; the caller keeps the unsent message. */
export class TerminalGone extends Error {
  readonly code = "terminal_gone";
  constructor() {
    super("That terminal has closed, so nothing was sent. Your message is still here; resume the session to continue.");
  }
}

/** `TMUX` holds "socket,server pid,session". A socket path comes from a process of this user, and is checked before use. */
export function tmuxSocket(value: string | null) {
  const socket = value?.split(",")[0];
  return socket && socket.startsWith("/") ? socket : null;
}

const tmux = (target: Extract<InputTarget, { kind: "tmux" }>, args: string[]) => run("tmux", [...(target.socket ? ["-S", target.socket] : []), ...args]);

/** A pane, as its own server reports it now. */
export function parsePanes(out: string) {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, pid, dead] = line.split("\t");
      return { id, pid: Number(pid), dead: dead === "1" };
    });
}

/** Asked before every use, because a remembered pane can close, or its id can come back meaning a different pane. */
export async function verifyPane(target: InputTarget) {
  if (target.kind !== "tmux" || !target.pane.startsWith("%")) return;
  const out = await tmux(target, ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{pane_dead}"]).catch(() => null);
  const pane = out === null ? null : parsePanes(out).find((p) => p.id === target.pane);
  if (!pane || pane.dead || (target.panePid !== undefined && pane.pid !== target.panePid)) throw new TerminalGone();
}

/** Where to type for a process, or null if it isn't in a pane; throws TerminalGone if its pane no longer holds it. */
export async function liveTarget(pid: number): Promise<InputTarget | null> {
  const chain: number[] = [];
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    chain.push(pid);
    const env = await fs.readFile(`/proc/${pid}/environ`, "utf8").catch(() => null);
    const zellij = envOf(env, "ZELLIJ_SESSION_NAME");
    const zellijPane = envOf(env, "ZELLIJ_PANE_ID");
    if (zellij && zellijPane !== null) return { kind: "zellij", session: zellij, pane: `terminal_${zellijPane}` };
    const tmuxPane = envOf(env, "TMUX_PANE");
    if (tmuxPane) return tmuxTarget(tmuxPane, tmuxSocket(envOf(env, "TMUX")), chain);
    pid = await procPpid(pid);
  }
  return null;
}

/** Only a pane this process really runs in: if the server's pane isn't on the process's parent chain, the id means something else. */
async function tmuxTarget(pane: string, socket: string | null, chain: number[]): Promise<InputTarget> {
  const stat = socket ? await fs.lstat(socket).catch(() => null) : null;
  if (socket && !stat?.isSocket()) throw new TerminalGone();
  const target = { kind: "tmux", pane, ...(socket ? { socket } : {}) } as const;
  const out = await tmux(target, ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{pane_dead}"]).catch(() => null);
  const found = out === null ? null : parsePanes(out).find((p) => p.id === pane);
  if (!found || found.dead) throw new TerminalGone();
  /* walking up can stop short of the pane's shell only if the chain was cut off, so an absent pid means a mismatch */
  let up = chain[chain.length - 1];
  for (let i = 0; i < 12 && up > 1 && !chain.includes(found.pid); i++) chain.push((up = await procPpid(up)));
  if (!chain.includes(found.pid)) throw new TerminalGone();
  return { ...target, panePid: found.pid };
}

const run = (cmd: string, args: string[]) => execFileAsync(cmd, args, { env: childEnv(), timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout);

/** The visible screen of the pane; `ansi` keeps styling (needed to tell dim placeholders from typed text). */
export async function paneScreen(target: InputTarget, ansi = false) {
  return target.kind === "zellij"
    ? run("zellij", ["--session", target.session, "action", "dump-screen", "-p", target.pane, ...(ansi ? ["-a"] : [])])
    : tmux(target, ["capture-pane", "-p", ...(ansi ? ["-e"] : []), "-t", target.pane]);
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const RULE = /^─{12,}/;
const PLACEHOLDER = /^(Try ".*"|Message @[\w.-]+…?)$/;
/** a box taller than this is something else framed by rules */
const MAX_PROMPT_LINES = 60;

export type PromptState =
  | { ok: true }
  | { ok: false; code: "agent_focus"; agent: string }
  | { ok: false; code: "has_text"; text: string }
  | { ok: false; code: "no_prompt"; screen: string };

/**
 * Finds Claude Code's input box: the last line starting with "❯" that sits
 * between two horizontal rules (a multi-line message fills the lines between).
 * The upper rule carries "@name" when the terminal is focused on another agent;
 * typed text is not dim, placeholders are.
 */
export function readPrompt(ansiScreen: string): PromptState {
  const raw = ansiScreen.split("\n");
  const plain = raw.map((l) => l.replace(ANSI, ""));
  for (let i = plain.length - 1; i > 0; i--) {
    if (!plain[i].trimStart().startsWith("❯")) continue;
    if (!RULE.test(plain[i - 1].trim())) continue;
    const end = plain.findIndex((l, j) => j > i && RULE.test(l.trim()));
    if (end < 0 || end - i > MAX_PROMPT_LINES) continue;
    const agent = /@([\w.-]+)\s*─*\s*$/.exec(plain[i - 1].trim())?.[1];
    if (agent) return { ok: false, code: "agent_focus", agent };
    const undimmed = (l: string) =>
      l
        .split(/(?=\u001b\[)/)
        .filter((part) => !/\u001b\[[0-9;]*\b2m/.test(part))
        .join("")
        .replace(ANSI, "");
    const lines = raw.slice(i, end).map((l, j) => (j ? undimmed(l).replace(/^ {2}/, "") : undimmed(l).replace(/^\s*❯\s?/, "")));
    const typed = lines.join("\n").trim();
    /* Claude's idle suggestion ('Try "…"') isn't always styled dim in the dump; it's never real input */
    return typed && !PLACEHOLDER.test(typed) ? { ok: false, code: "has_text", text: typed } : { ok: true };
  }
  return { ok: false, code: "no_prompt", screen: plain.filter((l) => l.trim()).slice(-8).join("\n") };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** waits before each read of the prompt after Ctrl+U */
const CLEAR_CHECKS_MS = [200, 300, 500];

/* tmux refuses a send-keys over about 16 KB ("command too long"), so long text goes in pieces of at most 8 KB */
const CHUNK = 2000;

/**
 * Plain text a terminal won't act on: tabs autocomplete and escapes interrupt, so neither gets through.
 * Newlines would submit, so they become spaces unless `newlines` (the agent takes Ctrl+J as a line break).
 */
export const typeable = (text: string, { newlines = false } = {}) => {
  const plain = text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
  return newlines ? plain : plain.replace(/\n+/g, " ");
};

async function keys(target: InputTarget, text: string) {
  const lines = text.split("\n");
  for (const [n, line] of lines.entries()) {
    /* Ctrl+J: a line break in the prompt (Enter would submit) */
    if (n) {
      if (target.kind === "zellij") await run("zellij", ["--session", target.session, "action", "write", "-p", target.pane, "10"]);
      else await tmux(target, ["send-keys", "-t", target.pane, "C-j"]);
    }
    /* by code point, so an emoji is never split across two pieces */
    const chars = Array.from(line);
    const parts = Array.from({ length: Math.ceil(chars.length / CHUNK) }, (_, i) => chars.slice(i * CHUNK, (i + 1) * CHUNK).join(""));
    for (const part of parts) {
      if (target.kind === "zellij") await run("zellij", ["--session", target.session, "action", "write-chars", "-p", target.pane, "--", part]);
      else await tmux(target, ["send-keys", "-t", target.pane, "-l", "--", part]);
    }
  }
  if (target.kind === "zellij") await run("zellij", ["--session", target.session, "action", "write", "-p", target.pane, "13"]);
  else await tmux(target, ["send-keys", "-t", target.pane, "Enter"]);
}

async function clearLine(target: InputTarget) {
  if (target.kind === "zellij") await run("zellij", ["--session", target.session, "action", "write", "-p", target.pane, "21"]);
  else await tmux(target, ["send-keys", "-t", target.pane, "C-u"]);
}

export class InputRefused extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/* one writer per pane: two sends interleaving would clear each other's half-typed text */
const paneLocks = new Map<string, Promise<unknown>>();
export function withPane<T>(target: InputTarget, fn: () => Promise<T>): Promise<T> {
  const key = target.kind === "zellij" ? `zellij:${target.session}:${target.pane}` : `tmux:${target.socket ?? ""}:${target.pane}`;
  const prev = paneLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  paneLocks.set(key, tail);
  void tail.then(() => paneLocks.get(key) === tail && paneLocks.delete(key));
  return next;
}

/**
 * Types the text and presses Return, after checking the prompt is focused and
 * empty. Reports whether it looks queued (Claude busy) rather than taken.
 * Line breaks go in as Ctrl+J (`newlines`, on with the prompt check: Claude takes it);
 * for a TUI that might submit on it they become spaces.
 */
export function typeIntoTerminal(target: InputTarget, text: string, opts: { checkPrompt?: boolean; newlines?: boolean } = {}) {
  return withPane(target, async () => {
    /* a target read from a live process carries its pane's pid; one given by name is the server's own session */
    if (target.kind === "tmux" && target.panePid !== undefined) await verifyPane(target);
    return typeLocked(target, text, opts);
  });
}

async function typeLocked(target: InputTarget, text: string, { checkPrompt = true, newlines = checkPrompt }: { checkPrompt?: boolean; newlines?: boolean } = {}) {
  if (!checkPrompt) {
    await keys(target, typeable(text, { newlines }));
    return { queued: false, cleared: null as string | null };
  }
  let before = readPrompt(await paneScreen(target, true));
  /* Claude's greyed next-turn suggestion and real half-typed text look the same in a screen dump,
   * so clear the box (Ctrl+U, per line) and report what was there in case it was real. */
  let cleared: string | null = null;
  let ghost = false;
  /* Ctrl+U clears one line of a multi-line draft at a time */
  for (let i = 0; i < 16 && !before.ok && before.code === "has_text"; i++) {
    const shown = before.text;
    await clearLine(target);
    /* a busy Claude can take a moment to redraw, so unchanged text is read again before it counts as unchanged */
    for (const ms of CLEAR_CHECKS_MS) {
      await sleep(ms);
      before = readPrompt(await paneScreen(target, true));
      if (before.ok || before.code !== "has_text" || before.text !== shown) break;
    }
    /* Ctrl+U removes typed text but not Claude's suggestion: unchanged text is the suggestion, and typing replaces it */
    if (!before.ok && before.code === "has_text" && before.text === shown) {
      ghost = true;
      before = { ok: true };
      break;
    }
    cleared ??= shown;
  }
  if (!before.ok) {
    if (before.code === "agent_focus") throw new InputRefused(`@${before.agent} has focus in the terminal. Switch to main first.`, before.code);
    if (before.code === "has_text") throw new InputRefused(`Unsent text in the terminal prompt ("${before.text.slice(0, 60)}"). Send or clear it first.`, before.code);
    throw new InputRefused("A dialog is open in the terminal. Answer it first.", before.code);
  }
  try {
    await keys(target, typeable(text, { newlines }));
  } catch (err) {
    /* the prompt was already emptied: say what was in it, or it's lost without a word */
    if (cleared && err instanceof Error) err.message = `${err.message}. Cleared unsent text: "${cleared.slice(0, 80)}".`;
    throw err;
  }
  /* a busy Claude keeps a submitted message in its prompt area as queued, so text still showing isn't a failure;
   * the keys are sent by now, so a failing check must not turn into an error (a retry would type it twice) */
  for (let i = 0; i < 4; i++) {
    await sleep(250);
    const screen = await paneScreen(target, true).catch(() => null);
    if (screen === null) return { queued: false, cleared };
    const after = readPrompt(screen);
    if (after.ok || after.code !== "has_text") return { queued: false, cleared };
    /* with a suggestion showing, its text can linger after submit; that's not our message being stuck */
    if (ghost) return { queued: false, cleared };
  }
  return { queued: true, cleared };
}

/* Single keys the web may press in a terminal pane: answering dialogs, interrupting, cycling mode. */
const KEYS = {
  Escape: { zellij: ["27"], tmux: "Escape" },
  Enter: { zellij: ["13"], tmux: "Enter" },
  Up: { zellij: ["27", "91", "65"], tmux: "Up" },
  Down: { zellij: ["27", "91", "66"], tmux: "Down" },
  ShiftTab: { zellij: ["27", "91", "90"], tmux: "BTab" },
  "1": { zellij: ["49"], tmux: "1" },
  "2": { zellij: ["50"], tmux: "2" },
  "3": { zellij: ["51"], tmux: "3" },
} as const;

export type TerminalKey = keyof typeof KEYS;
export const isTerminalKey = (k: unknown): k is TerminalKey => typeof k === "string" && k in KEYS;

export function pressKey(target: InputTarget, key: TerminalKey) {
  const k = KEYS[key];
  return withPane(target, async () => {
    if (target.kind === "zellij") await run("zellij", ["--session", target.session, "action", "write", "-p", target.pane, ...k.zellij]);
    else await tmux(target, ["send-keys", "-t", target.pane, k.tmux]);
  });
}
