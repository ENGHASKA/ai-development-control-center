import { NextResponse, type NextRequest } from "next/server";
import { whoIs } from "@/lib/guard";
import { audit } from "@/lib/server/access";
import { readJson } from "@/lib/server/http";
import { bypassRefused, setFullAccessPolicy } from "@/lib/server/workspace";

export const dynamic = "force-dynamic";

const denied = () => NextResponse.json({ error: "Only an administrator can change this." }, { status: 403 });

export async function GET(req: NextRequest) {
  if ((await whoIs(req))?.role !== "admin") return denied();
  return NextResponse.json({ enabled: !bypassRefused() });
}

/** Turns the policy on or off for this server. Turning it on needs the risk acknowledged in the same request. */
export async function POST(req: NextRequest) {
  const who = await whoIs(req);
  if (who?.role !== "admin") return denied();
  const body = await readJson(req);
  if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "Choose on or off." }, { status: 400 });
  if (body.enabled && body.acknowledged !== true) return NextResponse.json({ error: "Acknowledge the risk first.", code: "not_acknowledged" }, { status: 400 });
  setFullAccessPolicy(body.enabled);
  audit(who.id, body.enabled ? "full-access-on" : "full-access-off");
  return NextResponse.json({ enabled: body.enabled });
}
