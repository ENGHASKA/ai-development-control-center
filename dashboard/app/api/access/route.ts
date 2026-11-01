import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse, type NextRequest } from "next/server";
import { childEnv } from "@/lib/server/child-env";
import { allows, RANK, validPin, type AccessMode } from "@/lib/access-policy";
import { whoIs } from "@/lib/guard";
import { accessOf, addUser, audit, levelOf, listUsers, recover, removeUser, unlock, update } from "@/lib/server/access";
import { readJson, str } from "@/lib/server/http";
import { clientKey } from "@/lib/server/login-limit";

export const dynamic = "force-dynamic";

const run = promisify(execFile);
const agents = () =>
  run("/usr/bin/python3", [`${process.env.ACC_SOURCE_DIR}/bin/acc`, "agents"], { env: childEnv(), timeout: 10_000 })
    .then(({ stdout }) => JSON.parse(stdout) as unknown[])
    .catch(() => []);

const MODES: AccessMode[] = ["private", "pin", "trusted", "pin_all"];

/** `?session=`: its sharing settings, for whoever may manage it. Hashes and other people's details never leave here. No session: accounts, for the admin. */
export async function GET(req: NextRequest) {
  const who = await whoIs(req);
  if (!who) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const key = req.nextUrl.searchParams.get("session");
  if (key === null) return who.role === "admin" ? NextResponse.json({ users: listUsers(), agents: await agents() }) : NextResponse.json({ error: "Your account can't use this." }, { status: 403 });
  const level = levelOf(who.id, key);
  const a = accessOf(key);
  if (!allows(level, "manage")) return NextResponse.json({ level, locked: level === "none" && a.mode !== "private" && Boolean(a.pinHash) });
  return NextResponse.json({ level, mode: a.mode, pinSet: Boolean(a.pinHash), pinLevel: a.pinLevel, members: a.members, users: listUsers() });
}

export async function POST(req: NextRequest) {
  const who = await whoIs(req);
  if (!who) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  const body = await readJson(req);
  const action = str(body.action);
  const key = str(body.session) ?? "";
  try {
    if (action === "add-user" || action === "remove-user") {
      if (who.role !== "admin") return NextResponse.json({ error: "Your account can't use this." }, { status: 403 });
      if (action === "remove-user") {
        removeUser(str(body.user) ?? "");
        return NextResponse.json({ ok: true });
      }
      return NextResponse.json({ id: await addUser(str(body.name) ?? "", str(body.password) ?? "") });
    }
    if (action === "recover") {
      if (who.role !== "admin") return NextResponse.json({ error: "Your account can't use this." }, { status: 403 });
      recover(key, who.id);
      return NextResponse.json({ ok: true });
    }
    if (action === "unlock") {
      if (!validPin(body.pin)) return NextResponse.json({ error: "Enter the 4 to 6 digit PIN." }, { status: 400 });
      const a = accessOf(key);
      /* a private session answers as an unknown one does, and so does a wrong PIN, whether or not the session exists */
      const result = await unlock(key, who.id, clientKey(req.headers), a.mode === "private" ? "" : body.pin);
      if (result.ok) return NextResponse.json({ ok: true, level: levelOf(who.id, key) });
      const minutes = Math.ceil(result.retryAfter / 60);
      return NextResponse.json({ error: result.retryAfter ? `Wrong PIN. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` : "Wrong PIN." }, { status: result.retryAfter ? 429 : 403, headers: result.retryAfter ? { "Retry-After": String(result.retryAfter) } : undefined });
    }
    if (!key || !allows(levelOf(who.id, key), "manage")) {
      audit(who.id, "access-refused", { session: key, action });
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    if (action === "set") {
      const mode = str(body.mode) as AccessMode | undefined;
      if (mode && !MODES.includes(mode)) return NextResponse.json({ error: "Unknown mode." }, { status: 400 });
      if (body.pin !== undefined && body.pin !== null && !validPin(body.pin)) return NextResponse.json({ error: "Use a PIN of 4 to 6 digits." }, { status: 400 });
      const pinLevel = body.pinLevel === "interact" ? "interact" : body.pinLevel === "view" ? "view" : undefined;
      await update(key, who.id, { mode, pin: body.pin as string | null | undefined, pinLevel });
      return NextResponse.json({ ok: true });
    }
    if (action === "member") {
      const level = body.level === null ? null : (body.level as "view" | "interact" | "manage");
      if (level !== null && !(level in RANK)) return NextResponse.json({ error: "Unknown permission." }, { status: 400 });
      if (!listUsers().some((u) => u.id === body.user)) return NextResponse.json({ error: "No such member." }, { status: 400 });
      await update(key, who.id, { member: { id: str(body.user)!, level, trusted: body.trusted === true } });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : "That didn't work." }, { status: 400 });
  }
}
