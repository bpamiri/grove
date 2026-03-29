import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";

export interface CostAnalytics {
  today: number;
  week: number;
  daily: Array<{ date: string; total: number }>;
  by_tree: Array<{ tree_id: string; total_cost: number; task_count: number }>;
  top_tasks: Array<{ id: string; title: string; cost_usd: number; tree_id: string }>;
}

export interface GateAnalytics {
  by_gate: Array<{ gate: string; passed: number; failed: number; total: number }>;
  retry_stats: { total_tasks: number; retried_tasks: number; avg_retries: number };
}

export interface TimelineTask {
  id: string;
  title: string;
  status: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cost_usd: number;
  tree_id: string | null;
  sessions: Array<{
    id: string;
    role: string;
    started_at: string;
    ended_at: string | null;
    cost_usd: number;
    status: string;
  }>;
}

export function useAnalytics() {
  const [cost, setCost] = useState<CostAnalytics | null>(null);
  const [gates, setGates] = useState<GateAnalytics | null>(null);
  const [timeline, setTimeline] = useState<TimelineTask[]>([]);
  const [timeRange, setTimeRange] = useState(24);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [costData, gateData, timelineData] = await Promise.all([
        api<CostAnalytics>("/api/analytics/cost"),
        api<GateAnalytics>("/api/analytics/gates"),
        api<TimelineTask[]>(`/api/analytics/timeline?hours=${timeRange}`),
      ]);
      setCost(costData);
      setGates(gateData);
      setTimeline(timelineData);
    } catch {
      // silently fail — dashboard shows empty state
    }
    setLoading(false);
  }, [timeRange]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { cost, gates, timeline, timeRange, setTimeRange, loading, refresh };
}
