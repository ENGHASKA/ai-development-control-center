import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ADMIN_ID, allows, effectiveLevel, legacyAccess, newAccess, nextAttempt, UNLOCK_MINUTES, type Attempts, type Level, type SessionAccess } from "@/lib/access-policy";
import { CONFIG_DIR } from "./profiles";

/* Accounts and per-session access, in private files beside the app's other settings. Everything is read fresh: the middleware
 * and route handlers are bundled apart, so a value kept in memory here wouldn't be the same value there. */

export type User = { id: string; name: string; role: "member"; hash: string; version: number };
type Store = { users: User[]; sessions: Record<string, SessionAccess>; grants: Record<string, { until: number; version: number }>; attempts: Record<string, Attempts> };

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, n: number, o: object) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const file = () => path.join(process.env.AGENT_U_HOME || CONFIG_DIR, "access.json");
const auditFile = () => path.join(process.env.AGENT_U_HOME || CONFIG_DIR, "access-audit.jsonl");
const empty = (): Store => ({ users: [], sessions: {}, grants: {}, attempts: {} });

function read(): Store {
  try {
    return { ...empty(), ...(JSON.parse(fs.readFileSync(file(), "utf8")) as Partial<Store>) };
  } catch {
    return empty();
  }
}

function write(s: Store) {
  const now = Date.now();
  for (const [k, g] of Object.entries(s.grants)) if (g.until < now) delete s.grants[k];
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  const tmp = `${file()}.${process.pid}.${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

export function audit(actor: string, action: string, detail: Record<string, unknown> = {}) {
  fs.mkdirSync(path.dirname(auditFile()), { recursive: true, mode: 0o700 });
  fs.appendFileSync(auditFile(), `${JSON.stringify({ at: new Date().toISOString(), actor, action, ...detail })}\n`, { mode: 0o600 });
}

async function hash(secret: string) {
  const salt = randomBytes(16);
  const key = await scrypt(secret, salt, 32, SCRYPT);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function matches(secret: string, stored: string | undefined) {
  /* an unset PIN or an unknown account takes as long as a wrong one */
  const [, salt, key] = (stored ?? "scrypt$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").split("$");
  const actual = await scrypt(secret, Buffer.from(salt, "base64url"), 32, SCRYPT);
  const want = Buffer.from(key, "base64url");
  return Boolean(stored) && want.length === actual.length && timingSafeEqual(actual, want);
}

/* ── accounts ─────────────────────────────────────────────── */

export const listUsers = () => read().users.map(({ id, name, role }) => ({ id, name, role }));
export const findUser = (id: string) => read().users.find((u) => u.id === id) ?? null;
export const userByName = (name: string) => read().users.find((u) => u.name === name.trim().toLowerCase()) ?? null;

export async function addUser(name: string, password: string) {
  const clean = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(clean) || clean === ADMIN_ID) throw new Error("Use 2 to 32 letters, numbers, dots, dashes or underscores.");
  if (password.length < 10) throw new Error("Use a password of at least 10 characters.");
  const s = read();
  if (s.users.some((u) => u.name === clean)) throw new Error("That name is taken.");
  const user: User = { id: randomBytes(8).toString("hex"), name: clean, role: "member", hash: await hash(password), version: 1 };
  s.users.push(user);
  write(s);
  audit(ADMIN_ID, "user-added", { user: clean });
  return user.id;
}

/** Removing an account ends its sign-ins at once, and its shares. Sessions it owned stay, held by nobody but the admin. */
export function removeUser(id: string) {
  const s = read();
  s.users = s.users.filter((u) => u.id !== id);
  for (const a of Object.values(s.sessions)) {
    delete a.members[id];
    if (a.owner === id) a.owner = ADMIN_ID;
    a.version++;
  }
  write(s);
  audit(ADMIN_ID, "user-removed", { user: id });
}

/* ── session access ───────────────────────────────────────── */

export const accessOf = (key: string): SessionAccess => read().sessions[key] ?? legacyAccess();
const grantKey = (user: string, key: string) => `${user}|${key}`;

export function levelOf(userId: string, key: string): Level {
  const s = read();
  const a = s.sessions[key] ?? legacyAccess();
  const g = s.grants[grantKey(userId, key)];
  const level = effectiveLevel(userId, a, Boolean(g && g.until > Date.now() && g.version === a.version));
  return a.fullAccess && userId !== ADMIN_ID && allows(level, "interact") ? "view" : level;
}

/** Records whether a session now runs under Full access, so everyone but an administrator is held to viewing it. */
export function noteFullAccess(key: string, on: boolean) {
  const s = read();
  const a = s.sessions[key];
  if (Boolean(a?.fullAccess) === on) return;
  s.sessions[key] = { ...(a ?? legacyAccess()), fullAccess: on };
  write(s);
}

export const may = (userId: string, key: string, need: Level) => allows(levelOf(userId, key), need);

/** A new session belongs to whoever started it. A session already on record keeps its owner. */
export function claim(key: string, owner: string) {
  const s = read();
  if (s.sessions[key]) return;
  if (owner === ADMIN_ID) return;
  s.sessions[key] = newAccess(owner);
  write(s);
}

/** Sessions on record a member owns or could open, for the list. Locked ones show only that they exist. */
export const knownTo = (userId: string) => {
  const s = read();
  return new Set(Object.keys(s.sessions).filter((k) => levelOf(userId, k) !== "none"));
};

export async function update(key: string, actor: string, change: { mode?: SessionAccess["mode"]; pin?: string | null; pinLevel?: "view" | "interact"; member?: { id: string; level: "view" | "interact" | "manage" | null; trusted?: boolean } }) {
  const s = read();
  const a = s.sessions[key] ?? legacyAccess();
  if (change.mode) a.mode = change.mode;
  if (change.pinLevel) a.pinLevel = change.pinLevel;
  if (change.pin !== undefined) {
    if (change.pin) a.pinHash = await hash(change.pin);
    else delete a.pinHash;
  }
  if (change.member) {
    if (change.member.level === null) delete a.members[change.member.id];
    else a.members[change.member.id] = { level: change.member.level, trusted: change.member.trusted === true };
  }
  if ((a.mode === "pin" || a.mode === "pin_all" || a.mode === "trusted") && !a.pinHash) throw new Error("Set a PIN first.");
  a.version++;
  s.sessions[key] = a;
  write(s);
  audit(actor, "access-changed", { session: key, mode: a.mode, member: change.member?.id });
}

/** The way back from a forgotten PIN: only the admin, and it leaves the session private with the PIN gone. */
export function recover(key: string, actor: string) {
  const s = read();
  const a = s.sessions[key];
  if (!a) return;
  delete a.pinHash;
  a.mode = "private";
  a.version++;
  write(s);
  audit(actor, "pin-recovered", { session: key });
}

/* Tracked per person and per session, so neither many sessions nor many accounts make guessing cheap. */
export async function unlock(key: string, userId: string, source: string, pin: string): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const now = Date.now();
  const before = read();
  /* the shared counts stop many accounts or addresses guessing together, but mustn't let them lock an owner out of their own session */
  const owner = (before.sessions[key] ?? legacyAccess()).owner === userId;
  const buckets = [`u|${userId}|${key}`, ...(owner ? [] : [`s|${key}`, `ip|${source}`])];
  const wait = Math.max(0, ...buckets.map((b) => (before.attempts[b]?.until ?? 0) - now));
  if (wait > 0) return { ok: false, retryAfter: Math.ceil(wait / 1000) };
  const a = before.sessions[key] ?? legacyAccess();
  const right = await matches(pin, a.pinHash);
  const s = read();
  if (!right) {
    for (const b of buckets) s.attempts[b] = nextAttempt(s.attempts[b] ?? { fails: 0, until: 0 }, now);
    write(s);
    audit(userId, "unlock-failed", { session: key, source });
    return { ok: false, retryAfter: Math.ceil(Math.max(0, ...buckets.map((b) => s.attempts[b].until - now)) / 1000) };
  }
  delete s.attempts[buckets[0]];
  s.grants[grantKey(userId, key)] = { until: now + UNLOCK_MINUTES * 60_000, version: a.version };
  write(s);
  audit(userId, "unlocked", { session: key });
  return { ok: true };
}
