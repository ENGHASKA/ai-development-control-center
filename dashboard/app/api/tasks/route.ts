import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { guard } from "@/lib/guard";
import { childEnv } from "@/lib/server/child-env";
export const dynamic = "force-dynamic";
const run = promisify(execFile);
const ACC = process.env.ACC_SOURCE_DIR + "/bin/acc";
const ROOT = process.env.ACC_ROOT!;
const OPERATOR = "dashboard operator";
async function command(args: string[], timeout = 15000) {
  const { stdout } = await run("/usr/bin/python3", [ACC, ...args], { env: childEnv(), timeout, maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}
/** The reason bin/acc gave, on one line; it prints only its own validation messages, never task content. */
function refusal(err: unknown) {
  const raw = (err as { stderr?: string } | null)?.stderr?.trim().split("\n").pop()?.slice(0, 240);
  return raw && !/Traceback|File "/.test(raw) ? raw : "Task action refused. Inspect the task state, attempt budget, workspace and specification.";
}
export async function GET(req: NextRequest) {
  const denied = await guard(req); if (denied) return denied;
  const id = req.nextUrl.searchParams.get("id");
  if (id && !/^[a-f0-9]{12}$/.test(id)) return NextResponse.json({ error: "Invalid task ID" }, { status: 400 });
  const historyOf = req.nextUrl.searchParams.get("history") === "1";
  try {
    const result = JSON.parse(await command(id ? [historyOf ? "history" : "logs", id] : ["snapshot"]));
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Task state is temporarily unavailable. Execution continues on the server." }, { status: 503 }); }
}
export async function POST(req: NextRequest) {
  const denied = await guard(req); if (denied) return denied;
  const raw = await req.text(); if (raw.length > 65536) return NextResponse.json({ error: "Task request too large" }, { status: 413 });
  try {
    const body = JSON.parse(raw) as { action?: string; id?: string; owner?: string; text?: unknown; verdict?: string; spec?: Record<string, unknown> };
    if (body.action === "unblock-agent" && ["claude", "codex"].includes(body.owner || "")) { await command(["unblock-agent", body.owner!]); return NextResponse.json({ ok: true }); }
    if (body.action === "add") {
      if (!body.spec || !["claude", "codex"].includes(String(body.spec.owner))) throw new Error("Choose Claude or Codex");
      const dir = path.join(ROOT, "tasks", "requests"); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, randomUUID() + ".json"); await fs.writeFile(file, JSON.stringify(body.spec), { mode: 0o600 });
      try { const id = (await command(["add", file])).trim().split("\n").pop(); return NextResponse.json({ id }); }
      finally { await fs.rm(file, { force: true }); }
    }
    if (/^[a-f0-9]{12}$/.test(body.id || "")) {
      const id = body.id!;
      if (body.action === "followup") {
        const file = path.join(ROOT, "tasks", "requests", randomUUID());
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(file, typeof body.text === "string" ? body.text : "", { mode: 0o600 });
        try { return NextResponse.json({ result: (await command(["followup", id, file, "--reviewer", OPERATOR])).trim() }); }
        finally { await fs.rm(file, { force: true }); }
      }
      if (body.action === "decide" && (body.verdict === "approve" || body.verdict === "reject")) { await command(["decide", id, body.verdict, "--reviewer", OPERATOR]); return NextResponse.json({ ok: true }); }
      if (body.action === "close") { await command(["close", id, "--reviewer", OPERATOR]); return NextResponse.json({ ok: true }); }
      /* runs the task's tests again before anything is marked complete */
      if (body.action === "approve") { await command(["approve", id, "--reviewer", OPERATOR], 30 * 60_000); return NextResponse.json({ ok: true }); }
    }
    if (!["cancel", "pause", "resume", "retry"].includes(body.action || "") || !/^[a-f0-9]{12}$/.test(body.id || "")) return NextResponse.json({ error: "Invalid task action" }, { status: 400 });
    await command([body.action!, body.id!]); return NextResponse.json({ ok: true });
  } catch (err) { return NextResponse.json({ error: refusal(err) }, { status: 400 }); }
}
