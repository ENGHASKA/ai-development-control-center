"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export type SessionAccessState = { level: "none" | "view" | "interact" | "manage" | null; locked: boolean; mode: string | null; refresh: () => void };

/** What this person may do with a session, from the server, which enforces it either way. */
export function useSessionAccess(id: string): SessionAccessState {
  const [state, setState] = useState<Omit<SessionAccessState, "refresh">>({ level: null, locked: false, mode: null });
  const refresh = useCallback(() => {
    api<{ level: SessionAccessState["level"]; locked?: boolean; mode?: string }>(`/api/access?session=${encodeURIComponent(id)}`)
      .then((d) => setState({ level: d.level, locked: Boolean(d.locked), mode: d.mode ?? null }))
      /* the server still enforces access; a failed check must not leave the page blank */
      .catch(() => setState((s) => ({ ...s, level: s.level ?? "interact" })));
  }, [id]);
  useEffect(refresh, [refresh]);
  return { ...state, refresh };
}
