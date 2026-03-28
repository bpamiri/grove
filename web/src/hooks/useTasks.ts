import { useState, useEffect, useCallback } from "react";
import type { WsMessage } from "./useWebSocket";
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
  branch: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  pr_number: number | null;
  cost_usd: number;
  tokens_used: number;
  gate_results: string | null;
  session_summary: string | null;
  files_modified: string | null;
  retry_count: number;
  max_retries: number;
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
  created_at: string;
}

export interface Status {
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
const taskActivityLog = new Map<string, Array<{ ts: number; msg: string }>>();
const MAX_LOG_ENTRIES = 200;

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [trees, setTrees] = useState<Tree[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [selectedTree, setSelectedTree] = useState<string | null>(null);
  const [paths, setPaths] = useState<Record<string, { description: string; steps: Array<{ id: string; type: string; label: string; on_success: string; on_failure: string }> }>>({});

  const refresh = useCallback(async () => {
    try {
      const [tasksData, treesData, statusData, pathsData] = await Promise.all([
        api<Task[]>(selectedTree ? `/api/tasks?tree=${selectedTree}` : "/api/tasks"),
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
  }, [selectedTree]);

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
      case "worker:spawned":
      case "worker:ended":
      case "cost:updated":
        // Refresh all data for these events
        refresh();
        break;
    }
  }, [refresh]);

  const getActivity = (taskId: string): string | undefined => taskActivity.get(taskId);
  const getActivityLog = (taskId: string): Array<{ ts: number; msg: string }> => taskActivityLog.get(taskId) ?? [];

  /** Fetch historical activity from the worker log file (seeds the feed on expand) */
  const loadActivityLog = useCallback(async (taskId: string) => {
    if (taskActivityLog.has(taskId) && taskActivityLog.get(taskId)!.length > 0) return;
    try {
      const entries = await api<Array<{ ts: string; msg: string }>>(`/api/tasks/${taskId}/activity`);
      if (entries.length > 0) {
        const log = entries.map(e => ({
          ts: e.ts ? new Date(e.ts).getTime() : Date.now(),
          msg: e.msg,
        }));
        taskActivityLog.set(taskId, log);
        setTasks(prev => [...prev]); // force re-render
      }
    } catch {}
  }, []);

  return { tasks, trees, paths, status, selectedTree, setSelectedTree, refresh, handleWsMessage, getActivity, getActivityLog, loadActivityLog };
}
