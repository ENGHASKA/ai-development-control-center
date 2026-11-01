"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Clock, NavArrowLeft, Pause, Play, Plus, Refresh, WarningTriangle, Xmark } from "iconoir-react";
import { api, ApiError, shortPath } from "@/lib/client/api";
import { acceptsMessages, formatElapsed, GROUP_LABEL, GROUP_OF, messageWaits, STATE_LABEL, taskActions, taskErrorText, testResult, type TaskGroup, type TaskState } from "@/lib/tasks";
import { PLAN_LABEL, stepsDone, type Plan } from "@/lib/plans";
import { PlanDetail, planTone } from "./PlanDetail";
import { area, primaryBtn, Sheet } from "./Sheet";

type Task = { id: string; owner: string; title: string; state: TaskState; phase: string; elapsed: number; heartbeat: number | null; error: string | null; attempts: number; test_exit: number | null; commits: string[]; worktree: string; unit: string | null; repo?: string; branch?: string; base?: string; in_place?: boolean; resumed?: boolean; session_id?: string | null; pending_inputs?: number };
type TaskHistory = { inputs: { seq: number; text: string; state: string; at: number }[]; audit: { seq: number; action: string; actor: string; detail: string; at: number }[] };
type Health = { agents?: Record<string, { logged_in: boolean | null; checked_at: number }>; disk_free_gib?: number; memory_kib?: { MemAvailable: number }; services?: Record<string, string>; warnings?: string[] };
type Snapshot = { server_time: number; tasks: Task[]; plans?: Plan[]; provider_blocks?: Record<string, string>; health: Health };
type Log = { name: string; text: string };

const POLL_MS = 2000;
const STATE_ICON: Record<TaskState, typeof Check> = { waiting_input: Clock, waiting_approval: WarningTriangle, queued: Clock, running: Play, retrying: Refresh, paused: Pause, blocked: WarningTriangle, failed: WarningTriangle, review: WarningTriangle, completed: Check, cancelled: Xmark };
const STATE_TONE: Record<TaskGroup, string> = { active: "text-accent-ink", queued: "text-ink-2", attention: "text-orange-ink", done: "text-ink-3" };
const ACTION_LABEL = { pause: "Pause", cancel: "Cancel", resume: "Resume from checkpoint", retry: "Retry" };
const secondaryBtn = "tap relative inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium text-ink shadow-btn hover:bg-hover disabled:opacity-50";
const AGENT_NAME: Record<string, string> = { claude: "Claude", codex: "Codex", demo: "Fixture" };

function StateBadge({ state, phase }: { state: TaskState; phase?: string }) {
  const Icon = STATE_ICON[state];
  const showPhase = phase && phase !== state && !["completed", "cancelled", "queued"].includes(state);
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${STATE_TONE[GROUP_OF[state]]}`}>
      <Icon width={14} height={14} strokeWidth={2} aria-hidden className="shrink-0" />
      {STATE_LABEL[state]}
      {showPhase && <span className="font-normal text-ink-3">, {phase}</span>}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

function TaskDetail({ task, serverTime, onAction, onClose }: { task: Task; serverTime: number; onAction: (action: string, id: string, extra?: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [logError, setLogError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [record, setRecord] = useState<TaskHistory | null>(null);
  const live = GROUP_OF[task.state] === "active";

  useEffect(() => {
    let on = true;
    api<TaskHistory>(`/api/tasks?id=${task.id}&history=1`)
      .then((h) => on && setRecord(h))
      .catch(() => undefined);
    return () => void (on = false);
  }, [task.id, task.state, task.pending_inputs]);

  const send = async () => {
    setBusy("followup");
    setSent(null);
    await onAction("followup", task.id, { text: message });
    setMessage("");
    setSent(messageWaits(task.state) ? "Sent. It goes in when the current turn ends." : "Sent.");
    setBusy(null);
  };

  const copyLogs = async () => {
    await navigator.clipboard.writeText((logs ?? []).map((l) => `# ${l.name}\n${l.text}`).join("\n\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    let on = true;
    const get = async () => {
      try {
        const next = await api<Log[]>(`/api/tasks?id=${task.id}`);
        if (on) (setLogs(next), setLogError(false));
      } catch {
        if (on) setLogError(true);
      }
    };
    void get();
    if (!live) return () => void (on = false);
    const t = setInterval(() => void get(), POLL_MS);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [task.id, live]);

  const run = async (action: string, extra?: Record<string, unknown>) => {
    setBusy(action);
    await onAction(action, task.id, extra);
    setBusy(null);
  };

  return (
    <Sheet title={task.title.split("\n")[0].slice(0, 70) || "Task"} onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        <StateBadge state={task.state} phase={task.phase} />
        {task.error && (
          <p role="alert" className="rounded-xl bg-orange-tint px-3 py-2 text-sm break-words text-orange-ink">
            {taskErrorText(task.error)}
          </p>
        )}
        {task.state === "review" && (
          <p className="rounded-xl bg-orange-tint px-3 py-2 text-sm text-orange-ink">
            Tests passed. Inspect the work, then approve or reject it. Approving runs the tests once more; it merges nothing.
          </p>
        )}
        {(task.state === "waiting_approval" || task.state === "review") && (
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy !== null} onClick={() => void run(task.state === "review" ? "approve" : "decide", task.state === "review" ? undefined : { verdict: "approve" })} className={primaryBtn}>
              {busy === "approve" || busy === "decide" ? "Working…" : "Approve"}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void run("decide", { verdict: "reject" })} className={secondaryBtn}>
              Reject
            </button>
          </div>
        )}
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Fact label="Agent">{AGENT_NAME[task.owner] ?? task.owner}</Fact>
          <Fact label="Test">{testResult(task.test_exit)}</Fact>
          <Fact label="Attempt">{task.attempts}</Fact>
          <Fact label="Time">{formatElapsed(task.elapsed)}</Fact>
          {task.branch && <Fact label="Started from"><span className="font-mono text-xs" translate="no">{task.branch} {task.base?.slice(0, 7)}</span></Fact>}
          {task.state === "running" && <Fact label="Last heartbeat">{task.heartbeat ? `${formatElapsed(serverTime - task.heartbeat)} ago` : "Waiting"}</Fact>}
          <div className="col-span-2 sm:col-span-4">
            {task.session_id && task.owner !== "demo" && (
              <div className="pb-3">
                <Fact label={task.resumed ? "Resumed session" : "Session"}>
                  <span className="font-mono text-xs break-all" translate="no">{task.session_id}</span>
                </Fact>
              </div>
            )}
            <Fact label={task.in_place ? "Working in place" : "Worktree"}>
              <span className="font-mono text-xs" translate="no">{shortPath(task.worktree)}</span>
            </Fact>
          </div>
        </dl>
        <section aria-label="Commits">
          <h3 className="pb-1 text-sm font-medium text-ink">Commits</h3>
          {task.commits?.length ? (
            <ul className="flex flex-col gap-0.5 font-mono text-xs break-words text-ink-2" translate="no">
              {task.commits.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-3">No commits yet.</p>
          )}
        </section>
        {taskActions(task.state).length > 0 && (
          <div className="flex flex-wrap gap-2">
            {taskActions(task.state).map((a) => (
              <button key={a} type="button" disabled={busy !== null} onClick={() => void run(a)} className="tap relative inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium text-ink shadow-btn hover:bg-hover disabled:opacity-50">
                {busy === a ? "Working…" : ACTION_LABEL[a]}
              </button>
            ))}
          </div>
        )}
        {acceptsMessages(task.state) && (task.owner === "claude" || task.owner === "codex") && (
          <section aria-label="Send a message" className="flex flex-col gap-2">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
              Send {AGENT_NAME[task.owner]} a message
              <textarea className={`${area} min-h-20 resize-y`} value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p role="status" className="min-w-0 flex-1 text-sm text-ink-3">{sent ?? (messageWaits(task.state) ? "Background turns take one message at a time, so this waits for the current turn to end." : "This continues the same conversation.")}</p>
              <span className="flex gap-2">
                {task.state === "waiting_input" && (
                  <button type="button" disabled={busy !== null} onClick={() => void run("close")} className={secondaryBtn}>
                    Finish
                  </button>
                )}
                <button type="button" disabled={busy !== null || !message.trim()} onClick={() => void send()} className={primaryBtn}>
                  {busy === "followup" ? "Sending…" : "Send"}
                </button>
              </span>
            </div>
            {record?.inputs.some((i) => i.state === "pending") && <p className="text-xs text-ink-3">{record.inputs.filter((i) => i.state === "pending").length} waiting to be delivered.</p>}
          </section>
        )}
        <section aria-label="Logs" className="flex min-w-0 flex-col gap-2">
          <span className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-ink">Latest output</h3>
            {!!logs?.length && (
              <button type="button" onClick={() => void copyLogs()} className="tap relative text-sm text-ink-2 underline underline-offset-2 hover:text-ink">
                {copied ? "Copied" : "Copy output"}
              </button>
            )}
          </span>
          {logError && <p role="alert" className="text-sm text-orange-ink">Couldn't read the logs. Trying again.</p>}
          {logs === null && !logError && <p role="status" className="text-sm text-ink-3">Loading logs…</p>}
          {logs?.length === 0 && <p className="text-sm text-ink-3">Nothing logged yet.</p>}
          {logs?.map((l) => (
            <details key={l.name} open={logs.length === 1 || l === logs.at(-1)} className="min-w-0">
              <summary className="cursor-pointer py-1 font-mono text-xs break-all text-ink-2" translate="no">{l.name}</summary>
              <pre tabIndex={0} aria-label={`Output of ${l.name}`} className="mt-1 max-h-72 overflow-auto rounded-xl bg-inset p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-2">
                {l.text || "Empty."}
              </pre>
            </details>
          ))}
        </section>
        {!!record?.audit.length && (
          <details className="min-w-0">
            <summary className="cursor-pointer py-1 text-sm font-medium text-ink">History</summary>
            <ol className="flex flex-col gap-1 pt-1 text-xs text-ink-3">
              {record.audit.map((e) => (
                <li key={e.seq} className="break-words">
                  {new Date(e.at * 1000).toLocaleTimeString()} {e.action}, {e.actor}{e.detail ? `: ${e.detail}` : ""}
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </Sheet>
  );
}

export function TasksScreen() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskGroup | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [planId, setPlanId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api<Snapshot>("/api/tasks"));
      setConnected(true);
      setLoadError(null);
    } catch (err) {
      setConnected(false);
      setLoadError(err instanceof ApiError ? err.message : null);
    }
  }, []);

  useEffect(() => {
    const asked = new URLSearchParams(window.location.search);
    setSelected(asked.get("task"));
    setPlanId(asked.get("plan"));
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const again = () => void refresh();
    window.addEventListener("online", again);
    window.addEventListener("focus", again);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", again);
      window.removeEventListener("focus", again);
    };
  }, [refresh]);

  const open = (id: string | null) => {
    setSelected(id);
    window.history.replaceState(null, "", id ? `/tasks?task=${id}` : "/tasks");
  };
  const openPlan = (id: string | null) => {
    setPlanId(id);
    window.history.replaceState(null, "", id ? `/tasks?plan=${id}` : "/tasks");
  };

  const act = useCallback(
    async (action: string, id: string, extra?: Record<string, unknown>) => {
      setActionError(null);
      try {
        await api("/api/tasks", { action, ...(action === "unblock-agent" ? { owner: id } : { id }), ...extra });
        await refresh();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : "That action didn't go through. Check your connection.");
      }
    },
    [refresh],
  );

  const tasks = useMemo(() => data?.tasks ?? [], [data]);
  const counts = useMemo(() => {
    const c: Record<TaskGroup, number> = { active: 0, queued: 0, attention: 0, done: 0 };
    for (const t of tasks) c[GROUP_OF[t.state]]++;
    return c;
  }, [tasks]);
  const shown = filter === "all" ? tasks : tasks.filter((t) => GROUP_OF[t.state] === filter);
  const detail = tasks.find((t) => t.id === selected);
  const blocks = Object.entries(data?.provider_blocks ?? {});
  const health = data?.health;
  const dispatcher = health?.services?.["acc-worker"] ?? health?.services?.["adcc-worker"];

  return (
    <main className="min-h-dvh bg-page text-ink">
      <div className="safe-top safe-x"><div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 pt-3 pb-10 sm:px-8 sm:pt-6">
        <nav aria-label="Dashboard" className="flex min-h-11 items-center justify-between gap-3">
          <a href="/" className="tap relative -ml-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm text-ink-2 hover:text-ink">
            <NavArrowLeft width={16} height={16} strokeWidth={2} aria-hidden />
            Sessions
          </a>
          <span role="status" className={`inline-flex items-center gap-2 text-sm ${connected === false ? "text-orange-ink" : "text-ink-3"}`}>
            <span aria-hidden className={`size-2 rounded-full ${connected === false ? "bg-orange" : connected ? "bg-green" : "bg-line-strong"}`} />
            {connected === null ? "Connecting…" : connected ? "Live" : "Reconnecting…"}
          </span>
        </nav>

        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[26px] leading-8 font-semibold tracking-[-0.02em]">Background tasks</h1>
            <p className="mt-1 max-w-prose text-md text-ink-2">Work here keeps running on the server after you close this page.</p>
          </div>
          <a href="/?mode=background" className="tap relative inline-flex h-10 items-center rounded-full px-3 text-sm text-ink-2 hover:bg-hover hover:text-ink">New task</a>
          <a href="/?mode=auto" className="tap relative inline-flex h-10 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
            <Plus width={15} height={15} strokeWidth={2} aria-hidden />
            New work
          </a>
        </header>

        {connected === false && (
          <p role="alert" className="rounded-xl bg-orange-tint px-3 py-2 text-sm text-orange-ink">
            {loadError ?? "Can't reach the server."} Tasks keep running; what's below may be out of date.
          </p>
        )}
        {blocks.map(([owner, reason]) => (
          <div key={owner} role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-orange-tint px-3 py-2 text-sm text-orange-ink">
            <span className="min-w-0 flex-1 break-words">
              {AGENT_NAME[owner] ?? owner} tasks are paused: {taskErrorText(reason)}
            </span>
            <button type="button" onClick={() => void act("unblock-agent", owner)} className="tap relative rounded-full px-3 py-1.5 font-medium shadow-btn hover:bg-hover">
              Allow again
            </button>
          </div>
        ))}
        {!!health?.warnings?.length && (
          <p role="alert" className="rounded-xl bg-orange-tint px-3 py-2 text-sm text-orange-ink">
            {health.warnings.join(" ")}
          </p>
        )}
        {actionError && (
          <p role="alert" className="rounded-xl bg-red-tint px-3 py-2 text-sm text-red-ink">
            {actionError}
          </p>
        )}

        {!!data?.plans?.length && (
          <section aria-label="Auto plans" className="flex flex-col gap-1">
            <h2 className="text-sm font-medium text-ink-2">Auto plans</h2>
            <ul className="flex flex-col divide-y divide-line">
              {data.plans.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => openPlan(p.id)} aria-haspopup="dialog" className="flex w-full min-w-0 flex-col gap-1 rounded-lg px-2 py-3 text-left transition-colors duration-100 hover:bg-hover sm:-mx-2 sm:w-[calc(100%+1rem)]">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className={`text-sm font-medium ${planTone(p.state)}`}>{PLAN_LABEL[p.state]}</span>
                      {p.steps.length > 0 && <span className="shrink-0 text-xs text-ink-3 tabular-nums">{stepsDone(p)} of {p.steps.length} steps</span>}
                    </span>
                    <span className="line-clamp-2 text-md break-words text-ink">{p.goal ?? p.request}</span>
                    <span className="truncate text-xs text-ink-3" translate="no">{p.repo.split("/").pop()}</span>
                    {p.reason && <span className="line-clamp-2 text-sm break-words text-orange-ink">{p.reason}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div role="group" aria-label="Filter tasks" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5">
          {(["all", "active", "queued", "attention", "done"] as const).map((f) => {
            const count = f === "all" ? tasks.length : counts[f];
            return (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors duration-150 sm:min-h-9 ${filter === f ? "bg-field text-ink" : "text-ink-2 hover:bg-hover"}`}>
                {f === "all" ? "All" : GROUP_LABEL[f]}
                <span className={`tabular-nums ${f === "attention" && count > 0 ? "text-orange-ink" : "text-ink-3"}`}>{data ? count : ""}</span>
              </button>
            );
          })}
        </div>

        {data === null && connected !== false ? (
          <div role="status" aria-label="Loading tasks…" className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl bg-hover motion-reduce:animate-none" />
            ))}
          </div>
        ) : shown.length ? (
          <ul className="flex flex-col divide-y divide-line">
            {shown.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => open(t.id)} aria-haspopup="dialog" className="flex w-full min-w-0 flex-col gap-1 rounded-lg px-2 py-3 text-left transition-colors duration-100 hover:bg-hover sm:-mx-2 sm:w-[calc(100%+1rem)]">
                  <span className="flex min-w-0 items-baseline justify-between gap-3">
                    <StateBadge state={t.state} phase={t.phase} />
                    <span className="shrink-0 text-xs text-ink-3 tabular-nums">{formatElapsed(t.elapsed)}</span>
                  </span>
                  <span className="line-clamp-2 text-md break-words text-ink">{t.title}</span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-3 text-xs text-ink-3">
                    <span>{AGENT_NAME[t.owner] ?? t.owner}</span>
                    <span>Test: {testResult(t.test_exit)}</span>
                    {t.commits?.[0] && <span className="min-w-0 truncate font-mono" translate="no">{t.commits[0]}</span>}
                  </span>
                  {t.error && <span className="line-clamp-2 text-sm break-words text-orange-ink">{taskErrorText(t.error)}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : data ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-md text-ink-2">{filter === "all" ? "No background tasks yet." : `Nothing in ${GROUP_LABEL[filter as TaskGroup].toLowerCase()}.`}</p>
            {filter === "all" && <p className="max-w-sm text-sm text-ink-3">Queue work with a test command, and it runs in its own worktree while you're away.</p>}
          </div>
        ) : null}

        {data && (
          <footer className="flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-3 text-xs text-ink-3">
            <span>Dispatcher: {dispatcher ?? "not reported"}</span>
            <span>Disk: {health?.disk_free_gib !== undefined ? `${health.disk_free_gib} GiB free` : "not reported"}</span>
            <span>Memory: {health?.memory_kib ? `${Math.round(health.memory_kib.MemAvailable / 1024)} MiB free` : "not reported"}</span>
          </footer>
        )}
      </div></div>
      {planId && !selected && <PlanDetail id={planId} onOpenTask={open} onClose={() => openPlan(null)} onChanged={() => void refresh()} />}
      {detail && data && <TaskDetail task={detail} serverTime={data.server_time} onAction={act} onClose={() => open(null)} />}
    </main>
  );
}
