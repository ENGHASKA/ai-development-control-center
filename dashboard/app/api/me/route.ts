import { NextResponse, type NextRequest } from "next/server";
import { whoIs } from "@/lib/guard";

export const dynamic = "force-dynamic";

/** Who this browser is signed in as, so the interface can hide what the server would refuse. */
export async function GET(req: NextRequest) {
  return NextResponse.json(await whoIs(req));
}
