// grove hud — Interactive "Monday morning" dashboard
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { getDb, getEnv } from "../core/db";
import { workspaceName, budgetGet } from "../core/config";
import * as ui from "../core/ui";
import type { Command, Task, Event } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function todayString(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function budgetColor(spent: number, limit: number): string {
  if (limit <= 0) return "green";
  const ratio = spent / limit;
  if (ratio > 0.9) return "red";
  if (ratio > 0.7) return "yellow";
  return "green";
}

function colorize(text: string, color: string): string {
  switch (color) {
    case "red": return ui.pc.red(text);
    case "yellow": return ui.pc.yellow(text);
    case "green": return ui.pc.green(text);
    default: return text;
  }
}

/** Prompt the user with a numbered menu and return their choice (1-based) or null */
function promptChoice(choiceCount: number): Promise<number | null> {
  // Non-interactive — bail
  if (!process.stdin.isTTY) return Promise.resolve(null);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("  Choice: ", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (!trimmed || trimmed === "q" || trimmed === "Q") {
        resolve(null);
        return;
      }
      const n = parseInt(trimmed, 10);
      if (isNaN(n) || n < 1 || n > choiceCount) {
        resolve(null);
        return;
      }
      resolve(n);
    });
  });
}

// ---------------------------------------------------------------------------
// Main HUD
// ---------------------------------------------------------------------------

export const hudCommand: Command = {
  name: "hud",
  description: "Interactive dashboard (default when no command given)",

  async run() {
    const { GROVE_DB } = getEnv();
    if (!existsSync(GROVE_DB)) {
      ui.die("Grove not initialized. Run 'grove init' first.");
    }

    const db = getDb();
    const wsName = workspaceName();

    // --- Greeting ---
    ui.logo();
    console.log(`  ${ui.bold(wsName)}  ${ui.dim(`v0.2.0`)}`);
    console.log(`  ${greeting()} — ${todayString()}`);
    console.log();

    // --- Empty state ---
    const totalTasks = db.taskCount();
    if (totalTasks === 0) {
      console.log(`  ${ui.dim("No tasks yet.")}`);
      console.log(`  Run ${ui.bold("grove add")} or ${ui.bold("grove sync")} to get started.\n`);
      db.configSet("last_hud_view", new Date().toISOString());
      return;
    }

    // Menu items: parallel arrays
    const menuLabels: string[] = [];
    const menuActions: string[] = [];

    // --- COMPLETED section ---
    const lastHud = db.configGet("last_hud_view");
    let completedTasks: Task[];
    if (lastHud) {
      completedTasks = db.all<Task>(
        `SELECT id, repo, title FROM tasks
         WHERE status IN ('completed', 'done')
           AND (completed_at >= ? OR updated_at >= ?)
         ORDER BY completed_at DESC LIMIT 10`,
        [lastHud, lastHud],
      );
    } else {
      completedTasks = db.all<Task>(
        `SELECT id, repo, title FROM tasks
         WHERE status IN ('completed', 'done')
         ORDER BY completed_at DESC LIMIT 10`,
      );
    }

    if (completedTasks.length > 0) {
      console.log(`  ${ui.bold(ui.pc.green("COMPLETED"))}`);
      for (const t of completedTasks) {
        console.log(
          `    ${ui.statusBadge("done")} ${ui.dim(t.id)}  ${ui.truncate(t.title, 50)}`,
        );
      }
      console.log();
    }

    // --- IN PROGRESS section (running + paused) ---
    const inProgress = db.all<Task>(
      `SELECT id, repo, title, status, session_summary, next_steps
       FROM tasks WHERE status IN ('running', 'paused')
       ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, priority ASC`,
    );

    if (inProgress.length > 0) {
      console.log(`  ${ui.bold(ui.pc.yellow("IN PROGRESS"))}`);
      for (const t of inProgress) {
        console.log(
          `    ${ui.statusBadge(t.status)} ${ui.dim(t.id)} ${ui.dim(t.repo ?? "")}  ${ui.truncate(t.title, 44)}`,
        );

        // Last activity
        if (t.session_summary) {
          console.log(`      ${ui.dim("Last:")} ${ui.truncate(t.session_summary, 60)}`);
        } else {
          const lastEvt = db.get<Event>(
            "SELECT summary FROM events WHERE task_id = ? ORDER BY timestamp DESC LIMIT 1",
            [t.id],
          );
          if (lastEvt?.summary) {
            console.log(`      ${ui.dim("Last:")} ${ui.truncate(lastEvt.summary, 60)}`);
          }
        }

        // Next steps
        if (t.next_steps) {
          console.log(`      ${ui.dim("Next:")} ${ui.truncate(t.next_steps, 60)}`);
        }

        // Menu entries
        if (t.status === "paused") {
          menuLabels.push(`Resume ${t.id}: ${ui.truncate(t.title, 40)}`);
          menuActions.push(`resume ${t.id}`);
        } else if (t.status === "running") {
          menuLabels.push(`Watch ${t.id}: ${ui.truncate(t.title, 40)}`);
          menuActions.push(`watch ${t.id}`);
        }
      }
      console.log();
    }

    // --- READY TO START section ---
    const readyTasks = db.all<Task>(
      `SELECT id, repo, title, strategy, estimated_cost
       FROM tasks WHERE status = 'ready'
       ORDER BY priority ASC, created_at ASC LIMIT 10`,
    );

    if (readyTasks.length > 0) {
      console.log(`  ${ui.bold(ui.pc.blue("READY TO START"))}`);
      for (const t of readyTasks) {
        const costStr = t.estimated_cost && t.estimated_cost > 0
          ? ` ~${ui.dollars(t.estimated_cost)}`
          : "";
        const stratStr = t.strategy ? ` (${t.strategy})` : "";
        console.log(
          `    ${ui.statusBadge("ready")} ${ui.dim(t.id)} ${ui.dim(t.repo ?? "")}  ${ui.truncate(t.title, 40)}${ui.dim(`${stratStr}${costStr}`)}`,
        );

        menuLabels.push(`Start ${t.id}: ${ui.truncate(t.title, 40)}`);
        menuActions.push(`work ${t.id}`);
      }
      console.log();
    }

    // --- BLOCKED section ---
    const blockedCandidates = db.all<Task>(
      `SELECT id, repo, title, depends_on FROM tasks
       WHERE depends_on IS NOT NULL AND depends_on != ''
         AND status NOT IN ('completed', 'done', 'failed')
       ORDER BY priority ASC`,
    );

    const blockedLines: string[] = [];
    for (const t of blockedCandidates) {
      if (db.isTaskBlocked(t.id)) {
        blockedLines.push(
          `    ${ui.badge("blocked", "red")} ${ui.dim(t.id)} ${ui.dim(t.repo ?? "")}  ${ui.truncate(t.title, 44)}`,
        );
        blockedLines.push(`      ${ui.dim(`Waiting on: ${t.depends_on}`)}`);
      }
    }

    if (blockedLines.length > 0) {
      console.log(`  ${ui.bold(ui.pc.red("BLOCKED"))}`);
      for (const line of blockedLines) {
        console.log(line);
      }
      console.log();
    }

    // --- Queued counts ---
    const ingestedCount = db.taskCount("ingested");
    const plannedCount = db.taskCount("planned");
    const reviewCount = db.taskCount("review");

    if (ingestedCount > 0 || plannedCount > 0 || reviewCount > 0) {
      let queued = `  ${ui.dim("Queued:")}`;
      if (ingestedCount > 0) queued += ` ${ingestedCount} ingested`;
      if (plannedCount > 0) queued += ` ${plannedCount} planned`;
      if (reviewCount > 0) queued += ` ${reviewCount} awaiting review`;
      console.log(queued);
    }

    // --- Budget line ---
    const weekCost = db.costWeek();
    const weekBudget = budgetGet("per_week");
    const bColor = budgetColor(weekCost, weekBudget);
    console.log(
      `  ${ui.dim("Budget:")} ${colorize(ui.dollars(weekCost), bColor)} / ${ui.dollars(weekBudget)} this week`,
    );
    console.log();

    // --- Extra menu entries ---
    if (reviewCount > 0) {
      menuLabels.push(`Review PRs (${reviewCount} pending)`);
      menuActions.push("review");
    }
    if (ingestedCount > 0) {
      menuLabels.push(`Plan ingested tasks (${ingestedCount})`);
      menuActions.push("plan");
    }

    // --- Update last_hud_view ---
    db.configSet("last_hud_view", new Date().toISOString());

    // --- Interactive menu ---
    if (menuLabels.length === 0) {
      console.log(`  ${ui.dim("Nothing actionable right now.")}`);
      console.log(`  Run ${ui.bold("grove add")} or ${ui.bold("grove sync")} to bring in work.\n`);
      return;
    }

    if (!process.stdin.isTTY) return;

    console.log(`  ${ui.bold("What next?")}`);
    for (let i = 0; i < menuLabels.length; i++) {
      console.log(`    ${ui.bold(`[${i + 1}]`)} ${menuLabels[i]}`);
    }
    console.log(`    ${ui.bold("[q]")} Quit`);
    console.log();

    const choice = await promptChoice(menuLabels.length);
    if (choice === null) return;

    const action = menuActions[choice - 1];
    if (!action) return;

    console.log();
    const [actionCmd, ...actionRest] = action.split(" ");

    // Lazy-load and dispatch
    try {
      const mod = await import(`./${actionCmd}.ts`);
      const cmd: Command | undefined =
        mod[`${actionCmd}Command`] ?? Object.values(mod).find((v: any) => v?.run);
      if (cmd) {
        await cmd.run(actionRest);
      } else {
        ui.warn(`Command not yet implemented: ${actionCmd}`);
      }
    } catch {
      ui.warn(`Command not yet implemented: ${actionCmd}`);
    }
  },

  help() {
    return `Usage: grove

Show the interactive HUD (Heads-Up Display).

The HUD is the default command when you run grove with no arguments.
It shows:
  - Recently completed tasks
  - In-progress and paused tasks
  - Tasks ready to start
  - Blocked tasks
  - Budget summary
  - Interactive menu to resume, start, or review work

For a non-interactive summary, use: grove status`;
  },
};
