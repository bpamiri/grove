// grove prioritize — Interactive task priority reordering
import { getDb } from "../core/db";
import * as ui from "../core/ui";
import { EventType } from "../types";
import type { Command, Task } from "../types";
import { createInterface } from "node:readline";

interface TaskRow {
  id: string;
  repo: string;
  title: string;
  status: string;
  priority: number;
}

function showTable(tasks: TaskRow[]): void {
  console.log();
  console.log(
    `${ui.bold("  #   ")}${ui.bold(ui.pad("ID", 8))} ${ui.bold(ui.pad("REPO", 12))} ${ui.bold(ui.pad("TITLE", 30))} ${ui.bold(ui.pad("PRI", 5))} ${ui.bold("STATUS")}`,
  );
  console.log(
    `  --- -------- ------------ ------------------------------ ----- ------------`,
  );
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const num = String(i + 1);
    const displayTitle = ui.truncate(t.title, 28);
    console.log(
      `  ${ui.pad(num, 3)} ${ui.pad(t.id, 8)} ${ui.pad(t.repo, 12)} ${ui.pad(displayTitle, 30)} ${ui.pad(String(t.priority), 5)} ${t.status}`,
    );
  }
  console.log();
  console.log(ui.dim("Commands: move N up | move N down | set N priority P | show | done"));
}

function promptLine(rl: ReturnType<typeof createInterface>): Promise<string> {
  return new Promise((resolve) => {
    rl.question("> ", (answer) => {
      resolve(answer.trim());
    });
  });
}

export const prioritizeCommand: Command = {
  name: "prioritize",
  description: "Interactive task priority reordering",

  async run(args: string[]) {
    if (args.includes("-h") || args.includes("--help")) {
      console.log(this.help!());
      return;
    }

    if (!process.stdin.isTTY) {
      ui.die("Prioritize requires an interactive terminal.");
    }

    const db = getDb();

    ui.header("Prioritize Tasks");

    // Load non-completed tasks sorted by priority
    const rows = db.all<Task>(
      "SELECT id, repo, title, status, priority FROM tasks WHERE status != 'completed' ORDER BY priority ASC, created_at ASC",
    );

    if (rows.length === 0) {
      ui.info("No tasks to prioritize.");
      return;
    }

    // Build mutable task list
    const tasks: TaskRow[] = rows.map((r) => ({
      id: r.id,
      repo: r.repo || "-",
      title: r.title,
      status: r.status,
      priority: r.priority,
    }));

    let dirty = false;

    showTable(tasks);

    // REPL loop using raw readline (not @clack)
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      while (true) {
        const input = await promptLine(rl);

        if (!input) continue;

        // done / quit / exit
        if (/^(done|quit|q|exit)$/i.test(input)) {
          break;
        }

        // help
        if (/^(help|h|\?)$/i.test(input)) {
          console.log();
          console.log("  move N up       Move task #N up one position");
          console.log("  move N down     Move task #N down one position");
          console.log("  set N priority P  Set task #N priority to P (1-100)");
          console.log("  show            Redisplay the list");
          console.log("  done            Save and exit");
          console.log();
          continue;
        }

        // show
        if (/^(show|list|ls)$/i.test(input)) {
          showTable(tasks);
          continue;
        }

        // move N up
        const moveUpMatch = input.match(/^move\s+(\d+)\s+up$/i);
        if (moveUpMatch) {
          const num = parseInt(moveUpMatch[1], 10);
          const idx = num - 1;
          if (idx < 1 || idx >= tasks.length) {
            ui.warn(`Cannot move #${num} up.`);
            continue;
          }
          const prev = idx - 1;
          [tasks[idx], tasks[prev]] = [tasks[prev], tasks[idx]];
          dirty = true;
          ui.info(`Moved ${tasks[prev].id} up.`);
          showTable(tasks);
          continue;
        }

        // move N down
        const moveDownMatch = input.match(/^move\s+(\d+)\s+down$/i);
        if (moveDownMatch) {
          const num = parseInt(moveDownMatch[1], 10);
          const idx = num - 1;
          const next = idx + 1;
          if (idx < 0 || next >= tasks.length) {
            ui.warn(`Cannot move #${num} down.`);
            continue;
          }
          [tasks[idx], tasks[next]] = [tasks[next], tasks[idx]];
          dirty = true;
          ui.info(`Moved ${tasks[next].id} down.`);
          showTable(tasks);
          continue;
        }

        // set N priority P
        const setPriMatch = input.match(/^set\s+(\d+)\s+priority\s+(\d+)$/i);
        if (setPriMatch) {
          const num = parseInt(setPriMatch[1], 10);
          const pri = parseInt(setPriMatch[2], 10);
          const idx = num - 1;
          if (idx < 0 || idx >= tasks.length) {
            ui.warn(`Task #${num} does not exist.`);
            continue;
          }
          if (pri < 1 || pri > 100) {
            ui.warn("Priority must be 1-100.");
            continue;
          }
          tasks[idx].priority = pri;
          dirty = true;
          ui.info(`Set ${tasks[idx].id} priority to ${pri}.`);
          showTable(tasks);
          continue;
        }

        ui.warn("Unknown command. Type 'help' for options.");
      }
    } finally {
      rl.close();
    }

    // Save priorities
    if (dirty) {
      for (const task of tasks) {
        db.taskSet(task.id, "priority", task.priority);
      }
      db.addEvent(null, EventType.StatusChange, `Reprioritized ${tasks.length} tasks`);
      ui.success("Priorities saved.");
    } else {
      ui.info("No changes made.");
    }
  },

  help() {
    return [
      "Usage: grove prioritize",
      "",
      "Interactive priority reordering of active tasks.",
      "",
      "Shows all non-completed tasks sorted by current priority.",
      "Use commands to reorder:",
      "",
      "  move N up         Move task #N up one position",
      "  move N down       Move task #N down one position",
      "  set N priority P  Set task #N priority to P (1-100)",
      "  show              Redisplay the list",
      "  done              Save changes and exit",
      "",
      "Lower priority numbers sort first (1 = highest priority).",
    ].join("\n");
  },
};
