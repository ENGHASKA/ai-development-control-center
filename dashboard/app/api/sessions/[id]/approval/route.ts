import { NextResponse, type NextRequest } from "next/server";
import { parseApproval } from "@/lib/codex-approval";
import { whoIs } from "@/lib/guard";
import { audit } from "@/lib/server/access";
import { terminalForKey } from "@/lib/server/agents/bridge";
import { inputTarget, paneScreen, pressKey } from "@/lib/server/input";
import { readJson, str } from "@/lib/server/http";

export const dynamic = "force-dynamic";

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

async function current(id: string) {
  const terminal = await terminalForKey(id);
  const target = terminal && (await inputTarget(terminal.pid));
  if (!target) return null;
  const screen = (await paneScreen(target).catch(() => "")).replace(ANSI, "");
  return { target, approval: parseApproval(screen) };
}

/** The approval the agent is waiting on in this session's terminal, or none. Read fresh, so it's never out of date. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await current((await params).id).catch(() => null);
  return NextResponse.json({ terminal: Boolean(found), approval: found?.approval ?? null });
}

/**
 * Answers it with the agent's own keys, only if the dialog on screen is still the one the person saw: a different request that
 * replaced it gets no answer. Answering closes the dialog, so a repeat finds nothing to answer.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson(req);
  const decision = str(body.decision);
  if (decision !== "approve" && decision !== "reject") return NextResponse.json({ error: "Choose approve or reject." }, { status: 400 });
  const found = await current(id);
  if (!found?.approval || found.approval.id !== str(body.request)) return NextResponse.json({ error: "That request is no longer waiting. Check the conversation.", code: "approval_gone" }, { status: 409 });
  await pressKey(found.target, decision === "approve" ? "Enter" : "Escape");
  audit((await whoIs(req))?.id ?? "unknown", `${found.approval.agent}-${decision}`, { session: decodeURIComponent(id), detail: found.approval.detail.slice(0, 200) });
  return NextResponse.json({ ok: true });
}
