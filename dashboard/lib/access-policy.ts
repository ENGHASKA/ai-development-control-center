/* Who may do what with a session. Pure, so every rule is tested on its own and the same answer comes from every route. */

export type Level = "none" | "view" | "interact" | "manage";
export type AccessMode = "private" | "pin" | "trusted" | "pin_all";
export const ADMIN_ID = "admin";

export type SessionAccess = {
  owner: string;
  mode: AccessMode;
  /** what a correct PIN opens; a PIN never gives Manage */
  pinLevel: "view" | "interact";
  /** rises on any PIN or membership change, ending every unlock made before it */
  version: number;
  pinHash?: string;
  /** members, with what each may do; trusted ones skip the PIN in "trusted" mode */
  members: Record<string, { level: Exclude<Level, "none">; trusted?: boolean }>;
  /** running under Full access: only an administrator can drive it, whatever a PIN or grant says */
  fullAccess?: boolean;
};

export const RANK: Record<Level, number> = { none: 0, view: 1, interact: 2, manage: 3 };
export const allows = (have: Level, need: Level) => RANK[have] >= RANK[need];

/** Sessions from before accounts existed belong to the admin and stay private, so nothing is exposed by upgrading. */
export const legacyAccess = (): SessionAccess => ({ owner: ADMIN_ID, mode: "private", pinLevel: "view", version: 0, members: {} });
export const newAccess = (owner: string): SessionAccess => ({ owner, mode: "private", pinLevel: "view", version: 0, members: {} });

/** `unlocked`: this user holds a current unlock for this session. */
export function effectiveLevel(userId: string, a: SessionAccess, unlocked: boolean): Level {
  const owner = userId === a.owner;
  const member = a.members[userId];
  if (a.mode === "pin_all") {
    if (!unlocked) return "none";
    return owner ? "manage" : (member?.level ?? a.pinLevel);
  }
  if (owner) return "manage";
  if (a.mode === "private") return "none";
  if (a.mode === "trusted" && member?.trusted) return member.level;
  return unlocked ? (member?.level ?? a.pinLevel) : "none";
}

/** What a request needs, by route under /api/sessions/<id>. Anything unlisted needs Manage. */
export function levelFor(sub: string, method: string): Level {
  const read = method === "GET" || method === "HEAD";
  /* the event stream is also offered over POST, for proxies that buffer GET; it only ever reads */
  if (sub === "events") return "view";
  if (sub === "" || sub === "screen" || sub === "export") return read ? "view" : "manage";
  if (sub === "approval") return read ? "view" : "interact";
  if (sub === "message" || sub === "keys" || sub === "respond" || sub === "control") return "interact";
  return "manage";
}

const MEMBER_OPEN: [RegExp, string[]][] = [
  [/^\/api\/auth\//, ["GET", "POST"]],
  [/^\/api\/me$/, ["GET"]],
  [/^\/api\/access(\/|$)/, ["GET", "POST"]],
  [/^\/api\/sessions$/, ["GET", "POST"]],
  [/^\/api\/agents(\/models)?$/, ["GET"]],
  [/^\/api\/profiles$/, ["GET"]],
  [/^\/api\/settings$/, ["GET"]],
  [/^\/api\/commands$/, ["GET"]],
  [/^\/api\/workspace$/, ["GET"]],
];

/** Deny by default: a member reaches only what's named here, plus sessions the access check lets through. */
export const memberMayCall = (pathname: string, method: string) => MEMBER_OPEN.some(([re, methods]) => re.test(pathname) && methods.includes(method));

export const SESSION_ROUTE = /^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/;
const PIN = /^\d{4,6}$/;
export const validPin = (pin: unknown): pin is string => typeof pin === "string" && PIN.test(pin);

export type Attempts = { fails: number; until: number };
export const UNLOCK_MINUTES = 30;
const FREE_TRIES = 4;
const MAX_LOCK_MS = 60 * 60_000;

/** After a few tries each failure doubles the wait, up to an hour, so 4 to 6 digits can't be walked through. */
export function nextAttempt(a: Attempts, now: number): Attempts {
  const fails = a.fails + 1;
  return { fails, until: fails < FREE_TRIES ? 0 : now + Math.min(MAX_LOCK_MS, 30_000 * 2 ** (fails - FREE_TRIES)) };
}
