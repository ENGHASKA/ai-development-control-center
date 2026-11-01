"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Menu, NavArrowDown } from "iconoir-react";
import { AGENT_LABEL, type AgentId, type PermissionMode, type SessionSummary } from "@/lib/types";
import { api, ApiError, timeAgo } from "@/lib/client/api";
import { profileModels, useAgentModels, profilesFor, useProfiles } from "@/lib/client/useProfiles";
import { newClientId } from "@/lib/client/send";
import { openServerTerminal } from "@/lib/client/terminals";
import { saveEffort } from "@/lib/client/storage";
import { useProjectDefaults } from "@/lib/client/useProjectDefaults";
import { ProjectDefaultsNote } from "./ProjectDefaultsNote";
import { Composer, MODELS, type AgentOption } from "./Composer";
import { FolderPicker } from "./lazy";
import { Pulse } from "./Pulse";
import { isBusy } from "./SessionList";
import { reducedMotion } from "@/lib/client/motion";
import { type ExecutionAgent, type ExecutionMode } from "@/lib/agent-capabilities";
import { KIND_LABEL, pathInPrompt } from "@/lib/workspace";
import { useAgentsInfo, useAutoAvailability, useWorkspace } from "@/lib/client/useWorkspace";
import { Segmented } from "../atoms/Segmented";
import { BackgroundTaskForm } from "./BackgroundTaskForm";
import { ProjectKindIcon, ProjectPicker } from "./ProjectPicker";
import { ResumePanel } from "./ResumePanel";

/* The new-session screen: one question, one composer, and a few quiet rows
 * for picking up where you left off. Staggered blur-up reveal on entry. */
const REVEAL = { offsetY: 16, blur: 12, duration: 700, easing: "cubic-bezier(0.16, 1, 0.3, 1)" };
const reveal = (visible: boolean): CSSProperties => ({
  opacity: visible ? 1 : 0,
  transform: visible ? "translate3d(0,0,0)" : `translate3d(0,${REVEAL.offsetY}px,0)`,
  filter: visible ? "blur(0px)" : `blur(${REVEAL.blur}px)`,
  transition: ["opacity", "transform", "filter"].map((p) => `${p} ${REVEAL.duration}ms ${REVEAL.easing}`).join(", "),
});

/* Claude and Codex ask before acting; other agents' print modes can't, so they run unattended */
const defaultMode = (a: AgentId): PermissionMode => (a === "claude" || a === "codex" ? "default" : "bypassPermissions");

const SIGN_IN_HELP: Partial<Record<AgentId, string>> = {
  claude: "Claude isn't signed in on the server. Run `claude auth login` over SSH.",
  codex: "Codex isn't signed in on the server. Run `codex login` over SSH.",
};

const noAgents: AgentOption[] = [];

const isLive = (s: SessionSummary) => Boolean(s.terminal) || (s.web !== null && s.web.status !== "closed");

export function NewSession({
  sessions,
  onMenu,
  onOpen,
  extra,
}: {
  sessions: SessionSummary[] | null;
  onMenu: () => void;
  onOpen: (id: string) => void;
  /** trailing header control (the phone tab switcher) */
  extra?: ReactNode;
}) {
  const [stage, setStage] = useState(0);
  const [cwd, setCwd] = useState("");
  const [mode, setMode] = useState<PermissionMode>("default");
  const [model, setModel] = useState("");
  /* "" for the default (the profile's, else the agent's own) */
  const [effort, setEffort] = useState("");
  const [agent, setAgent] = useState<AgentId>("claude");
  const [picker, setPicker] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [execution, setExecution] = useState<ExecutionMode>("interactive");
  /* the task form, for work with its own test command and worktree. Reached from Tasks, not part of a normal conversation */
  const [taskForm, setTaskForm] = useState(false);
  const { workspace, error: workspaceError, refresh: refreshWorkspace } = useWorkspace();
  const agentsInfo = useAgentsInfo();
  const auto = useAutoAvailability();
  const [autoMode, setAutoMode] = useState(false);
  const [flow, setFlow] = useState<"new" | "resume">("new");
  const [error, setError] = useState<string | null>(null);
  const [folderInvalid, setFolderInvalid] = useState(false);
  const [profile, setProfile] = useState<string>("claude");
  const [launching, setLaunching] = useState(false);
  const { profiles } = useProfiles();
  const [now, setNow] = useState(0);
  /* once the user picks a folder, never refill it behind their back */
  const touched = useRef(false);

  useEffect(() => {
    const saved = localStorage.getItem("cui:newAgent") as AgentId | null;
    if (saved && saved in AGENT_LABEL) {
      setAgent(saved);
      setMode(defaultMode(saved));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* the saved agent was uninstalled: fall back to Claude */
  useEffect(() => {
    const saved = localStorage.getItem("cui:newAgent");
    if (agentsInfo && saved && saved !== "claude" && !agentsInfo.some((a) => a.id === saved && a.installed)) pickAgent("claude");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentsInfo]);

  /* the profile last used for each agent */
  useEffect(() => {
    const saved = localStorage.getItem(`cui:newProfile:${agent}`);
    const list = profilesFor(profiles, agent);
    setProfile(saved && list.some((p) => p.id === saved && p.installed) ? saved : agent);
  }, [agent, profiles]);
  const pickProfile = (id: string) => {
    /* the folder's project may have put another agent's profile on screen */
    const a = profiles?.find((p) => p.id === id)?.agent ?? agent;
    if (a !== agent) pickAgent(a);
    setProfile(id);
    setModel("");
    localStorage.setItem(`cui:newProfile:${a}`, id);
  };
  /* the folder's project defaults (Settings > Projects) under what's picked here */
  const d = useProjectDefaults({ cwd: cwd.trim(), current: { agent, profile, model, mode, effort }, profiles });
  const profileInfo = profiles?.find((p) => p.id === d.profile);
  const sentEffort = d.sentEffort;
  const agentModels = useAgentModels(d.agent, d.profile);

  const pickAgent = (a: AgentId) => {
    setAgent(a);
    setModel("");
    setEffort("");
    setMode(defaultMode(a));
    localStorage.setItem("cui:newAgent", a);
  };
  const name = AGENT_LABEL[d.agent];
  const folderName = cwd.trim().replace(/\/+$/, "").split("/").pop() || "";

  useEffect(() => {
    setNow(Date.now());
    const asked = new URLSearchParams(window.location.search).get("mode");
    if (asked === "background" || asked === "auto") setExecution("background");
    if (asked === "background") setTaskForm(true);
    if (asked === "auto") setAutoMode(true);
    if (asked === "resume") setFlow("resume");
    /* reduced motion: show everything at once, no blur-up */
    if (reducedMotion()) {
      setStage(3);
      return;
    }
    const timers = [120, 260, 420].map((t, i) => setTimeout(() => setStage(i + 1), t));
    return () => timers.forEach(clearTimeout);
  }, []);

  /* prefill once: the last folder if it's still usable, else the most recent project. Folders outside the workspace
   * never get here, so a first session can't start somewhere the server would refuse. */
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || touched.current || !workspace) return;
    prefilled.current = true;
    const usable = workspace.entries.filter((e) => e.kind !== "missing");
    const last = localStorage.getItem("cui:lastCwd");
    setCwd(usable.find((e) => e.path === last)?.path ?? usable[0]?.path ?? "");
  }, [workspace]);

  const chooseFolder = (p: string) => {
    touched.current = true;
    setCwd(p);
    setFolderInvalid(false);
    setError(null);
    localStorage.setItem("cui:lastCwd", p);
  };

  /* live sessions first, then the most recent ones */
  const all = sessions ?? [];
  const rows = [...all.filter(isLive), ...all.filter((s) => !isLive(s))].slice(0, 3);

  const { worktree, setWorktree } = d;
  const listed = workspace?.entries.find((e) => e.path === cwd.trim()) ?? null;
  /* the list only carries Git details for the first folders, so the chosen one is asked for its own */
  const [details, setDetails] = useState<{ path: string; branch: string | null; changes: number | null; tracked: number | null } | null>(null);
  useEffect(() => {
    if (!listed || listed.tracked !== null || (listed.kind !== "git" && listed.kind !== "worktree")) return;
    let on = true;
    api<{ allowed: boolean; branch: string | null; changes: number | null; tracked: number | null }>(`/api/workspace?check=${encodeURIComponent(listed.path)}`)
      .then((d) => on && d.allowed && setDetails({ path: listed.path, branch: d.branch, changes: d.changes, tracked: d.tracked }))
      .catch(() => undefined);
    return () => {
      on = false;
    };
  }, [listed]);
  const project = listed && details?.path === listed.path ? { ...listed, branch: details.branch, changes: details.changes, tracked: details.tracked } : listed;
  const signedOut = agentsInfo?.find((a) => a.id === d.agent)?.signIn === "signed-out" ? SIGN_IN_HELP[d.agent] : null;
  const choices = [
    ...(["claude", "codex"] as const).map((a) => {
      const missing = agentsInfo?.find((x) => x.id === a)?.installed === false;
      return { value: a, label: AGENT_LABEL[a], disabled: missing, title: missing ? `${AGENT_LABEL[a]} isn't installed on the server.` : undefined };
    }),
    { value: "auto" as const, label: "Auto", disabled: auto?.available === false, title: auto?.reason },
  ];
  /* a project or other profile can put another agent on screen; the choice then shows none of the three as picked */
  const agentChoice: ExecutionAgent = autoMode ? "auto" : d.agent === "claude" || d.agent === "codex" ? d.agent : "claude";
  const chooseAgent = (a: ExecutionAgent) => {
    setAutoMode(a === "auto");
    setExecution(a === "auto" || taskForm ? "background" : "interactive");
    if (a !== "auto") (d.pick("profile"), pickAgent(a));
  };

  /* "open the project at /srv/app and..." names where to work. The server decides whether that's allowed. */
  const projectFromPrompt = async (text: string) => {
    const named = pathInPrompt(text);
    if (!named || named === cwd.trim()) return cwd.trim();
    const found = await api<{ allowed: boolean; path?: string; reason?: string }>(`/api/workspace?check=${encodeURIComponent(named)}`);
    if (!found.allowed || !found.path) {
      setError(found.reason ?? `Can't use ${named}.`);
      return null;
    }
    chooseFolder(found.path);
    return found.path;
  };

  const pickProject = (p: string) => {
    chooseFolder(p);
    setChoosing(false);
  };
  /* picking a folder from the browser adds it to the project list */
  const addFolder = async (p: string) => {
    try {
      await api("/api/workspace", { action: "register", path: p });
      await refreshWorkspace();
      chooseFolder(p);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that folder.");
    }
  };

  const start = async (text: string) => {
    setError(null);
    const target = await projectFromPrompt(text).catch(() => null);
    if (target === null) return false;
    if (!target) {
      setFolderInvalid(true);
      setError("Choose a project.");
      setChoosing(true);
      return false;
    }
    try {
      const { id } = await api<{ id: string }>("/api/sessions", { agent: d.agent, profile: d.profile, cwd: target, text, model: d.model || undefined, effort: sentEffort, permissionMode: d.mode, worktree, clientId: newClientId() });
      localStorage.setItem("cui:lastCwd", target);
      saveEffort(id, d.effort);
      onOpen(id);
      return true;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Couldn't start the session.";
      if (/^(Folder not found|Choose a folder)/.test(msg)) setFolderInvalid(true);
      setError(msg);
      /* the TUI is up but stuck on a question at startup: show it */
      if (err instanceof ApiError && err.terminal) openServerTerminal({ id: err.terminal, backing: "tmux" }, `${name} in ${cwd.trim().split("/").pop()}`);
      return false;
    }
  };

  /* the agent's own TUI in a terminal the server keeps, for work that needs it */
  const startInTerminal = async () => {
    setError(null);
    if (!cwd.trim()) {
      setFolderInvalid(true);
      setError("Choose a project.");
      setChoosing(true);
      return;
    }
    setLaunching(true);
    try {
      const t = await api<{ id: string; backing: string; label: string }>("/api/terminals", { profile: d.profile, cwd: cwd.trim(), model: d.model || undefined, effort: sentEffort });
      localStorage.setItem("cui:lastCwd", cwd.trim());
      openServerTerminal(t, `${t.label} in ${cwd.trim().split("/").pop()}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't open the terminal.");
    } finally {
      setLaunching(false);
    }
  };

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="safe-top flex shrink-0 items-center px-[max(0.375rem,env(safe-area-inset-left))] lg:hidden">
        <div className="flex h-14 w-full items-center gap-1 pr-[max(0.375rem,env(safe-area-inset-right))]">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="flex size-10 items-center justify-center rounded-[10px] text-ink-2 hover:bg-hover hover:text-ink">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
          <span className="min-w-0 flex-1 truncate px-1 text-base font-semibold tracking-[-0.01em] text-ink">New session</span>
          {extra}
        </div>
      </header>

      <div className="safe-x safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full max-w-(--thread-w) flex-col px-3 pb-3 sm:justify-center sm:px-8 sm:pt-8 sm:pb-[14vh]">
          {/* phones: the question sits in the middle, the composer at the bottom (where the reply composer lives) */}
          <div className="order-1 flex flex-1 flex-col justify-center py-8 sm:flex-none sm:py-0">
            <h1 className="home-reveal text-center text-[24px] leading-8 font-medium tracking-[-0.025em] text-balance text-ink sm:text-[30px] sm:leading-10" style={reveal(stage >= 1)}>
              {folderName ? (
                <>
                  What&apos;s next in <span translate="no">{project?.name ?? folderName}</span>?
                </>
              ) : (
                "What should we work on?"
              )}
            </h1>
          </div>

          <div className="home-reveal relative z-10 order-3 flex flex-col gap-2.5 sm:order-2 sm:mt-7" style={reveal(stage >= 2)}>
            <div className="flex flex-col gap-2 px-1">
              <button
                type="button"
                onClick={() => setChoosing(true)}
                aria-haspopup="dialog"
                aria-invalid={folderInvalid || undefined}
                aria-label={project ? `Project: ${project.name}, ${KIND_LABEL[project.kind]}. Change project` : "Choose a project"}
                data-testid="project-button"
                className={`flex min-h-12 w-full min-w-0 items-center gap-3 rounded-xl bg-surface px-3 py-1.5 text-left shadow-btn transition-colors duration-150 hover:bg-hover ${folderInvalid ? "outline-2 outline-red-ink" : ""}`}
              >
                {project ? <ProjectKindIcon kind={project.kind} /> : null}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-ink" translate="no">{project?.name ?? (cwd ? folderName : workspace ? "Choose a project" : "Loading projects…")}</span>
                  <span className="truncate text-xs text-ink-3" translate="no">
                    {project ? [KIND_LABEL[project.kind], project.branch].filter(Boolean).join(", ") : cwd ? "Not in the project list" : "Where the work happens"}
                  </span>
                </span>
                <NavArrowDown width={15} height={15} strokeWidth={2} aria-hidden className="shrink-0 text-ink-3" />
              </button>
              <Segmented
                label="New or existing conversation"
                value={flow}
                onChange={setFlow}
                options={[
                  { value: "new", label: "New session" },
                  { value: "resume", label: "Resume session" },
                ]}
              />
              {flow === "new" && <Segmented label="Agent" value={agentChoice} onChange={chooseAgent} options={choices} />}
              {flow === "new" && !autoMode && !taskForm && <p className="px-1 text-xs text-ink-3">Keeps running on the server after you close this page. Come back to it from any device.</p>}
              {flow === "new" && taskForm && <p className="px-1 text-xs text-ink-3">A background task with its own worktree and test command. <a href="/" className="inline-flex min-h-6 items-center underline underline-offset-2 hover:text-ink">Start a conversation instead</a></p>}
              {auto?.available === false && <p className="px-1 text-xs text-ink-3">{auto.reason}</p>}
              {flow === "new" && autoMode && <p className="px-1 text-xs text-ink-3">An agent plans the work, then Claude and Codex carry it out in the background. It all stops at your review.</p>}
              {signedOut && (
                <p role="alert" className="text-sm text-orange-ink">
                  {signedOut}
                </p>
              )}
              {workspaceError && (
                <p role="alert" className="text-sm text-red-ink">
                  {workspaceError}
                </p>
              )}
              {project?.kind === "missing" && (
                <p role="alert" className="text-sm text-orange-ink">
                  This folder was moved or deleted. Put it back, or choose another project.
                </p>
              )}
            </div>
            {flow === "resume" ? (
              <ResumePanel project={cwd.trim()} />
            ) : execution === "background" ? (
              <BackgroundTaskForm project={project} agent={agentChoice} onQueued={(where) => (where.startsWith("plan:") ? onOpen(where) : window.location.assign(where))} resolveProject={projectFromPrompt} />
            ) : (
            <>
            <Composer
              draftKey="new"
              placeholder={`Message ${name}…`}
              onSend={start}
              running={false}
              slashCommands={[]}
              mode={d.mode}
              onModeChange={(m) => (d.pick("mode"), setMode(m))}
              model={d.model || null}
              onModelChange={(m) => (d.pick("model"), setModel(m))}
              models={profileModels(profileInfo, d.agent === "claude" ? MODELS : agentModels)}
              cwd={d.agent === "claude" ? cwd.trim() || undefined : undefined}
              profiles={profiles ?? undefined}
              profile={d.profile}
              onProfileChange={(id) => (d.pick("profile"), pickProfile(id))}
              root={cwd.trim() || undefined}
              effort={d.effort}
              defaultEffort={profileInfo?.defaultEffort ?? null}
              onEffortChange={(e) => (d.pick("effort"), setEffort(e))}
              agents={agentsInfo ?? noAgents}
              agent={d.agent}
              onAgentChange={(a) => (d.pick("profile"), pickAgent(a))}
              onPickFolder={() => setChoosing(true)}
              busyLabel={`Starting ${name}…`}
              autoFocus
              context={
                <>
                <button
                  type="button"
                  aria-pressed={worktree}
                  onClick={() => setWorktree(!worktree)}
                  title="New branch in a separate folder"
                  className={`tap relative inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1 transition-colors duration-150 ${worktree ? "text-ink" : "text-ink-3 hover:text-ink"}`}
                >
                  <span aria-hidden className={`flex size-3.5 items-center justify-center rounded-[4px] border ${worktree ? "border-ink bg-ink text-surface" : "border-line-strong"}`}>
                    {worktree && <Check width={10} height={10} strokeWidth={3} />}
                  </span>
                  New worktree
                </button>
                {d.project && d.fromProject.length > 0 && <ProjectDefaultsNote project={d.project} fields={d.fromProject} />}
                </>
              }
              contextEnd={
                <button
                  type="button"
                  onClick={startInTerminal}
                  disabled={launching}
                  className="tap relative inline-flex h-6 shrink-0 items-center rounded-md px-1 text-ink-3 transition-colors duration-150 hover:text-ink disabled:opacity-60"
                >
                  {launching ? `Opening ${profileInfo?.label ?? name}…` : "Open in terminal"}
                </button>
              }
            />
            {error && (
              <p role="alert" className="px-4 pt-2.5 text-sm text-red-ink" style={{ animation: "fade-up 240ms cubic-bezier(0.23,1,0.32,1) both" }}>
                {error}
              </p>
            )}
            </>
            )}
          </div>

          {rows.length > 0 && (
            <nav aria-label="Recent sessions" className="home-reveal order-2 mb-3 sm:order-3 sm:mt-8 sm:mb-0" style={reveal(stage >= 3)}>
              <h2 className="px-4 pb-1.5 text-xs font-medium text-ink-3">Recent</h2>
              <ul className="flex flex-col">
                {rows.map((s) => {
                  const live = isLive(s);
                  const waiting = (s.web?.pending.length ?? 0) > 0;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(s.id)}
                        title={s.cwd ? `${s.title}\n${s.cwd}` : s.title}
                        className="group flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl px-4 text-left transition-colors duration-150 hover:bg-hover focus-visible:bg-hover sm:min-h-10"
                      >
                        {live && (
                          <span className="flex w-4 shrink-0 items-center justify-center" aria-hidden>
                            <Pulse busy={isBusy(s)} cellClass={waiting ? "bg-orange" : "bg-ink"} />
                          </span>
                        )}
                        <span className="flex min-w-0 flex-1 items-baseline gap-2">
                          <span className="min-w-0 truncate text-md text-ink-2 transition-colors duration-150 group-hover:text-ink">{s.title}</span>
                          <span className="hidden min-w-0 max-w-[40%] shrink-0 truncate text-sm text-ink-3 min-[420px]:inline" translate="no">
                            {[s.project, s.agent !== "claude" ? AGENT_LABEL[s.agent] : null].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-ink-3">
                          {waiting ? <span className="text-orange-ink">Needs you</span> : live ? "Open" : now ? timeAgo(s.mtime, now) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}
        </div>
      </div>

      {choosing && (
        <ProjectPicker
          workspace={workspace}
          value={cwd.trim()}
          onPick={pickProject}
          onBrowse={() => (setChoosing(false), setPicker(true))}
          onChanged={refreshWorkspace}
          onClose={() => setChoosing(false)}
        />
      )}
      <FolderPicker open={picker} value={cwd} recent={[]} onPick={(p) => void addFolder(p)} onClose={() => setPicker(false)} />
    </section>
  );
}
