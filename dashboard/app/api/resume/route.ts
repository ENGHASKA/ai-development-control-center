import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse, type NextRequest } from "next/server";
import { guard } from "@/lib/guard";
import { childEnv } from "@/lib/server/child-env";
import { sessionRows } from "@/lib/server/rows";
import { isSessionId } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/* Existing conversations: which ones this server holds, whether one can continue here, and queueing its next turn. The
 * checks live in libexec/acc_sessions.py, so the worker and this route can't disagree. */

const run = promisify(execFile);
const LIST = 400;
const acc = async (...args: string[]) => {
  const { stdout } = await run("/usr/bin/python3", [`${process.env.ACC_SOURCE_DIR}/bin/acc`, ...args], { env: childEnv(), timeout: 20_000, maxBuffer: 1 << 22 });
  return stdout;
};
const provider = (raw: unknown): raw is "claude" | "codex" => raw === "claude" || raw === "codex";

/** `?agent=&id=`: can this one be resumed, and if not, why. No parameters: the saved conversations, newest first. */
export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;
  const agent = req.nextUrl.searchParams.get("agent");
  const id = req.nextUrl.searchParams.get("id");
  if (id !== null) {
    if (!provider(agent)) return NextResponse.json({ error: "Choose Claude or Codex." }, { status: 400 });
    if (!isSessionId(id)) return NextResponse.json({ exists: false, agent, id, problem: "That is not a valid session ID." });
    return NextResponse.json(JSON.parse(await acc("session-inspect", agent, id)));
  }
  const rows = await sessionRows(LIST).catch(() => []);
  const sessions = rows
    .filter((s) => s.agent === "claude" || s.agent === "codex")
    .map((s) => ({ id: s.id.includes(":") ? s.id.split(":").pop()! : s.id, key: s.id, agent: s.agent, title: s.title, cwd: s.cwd, mtime: s.mtime, open: Boolean(s.terminal) }));
  return NextResponse.json({ sessions });
}

/** Queues a background turn in the same conversation. An interactive resume goes through /api/terminals. */
export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !provider(body.agent) || typeof body.session !== "string" || !isSessionId(body.session)) return NextResponse.json({ error: "Choose a valid session." }, { status: 400 });
  const dir = path.join(process.env.ACC_ROOT!, "tasks", "requests");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${randomUUID()}.json`);
  await fs.writeFile(file, JSON.stringify({ agent: body.agent, session: body.session, prompt: body.prompt, cwd: body.cwd, model: body.model, effort: body.effort, permission_mode: body.permissionMode, actor: "dashboard operator" }), { mode: 0o600 });
  try {
    return NextResponse.json({ id: (await acc("session-resume", file)).trim().split("\n").pop() });
  } catch (err) {
    const line = (err as { stderr?: string } | null)?.stderr?.trim().split("\n").pop()?.slice(0, 300);
    return NextResponse.json({ error: line && !/Traceback|File "/.test(line) ? line : "That session could not be resumed." }, { status: 400 });
  } finally {
    await fs.rm(file, { force: true });
  }
}
