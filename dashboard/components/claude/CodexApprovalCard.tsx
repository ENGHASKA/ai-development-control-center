"use client";

import { useEffect, useState } from "react";
import { WarningTriangle } from "iconoir-react";
import { api, ApiError } from "@/lib/client/api";
import type { CodexApproval } from "@/lib/codex-approval";
import { primaryBtn } from "./Sheet";

const POLL_MS = 2000;
const secondaryBtn = "tap relative inline-flex h-9 items-center rounded-full px-3.5 text-sm font-medium text-ink shadow-btn hover:bg-hover disabled:opacity-50";

/** What the agent is waiting on in its terminal, with its real choices. The terminal stays the source; this only reads and answers it. */
export function CodexApprovalCard({ id, canAnswer, onOpenTerminal }: { id: string; canAnswer: boolean; onOpenTerminal: () => void }) {
  const [approval, setApproval] = useState<CodexApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = encodeURIComponent(id);

  useEffect(() => {
    let on = true;
    const look = () =>
      api<{ approval: CodexApproval | null }>(`/api/sessions/${key}/approval`)
        .then((d) => on && setApproval(d.approval))
        .catch(() => undefined);
    void look();
    const t = setInterval(() => void look(), POLL_MS);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [key]);

  if (!approval) return null;
  const answer = async (decision: "approve" | "reject") => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/sessions/${key}/approval`, { decision, request: approval.id });
      setApproval(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't reach the agent. Open the terminal to answer.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Approval required" className="mx-3 mb-2 flex flex-col gap-2 rounded-2xl bg-orange-tint p-3 text-sm sm:mx-auto sm:w-full sm:max-w-(--thread-w)">
      <h2 className="inline-flex items-center gap-1.5 font-medium text-orange-ink">
        <WarningTriangle width={14} height={14} strokeWidth={2} aria-hidden />
        {approval.agent === "claude" ? "Claude" : "Codex"} is waiting for your approval
      </h2>
      <p className="text-ink">{approval.question}</p>
      {approval.reason && <p className="text-ink-2">{approval.reason}</p>}
      {approval.detail && <pre className="max-h-40 overflow-auto rounded-xl bg-inset p-2 font-mono text-xs break-words whitespace-pre-wrap text-ink" translate="no">{approval.detail}</pre>}
      {error && <p role="alert" className="text-red-ink">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {canAnswer && (
          <>
            <button type="button" disabled={busy} onClick={() => void answer("approve")} className={primaryBtn}>Approve once</button>
            <button type="button" disabled={busy} onClick={() => void answer("reject")} className={secondaryBtn}>Reject</button>
          </>
        )}
        <button type="button" onClick={onOpenTerminal} className={secondaryBtn}>Open terminal</button>
      </div>
    </section>
  );
}
