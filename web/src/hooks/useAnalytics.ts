import { useState, useEffect, useCallback, useRef } from "react";
import type { WsMessage } from "./useWebSocket";
import { api } from "../api/client";

// ---- Types ----

export type TimeRange = "1h" | "4h" | "24h" | "7d";
export type DashboardTab = "overview" | "costs" | "gates";

export interface CostByTree {
  tree_name: string;
  tree_id: string;
  total_cost: number;
  task_count: number;
}

export interface CostDaily {
  date: string;
  total_cost: number;
  task_count: number;
}

export interface CostTopTask {
  task_id: string;
  title: string;
  tree_name: string | null;
  cost_usd: number;
}

export interface CostData {
  by_tree: CostByTree[];
  daily: CostDaily[];
  top_tasks: CostTopTask[];
}

export interface GateAnalytics {
  gate_type: string;
  pass_count: number;
  fail_count: number;
  total: number;
}

export interface RetryStats {
  total_retried: number;
  avg_retries: number;
  max_retries: number;
}

export interface GateData {
  gates: GateAnalytics[];
  retries: RetryStats;
}

export interface TimelineTask {
  task_id: string;
  title: string;
  tree_name: string | null;
  status: string;
  started_at: string;
  completed_at: string | null;
  cost_usd: number;
  current_step: string | null;
}

export interface TimelineData {
  tasks: TimelineTask[];
}

// WS event types that trigger a refresh in live mode
const LIVE_EVENTS = new Set(["task:status", "cost:updated", "gate:result", "task:created", "worker:ended"]);

function isLiveRange(range: TimeRange): boolean {
  return range === "1h" || range === "4h";
}

// ---- Hook ----

export function useAnalytics(
  range: TimeRange,
  activeTab: DashboardTab,
  wsMessages: WsMessage[],
) {
  const [costData, setCostData] = useState<CostData | null>(null);
  const [gateData, setGateData] = useState<GateData | null>(null);
  const [timelineData, setTimelineData] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(false);
  const lastWsMsgTs = useRef(0);

  const fetchTab = useCallback(async (tab: DashboardTab, r: TimeRange) => {
    setLoading(true);
    try {
      if (tab === "overview" || tab === "costs") {
        const data = await api<CostData>(`/api/analytics/cost?range=${r}`);
        setCostData(data);
      }
      if (tab === "overview" || tab === "gates") {
        const data = await api<GateData>(`/api/analytics/gates?range=${r}`);
        setGateData(data);
      }
      if (tab === "overview") {
        const data = await api<TimelineData>(`/api/analytics/timeline?range=${r}`);
        setTimelineData(data);
      }
    } catch {
      // API not available
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount, tab change, or range change
  useEffect(() => {
    fetchTab(activeTab, range);
  }, [activeTab, range, fetchTab]);

  // Live mode: re-fetch on relevant WS events
  useEffect(() => {
    if (!isLiveRange(range)) return;
    const latest = wsMessages[wsMessages.length - 1];
    if (!latest || latest.ts <= lastWsMsgTs.current) return;
    if (!LIVE_EVENTS.has(latest.type)) return;
    lastWsMsgTs.current = latest.ts;
    fetchTab(activeTab, range);
  }, [wsMessages, range, activeTab, fetchTab]);

  const refresh = useCallback(() => {
    fetchTab(activeTab, range);
  }, [activeTab, range, fetchTab]);

  return { costData, gateData, timelineData, loading, refresh };
}
