// grove add — Create a new task (quick one-liner or interactive)
import { getDb, getEnv } from "../core/db";
import { configRepos } from "../core/config";
import * as ui from "../core/ui";
import * as prompts from "../core/prompts";
import { SourceType, EventType } from "../types";
import type { Command } from "../types";

export const addCommand: Command = {
  name: "add",
  description: "Create a new task",

  async run(args: string[]) {
    const db = getDb();
    const { GROVE_CONFIG } = getEnv();

    let description = "";
    let repo = "";
    let depends = "";

    // Parse arguments
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--repo" && i + 1 < args.length) {
        repo = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--repo=")) {
        repo = arg.slice("--repo=".length);
        i++;
      } else if (arg === "--depends" && i + 1 < args.length) {
        depends = args[i + 1];
        i += 2;
      } else if (arg.startsWith("--depends=")) {
        depends = arg.slice("--depends=".length);
        i++;
      } else if (arg === "-h" || arg === "--help") {
        console.log(this.help!());
        return;
      } else {
        description = description ? `${description} ${arg}` : arg;
        i++;
      }
    }

    // Interactive mode if no description provided
    if (!description) {
      ui.header("Add Task");
      description = await prompts.text("Describe the task:", {
        validate: (v) => {
          if (!v.trim()) return "Task description cannot be empty.";
        },
      });
    }

    // Get configured repos
    const repoNames = configRepos();
    if (repoNames.length === 0) {
      ui.die(`No repos configured. Add repos to ${GROVE_CONFIG} first.`);
    }

    // If no repo specified, try to detect from description keywords
    if (!repo) {
      const descLower = description.toLowerCase();
      let matchedRepo = "";
      let matchCount = 0;

      for (const r of repoNames) {
        if (descLower.includes(r.toLowerCase())) {
          matchedRepo = r;
          matchCount++;
        }
      }

      if (matchCount === 1) {
        repo = matchedRepo;
        ui.info(`Detected repo: ${repo}`);
      } else if (matchCount > 1) {
        ui.info("Multiple repos detected in description.");
      }
    }

    // If still no repo, prompt user to choose
    if (!repo) {
      if (repoNames.length === 1) {
        repo = repoNames[0];
        ui.info(`Using repo: ${repo}`);
      } else {
        repo = await prompts.choose(
          "Which repo?",
          repoNames.map((r) => ({ value: r, label: r })),
        );
      }
    }

    // Validate repo exists in config
    if (!repoNames.includes(repo)) {
      ui.die(
        `Repo '${repo}' not found in config. Available: ${repoNames.join(", ")}`,
      );
    }

    // Validate dependency IDs exist
    if (depends) {
      const depIds = depends.split(",").map((d) => d.trim()).filter(Boolean);
      for (const depId of depIds) {
        if (!db.taskExists(depId)) {
          ui.die(`Dependency not found: ${depId}`);
        }
      }
    }

    // Generate task ID: first letter of repo name, uppercased
    const prefix = repo.charAt(0).toUpperCase();
    const taskId = db.nextTaskId(prefix);

    // Insert task
    db.exec(
      `INSERT INTO tasks (id, repo, source_type, title, description, status, priority, depends_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [taskId, repo, SourceType.Manual, description, description, "ingested", 50, depends || null],
    );

    // Log event
    db.addEvent(taskId, EventType.Created, "Task created manually");

    ui.success(`Created ${taskId}: ${description}`);
    console.log(`  ${ui.dim("Repo:")}     ${repo}`);
    console.log(`  ${ui.dim("Status:")}   ingested`);
    console.log(`  ${ui.dim("Priority:")} 50`);

    // Offer to start work immediately (only in interactive TTY)
    if (process.stdin.isTTY) {
      console.log();
      const startNow = await prompts.confirm("Start working on this now?");
      if (startNow) {
        try {
          const { workCommand } = await import("./work");
          await workCommand.run([taskId]);
        } catch {
          ui.info(`Next: grove plan ${taskId}`);
        }
      }
    }
  },

  help() {
    return [
      "Usage: grove add [DESCRIPTION] [--repo NAME] [--depends IDS]",
      "",
      "Create a new task. Two modes:",
      "",
      '  Quick:       grove add "Fix route parsing" --repo wheels',
      "  Interactive: grove add",
      "",
      "Options:",
      "  --repo NAME        Assign to a specific repository",
      "  --depends IDS      Comma-separated task IDs this depends on",
      "",
      "Dependencies prevent dispatch until all listed tasks complete.",
      "",
      'The task starts in "ingested" status. Run "grove plan TASK"',
      'to assign a strategy, or "grove work TASK" to start immediately.',
    ].join("\n");
  },
};
