export type FolderKind = "git" | "worktree" | "folder" | "missing";

/** A folder agent work can start in, as GET /api/workspace lists it. */
export type WorkspaceEntry = {
  path: string;
  name: string;
  kind: FolderKind;
  branch: string | null;
  /** files changed since the last commit; null when unknown or not a repository */
  changes: number | null;
  /** files in the last commit; 0 means the project is empty, null means it isn't a repository */
  tracked: number | null;
  registered: boolean;
  lastUsed: number | null;
  /** background tasks can start here: a Git repository */
  queueable: boolean;
};

export type Workspace = { root: string; roots: string[]; managed: boolean; projectsDir: string; entries: WorkspaceEntry[] };

export const KIND_LABEL: Record<FolderKind, string> = { git: "Git repository", worktree: "Git worktree", folder: "Folder", missing: "Missing" };

/** A test command as argv: split on spaces, with single or double quotes around words that hold them. Null when a quote is left open. */
export function parseCommand(line: string): string[] | null {
  const argv: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const c of line.trim()) {
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= "";
    } else if (/\s/.test(c)) {
      if (word !== null) argv.push(word);
      word = null;
    } else word = (word ?? "") + c;
  }
  if (quote) return null;
  if (word !== null) argv.push(word);
  return argv;
}

/** The folder a prompt asks to work in ("open the project at /srv/app and..."), or null. The server still decides if it's allowed. */
export function pathInPrompt(text: string): string | null {
  const m = /\b(?:project|folder|directory|repo(?:sitory)?|workspace|codebase|worktree)\b(?:\s+(?:at|in|located at|under)|\s*:)\s*[`"']?(\/[^\s`"',;]+)/i.exec(text);
  return m ? m[1].replace(/[.)]+$/, "").replace(/\/+$/, "") || null : null;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Exactly a provider session ID, nothing that could be read as a flag or an argument. */
export const isSessionId = (value: string) => SESSION_ID.test(value);
