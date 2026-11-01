import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { startRun } from "@/lib/server/runner";
import { claudeInTmux, startClaudeTui, TuiStartError } from "@/lib/server/claude-tui";
import { sessionRows } from "@/lib/server/rows";
import { newestFirst } from "@/lib/server/order";
import { jsonWithEtag } from "@/lib/server/etag";
import type { ListingSeen } from "@/lib/server/sessions";
import { matchSession, queryWords } from "@/lib/session-match";
import { readJson, requestedMode, str } from "@/lib/server/http";
import { workspaceProblem } from "@/lib/server/workspace";
import { whoIs, type Who } from "@/lib/guard";
import { claim, knownTo, noteFullAccess } from "@/lib/server/access";
import type { AgentId } from "@/lib/types";
import { agentStart } from "@/lib/server/agents/routes";
import { once } from "@/lib/server/dedupe";
import { guardTurn } from "@/lib/server/fallback";
import { pickProfile, setSessionProfile } from "@/lib/server/profiles";
import { beforeTurn } from "@/lib/server/checkpoints";
import { GitError, moveCheckpoints, newWorktree } from "@/lib/server/git";
import { parseEffort } from "@/lib/agent-traits";

export const dynamic = "force-dynamic";

const PAGE = 120;
const MAX_LIMIT = 5000;
/* how far back a search looks: the list's pages are only the newest */
const SEARCH_SCAN = 2000;
const SEARCH_CAP = 50;

/** `?limit=` newest rows (pinned ones past it too) and whether there are more; `?q=` the best matches instead. */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const q = params.get("q");
  if (q !== null) {
    const asker = await whoIs(req);
    const allowed = asker?.role === "member" ? knownTo(asker.id) : null;
    return jsonWithEtag(req, { sessions: (await findSessions(q)).filter((s) => !allowed || allowed.has(s.id)) });
  }
  const asked = Number.parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), MAX_LIMIT) : PAGE;
  const seen: ListingSeen = { total: 0 };
  const who = await whoIs(req);
  const visible = who?.role === "member" ? knownTo(who.id) : null;
  const rows = (await sessionRows(limit, seen)).filter((s) => !visible || visible.has(s.id));
  /* past the last transcript looked at, older Claude sessions could still come before another agent's row */
  const edge = seen.total > limit ? seen.oldest : undefined;
  const sessions = rows.filter((s, i) => s.pinned || (i < limit && (!edge || newestFirst(s, edge) <= 0)));
  const projects = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))].slice(0, 30);
  return jsonWithEtag(req, { sessions, projects, more: seen.total > limit || rows.length > limit });
}

async function findSessions(q: string) {
  const words = queryWords(q.slice(0, 200));
  if (!words.length) return [];
  return (await sessionRows(SEARCH_SCAN))
    .map((s) => ({ s, rank: matchSession(s, words) }))
    .filter((x) => x.rank > 0)
    .sort((a, b) => b.rank - a.rank || newestFirst(a.s, b.s))
    .slice(0, SEARCH_CAP)
    .map((x) => x.s);
}

export async function POST(req: NextRequest) {
  const body = await readJson(req);
  const who = await whoIs(req);
  const res = await once(body.clientId, () => startWithGit(body, who));
  if (who?.role === "member" && res.ok) {
    const made = (await res.clone().json().catch(() => null)) as { id?: string } | null;
    if (made?.id) claim(made.id, who.id);
  }
  return res;
}

/* an optional worktree to start in, and a checkpoint of the folder before the first turn (kept under a
 * provisional key until the session has its id) */
async function startWithGit(body: Record<string, unknown>, who: Who | null) {
  const cwd = str(body.cwd)?.trim();
  const text = str(body.text)?.trim();
  /* before anything below touches the folder: a worktree or a checkpoint is work too */
  const outside = cwd && path.isAbsolute(cwd) && text ? workspaceProblem(cwd) : null;
  if (outside && !outside.startsWith("Folder not found")) return NextResponse.json({ error: outside }, { status: 403 });
  let worktree: { dir: string; branch: string } | null = null;
  if (body.worktree === true && cwd && text) {
    try {
      worktree = await newWorktree(cwd, text.slice(0, 40));
    } catch (err) {
      return NextResponse.json({ error: `Couldn't create worktree: ${(err as Error).message}` }, { status: err instanceof GitError ? err.status : 500 });
    }
    body = { ...body, cwd: worktree.dir };
  }
  const dir = str(body.cwd)?.trim();
  const provisional = `pending-${crypto.randomUUID()}`;
  if (dir && text && path.isAbsolute(dir)) await beforeTurn(provisional, text, dir);
  const res = await start(body, who);
  if (res.ok && dir) {
    const data = (await res.clone().json().catch(() => null)) as { id?: string } | null;
    if (data?.id) {
      const agent = str(body.agent) as AgentId | undefined;
      const key = agent && agent !== "claude" && !data.id.includes(":") ? `${agent}:${data.id}` : data.id;
      await moveCheckpoints(dir, provisional, key).catch(() => undefined);
      if (worktree) return NextResponse.json({ ...data, worktree });
    }
  }
  return res;
}

async function start(body: Record<string, unknown>, who: Who | null) {
  const agent = str(body.agent) as AgentId | undefined;
  if (agent && agent !== "claude") return agentStart(agent, body, who);
  const text = str(body.text)?.trim();
  const cwd = str(body.cwd)?.trim();
  if (!text) return NextResponse.json({ error: "Enter a message." }, { status: 400 });
  if (!cwd || !path.isAbsolute(cwd) || !(await fs.stat(cwd).then((s) => s.isDirectory()).catch(() => false))) {
    return NextResponse.json({ error: cwd ? `Folder not found: ${cwd}` : "Choose a folder." }, { status: 400 });
  }
  const profile = pickProfile("claude", body.profile, null);
  const model = str(body.model) || undefined;
  const mode = requestedMode(body.permissionMode, who) ?? "default";
  const effort = parseEffort("claude", body.effort);
  if (await claudeInTmux()) {
    try {
      const { id, terminal } = await startClaudeTui({ profile, cwd, text, model, effort, permissionMode: mode });
      setSessionProfile(id, profile.id);
      noteFullAccess(id, mode === "bypassPermissions");
      return NextResponse.json({ id, terminal });
    } catch (err) {
      if (err instanceof TuiStartError && err.diagnostic) console.error("claude start failed", JSON.stringify(err.diagnostic));
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err), terminal: err instanceof TuiStartError ? err.terminal : undefined, diagnostic: err instanceof TuiStartError ? err.diagnostic : undefined }, { status: 502 });
    }
  }
  const run = startRun({ cwd, model, effort, permissionMode: mode, profile });
  run.send(text);
  const id = await Promise.race([run.sessionId(), new Promise<string>((r) => setTimeout(() => r(""), 90_000))]);
  if (!id) {
    run.close();
    return NextResponse.json({ error: run.state.error ?? "Claude didn't start in time." }, { status: 502 });
  }
  setSessionProfile(id, profile.id);
  guardTurn({ key: id, text, mode, model, effort, profile });
  return NextResponse.json({ id });
}
