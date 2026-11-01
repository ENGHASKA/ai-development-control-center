"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Folder, GitBranch, GitFork, Plus, Search, WarningTriangle } from "iconoir-react";
import { api, ApiError, shortPath } from "@/lib/client/api";
import { KIND_LABEL, type Workspace, type WorkspaceEntry } from "@/lib/workspace";
import { field, primaryBtn, Sheet } from "./Sheet";

const KIND_ICON = { git: GitBranch, worktree: GitFork, folder: Folder, missing: WarningTriangle };

export const ProjectKindIcon = ({ kind, size = 16 }: { kind: WorkspaceEntry["kind"]; size?: number }) => {
  const Icon = KIND_ICON[kind];
  return <Icon width={size} height={size} strokeWidth={1.8} aria-hidden className={`shrink-0 ${kind === "missing" ? "text-orange-ink" : "text-ink-3"}`} />;
};

function Row({ entry, active, onPick, onForget }: { entry: WorkspaceEntry; active: boolean; onPick: () => void; onForget: () => void }) {
  const gone = entry.kind === "missing";
  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        onClick={onPick}
        disabled={gone}
        aria-current={active ? "true" : undefined}
        className={`flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-100 ${active ? "bg-hover" : "enabled:hover:bg-hover"} disabled:cursor-not-allowed`}
      >
        <ProjectKindIcon kind={entry.kind} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-md font-medium text-ink" translate="no">{entry.name}</span>
          <span className="truncate text-xs text-ink-3" translate="no">{shortPath(entry.path)}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end text-xs text-ink-3">
          <span className={gone ? "text-orange-ink" : ""}>{KIND_LABEL[entry.kind]}</span>
          {entry.branch && <span className="max-w-32 truncate" translate="no">{entry.branch}</span>}
          {!!entry.changes && <span>{entry.changes === 1 ? "1 changed file" : `${entry.changes} changed files`}</span>}
        </span>
      </button>
      {gone && entry.registered && (
        <button type="button" onClick={onForget} className="tap relative shrink-0 rounded-lg px-2 py-1 text-xs text-ink-2 hover:bg-hover hover:text-ink">
          Remove
        </button>
      )}
    </li>
  );
}

/** Choosing where work happens: the workspace's projects first, then ways to add one. Only folders the server allows are listed. */
export function ProjectPicker({
  workspace,
  value,
  onPick,
  onBrowse,
  onChanged,
  onClose,
}: {
  workspace: Workspace | null;
  value: string;
  onPick: (path: string) => void;
  onBrowse: () => void;
  onChanged: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [git, setGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (workspace?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q));
  }, [workspace, query]);
  const recent = query ? [] : entries.filter((e) => e.lastUsed).slice(0, 5);
  const rest = entries.filter((e) => !recent.includes(e));

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { path } = await api<{ path: string }>("/api/workspace", { action: "create", name: name.trim(), git });
      await onChanged();
      onPick(path);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create the project.");
    } finally {
      setBusy(false);
    }
  };

  const forget = async (path: string) => {
    setError(null);
    try {
      await api("/api/workspace", { action: "forget", path });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove the project.");
    }
  };

  const row = (e: WorkspaceEntry) => <Row key={e.path} entry={e} active={e.path === value} onPick={() => onPick(e.path)} onForget={() => void forget(e.path)} />;

  return (
    <Sheet
      title="Choose a project"
      onClose={onClose}
      wide
      footer={
        !creating && (
          <>
            <button type="button" onClick={onBrowse} className="tap relative inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium text-ink shadow-btn hover:bg-hover">
              Add existing folder
            </button>
            <button type="button" onClick={() => setCreating(true)} className={`${primaryBtn} gap-1.5`}>
              <Plus width={15} height={15} strokeWidth={2} aria-hidden />
              New project
            </button>
          </>
        )
      }
    >
      {creating ? (
        <form onSubmit={(e) => void create(e)} className="flex flex-col gap-3 pt-1">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Project name
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" spellCheck={false} aria-invalid={error ? true : undefined} aria-describedby="project-name-help" />
          </label>
          <p id="project-name-help" className="text-sm text-ink-3" translate="no">{workspace ? `${shortPath(workspace.projectsDir)}/${name.trim() || "name"}` : ""}</p>
          <label className="flex min-h-11 items-center gap-2.5 text-sm text-ink">
            <input type="checkbox" className="size-4 accent-(--accent)" checked={git} onChange={(e) => setGit(e.target.checked)} />
            Start a Git repository (background tasks and worktrees need one)
          </label>
          {error && <p role="alert" className="text-sm text-red-ink">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => (setCreating(false), setError(null))} className="tap relative inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium text-ink hover:bg-hover">
              Back
            </button>
            <button type="submit" disabled={busy || !name.trim()} className={primaryBtn}>
              {busy ? "Creating…" : "Create project"}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="relative block">
            <span className="sr-only">Filter projects</span>
            <Search width={15} height={15} strokeWidth={1.9} aria-hidden className="absolute top-1/2 left-3 -translate-y-1/2 text-ink-3" />
            <input className={`${field} pl-9`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter projects" type="search" autoComplete="off" />
          </label>
          {error && <p role="alert" className="text-sm text-red-ink">{error}</p>}
          {!workspace ? (
            <p className="py-6 text-center text-sm text-ink-3" role="status">Loading projects…</p>
          ) : !entries.length ? (
            <p className="py-6 text-center text-sm text-ink-3">{query ? "No projects match." : "No projects yet. Create one to get started."}</p>
          ) : (
            <>
              {recent.length > 0 && (
                <section aria-label="Recent projects">
                  <h3 className="px-3 pb-1 text-xs font-medium text-ink-3">Recent</h3>
                  <ul className="flex flex-col">{recent.map(row)}</ul>
                </section>
              )}
              {rest.length > 0 && (
                <section aria-label="All projects">
                  {recent.length > 0 && <h3 className="px-3 pb-1 text-xs font-medium text-ink-3">All projects</h3>}
                  <ul className="flex flex-col">{rest.map(row)}</ul>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
