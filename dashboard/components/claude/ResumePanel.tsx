"use client";

import { useEffect, useMemo, useState } from "react";
import { api, ApiError, shortPath, timeAgo } from "@/lib/client/api";
import { openServerTerminal } from "@/lib/client/terminals";
import { isSessionId } from "@/lib/workspace";
import { Segmented } from "../atoms/Segmented";
import { area, field, primaryBtn } from "./Sheet";

type Saved = { id: string; key: string; agent: "claude" | "codex"; title: string; cwd: string; mtime: number; open: boolean };
type Facts = { exists: boolean; cwd?: string | null; folder?: string; in_use?: boolean; approval?: string; interactive?: boolean; problem?: string };

const secondaryBtn = "tap relative inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-ink shadow-btn hover:bg-hover disabled:opacity-50";

/** Continue an existing conversation: found in a list or by its ID, checked by the server, never swapped for a new one. */
export function ResumePanel({ project }: { project: string }) {
  const [saved, setSaved] = useState<Saved[] | null>(null);
  const [agent, setAgent] = useState<"claude" | "codex">("codex");
  const [typed, setTyped] = useState("");
  const [picked, setPicked] = useState<Saved | null>(null);
  const [facts, setFacts] = useState<Facts | null>(null);
  const [checking, setChecking] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"terminal" | "background" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ sessions: Saved[] }>("/api/resume")
      .then((d) => setSaved(d.sessions))
      .catch(() => setSaved([]));
  }, []);

  const id = picked?.id ?? typed.trim();
  const who = picked?.agent ?? agent;
  const valid = isSessionId(id);

  useEffect(() => {
    setFacts(null);
    setError(null);
    if (!valid) return;
    let on = true;
    setChecking(true);
    api<Facts>(`/api/resume?agent=${who}&id=${id}`)
      .then((f) => on && setFacts(f))
      .catch((err) => on && setError(err instanceof ApiError ? err.message : "Couldn't check that session."))
      .finally(() => on && setChecking(false));
    return () => {
      on = false;
    };
  }, [id, who, valid]);

  const listed = useMemo(() => {
    const q = typed.trim().toLowerCase();
    const rows = (saved ?? []).filter((s) => s.agent === agent && (!q || isSessionId(q) || s.title.toLowerCase().includes(q) || s.id.startsWith(q)));
    return [...rows.filter((s) => s.cwd === project), ...rows.filter((s) => s.cwd !== project)].slice(0, 8);
  }, [saved, agent, typed, project]);

  const openTerminal = async () => {
    setBusy("terminal");
    setError(null);
    try {
      const key = who === "claude" ? id : `${who}:${id}`;
      const t = await api<{ id: string; backing: string; label: string }>("/api/terminals", { session: key });
      openServerTerminal(t, t.label);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open that session.");
    } finally {
      setBusy(null);
    }
  };

  const queue = async () => {
    setBusy("background");
    setError(null);
    try {
      const { id: task } = await api<{ id: string }>("/api/resume", { agent: who, session: id, prompt: prompt.trim() });
      window.location.assign(`/tasks?task=${task}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't resume that session.");
      setBusy(null);
    }
  };

  const usable = facts?.exists && !facts.problem;
  return (
    <div className="flex flex-col gap-3 rounded-[22px] bg-surface p-4">
      <Segmented
        label="Which agent's session"
        value={agent}
        onChange={(a) => (setAgent(a), setPicked(null))}
        options={[
          { value: "codex", label: "Codex" },
          { value: "claude", label: "Claude" },
        ]}
      />
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        Search or paste a session ID
        <input className={`${field} font-mono`} value={typed} onChange={(e) => (setTyped(e.target.value), setPicked(null))} autoComplete="off" autoCapitalize="off" spellCheck={false} aria-invalid={typed.trim().length === 36 && !valid ? true : undefined} />
      </label>
      {saved === null ? (
        <p role="status" className="text-sm text-ink-3">Loading saved sessions…</p>
      ) : listed.length > 0 && !valid ? (
        <ul aria-label="Saved sessions" className="flex flex-col">
          {listed.map((s) => (
            <li key={s.key}>
              <button type="button" onClick={() => setPicked(s)} className="flex min-h-12 w-full min-w-0 flex-col rounded-xl px-2 py-1.5 text-left hover:bg-hover">
                <span className="truncate text-md text-ink">{s.title || "Untitled conversation"}</span>
                <span className="truncate text-xs text-ink-3" translate="no">{shortPath(s.cwd)}, {timeAgo(s.mtime, Date.now())}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : !valid && saved.length > 0 ? (
        <p className="text-sm text-ink-3">No saved {agent} sessions match.</p>
      ) : null}

      {picked && <p className="text-sm break-words text-ink">{picked.title || "Untitled conversation"}</p>}
      {valid && <p className="font-mono text-xs break-all text-ink-3" translate="no">{id}</p>}
      {checking && <p role="status" className="text-sm text-ink-3">Checking this session…</p>}
      {facts?.folder && <p className="text-sm text-ink-2">Continues in <span className="font-mono text-xs" translate="no">{shortPath(facts.folder)}</span></p>}
      {facts?.problem && <p role="alert" className="text-sm break-words text-orange-ink">{facts.problem}</p>}
      {error && <p role="alert" className="text-sm break-words text-red-ink">{error}</p>}

      {usable && (
        <>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            What should it do next?
            <textarea className={`${area} min-h-24 resize-y`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <p className="text-sm text-ink-3">The same conversation continues, in place. While it runs, nothing else can work in this folder. Background turns can't ask questions; open a terminal to answer prompts live.</p>
        </>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" disabled={!(usable || facts?.interactive) || busy !== null} onClick={() => void openTerminal()} className={secondaryBtn}>
          {busy === "terminal" ? "Opening…" : "Open in terminal"}
        </button>
        <button type="button" disabled={!usable || !prompt.trim() || busy !== null} onClick={() => void queue()} className={primaryBtn}>
          {busy === "background" ? "Queuing…" : "Continue in background"}
        </button>
      </div>
    </div>
  );
}
