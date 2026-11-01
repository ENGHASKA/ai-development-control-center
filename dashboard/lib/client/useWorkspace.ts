"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentCapabilities, SignIn } from "@/lib/agent-capabilities";
import type { AgentId } from "@/lib/types";
import type { Workspace } from "@/lib/workspace";
import { api, ApiError } from "./api";

/** The folders work can start in. `error` keeps what's already on screen usable; `refresh` follows a change. */
export function useWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await api<Workspace>("/api/workspace");
      setWorkspace(next);
      setError(null);
      return next;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your projects.");
      return null;
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);
  return { workspace, error, refresh };
}

export type AgentInfo = { id: AgentId; label: string; installed: boolean; signIn: SignIn | null; capabilities: AgentCapabilities };

export type AutoAvailability = { available: boolean; reason?: string };
type AgentsResponse = { agents: AgentInfo[]; auto: AutoAvailability };

let agentsCache: Promise<AgentsResponse> | null = null;
const loadAgents = () =>
  (agentsCache ??= api<AgentsResponse>("/api/agents")
    .catch((err) => {
      agentsCache = null;
      throw err;
    }));

/** Installed agents with what each can do here, shared by every composer on the page. */
export function useAgentsInfo() {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    loadAgents()
      .then((a) => live && setAgents(a.agents))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return agents;
}

/** Whether this server can run Auto Mode. */
export function useAutoAvailability() {
  const [auto, setAuto] = useState<AutoAvailability | null>(null);
  useEffect(() => {
    let live = true;
    loadAgents()
      .then((a) => live && setAuto(a.auto))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return auto;
}
