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
  orchestrator: string;
  workers: number;
  wsClients: number;
  tasks: { total: number; running: number; done: number; planned: number };
  cost: { today: number; week: number };
}

// Activity messages per task (transient, not from DB)
const taskActivity = new Map<string, string>();

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [trees, setTrees] = useState<Tree[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [selectedTree, setSelectedTree] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [tasksData, treesData, statusData] = await Promise.all([
        api<Task[]>(selectedTree ? `/api/tasks?tree=${selectedTree}` : "/api/tasks"),
        api<Tree[]>("/api/trees"),
        api<Status>("/api/status"),
      ]);
      setTasks(tasksData);
      setTrees(treesData);
      setStatus(statusData);
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
      case "worker:activity":
        taskActivity.set(msg.data.taskId, msg.data.msg);
        // Force re-render by updating the task (status hasn't changed but activity has)
        setTasks(prev => [...prev]);
        break;
      case "worker:spawned":
      case "worker:ended":
      case "cost:updated":
        // Refresh all data for these events
        refresh();
        break;
    }
  }, [refresh]);

  const getActivity = (taskId: string): string | undefined => taskActivity.get(taskId);

  return { tasks, trees, status, selectedTree, setSelectedTree, refresh, handleWsMessage, getActivity };
}
