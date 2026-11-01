"use client";

import { useEffect, useState } from "react";
import { Check, Clock, Play, WarningTriangle, Xmark } from "iconoir-react";
import { api, ApiError, shortPath } from "@/lib/client/api";
import { PLAN_LABEL, planOpen, planResumable, planStoppable, STEP_LABEL, stepsDone, type Plan, type PlanState, type PlanStep, type StepState } from "@/lib/plans";
import { testResult } from "@/lib/tasks";
import { primaryBtn, Sheet } from "./Sheet";

const POLL_MS = 2000;
const AGENT_NAME: Record<string, string> = { claude: "Claude", codex: "Codex", demo: "Fixture" };
const STEP_ICON: Record<StepState, typeof Check> = { planned: Clock, waiting_approval: WarningTriangle, queued: Clock, running: Play, completed: Check, blocked: WarningTriangle, failed: WarningTriangle, cancelled: Xmark };
const STEP_TONE: Record<StepState, string> = { planned: "text-ink-3", waiting_approval: "text-orange-ink", queued: "text-ink-2", running: "text-accent-ink", completed: "text-ink-2", blocked: "text-orange-ink", failed: "text-orange-ink", cancelled: "text-ink-3" };
const secondaryBtn = "tap relative inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium text-ink shadow-btn hover:bg-hover disabled:opacity-50";

export function planTone(s: PlanState) {
  return s === "ready" || s === "blocked" || s === "failed" ? "text-orange-ink" : s === "merged" || s === "cancelled" ? "text-ink-3" : "text-accent-ink";
}

function StepRow({ step, busy, onApprove, onOpenTask }: { step: PlanStep; busy: boolean; onApprove: () => void; onOpenTask?: (task: string) => void }) {
  const Icon = STEP_ICON[step.state];
  const summary = step.handoff?.reported_by_agent?.summary;
  return (
    <li className="flex flex-col gap-1 py-3">
      <span className="flex min-w-0 items-baseline justify-between gap-3">
        <span className={`inline-flex min-w-0 items-center gap-1.5 text-sm font-medium ${STEP_TONE[step.state]}`}>
          <Icon width={14} height={14} strokeWidth={2} aria-hidden className="shrink-0" />
          {STEP_LABEL[step.state]}
          {step.state === "running" && step.phase && step.phase !== "running" && <span className="font-normal text-ink-3">, {step.phase}</span>}
        </span>
        <span className="shrink-0 text-xs text-ink-3">{AGENT_NAME[step.agent] ?? step.agent}</span>
      </span>
      <span className="text-md break-words text-ink">{step.title}</span>
      <span className="text-xs text-ink-3">{step.route_reason}</span>
      {step.repairs && (
        <ul className="list-disc pl-4 text-sm text-ink-2">
          {step.repairs.map((r) => (
            <li key={r} className="break-words">{r}</li>
          ))}
        </ul>
      )}
      {step.depends.length > 0 && <span className="text-xs text-ink-3">After: {step.depends.join(", ")}</span>}
      {step.state !== "planned" && step.state !== "waiting_approval" && <span className="text-xs text-ink-3">Test: {testResult(step.test_exit)}</span>}
      {step.reason && <span className="text-sm break-words text-orange-ink">{step.reason}</span>}
      {summary && <span className="text-sm break-words text-ink-2">The agent reports: {summary}</span>}
      <span className="flex flex-wrap gap-2 pt-1">
        {step.state === "waiting_approval" && (
          <button type="button" disabled={busy} onClick={onApprove} className={secondaryBtn}>
            Approve this step
          </button>
        )}
        {step.task && onOpenTask && (
          <button type="button" onClick={() => onOpenTask(step.task!)} className="tap relative text-sm text-ink-2 underline underline-offset-2 hover:text-ink">
            Logs and worktree
          </button>
        )}
      </span>
      {step.task && !onOpenTask && <StepLogs task={step.task} live={step.state === "running"} />}
    </li>
  );
}

/** Output of one task, fetched when opened and kept live while it runs. Real logs, in full, on request. */
function StepLogs({ task, live }: { task: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<{ name: string; text: string }[] | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    let on = true;
    const get = () =>
      api<{ name: string; text: string }[]>(`/api/tasks?id=${task}`)
        .then((l) => on && setLogs(l))
        .catch(() => undefined);
    void get();
    if (!live) return () => void (on = false);
    const t = setInterval(() => void get(), POLL_MS);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [open, task, live]);
  const copy = async () => {
    await navigator.clipboard.writeText((logs ?? []).map((l) => `# ${l.name}\n${l.text}`).join("\n\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <details className="min-w-0" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer py-1 text-sm text-ink-2">Agent activity and logs</summary>
      {logs === null ? (
        <p role="status" className="text-sm text-ink-3">Loading logs…</p>
      ) : (
        <div className="flex flex-col gap-1">
          {logs.length > 0 && (
            <button type="button" onClick={() => void copy()} className="tap relative w-fit text-sm text-ink-2 underline underline-offset-2 hover:text-ink">
              {copied ? "Copied" : "Copy output"}
            </button>
          )}
          {logs.length === 0 && <p className="text-sm text-ink-3">Nothing logged yet.</p>}
          {logs.map((l) => (
            <pre key={l.name} tabIndex={0} aria-label={`Output of ${l.name}`} className="max-h-64 overflow-auto rounded-xl bg-inset p-2 font-mono text-xs break-words whitespace-pre-wrap text-ink-2">{l.text || "Empty."}</pre>
          ))}
        </div>
      )}
    </details>
  );
}

/** One plan, from the server's record: the same view in a sheet and in a conversation. Closing it changes nothing about the work. */
export function PlanBody({ id, onOpenTask, onChanged, inline }: { id: string; onOpenTask?: (task: string) => void; onChanged?: () => void; inline?: boolean }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [merged, setMerged] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    const get = async () => {
      try {
        const next = await api<Plan>(`/api/plans?id=${id}`);
        if (on) (setPlan(next), setLoadError(null));
      } catch (err) {
        if (on) setLoadError(err instanceof ApiError ? err.message : "Can't reach the server. Trying again.");
      }
    };
    void get();
    const t = setInterval(() => void get(), POLL_MS);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [id]);

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await api<{ branch?: string }>("/api/plans", { id, ...body });
      if (res.branch) setMerged(res.branch);
      setConfirming(false);
      setPlan(await api<Plan>(`/api/plans?id=${id}`));
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "That didn't go through. Check your connection.");
    } finally {
      setBusy(false);
    }
  };

  const report = plan?.report;
  return (
    <>
      {!plan ? (
        <p role={loadError ? "alert" : "status"} className="py-6 text-center text-sm text-ink-3">
          {loadError ?? "Loading the plan…"}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {inline && (
            <div className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl bg-field px-3.5 py-2 text-md break-words whitespace-pre-wrap text-ink">{plan.request}</p>
            </div>
          )}
          <p className={`text-sm font-medium ${planTone(plan.state)}`}>
            {PLAN_LABEL[plan.state]}
            {plan.steps.length > 0 && <span className="font-normal text-ink-3">, {stepsDone(plan)} of {plan.steps.length} steps done{plan.repairs ? `, repair round ${plan.repairs}` : ""}</span>}
          </p>
          {plan.reason && (
            <p role="alert" className="rounded-xl bg-orange-tint px-3 py-2 text-sm break-words text-orange-ink">
              {plan.reason}
            </p>
          )}
          {loadError && <p role="alert" className="text-sm text-orange-ink">{loadError}</p>}
          {actionError && <p role="alert" className="rounded-xl bg-red-tint px-3 py-2 text-sm text-red-ink">{actionError}</p>}
          {merged && <p role="status" className="text-sm text-ink-2">Merged into {merged}. Nothing was pushed.</p>}
          {plan.goal && inline && <p className="text-md text-ink">{plan.goal}</p>}
          <section aria-label="Request">
            {!inline && <h3 className="pb-1 text-sm font-medium text-ink">Request</h3>}
            {!inline && <p className="text-sm break-words whitespace-pre-wrap text-ink-2">{plan.request}</p>}
            <p className="pt-1 font-mono text-xs break-all text-ink-3" translate="no">{shortPath(plan.repo)}</p>
          </section>

          {report?.review && (
            <section aria-label="Independent review" className={`rounded-xl px-3 py-2 text-sm ${report.review.approved ? "bg-hover text-ink-2" : "bg-orange-tint text-orange-ink"}`}>
              <h3 className="font-medium">{report.review.approved ? "Reviewer found no problems" : "Reviewer found problems"}</h3>
              {report.review.summary && <p>{report.review.summary}</p>}
              {report.review.findings.length > 0 && (
                <ul className="list-disc pl-4">
                  {report.review.findings.map((f) => (
                    <li key={f} className="break-words">{f}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {report?.validation && (
            <section aria-label="Final validation">
              <h3 className="pb-1 text-sm font-medium text-ink">Final test of the merged work</h3>
              <p className="text-sm text-ink-2">{testResult(report.validation.exit ?? null)}</p>
              {report.validation.test && <p className="font-mono text-xs break-all text-ink-3" translate="no">{report.validation.test.join(" ")}</p>}
            </section>
          )}

          {plan.steps.length > 0 ? (
            <section aria-label="Steps" className="min-w-0">
              <h3 className="text-sm font-medium text-ink">Plan</h3>
              <ul className="flex flex-col divide-y divide-line">
                {plan.steps.map((s) => (
                  <StepRow key={s.key} step={s} busy={busy} onApprove={() => void act({ action: "approve-step", step: s.key })} onOpenTask={onOpenTask} />
                ))}
              </ul>
            </section>
          ) : (
            plan.state === "planning" && (
              <div className="flex flex-col items-start gap-1">
                <p className="text-sm text-ink-2">An agent is reading the project and writing the plan.</p>
                {plan.planner_task && onOpenTask && (
                  <button type="button" onClick={() => onOpenTask(plan.planner_task!)} className="tap relative text-sm text-ink-2 underline underline-offset-2 hover:text-ink">
                    Logs
                  </button>
                )}
              </div>
            )
          )}

          {report?.diff_stat && (
            <section aria-label="Changes">
              <h3 className="pb-1 text-sm font-medium text-ink">Changes on {plan.branch}</h3>
              <pre tabIndex={0} className="max-h-48 overflow-auto rounded-xl bg-inset p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-ink-2" translate="no">{report.diff_stat}</pre>
            </section>
          )}

          <div className="flex flex-wrap gap-2">
            {plan.state === "ready" &&
              (confirming ? (
                <>
                  <button type="button" disabled={busy} onClick={() => void act({ action: "merge" })} className={primaryBtn}>
                    {busy ? "Merging…" : "Confirm merge"}
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className={secondaryBtn}>
                    Not yet
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirming(true)} className={primaryBtn}>
                  Merge into project
                </button>
              ))}
            {planResumable(plan.state) && (
              <button type="button" disabled={busy} onClick={() => void act({ action: "resume" })} className={secondaryBtn}>
                {busy ? "Resuming…" : "Resume"}
              </button>
            )}
            {planStoppable(plan.state) && (
              <button type="button" disabled={busy} onClick={() => void act({ action: "cancel" })} className={secondaryBtn}>
                {planOpen(plan.state) ? "Stop plan" : "Discard plan"}
              </button>
            )}
          </div>

          {plan.events && plan.events.length > 0 && (
            <details className="min-w-0">
              <summary className="cursor-pointer py-1 text-sm font-medium text-ink">History</summary>
              <ol className="flex flex-col gap-1 pt-1 text-xs text-ink-3">
                {plan.events.map((e) => (
                  <li key={e.seq} className="break-words">
                    {new Date(e.at * 1000).toLocaleTimeString()} {e.step ? `${e.step}: ` : ""}{e.state}{e.detail ? `, ${e.detail}` : ""}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
    </>
  );
}

export function PlanDetail({ id, onOpenTask, onClose, onChanged }: { id: string; onOpenTask: (task: string) => void; onClose: () => void; onChanged: () => void }) {
  return (
    <Sheet title="Auto plan" onClose={onClose} wide>
      <a href={`/?s=${encodeURIComponent(`plan:${id}`)}`} className="inline-flex min-h-11 items-center self-start text-sm text-ink-2 underline underline-offset-2 hover:text-ink">Open as conversation</a>
      <PlanBody id={id} onOpenTask={onOpenTask} onChanged={onChanged} />
    </Sheet>
  );
}
