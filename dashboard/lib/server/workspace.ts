import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FolderKind } from "@/lib/workspace";

/* The control center's boundary for agent work. ACC_FILE_ROOT is set on managed installs: sessions, terminals and the
 * folder browser stay under it, and permission bypass is off. Without it (plain agent-u) the folder browser starts at
 * home and none of these rules apply. Credential files are kept out separately, in lib/server/files.ts. */

export const workspaceRoot = () => process.env.ACC_FILE_ROOT || null;
export const browseRoot = () => workspaceRoot() ?? os.homedir();

/* An operator approves extra roots at a shell (bin/acc roots add), and nothing here can write that file, so a browser
 * session or a prompt can't widen its own reach. The rules repeat libexec/acc_roots.py: a hand-edited entry naming a
 * protected place is ignored here too. */
const PROTECTED = new Set([".ssh", ".gnupg", ".aws", ".claude", ".codex", ".config", ".local", ".cache", ".nvm", "backups"]);
const rootsFile = () => process.env.ACC_ROOTS_FILE || path.join(os.homedir(), ".config", "ai-control-center", "workspace-roots.json");

function acceptableRoot(raw: unknown) {
  const home = os.homedir();
  if (typeof raw !== "string" || !path.isAbsolute(raw)) return false;
  let real: string;
  try {
    real = fs.realpathSync(raw);
  } catch {
    return false;
  }
  if (real === home || !real.startsWith(home + path.sep)) return false;
  return !PROTECTED.has(real.slice(home.length + 1).split(path.sep)[0]);
}

/** Extra approved folders, read fresh so an approval or removal at a shell applies without a restart. */
export function extraRoots(): string[] {
  try {
    const { roots } = JSON.parse(fs.readFileSync(rootsFile(), "utf8")) as { roots?: unknown };
    return Array.isArray(roots) ? (roots.filter(acceptableRoot) as string[]).map((r) => fs.realpathSync(r)) : [];
  } catch {
    return [];
  }
}

/** Every folder agent work may start under; empty where no boundary applies. */
export function approvedRoots(root = workspaceRoot()): string[] {
  return root ? [root, ...extraRoots()] : [];
}
export const projectsRoot = () => path.join(browseRoot(), "projects");
const policyFile = () => process.env.ACC_POLICY_FILE || path.join(os.homedir(), ".config", "ai-control-center", "policy.json");

/** Full access stays off on a managed install until an administrator turns it on, in Team and sharing or with `acc policy full-access on`. */
export function bypassRefused() {
  if (workspaceRoot() === null) return false;
  try {
    return (JSON.parse(fs.readFileSync(policyFile(), "utf8")) as { full_access?: unknown }).full_access !== true;
  } catch {
    return true;
  }
}

/** The same file `acc policy` writes. Written whole, so a reader never sees half of it. */
export function setFullAccessPolicy(on: boolean) {
  const file = policyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ full_access: on })}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

const within = (dir: string, root: string) => dir === root || dir.startsWith(root + path.sep);

/** Why a folder can't host agent work, or null. Symlinks are followed: where a folder really is decides. */
export function workspaceProblem(cwd: string, root = workspaceRoot()): string | null {
  const roots = approvedRoots(root);
  if (!roots.length) return null;
  let real: string;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    return `Folder not found: ${cwd}`;
  }
  return roots.some((r) => within(real, r)) ? null : `${cwd} is outside the development workspace (${root}). Choose a project inside it, or approve its folder at a shell with: acc roots add PATH`;
}

/**
 * Why a guarded launcher (bin/acc-claude, bin/acc-codex) would refuse this folder. They exit with status 1 and leave
 * only a dead pane behind, so the refusal is spotted before launching. They allow the same folders as this file.
 */
export function launcherProblem(bin: string | null | undefined, cwd: string, root = process.env.ACC_ROOT ?? workspaceRoot()): string | null {
  if (!bin || !root || !/^acc-(claude|codex)$/.test(path.basename(bin))) return null;
  return workspaceProblem(cwd, root);
}


/** What a folder is: a repository has a .git directory, a linked worktree a .git file. */
export function folderKind(dir: string): FolderKind {
  try {
    if (!fs.statSync(dir).isDirectory()) return "missing";
  } catch {
    return "missing";
  }
  try {
    return fs.lstatSync(path.join(dir, ".git")).isDirectory() ? "git" : "worktree";
  } catch {
    return "folder";
  }
}
