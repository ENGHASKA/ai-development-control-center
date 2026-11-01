import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse, type NextRequest } from "next/server";
import { childEnv } from "@/lib/server/child-env";
import { readJson, str } from "@/lib/server/http";
import { projectBranch } from "@/lib/server/project-icon";
import { allProfiles } from "@/lib/server/profiles";
import { readProjects, removeProject, saveProject } from "@/lib/server/projects";
import { sessionRows } from "@/lib/server/rows";
import { browseRoot, extraRoots, folderKind, projectsRoot, workspaceProblem, workspaceRoot } from "@/lib/server/workspace";
import type { WorkspaceEntry } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const run = promisify(execFile);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SCAN = 400;
const MAX = 200;

async function children(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => path.join(dir, e.name));
}

/** How many files differ from the last commit; null when Git didn't answer in time. */
const changedFiles = (dir: string) =>
  run("git", ["-C", dir, "status", "--porcelain"], { env: childEnv({ GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }), timeout: 3000, maxBuffer: 1 << 22 })
    .then(({ stdout }) => stdout.split("\n").filter(Boolean).length)
    .catch(() => null);

/** How many files the last commit holds; 0 is a repository with nothing in it yet. */
const trackedFiles = (dir: string) =>
  run("git", ["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"], { env: childEnv({ GIT_TERMINAL_PROMPT: "0" }), timeout: 3000, maxBuffer: 1 << 24 })
    .then(({ stdout }) => stdout.split("\n").filter(Boolean).length)
    .catch(() => 0);

/* Git facts cost a few processes per folder and a workspace can hold a hundred, so only the folders a person sees first get
 * them, a few at a time, and briefly remembered. A folder without them just shows less. */
const GIT_DETAILS = 24;
const GIT_AT_ONCE = 6;
const GIT_TTL_MS = 20_000;
const details = new Map<string, { at: number; branch: string | null; changes: number | null; tracked: number | null }>();

async function enrich(list: WorkspaceEntry[]) {
  const queue = list.filter((e) => e.kind === "git" || e.kind === "worktree");
  const worker = async () => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      let known = details.get(e.path);
      if (!known || Date.now() - known.at > GIT_TTL_MS) {
        const [branch, changes, tracked] = await Promise.all([projectBranch(e.path).catch(() => null), changedFiles(e.path), trackedFiles(e.path)]);
        known = { at: Date.now(), branch, changes, tracked };
        details.set(e.path, known);
      }
      Object.assign(e, { branch: known.branch, changes: known.changes, tracked: known.tracked });
    }
  };
  await Promise.all(Array.from({ length: GIT_AT_ONCE }, worker));
}

/**
 * The folders agent work can start in: registered projects, everything under projects/ and worktrees/, and folders
 * sessions ran in. A folder outside the workspace is left out. A folder that's gone stays listed as missing when it
 * was registered or used, so the user can see what happened to it.
 */
export async function GET(req: NextRequest) {
  /* `?check=<path>`: whether a folder someone named can be used, and why not */
  const check = req.nextUrl.searchParams.get("check");
  if (check !== null) {
    if (!path.isAbsolute(check) || check.includes("\0")) return NextResponse.json({ allowed: false, reason: "Use an absolute path." });
    const reason = workspaceProblem(check);
    if (reason) return NextResponse.json({ allowed: false, reason });
    const kind = folderKind(check);
    const git = kind === "git" || kind === "worktree";
    return NextResponse.json({ allowed: true, path: await fs.realpath(check), kind, branch: git ? await projectBranch(check).catch(() => null) : null, changes: git ? await changedFiles(check) : null, tracked: git ? await trackedFiles(check) : null });
  }
  const top = browseRoot();
  const registered = readProjects();
  const rows = await sessionRows(SCAN).catch(() => []);
  const used = new Map<string, number>();
  for (const s of rows) if (s.cwd) used.set(s.cwd, Math.max(used.get(s.cwd) ?? 0, s.mtime));
  const extra = extraRoots();
  const scanned = await Promise.all([projectsRoot(), path.join(top, "worktrees"), ...extra].map(children));
  const dirs = new Set([...registered.map((p) => p.path), ...used.keys(), ...extra, ...scanned.flat()]);
  const allowed = [...dirs].filter((d) => {
    const problem = workspaceProblem(d);
    return !problem || (problem.startsWith("Folder not found") && [top, ...extra].some((r) => d === r || d.startsWith(`${r}/`)));
  });
  const named = new Map(registered.map((p) => [p.path, p.name]));
  const entries: WorkspaceEntry[] = allowed.slice(0, MAX).map((dir) => ({
    path: dir,
    name: named.get(dir) || path.basename(dir),
    kind: folderKind(dir),
    branch: null,
    changes: null,
    tracked: null,
    registered: named.has(dir),
    lastUsed: used.get(dir) ?? null,
    queueable: folderKind(dir) === "git",
  }));
  /* real projects before the task worktrees cut from them, so a first visit doesn't land in someone's task */
  const rank = (e: WorkspaceEntry) => (e.kind === "missing" ? 2 : e.kind === "worktree" ? 1 : 0);
  entries.sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || rank(a) - rank(b) || Number(b.registered) - Number(a.registered) || a.name.localeCompare(b.name));
  await enrich(entries.slice(0, GIT_DETAILS));
  return NextResponse.json({ root: top, roots: [top, ...extra], managed: workspaceRoot() !== null, projectsDir: projectsRoot(), entries });
}

/**
 * { action: "create", name, git } makes a project under projects/. { action: "register", path } keeps a folder inside the
 * workspace in the project list, and { action: "forget", path } drops it from the list; neither touches the folder.
 */
export async function POST(req: NextRequest) {
  const body = await readJson(req);
  if (body.action === "create") {
    const name = str(body.name)?.trim() ?? "";
    if (!NAME.test(name)) return NextResponse.json({ error: "Use letters, numbers, dots, dashes or underscores, starting with a letter or number." }, { status: 400 });
    const dir = path.join(projectsRoot(), name);
    try {
      await fs.mkdir(projectsRoot(), { recursive: true });
      await fs.mkdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return NextResponse.json({ error: `A project named ${name} already exists.` }, { status: 409 });
      return NextResponse.json({ error: `Couldn't create ${name}: ${(err as Error).message}` }, { status: 500 });
    }
    if (body.git === true) {
      try {
        const env = childEnv({ GIT_TERMINAL_PROMPT: "0" });
        await run("git", ["init", "-q", "-b", "main", dir], { env, timeout: 10_000 });
        /* worktrees and background tasks start from a commit */
        await run("git", ["-C", dir, "-c", "user.name=Control Center", "-c", "user.email=control-center@localhost", "commit", "-q", "--allow-empty", "-m", "Start project"], { env, timeout: 10_000 });
      } catch (err) {
        await fs.rm(dir, { recursive: true, force: true });
        return NextResponse.json({ error: `Couldn't initialize Git: ${(err as Error).message}` }, { status: 500 });
      }
    }
    return save(dir, name);
  }
  const dir = str(body.path)?.trim();
  if (!dir || !path.isAbsolute(dir)) return NextResponse.json({ error: "Choose a folder." }, { status: 400 });
  if (body.action === "forget") {
    const gone = removeProject(dir);
    return "error" in gone ? NextResponse.json({ error: gone.error }, { status: 400 }) : NextResponse.json(gone);
  }
  if (body.action !== "register") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  const problem = workspaceProblem(dir);
  if (problem) return NextResponse.json({ error: problem }, { status: problem.startsWith("Folder not found") ? 404 : 403 });
  if (readProjects().some((p) => p.path === dir)) return NextResponse.json({ path: dir });
  return save(dir, path.basename(dir));
}

function save(dir: string, name: string) {
  const saved = saveProject({ path: dir, name }, new Map(allProfiles().map((p) => [p.id, p.agent] as const)));
  return "error" in saved ? NextResponse.json({ error: saved.error }, { status: 400 }) : NextResponse.json({ path: dir });
}
