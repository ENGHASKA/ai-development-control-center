import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { NextResponse, type NextRequest } from "next/server";
import { guard } from "@/lib/guard";
import { childEnv } from "@/lib/server/child-env";
import { workspaceProblem } from "@/lib/server/workspace";

export const dynamic = "force-dynamic";

/* Auto Mode. The plan lives in the queue's database and the worker advances it; this route only starts and steers it,
 * so closing the page changes nothing. */

const run = promisify(execFile);
const ID = /^[a-f0-9]{12}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_BODY = 65536;

const acc = async (...args: string[]) => {
  const { stdout } = await run("/usr/bin/python3", [`${process.env.ACC_SOURCE_DIR}/bin/acc`, ...args], { env: childEnv(), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
};

/** bin/acc's own validation message, never a stack trace. */
function refusal(err: unknown) {
  const line = (err as { stderr?: string } | null)?.stderr?.trim().split("\n").pop()?.slice(0, 300);
  return NextResponse.json({ error: line && !/Traceback|File "/.test(line) ? line : "The plan action was refused." }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;
  const id = req.nextUrl.searchParams.get("id");
  if (id !== null && !ID.test(id)) return NextResponse.json({ error: "Invalid plan ID" }, { status: 400 });
  try {
    return NextResponse.json(JSON.parse(await acc(...(id ? ["plan-show", id] : ["plan-list"]))), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Plans are temporarily unavailable. Work continues on the server." }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const denied = await guard(req);
  if (denied) return denied;
  const raw = await req.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "That request is too large." }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  try {
    if (body.action === "create") {
      const repo = typeof body.repo === "string" ? body.repo : "";
      const outside = repo && path.isAbsolute(repo) ? workspaceProblem(repo) : "Choose a project.";
      if (outside) return NextResponse.json({ error: outside }, { status: 403 });
      const spec = { repo, request: body.request, routing: body.routing, models: body.models, allow_reassign: body.allowReassign === true, review: body.review !== false, max_repairs: body.maxRepairs };
      const dir = path.join(process.env.ACC_ROOT!, "tasks", "requests");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${randomUUID()}.json`);
      await fs.writeFile(file, JSON.stringify(spec), { mode: 0o600 });
      try {
        return NextResponse.json({ id: (await acc("plan-add", file)).trim().split("\n").pop() });
      } finally {
        await fs.rm(file, { force: true });
      }
    }
    if (!ID.test(id)) return NextResponse.json({ error: "Invalid plan ID" }, { status: 400 });
    if (body.action === "cancel") await acc("plan-cancel", id);
    else if (body.action === "resume") await acc("plan-resume", id);
    else if (body.action === "merge") return NextResponse.json({ ok: true, branch: (await acc("plan-merge", id, "--reviewer", "dashboard operator")).trim() });
    else if (body.action === "approve-step" && typeof body.step === "string" && KEY.test(body.step)) await acc("plan-approve-step", id, body.step);
    else return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return refusal(err);
  }
}
