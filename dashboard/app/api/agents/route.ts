import { NextResponse, type NextRequest } from "next/server";
import { capabilitiesFor } from "@/lib/agent-capabilities";
import { whoIs } from "@/lib/guard";
import { installedAgents } from "@/lib/server/agents/bridge";
import { signInState } from "@/lib/server/agents/readiness";
import { getProfile } from "@/lib/server/profiles";
import { bypassRefused } from "@/lib/server/workspace";
import type { AgentId } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Which agent CLIs are installed on the server (Claude is always available through the SDK), what each can do here, and whether Claude and Codex are signed in. */
export async function GET(req: NextRequest) {
  const list = [{ id: "claude" as AgentId, label: "Claude", installed: true }, ...(await installedAgents())];
  const who = await whoIs(req);
  const admin = who?.role === "admin";
  const agents = await Promise.all(
    list.map(async (a) => {
      const bin = a.id === "claude" || a.id === "codex" ? (getProfile(a.id)?.binPath ?? a.id) : null;
      /* a slow CLI answers "unknown" rather than hold up the page; the check keeps running for the next request */
      const signIn = a.installed && bin ? await Promise.race([signInState(a.id as "claude" | "codex", bin), new Promise<"unknown">((r) => setTimeout(() => r("unknown"), 1500))]) : null;
      return { ...a, signIn, capabilities: capabilitiesFor(a.id, { bypassRefused: bypassRefused(), admin }) };
    }),
  );
  /* Auto Mode needs the task queue, which a plain dashboard install doesn't have */
  const auto = process.env.ACC_SOURCE_DIR ? { available: true } : { available: false, reason: "Auto needs the background task queue, which isn't set up on this server." };
  return NextResponse.json({ agents, auto });
}
