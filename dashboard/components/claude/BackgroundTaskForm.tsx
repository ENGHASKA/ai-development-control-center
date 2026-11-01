"use client";

import { useState, type FormEvent } from "react";
import { api, ApiError } from "@/lib/client/api";
import { useAgentModels } from "@/lib/client/useProfiles";
import { effortOptions } from "@/lib/agent-traits";
import type { ExecutionAgent, RoutingMode } from "@/lib/agent-capabilities";
import { MODELS } from "@/lib/composer-options";
import { ROUTING_OPTIONS } from "@/lib/plans";
import { parseCommand, pathInPrompt, type WorkspaceEntry } from "@/lib/workspace";
import { Select } from "./Select";
import { area, field, primaryBtn } from "./Sheet";

const ACCESS = [
  { value: "acceptEdits", label: "Can edit files", hint: "Works in its own worktree without asking" },
  { value: "default", label: "Ask before editing", hint: "Claude only: stops for your approval first" },
  { value: "plan", label: "Read only", hint: "Reads and proposes, changes nothing" },
];

type ModelChoice = { model: string; effort: string };
const CLI_DEFAULT = "Configured on the server";

/** Model and effort for one agent. Blank sends nothing, so the CLI's own configuration decides. */
function ModelFields({ agent, value, onChange }: { agent: "claude" | "codex"; value: ModelChoice; onChange: (v: ModelChoice) => void }) {
  const listed = useAgentModels(agent, agent);
  const models = agent === "claude" ? MODELS : listed;
  const efforts = effortOptions(agent, (models as { key: string; efforts?: string[] }[]).find((m) => m.key === value.model)?.efforts);
  const name = agent === "claude" ? "Claude" : "Codex";
  const pick = (model: string) => {
    const allowed = effortOptions(agent, (models as { key: string; efforts?: string[] }[]).find((m) => m.key === model)?.efforts);
    onChange({ model, effort: allowed.some((e) => e.key === value.effort) ? value.effort : "" });
  };
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        <span>{name} model</span>
        <Select value={value.model} label={`${name} model`} onChange={pick} options={[{ value: "", label: CLI_DEFAULT }, ...models.filter((m) => m.key).map((m) => ({ value: m.key, label: m.name }))]} />
      </div>
      <div className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        <span>{name} reasoning</span>
        <Select value={value.effort} label={`${name} reasoning`} onChange={(effort) => onChange({ ...value, effort })} options={[{ value: "", label: CLI_DEFAULT }, ...efforts.map((e) => ({ value: e.key, label: e.name, hint: e.desc }))]} />
      </div>
    </div>
  );
}

const sendable = (m: ModelChoice) => ({ ...(m.model ? { model: m.model } : {}), ...(m.effort ? { effort: m.effort } : {}) });

/**
 * Queues durable work: it runs in worktrees on the server, under systemd, whether or not a browser stays open. With Auto,
 * the request goes to the planner; otherwise it's one task for the chosen agent, with the test that proves it's done.
 */
export function BackgroundTaskForm({
  project,
  agent,
  onQueued,
  resolveProject,
}: {
  project: WorkspaceEntry | null;
  agent: ExecutionAgent;
  /** where to go once it's queued */
  onQueued: (where: string) => void;
  /** a folder named in the prompt, checked with the server; null when it's refused */
  resolveProject: (text: string) => Promise<string | null>;
}) {
  const auto = agent === "auto";
  const [prompt, setPrompt] = useState("");
  const [routing, setRouting] = useState<RoutingMode>("auto");
  const [claudeModel, setClaudeModel] = useState<ModelChoice>({ model: "", effort: "" });
  const [codexModel, setCodexModel] = useState<ModelChoice>({ model: "", effort: "" });
  const [reassign, setReassign] = useState(false);
  const [repairs, setRepairs] = useState("2");
  const [holdFirst, setHoldFirst] = useState(false);
  const [emptyOk, setEmptyOk] = useState(false);
  const [test, setTest] = useState("");
  const [access, setAccess] = useState("acceptEdits");
  const [hours, setHours] = useState("4");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const named = pathInPrompt(prompt) !== null;
  const blocked = named ? null : !project ? "Choose a project first." : project.kind === "missing" ? "This project's folder is gone. Choose another." : !project.queueable ? "Background work starts from a Git repository. Choose one, or create a project with Git." : null;

  const empty = !named && project?.tracked === 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const argv = auto ? [] : parseCommand(test);
    const bad = auto ? null : !test.trim() ? "Enter the command that proves the work is done." : !argv?.length ? "Close the quote in this command." : null;
    setTestError(bad);
    /* Auto is how a new project gets built, so an empty one is fine there */
    if (bad || blocked || (empty && !auto && !emptyOk)) return;
    setBusy(true);
    try {
      const repo = await resolveProject(prompt);
      if (!repo) return;
      if (auto) {
        const { id } = await api<{ id: string }>("/api/plans", { action: "create", repo, request: prompt.trim(), routing, models: { claude: sendable(claudeModel), codex: sendable(codexModel) }, allowReassign: reassign, maxRepairs: Number(repairs) });
        return onQueued(`plan:${id}`);
      }
      const chosen = agent === "codex" ? codexModel : claudeModel;
      const { id } = await api<{ id: string }>("/api/tasks", {
        action: "add",
        spec: { repo, owner: agent, prompt: prompt.trim(), test: argv, permission_mode: access, timeout: Math.round(Number(hours) * 3600), max_attempts: 2, auto_resume: false, allow_empty: emptyOk, hold_for_approval: holdFirst, ...sendable(chosen) },
      });
      onQueued(`/tasks?task=${id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't queue that.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-3 rounded-[22px] bg-surface p-4 shadow-composer">
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        {auto ? "What do you want built?" : "What should the agent do?"}
        <textarea className={`${area} min-h-28 resize-y`} value={prompt} onChange={(e) => setPrompt(e.target.value)} required placeholder={auto ? "Describe the result you want. It can be as large as a whole feature." : "Describe a task that can be finished and tested on its own."} />
      </label>
      {auto ? (
        <div className="flex flex-col gap-1.5 text-sm font-medium text-ink">
          <span>Which agents</span>
          <Select value={routing} label="Which agents" onChange={(v) => setRouting(v as RoutingMode)} options={ROUTING_OPTIONS} />
        </div>
      ) : null}
      {!auto && <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
        Test command
        <input
          className={`${field} font-mono`}
          value={test}
          onChange={(e) => (setTest(e.target.value), setTestError(null))}
          required
          placeholder="python3 -m unittest"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-invalid={testError ? true : undefined}
          aria-describedby="task-test-help"
        />
        <span id="task-test-help" className={`font-normal ${testError ? "text-red-ink" : "text-ink-3"}`}>
          {testError ?? "Runs in the task's worktree when the agent finishes. The task goes to review only if this exits 0."}
        </span>
      </label>}
      {!auto && <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 text-sm font-medium text-ink">
          <span id="task-access">Access</span>
          <Select value={access} options={ACCESS} onChange={setAccess} label="Access" />
        </div>
        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
          Time limit (hours)
          <input className={field} type="number" inputMode="decimal" min="0.1" max="24" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} />
        </label>
      </div>}
      {(auto ? routing !== "codex" : agent === "claude") && <ModelFields agent="claude" value={claudeModel} onChange={setClaudeModel} />}
      {(auto ? routing !== "claude" : agent === "codex") && <ModelFields agent="codex" value={codexModel} onChange={setCodexModel} />}
      {auto && (
        <div className="flex flex-col gap-1.5 text-sm font-medium text-ink">
          <span>Automatic repair rounds</span>
          <Select value={repairs} label="Automatic repair rounds" onChange={setRepairs} options={[{ value: "0", label: "None", hint: "Stop at the first review findings" }, { value: "1", label: "1" }, { value: "2", label: "2", hint: "Recommended" }, { value: "3", label: "3" }]} />
          <span className="font-normal text-ink-3">When a test or review finds a problem, an agent fixes it and the work is checked again. It stops if the same problem comes back.</span>
        </div>
      )}
      {auto && routing !== "claude" && routing !== "codex" && (
        <label className="flex min-h-11 items-center gap-2.5 text-sm text-ink">
          <input type="checkbox" className="size-4 accent-(--accent)" checked={reassign} onChange={(e) => setReassign(e.target.checked)} />
          If an agent hits a usage limit, let the other one take over its step
        </label>
      )}
      {!auto && (
        <label className="flex min-h-11 items-center gap-2.5 text-sm text-ink">
          <input type="checkbox" className="size-4 accent-(--accent)" checked={holdFirst} onChange={(e) => setHoldFirst(e.target.checked)} />
          Wait for my approval before starting
        </label>
      )}
      {empty && !auto && (
        <label className="flex min-h-11 items-start gap-2.5 rounded-xl bg-orange-tint px-3 py-2 text-sm text-orange-ink">
          <input type="checkbox" className="mt-0.5 size-4 accent-(--accent)" checked={emptyOk} onChange={(e) => setEmptyOk(e.target.checked)} />
          <span>{project?.name} has no files yet. If you meant an existing project, choose it above. Tick this only to start from nothing.</span>
        </label>
      )}
      <p className="text-sm text-ink-3">{auto ? "Every step must pass its own test in a sandbox. The finished work waits on its own branch until you merge it." : "Attempts are limited to 2, and nothing is merged without your review."} Your plan decides which models run.</p>
      {(error || blocked) && (
        <p role="alert" className={`text-sm ${error ? "text-red-ink" : "text-orange-ink"}`}>
          {error ?? blocked}
        </p>
      )}
      <div className="flex justify-end">
        <button type="submit" disabled={busy || !!blocked || !prompt.trim() || (empty && !auto && !emptyOk)} className={primaryBtn}>
          {busy ? "Queuing…" : auto ? "Start Auto" : "Queue task"}
        </button>
      </div>
    </form>
  );
}
