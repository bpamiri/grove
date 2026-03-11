// grove edit — Edit task fields (flag-based or interactive)
import { getDb } from "../core/db";
import { configRepos } from "../core/config";
import * as ui from "../core/ui";
import * as prompts from "../core/prompts";
import { EventType, Strategy } from "../types";
import type { Command, Task } from "../types";
import type { Database } from "../core/db";

const TERMINAL_STATUSES = new Set(["done", "completed", "failed"]);
const VALID_STRATEGIES = new Set(Object.values(Strategy));

/** DFS cycle detection: returns true if setting taskId's deps to newDeps would create a cycle */
function hasCycle(db: Database, taskId: string, newDeps: string[]): boolean {
  const visited = new Set<string>();

  function walk(depId: string): boolean {
    if (depId === taskId) return true;
    if (visited.has(depId)) return false;
    visited.add(depId);

    const depTask = db.taskGet(depId);
    if (!depTask?.depends_on) return false;

    const chain = depTask.depends_on.split(",").map((d) => d.trim()).filter(Boolean);
    for (const next of chain) {
      if (walk(next)) return true;
    }
    return false;
  }

  for (const dep of newDeps) {
    if (walk(dep)) return true;
  }
  return false;
}

/** Validate and apply a set of field changes. Returns false if validation failed (die was called). */
function applyChanges(
  db: Database,
  task: Task,
  changes: Record<string, string>,
): boolean {
  // Validate all fields first, before touching DB
  const validated: Array<{ field: string; dbField: string; value: any }> = [];

  for (const [key, value] of Object.entries(changes)) {
    switch (key) {
      case "title":
        if (!value.trim()) { ui.die("Title cannot be empty"); return false; }
        validated.push({ field: "title", dbField: "title", value });
        break;

      case "description":
        validated.push({ field: "description", dbField: "description", value: value === "" ? null : value });
        break;

      case "repo": {
        const repos = configRepos();
        if (!repos.includes(value)) {
          ui.die(`Repo '${value}' not found in config. Available: ${repos.join(", ")}`);
          return false;
        }
        validated.push({ field: "repo", dbField: "repo", value });
        break;
      }

      case "priority": {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < 1) { ui.die("Priority must be a positive integer"); return false; }
        validated.push({ field: "priority", dbField: "priority", value: n });
        break;
      }

      case "depends_on": {
        if (value === "") {
          validated.push({ field: "depends_on", dbField: "depends_on", value: null });
        } else {
          const depIds = value.split(",").map((d) => d.trim()).filter(Boolean);
          for (const depId of depIds) {
            if (!db.taskExists(depId)) {
              ui.die(`Dependency not found: ${depId}`);
              return false;
            }
          }
          if (hasCycle(db, task.id, depIds)) {
            ui.die(`Circular dependency detected`);
            return false;
          }
          validated.push({ field: "depends_on", dbField: "depends_on", value: depIds.join(",") });
        }
        break;
      }

      case "max_retries": {
        const n = parseInt(value, 10);
        if (isNaN(n) || n < 0) { ui.die("--max-retries requires a non-negative integer"); return false; }
        validated.push({ field: "max_retries", dbField: "max_retries", value: n });
        break;
      }

      case "strategy": {
        if (!VALID_STRATEGIES.has(value as Strategy)) {
          ui.die(`Invalid strategy '${value}'. Valid: ${[...VALID_STRATEGIES].join(", ")}`);
          return false;
        }
        validated.push({ field: "strategy", dbField: "strategy", value });
        break;
      }
    }
  }

  // Apply all validated changes
  const fields: string[] = [];
  for (const { field, dbField, value } of validated) {
    db.taskSet(task.id, dbField, value);
    fields.push(field);
  }

  if (fields.length > 0) {
    const summary = `Edited: ${fields.join(", ")}`;
    db.addEvent(task.id, EventType.StatusChange, summary);
    ui.success(`Updated ${task.id}: ${fields.join(", ")}`);
  }

  return true;
}

/** Interactive editing loop */
async function interactiveEdit(db: Database, task: Task): Promise<void> {
  ui.header(`Edit ${task.id}`);

  while (true) {
    // Refresh task from DB
    const current = db.taskGet(task.id)!;

    const choice = await prompts.numberedMenu("Select field to edit:", [
      `Title: ${current.title}`,
      `Description: ${current.description ?? "(none)"}`,
      `Repo: ${current.repo ?? "(none)"}`,
      `Priority: ${current.priority}`,
      `Dependencies: ${current.depends_on ?? "(none)"}`,
      `Max Retries: ${current.max_retries ?? "(global default)"}`,
      `Strategy: ${current.strategy ?? "(none)"}`,
      "Done",
    ]);

    if (choice === 7) break;

    switch (choice) {
      case 0: {
        const val = await prompts.text("Title:", { defaultValue: current.title });
        applyChanges(db, current, { title: val });
        break;
      }
      case 1: {
        const val = await prompts.text("Description:", { defaultValue: current.description ?? "" });
        applyChanges(db, current, { description: val });
        break;
      }
      case 2: {
        const repos = configRepos();
        const val = await prompts.choose(
          "Repo:",
          repos.map((r) => ({ value: r, label: r })),
        );
        applyChanges(db, current, { repo: val });
        break;
      }
      case 3: {
        const val = await prompts.text("Priority:", { defaultValue: String(current.priority) });
        applyChanges(db, current, { priority: val });
        break;
      }
      case 4: {
        const val = await prompts.text("Dependencies (comma-separated IDs):", {
          defaultValue: current.depends_on ?? "",
        });
        applyChanges(db, current, { depends_on: val });
        break;
      }
      case 5: {
        const val = await prompts.text("Max retries (empty for global default):", {
          defaultValue: current.max_retries != null ? String(current.max_retries) : "",
        });
        if (val === "") {
          db.taskSet(current.id, "max_retries", null);
          db.addEvent(current.id, EventType.StatusChange, "Edited: max_retries");
          ui.success(`Updated ${current.id}: max_retries`);
        } else {
          applyChanges(db, current, { max_retries: val });
        }
        break;
      }
      case 6: {
        const strategies = [...VALID_STRATEGIES];
        const val = await prompts.choose(
          "Strategy:",
          strategies.map((s) => ({ value: s, label: s })),
        );
        applyChanges(db, current, { strategy: val });
        break;
      }
    }
  }
}

export const editCommand: Command = {
  name: "edit",
  description: "Edit task fields",

  async run(args: string[]) {
    // Check for help
    if (args.includes("-h") || args.includes("--help")) {
      console.log(this.help!());
      return;
    }

    // Parse task ID (first non-flag arg)
    const taskId = args[0];
    if (!taskId || taskId.startsWith("-")) {
      return ui.die("Usage: grove edit TASK_ID [--field value ...]");
    }

    const db = getDb();

    // Fetch task
    const task = db.taskGet(taskId);
    if (!task) {
      return ui.die(`Task not found: ${taskId}`);
    }

    // Status gate
    if (TERMINAL_STATUSES.has(task.status)) {
      return ui.die(`Cannot edit task in ${task.status} status`);
    }

    // Parse remaining args as flag pairs
    const changes: Record<string, string> = {};
    let i = 1;
    while (i < args.length) {
      const arg = args[i];

      if (arg === "--title" && i + 1 < args.length) {
        changes.title = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--title=")) {
        changes.title = arg.slice("--title=".length);
        i++;
      } else if (arg === "--description" && i + 1 < args.length) {
        changes.description = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--description=")) {
        changes.description = arg.slice("--description=".length);
        i++;
      } else if (arg === "--repo" && i + 1 < args.length) {
        changes.repo = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--repo=")) {
        changes.repo = arg.slice("--repo=".length);
        i++;
      } else if (arg === "--priority" && i + 1 < args.length) {
        changes.priority = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--priority=")) {
        changes.priority = arg.slice("--priority=".length);
        i++;
      } else if (arg === "--depends" && i + 1 < args.length) {
        changes.depends_on = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--depends=")) {
        changes.depends_on = arg.slice("--depends=".length);
        i++;
      } else if (arg === "--max-retries" && i + 1 < args.length) {
        changes.max_retries = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--max-retries=")) {
        changes.max_retries = arg.slice("--max-retries=".length);
        i++;
      } else if (arg === "--no-retry") {
        changes.max_retries = "0";
        i++;
      } else if (arg === "--strategy" && i + 1 < args.length) {
        changes.strategy = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--strategy=")) {
        changes.strategy = arg.slice("--strategy=".length);
        i++;
      } else {
        return ui.die(`Unknown flag: ${arg}`);
      }
    }

    // If no flags, go interactive
    if (Object.keys(changes).length === 0) {
      await interactiveEdit(db, task);
      return;
    }

    // Apply flag-based changes
    applyChanges(db, task, changes);
  },

  help() {
    return [
      "Usage: grove edit TASK_ID [OPTIONS]",
      "",
      "Edit task fields. Without flags, opens interactive mode.",
      "",
      "Options:",
      "  --title TEXT          Set task title",
      "  --description TEXT    Set task description (empty clears)",
      "  --repo NAME          Reassign to a different repo",
      "  --priority N         Set priority (positive integer)",
      "  --depends IDS        Comma-separated dependency task IDs (empty clears)",
      "  --max-retries N      Max auto-retries (non-negative integer)",
      "  --no-retry           Disable auto-retry (sets max_retries to 0)",
      "  --strategy NAME      Set strategy (solo, team, sweep, pipeline)",
      "",
      "Status restrictions:",
      "  Tasks in done, completed, or failed status cannot be edited.",
      "",
      "Examples:",
      '  grove edit W-001 --title "New title"',
      "  grove edit W-001 --priority 10 --repo titan",
      "  grove edit W-001 --depends W-002,W-003",
      '  grove edit W-001 --depends ""       # clear dependencies',
      "  grove edit W-001 --no-retry",
      "  grove edit W-001                    # interactive mode",
    ].join("\n");
  },
};
