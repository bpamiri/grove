// Grove v3 — Orchestrator event parsing and handling (extracted from orchestrator.ts)
// Standalone, testable module for parsing JSONL events and updating state.
import type { BrokerEvent, Task } from "../shared/types";
import type { Database } from "../broker/db";
import { bus } from "../broker/event-bus";

/**
 * Parse a single text line as a JSON BrokerEvent.
 * Returns null if the line is not valid JSON or lacks a `type` field.
 */
export function parseOrchestratorEvent(line: string): BrokerEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (!obj.type) return null;
    return obj as BrokerEvent;
  } catch {
    return null;
  }
}

/**
 * Process a parsed BrokerEvent by updating the database and emitting bus events.
 * Handles: spawn_worker, user_response, task_update.
 */
export function handleOrchestratorEvent(event: BrokerEvent, db: Database): void {
  switch (event.type) {
    case "spawn_worker": {
      const task: Task = {
        id: event.task,
        tree_id: event.tree,
        parent_task_id: null,
        title: event.prompt,
        description: event.prompt,
        status: "queued",
        current_step: null,
        step_index: 0,
        paused: 0,
        path_name: "development",
        priority: 0,
        depends_on: event.depends_on ?? null,
        branch: null,
        worktree_path: null,
        github_issue: null,
        pr_url: null,
        pr_number: null,
        cost_usd: 0,
        tokens_used: 0,
        gate_results: null,
        session_summary: null,
        files_modified: null,
        retry_count: 0,
        max_retries: 2,
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
      };
      bus.emit("task:created", { task });
      break;
    }

    case "user_response":
      db.addMessage("orchestrator", event.text);
      bus.emit("message:new", {
        message: {
          id: 0,
          source: "orchestrator",
          channel: "main",
          content: event.text,
          created_at: new Date().toISOString(),
        },
      });
      break;

    case "task_update":
      if (event.field === "status") {
        const newStatus = event.value as string;
        if (newStatus === "completed") {
          db.run(
            "UPDATE tasks SET status = 'completed', current_step = '$done', completed_at = datetime('now') WHERE id = ?",
            [event.task]
          );
          db.addEvent(event.task, null, "task_completed", "Marked completed by orchestrator");
        } else if (newStatus === "failed") {
          db.run(
            "UPDATE tasks SET status = 'failed', current_step = '$fail' WHERE id = ?",
            [event.task]
          );
          db.addEvent(event.task, null, "task_failed", "Marked failed by orchestrator");
        } else {
          db.taskSetStatus(event.task, newStatus);
        }
        bus.emit("task:status", { taskId: event.task, status: newStatus });
      }
      break;
  }
}
