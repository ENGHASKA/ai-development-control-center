/* Reading an agent's approval dialog from its terminal. Neither Codex nor Claude offers approval events to a client beside its
 * TUI, so the dialog on screen is the only source. It's read from the real screen each time, and only answered with the agent's
 * own keys: Enter takes the focused "Yes" row and Escape refuses, in both. */

export type CodexApproval = {
  agent: "codex" | "claude";
  question: string;
  reason: string | null;
  /** what would run or change, as Codex shows it */
  detail: string;
  /** identifies this request, so an answer can't land on a different one that took its place */
  id: string;
};

const QUESTION = /^\s*Would you like to (.+\?)\s*$/;
const FOOTER = /^\s*Press enter to confirm or esc to cancel/;
const OPTION = /^\s*[›>]?\s*\d\.\s/;

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

/** The dialog on screen, or null. Enter approves only while "Yes, proceed" is the focused row, so anything else isn't answerable here. */
export function parseCodexApproval(screen: string): CodexApproval | null {
  const lines = screen.split("\n");
  const end = lines.findLastIndex((l) => FOOTER.test(l));
  if (end < 0) return null;
  const start = lines.slice(0, end).findLastIndex((l) => QUESTION.test(l));
  if (start < 0) return null;
  const body = lines.slice(start + 1, end);
  const firstOption = body.findIndex((l) => OPTION.test(l));
  if (firstOption < 0 || !/^\s*[›>]\s*1\.\s*Yes/.test(body[firstOption])) return null;
  const info = body.slice(0, firstOption).map((l) => l.trim()).filter(Boolean);
  const reasonAt = info.findIndex((l) => l.startsWith("Reason:"));
  const commandAt = info.findIndex((l) => l.startsWith("$ "));
  const reason = reasonAt < 0 ? null : info.slice(reasonAt, commandAt > reasonAt ? commandAt : undefined).join(" ").replace(/^Reason:\s*/, "");
  const detail = (commandAt >= 0 ? info.slice(commandAt) : info.filter((l) => !l.startsWith("Environment:"))).join("\n").replace(/^\$ /, "");
  const question = `Would you like to ${QUESTION.exec(lines[start])![1]}`;
  return { agent: "codex", question, reason, detail, id: hash(`${question}\n${detail}\n${reason ?? ""}`) };
}

const CLAUDE_QUESTION = /^\s*Do you want to (.+\?)\s*$/;
const CLAUDE_FOOTER = /^\s*Esc to cancel/;
const CLAUDE_OPTION = /^\s*[❯>]?\s*\d\.\s/;
const DASHES = /^\s*╌{4,}/;
const RULE = /^\s*─{4,}/;

/** Claude's dialog, or null. Its panel runs from a solid rule; what would run or change sits between dashed rules. */
export function parseClaudeApproval(screen: string): CodexApproval | null {
  const lines = screen.split("\n");
  const end = lines.findLastIndex((l) => CLAUDE_FOOTER.test(l));
  if (end < 0) return null;
  const at = lines.slice(0, end).findLastIndex((l) => CLAUDE_QUESTION.test(l));
  if (at < 0) return null;
  const firstOption = lines.slice(at + 1, end).find((l) => CLAUDE_OPTION.test(l));
  if (!firstOption || !/^\s*[❯>]\s*1\.\s*Yes/.test(firstOption)) return null;
  const panel = lines.slice(lines.slice(0, at).findLastIndex((l) => RULE.test(l)) + 1, at);
  const dashes = panel.flatMap((l, i) => (DASHES.test(l) ? [i] : []));
  const clean = (ls: string[]) => ls.map((l) => l.replace(/^\s*│\s?/, "").trim()).filter((l) => l && !l.startsWith("Tip:"));
  const [title, ...about] = clean(dashes.length ? panel.slice(0, dashes[0]) : panel);
  const detail = dashes.length > 1 ? clean(panel.slice(dashes[0] + 1, dashes[dashes.length - 1])).join("\n") : "";
  const reason = [title, ...about].filter(Boolean).join(" · ") || null;
  const question = `Do you want to ${CLAUDE_QUESTION.exec(lines[at])![1]}`;
  return { agent: "claude", question, reason, detail, id: hash(`${question}\n${detail}\n${reason ?? ""}`) };
}

export const parseApproval = (screen: string) => parseCodexApproval(screen) ?? parseClaudeApproval(screen);
