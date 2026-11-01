import { NextResponse, type NextRequest } from "next/server";
import { levelFor, memberMayCall, SESSION_ROUTE } from "@/lib/access-policy";
import { hostOk, sameOrigin, sessionDenied, whoIs } from "@/lib/guard";
import { readRespondToken, RESPOND_HEADER, RESPOND_PATH } from "@/lib/server/push-token";

const PUBLIC = ["/login", "/api/auth/login", "/manifest.webmanifest", "/icon.svg", "/apple-touch-icon.png", "/sw.js"];

/** One id for a session however a URL spells it, so an encoding can't reach a different access record. */
const canonicalKey = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const api = pathname.startsWith("/api/");

  if (!hostOk(req)) return new NextResponse("Unknown host.", { status: 421, headers: { "Content-Type": "text/plain" } });

  /* state-changing API calls must come from this origin (see lib/guard.ts) */
  if (api && req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  if (PUBLIC.includes(pathname)) return NextResponse.next();
  /* a notification's Allow or Deny: only this route, only a POST, only with a valid token (the route spends it) */
  if (pathname === RESPOND_PATH && req.method === "POST" && readRespondToken(req.headers.get(RESPOND_HEADER))) return NextResponse.next();
  const who = await whoIs(req);
  if (who?.role === "admin" || (who && !api)) {
    /* the admin's own sessions stay exactly as they were; only someone else's locked session is checked */
    const session = api ? SESSION_ROUTE.exec(pathname) : null;
    const denied = session ? sessionDenied(who, canonicalKey(session[1]), levelFor(session[2] ?? "", req.method)) : null;
    return denied ?? NextResponse.next();
  }
  if (who) {
    const session = SESSION_ROUTE.exec(pathname);
    if (session) return sessionDenied(who, canonicalKey(session[1]), levelFor(session[2] ?? "", req.method)) ?? NextResponse.next();
    if (memberMayCall(pathname, req.method)) return NextResponse.next();
    return NextResponse.json({ error: "Your account can't use this." }, { status: 403 });
  }

  if (api) return NextResponse.json({ error: "Sign in first" }, { status: 401 });
  return NextResponse.redirect(loginUrl(req));
}

/* Next can't send a relative Location from middleware (it parses it as a URL, and turns 127.0.0.1 into localhost),
 * so the redirect is built from the Host the browser used, which hostOk vetted; never from x-forwarded-host, which any
 * client can send. Behind the tunnel Host is the public name and x-forwarded-proto says https. */
function loginUrl(req: NextRequest) {
  const proto = req.headers.get("x-forwarded-proto") === "https" ? "https" : "http";
  try {
    return new URL("/login", `${proto}://${req.headers.get("host") ?? req.nextUrl.host}`);
  } catch {
    return new URL("/login", req.url);
  }
}

export const config = {
  runtime: "nodejs",
  /* /api/files/upload and /share run the same checks themselves (lib/guard.ts): middleware would buffer their bodies */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/files/upload|share$).*)"],
};
