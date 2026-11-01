import type { NextRequest } from "next/server";
import { ADMIN_ID, type Level } from "@/lib/access-policy";
import { COOKIE, verifyMember, verifySession } from "@/lib/auth";
import { accessOf, findUser, levelOf, may } from "@/lib/server/access";
import { allowedHosts, hostAllowed } from "@/lib/hosts";

/** "null" (sandboxed/opaque origins) and garbage don't parse; treat them as no origin. */
function originHost(origin: string | null) {
  try {
    return origin ? new URL(origin).host : null;
  } catch {
    return null;
  }
}

let warned = false;
/** Host is one of ours (lib/hosts.ts); servers set up before ALLOWED_HOSTS existed accept any Host, with one warning */
export function hostOk(req: NextRequest) {
  const allow = allowedHosts();
  if (!allow && !warned) {
    warned = true;
    console.warn("agent-u: neither ALLOWED_HOSTS nor PUBLIC_HOSTNAME is set, so any Host header is accepted (DNS rebinding). Set one in .env.local.");
  }
  return hostAllowed(req.headers.get("host"), allow);
}

/* Defence in depth on top of SameSite=strict: state-changing API calls must come from this origin.
 * Behind a tunnel Host is the public name and x-forwarded-host may be missing or point elsewhere, so either may match. */
export function sameOrigin(req: NextRequest) {
  const hosts = [req.headers.get("host"), req.headers.get("x-forwarded-host")?.split(",")[0].trim()].filter(Boolean);
  return hosts.includes(originHost(req.headers.get("origin")));
}

export type Who = { id: string; role: "admin" | "member" };

/** The signed-in identity. The original password is the admin; members are named accounts. */
export async function whoIs(req: NextRequest): Promise<Who | null> {
  const value = req.cookies?.get(COOKIE)?.value;
  if (await verifySession(value)) return { id: ADMIN_ID, role: "admin" };
  const id = await verifyMember(value, (u) => findUser(u)?.hash);
  return id ? { id, role: "member" } : null;
}

export const signedIn = async (req: NextRequest) => (await whoIs(req)) !== null;

/** For routes that act on one session: null when `who` may, else the answer. Refused and unknown look alike. */
export function sessionDenied(who: Who, key: string, need: Level): Response | null {
  if (may(who.id, key, need)) return null;
  const a = accessOf(key);
  const canUnlock = a.mode !== "private" && Boolean(a.pinHash) && levelOf(who.id, key) === "none";
  return canUnlock ? Response.json({ error: "This conversation is locked.", code: "pin_required" }, { status: 423 }) : Response.json({ error: "Session not found." }, { status: 404 });
}

/** routes the middleware skips (it buffers bodies, which breaks large uploads) check here instead */
export async function guard(req: NextRequest): Promise<Response | null> {
  if (!hostOk(req)) return Response.json({ error: "Unknown host" }, { status: 421 });
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return Response.json({ error: "Bad origin" }, { status: 403 });
  const who = await whoIs(req);
  if (!who) return Response.json({ error: "Sign in first" }, { status: 401 });
  /* these routes reach files, tasks or the shell, which run as the server's user: not for member accounts */
  if (who.role !== "admin") return Response.json({ error: "Your account can't use this." }, { status: 403 });
  return null;
}

/** Ends a stream the moment its reader loses access, so a share revoked mid-conversation stops at once. */
export function whileAllowed(res: Response, allowed: () => boolean, everyMs = 2000): Response {
  if (!res.body) return res;
  const reader = res.body.getReader();
  let timer: ReturnType<typeof setInterval>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (allowed()) return;
        clearInterval(timer);
        void reader.cancel();
        try {
          controller.close();
        } catch {
          /* already closed by the reader finishing */
        }
      }, everyMs);
    },
    async pull(controller) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) {
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* closed by the access check */
        }
      } else controller.enqueue(value);
    },
    cancel() {
      clearInterval(timer);
      return reader.cancel();
    },
  });
  return new Response(body, { status: res.status, headers: res.headers });
}
