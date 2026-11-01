"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { NavArrowLeft } from "iconoir-react";
import { api, ApiError } from "@/lib/client/api";
import type { AccessMode } from "@/lib/access-policy";
import { Select } from "./Select";
import { field, primaryBtn } from "./Sheet";

type Member = { id: string; name: string; role: string };
type Sharing = { level: string; locked?: boolean; mode?: AccessMode; pinSet?: boolean; pinLevel?: "view" | "interact"; members?: Record<string, { level: string; trusted?: boolean }>; users?: Member[] };

const MODES: { value: AccessMode; label: string; hint: string }[] = [
  { value: "private", label: "Private", hint: "Only you" },
  { value: "pin", label: "PIN protected", hint: "Team members who enter the PIN" },
  { value: "trusted", label: "Trusted members", hint: "Trusted members skip the PIN, others enter it" },
  { value: "pin_all", label: "PIN for everyone", hint: "Everyone unlocks it, including you" },
];
const LEVELS = [
  { value: "view", label: "View only" },
  { value: "interact", label: "Interact" },
  { value: "manage", label: "Manage" },
];
const secondaryBtn = "tap relative inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium text-ink shadow-btn hover:bg-hover disabled:opacity-50";

/** Shown in place of a locked conversation. Nothing of the conversation has been loaded at this point. */
export function PinGate({ session, onUnlocked }: { session: string; onUnlocked: () => void }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm"><Unlock session={session} onDone={onUnlocked} /></div>
    </section>
  );
}

function Unlock({ session, onDone }: { session: string; onDone: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/access", { action: "unlock", session, pin });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't check the PIN.");
    }
    setPin("");
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        This conversation is locked. Enter its PIN
        <input className={field} type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value)} />
      </label>
      {error && <p role="alert" className="text-sm text-red-ink">{error}</p>}
      <div><button type="submit" disabled={pin.length < 4} className={primaryBtn}>Unlock</button></div>
    </form>
  );
}

function SessionSharing({ session }: { session: string }) {
  const [data, setData] = useState<Sharing | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<Sharing>(`/api/access?session=${encodeURIComponent(session)}`).then(setData).catch(() => setData({ level: "none" })), [session]);
  useEffect(() => void load(), [load]);
  const change = async (body: Record<string, unknown>) => {
    setError(null);
    try {
      await api("/api/access", { session, ...body });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through.");
    }
  };
  if (!data) return <p role="status" className="text-sm text-ink-3">Loading…</p>;
  if (data.locked) return <Unlock session={session} onDone={() => window.location.assign(`/?s=${encodeURIComponent(session)}`)} />;
  if (data.level !== "manage") return <p className="text-sm text-ink-2">{data.level === "none" ? "This conversation isn't available to you." : "You can use this conversation, but only its owner changes who else can."}</p>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        <span>Who can open it</span>
        <Select value={data.mode ?? "private"} label="Who can open it" options={MODES} onChange={(mode) => void change({ action: "set", mode })} />
      </div>
      <form
        className="flex flex-col gap-1.5 text-sm font-medium text-ink"
        onSubmit={(e) => {
          e.preventDefault();
          void change({ action: "set", pin }).then(() => setPin(""));
        }}
      >
        <label className="flex flex-col gap-1.5">
          {data.pinSet ? "Change the PIN" : "Set a PIN"}
          <input className={field} type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value)} />
        </label>
        <span className="font-normal text-ink-3">4 to 6 digits. Changing it ends every unlock.</span>
        <div><button type="submit" disabled={pin.length < 4} className={secondaryBtn}>Save PIN</button></div>
      </form>
      <div className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        <span>A correct PIN allows</span>
        <Select value={data.pinLevel ?? "view"} label="A correct PIN allows" options={LEVELS.slice(0, 2)} onChange={(pinLevel) => void change({ action: "set", pinLevel })} />
      </div>
      {!!data.users?.length && (
        <section aria-label="Members" className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-ink">Members</h2>
          <ul className="flex flex-col divide-y divide-line">
            {data.users.map((u) => {
              const m = data.members?.[u.id];
              return (
                <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-sm text-ink" translate="no">{u.name}</span>
                  <span className="flex items-center gap-2">
                    <Select className="w-32" value={m?.level ?? "view"} label={`What ${u.name} can do`} options={LEVELS} onChange={(level) => void change({ action: "member", user: u.id, level, trusted: m?.trusted ?? false })} />
                    {m && (
                      <label className="flex min-h-11 items-center gap-1.5 text-sm text-ink-2">
                        <input type="checkbox" className="size-4 accent-(--accent)" checked={Boolean(m.trusted)} onChange={(e) => void change({ action: "member", user: u.id, level: m.level, trusted: e.target.checked })} />
                        Trusted
                      </label>
                    )}
                    {m && <button type="button" onClick={() => void change({ action: "member", user: u.id, level: null })} className={secondaryBtn}>Remove</button>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {error && <p role="alert" className="text-sm text-red-ink">{error}</p>}
    </div>
  );
}

type Agent = { id: string; name: string; tools: string[]; approvals: string; sandbox: string; models: string; available: boolean; unavailable_reason: string | null; record: { finished: number; failed: number } };

function Accounts() {
  const [users, setUsers] = useState<Member[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ users: Member[]; agents: Agent[] }>("/api/access").then((d) => (setUsers(d.users), setAgents(d.agents))).catch(() => setUsers([])), []);
  useEffect(() => void load(), [load]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/access", { action: "add-user", name, password });
      setName("");
      setPassword("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that account.");
    }
  };
  return (
    <section aria-label="Accounts" className="flex flex-col gap-3">
      <h2 className="text-base font-medium text-ink">Team accounts</h2>
      <p className="max-w-prose text-sm text-ink-2">Members use conversations they own or are given. They get no shell, files, tasks or settings. Agents still run as this server's one Unix user, so give accounts only to people you trust with that.</p>
      <ul className="flex flex-col divide-y divide-line">
        {users?.map((u) => (
          <li key={u.id} className="flex items-center justify-between gap-2 py-2">
            <span className="text-sm text-ink" translate="no">{u.name}</span>
            <button type="button" onClick={() => void api("/api/access", { action: "remove-user", user: u.id }).then(load)} className={secondaryBtn}>Remove</button>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void add(e)} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input className={field} aria-label="New member's name" placeholder="Name" autoComplete="off" autoCapitalize="off" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={field} aria-label="New member's password" placeholder="Password, 10 or more characters" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" disabled={!name || password.length < 10} className={primaryBtn}>Add account</button>
      </form>
      {error && <p role="alert" className="text-sm text-red-ink">{error}</p>}
      {agents.length > 0 && (
        <>
          <h2 className="pt-4 text-base font-medium text-ink">Agents</h2>
          <ul className="flex flex-col divide-y divide-line">
            {agents.map((a) => (
              <li key={a.id} className="flex flex-col gap-0.5 py-2 text-sm">
                <span className="font-medium text-ink">{a.name}: {a.available ? "available" : a.unavailable_reason}</span>
                <span className="text-ink-2">Can use: {a.tools.join(", ")}. {a.sandbox}.</span>
                <span className="text-ink-3">Approvals: {a.approvals}.</span>
                <span className="text-ink-3">Models: {a.models}. Tasks finished: {a.record.finished}, failed: {a.record.failed}.</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Accounts for the admin, and locking or sharing one conversation (`?session=`). */
/** The server-wide switch for Full access. Off is the default, and turning it on takes an explicit acknowledgment. */
function FullAccessPolicy() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ enabled: boolean }>("/api/full-access").then((d) => setEnabled(d.enabled)).catch(() => setError("Couldn't read the Full access policy."));
  }, []);
  const change = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const d = await api<{ enabled: boolean }>("/api/full-access", { enabled: next, acknowledged: next && understood });
      setEnabled(d.enabled);
      setUnderstood(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the policy.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section id="full-access" aria-labelledby="full-access-title" className="flex scroll-mt-4 flex-col gap-2.5 rounded-2xl bg-surface p-4 shadow-btn">
      <h2 id="full-access-title" className="font-medium">Full access: {enabled === null ? "checking" : enabled ? "on" : "off"}</h2>
      <p className="text-sm text-ink-2">Lets an administrator run Claude or Codex with no prompts and no agent sandbox. Team members never get it, and a PIN doesn't grant it.</p>
      <ul className="list-disc pl-5 text-sm text-ink-2">
        <li>The agent runs as this server's account and isn't limited to its project. It can change or delete anything that account can reach, including other projects.</li>
        <li>It doesn't give root, and sign-in stays in force.</li>
        <li>Each session still needs Full access chosen for it. Turning this off doesn't stop sessions already running; restart them.</li>
      </ul>
      {error && <p role="alert" className="text-sm text-red-ink">{error}</p>}
      {enabled === false && (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          I understand the agent can reach everything this account can.
        </label>
      )}
      {enabled !== null && (
        <button type="button" disabled={busy || (!enabled && !understood)} onClick={() => void change(!enabled)} className="tap relative inline-flex h-10 w-fit items-center rounded-full px-4 text-sm font-medium shadow-btn hover:bg-hover disabled:opacity-50">
          {enabled ? "Turn off Full access" : "Turn on Full access"}
        </button>
      )}
    </section>
  );
}

export function TeamScreen() {
  const [who, setWho] = useState<{ role: string } | null>(null);
  const [session, setSession] = useState<string | null>(null);
  useEffect(() => {
    setSession(new URLSearchParams(window.location.search).get("session"));
    api<{ role: string } | null>("/api/me").then(setWho).catch(() => undefined);
  }, []);
  return (
    <main className="min-h-dvh bg-page text-ink">
      <div className="safe-top safe-x"><div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pt-3 pb-10 sm:px-8 sm:pt-6">
        <a href="/" className="tap relative -ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-sm text-ink-2 hover:text-ink">
          <NavArrowLeft width={16} height={16} strokeWidth={2} aria-hidden />
          Sessions
        </a>
        <h1 className="text-[26px] leading-8 font-semibold tracking-[-0.02em]">{session ? "Share this conversation" : "Team and sharing"}</h1>
        {session ? <SessionSharing session={session} /> : who?.role === "admin" ? <><FullAccessPolicy /><Accounts /></> : <p className="text-sm text-ink-2">Open a conversation to see who can use it.</p>}
      </div></div>
    </main>
  );
}
