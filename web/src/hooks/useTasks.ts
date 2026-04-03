import { useState, useEffect, useCallback } from "react";
import type { WsMessage } from "./useWebSocket";
import { useLocalStorage } from "./useLocalStorage";
import { api } from "../api/client";

export interface Task {
  id: string;
  tree_id: string | null;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: string;
  current_step: string | null;
  step_index: number;
  paused: number;
  path_name: string;
  priority: number;
  depends_on: string | null;
  github_issue: number | null;
  labels: string | null;
  branch: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  pr_number: number | null;
  cost_usd: number;
  tokens_used: number;
  skill_overrides: string | null;
  gate_results: string | null;
  session_summary: string | null;
  files_modified: string | null;
  retry_count: number;
  max_retries: number;
  source_pr: number | null;
  has_seed?: boolean;
  seed_status?: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface Tree {
  id: string;
  name: string;
  path: string;
  github: string | null;
  branch_prefix: string;
  default_path: string | null;
  default_branch: string | null;
  created_at: string;
}

export interface Status {
  version?: string;
  broker: string;
  remoteUrl: string | null;
  orchestrator: string;
  workers: number;
  wsClients: number;
  tasks: { total: number; active: number; completed: number; draft: number };
  cost: { today: number; week: number };
}

// Activity messages per task (transient, not from DB)
const taskActivity = new Map<string, string>();
const taskActivityLog = new Map<string, Array<{ ts: number; msg: string; kind?: string }>>();
const activityLogFetched = new Set<string>();
const MAX_LOG_ENTRIES = 200;

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [trees, setTrees] = useState<Tree[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [selectedTree, setSelectedTree] = useLocalStorage<string | null>("grove-selected-tree", null);
  const [paths, setPaths] = useState<Record<string, { description: string; steps: Array<{ id: string; type: string; label: string; skills?: string[]; on_success: string; on_failure: string }> }>>({});

  const refresh = useCallback(async () => {
    try {
      const [tasksData, treesData, statusData, pathsData] = await Promise.all([
        api<Task[]>("/api/tasks"),
        api<Tree[]>("/api/trees"),
        api<Status>("/api/status"),
        api<Record<string, any>>("/api/paths"),
      ]);
      setTasks(tasksData);
      setTrees(treesData);
      setStatus(statusData);
      setPaths(pathsData);
    } catch {
      // API not available
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleWsMessage = useCallback((msg: WsMessage) => {
    switch (msg.type) {
      case "task:created":
        setTasks(prev => [msg.data.task, ...prev]);
        break;
      case "task:status":
        setTasks(prev =>
          prev.map(t => t.id === msg.data.taskId ? { ...t, status: msg.data.status } : t)
        );
        break;
      case "task:step":
        setTasks(prev =>
          prev.map(t => t.id === msg.data.taskId
            ? { ...t, current_step: msg.data.step, step_index: msg.data.stepIndex }
            : t
          )
        );
        break;
      case "worker:activity": {
        const tid = msg.data.taskId;
        taskActivity.set(tid, msg.data.msg);
        if (!taskActivityLog.has(tid)) taskActivityLog.set(tid, []);
        const log = taskActivityLog.get(tid)!;
        log.push({ ts: Date.now(), msg: msg.data.msg });
        if (log.length > MAX_LOG_ENTRIES) log.shift();
        // Force re-render
        setTasks(prev => [...prev]);
        break;
      }
      case "agent:tool_use": {
        const tid = msg.data.taskId;
        if (tid === "orchestrator") break;
        const toolMsg = `${msg.data.tool}: ${msg.data.input}`;
        taskActivity.set(tid, toolMsg);
        if (!taskActivityLog.has(tid)) taskActivityLog.set(tid, []);
        const tlog = taskActivityLog.get(tid)!;
        tlog.push({ ts: msg.data.ts ?? Date.now(), msg: toolMsg, kind: "tool" });
        if (tlog.length > MAX_LOG_ENTRIES) tlog.shift();
        setTasks(prev => [...prev]);
        break;
      }
      case "agent:thinking": {
        const tid = msg.data.taskId;
        if (tid === "orchestrator") break;
        const thinkMsg = `thinking: ${msg.data.snippet}`;
        taskActivity.set(tid, thinkMsg);
        if (!taskActivityLog.has(tid)) taskActivityLog.set(tid, []);
        const thlog = taskActivityLog.get(tid)!;
        thlog.push({ ts: msg.data.ts ?? Date.now(), msg: thinkMsg, kind: "thinking" });
        if (thlog.length > MAX_LOG_ENTRIES) thlog.shift();
        setTasks(prev => [...prev]);
        break;
      }
      case "agent:text": {
        const tid = msg.data.taskId;
        if (tid === "orchestrator") break;
        taskActivity.set(tid, msg.data.content);
        if (!taskActivityLog.has(tid)) taskActivityLog.set(tid, []);
        const txlog = taskActivityLog.get(tid)!;
        txlog.push({ ts: msg.data.ts ?? Date.now(), msg: msg.data.content, kind: "text" });
        if (txlog.length > MAX_LOG_ENTRIES) txlog.shift();
        setTasks(prev => [...prev]);
        break;
      }
      case "agent:cost": {
        const tid = msg.data.taskId;
        if (tid === "orchestrator") break;
        const costMsg = `cost: $${msg.data.costUsd?.toFixed(2) ?? "?"} (${msg.data.tokens ?? 0} tokens)`;
        if (!taskActivityLog.has(tid)) taskActivityLog.set(tid, []);
        const clog = taskActivityLog.get(tid)!;
        clog.push({ ts: msg.data.ts ?? Date.now(), msg: costMsg, kind: "cost" });
        if (clog.length > MAX_LOG_ENTRIES) clog.shift();
        setTasks(prev => [...prev]);
        // Also refresh to update cost_usd on the task object
        refresh();
        break;
      }
      case "worker:spawned":
      case "worker:ended":
      case "cost:updated":
        // Refresh all data for these events
        refresh();
        break;
    }
  }, [refresh]);

  const getActivity = (taskId: string): string | undefined => taskActivity.get(taskId);
  const getActivityLog = (taskId: string): Array<{ ts: number; msg: string; kind?: string }> => taskActivityLog.get(taskId) ?? [];

  /** Fetch activity from live ring buffer first, then fall back to historical log */
  const loadActivityLog = useCallback(async (taskId: string) => {
    if (activityLogFetched.has(taskId)) return;
    activityLogFetched.add(taskId);
    try {
      // Try live ring buffer first (for active tasks)
      const liveEntries = await api<Array<{ type: string; taskId: string; tool?: string; input?: string; snippet?: string; content?: string; costUsd?: number; tokens?: number; ts?: number }>>(`/api/tasks/${taskId}/activity/live`);
      if (liveEntries.length > 0) {
        const fetched = liveEntries.map(e => {
          const ts = e.ts ?? Date.now();
          if (e.type === "agent:tool_use") return { ts, msg: `${e.tool}: ${e.input}`, kind: "tool" as const };
          if (e.type === "agent:thinking") return { ts, msg: `thinking: ${e.snippet}`, kind: "thinking" as const };
          if (e.type === "agent:text") return { ts, msg: e.content ?? "", kind: "text" as const };
          if (e.type === "agent:cost") return { ts, msg: `cost: $${e.costUsd?.toFixed(2) ?? "?"} (${e.tokens ?? 0} tokens)`, kind: "cost" as const };
          return { ts, msg: `${e.type}` };
        });
        // Merge with any live WS events already in the log, deduplicating by timestamp
        const existing = taskActivityLog.get(taskId) ?? [];
        const existingTs = new Set(existing.map(e => e.ts));
        const merged = [...fetched.filter(e => !existingTs.has(e.ts)), ...existing].sort((a, b) => a.ts - b.ts);
        if (merged.length > MAX_LOG_ENTRIES) merged.splice(0, merged.length - MAX_LOG_ENTRIES);
        taskActivityLog.set(taskId, merged);
        setTasks(prev => [...prev]);
        return;
      }

      // Fall back to historical log file parsing
      const entries = await api<Array<{ ts: string; msg: string }>>(`/api/tasks/${taskId}/activity`);
      if (entries.length > 0) {
        const log = entries.map(e => ({
          ts: e.ts ? new Date(e.ts).getTime() : Date.now(),
          msg: e.msg,
        }));
        taskActivityLog.set(taskId, log);
        setTasks(prev => [...prev]);
      }
    } catch {}
  }, []);

  return { tasks, trees, paths, status, selectedTree, setSelectedTree, refresh, handleWsMessage, getActivity, getActivityLog, loadActivityLog };
}
