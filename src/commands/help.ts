// grove help — Show usage overview or detailed help
import * as ui from "../core/ui";
import { GROVE_VERSION } from "../types";
import type { Command } from "../types";

export const helpCommand: Command = {
  name: "help",
  description: "Show help for Grove commands",

  async run(args: string[], commands?: Map<string, Command>) {
    const target = args[0];

    if (target && commands?.has(target)) {
      const cmd = commands.get(target)!;
      if (cmd.help) {
        console.log(cmd.help());
      } else {
        console.log(`${ui.bold(cmd.name)} — ${cmd.description}`);
        console.log("\nNo detailed help available.");
      }
      return;
    }

    if (target) {
      ui.error(`Unknown command: ${target}`);
      console.log('Run "grove help" for available commands.');
      return;
    }

    // Full help listing
    console.log(`\n${ui.bold(`Grove v${GROVE_VERSION}`)} — Development Command Center\n`);

    const sections: [string, string[]][] = [
      ["HUD & Status", [
        "grove              Open the interactive HUD",
        "grove status       Quick text summary (pipe-friendly)",
      ]],
      ["Task Management", [
        "grove add          Add a task (interactive or quick)",
        "grove tasks        List tasks (--all, --status, --repo)",
        "grove plan [ID]    Assign strategy to task(s)",
        "grove prioritize   Interactive priority reordering",
        "grove sync         Pull issues from GitHub",
      ]],
      ["Execution", [
        "grove work [ID]    Start working (batch or specific)",
        "grove run ID       Execute without prompts",
        "grove drain        Continuously dispatch until queue empty",
        "grove resume ID    Resume a paused task",
        "grove pause ID     Save state and stop",
        "grove cancel ID    Stop and clean up",
      ]],
      ["Monitoring", [
        "grove dashboard    Live-updating TUI",
        "grove health       Worker health report + reap",
        "grove watch ID     Tail worker output",
        "grove detach [ID]  Worker continues in background",
        "grove msg ID MSG   Queue message for worker",
        "grove log [ID]     Event timeline",
      ]],
      ["PR & Review", [
        "grove prs          List open Grove PRs",
        "grove review       Interactive PR review",
        "grove done ID      Mark complete (checks merge)",
        "grove close ID     Close without completing",
      ]],
      ["Reporting", [
        "grove cost         Cost breakdown (--today, --week)",
        "grove report       Markdown summary (--week, --output)",
      ]],
      ["Configuration", [
        "grove init         Set up ~/.grove/",
        "grove config       View/edit settings",
        "grove repos        List configured repos",
        "grove help [CMD]   Show help",
      ]],
    ];

    for (const [title, lines] of sections) {
      console.log(`  ${ui.bold(title)}`);
      for (const line of lines) {
        console.log(`    ${line}`);
      }
      console.log();
    }
  },

  help() {
    return `Usage: grove help [COMMAND]

With no arguments, shows all available commands grouped by category.
With a command name, shows detailed help for that command.

Examples:
  grove help
  grove help add
  grove help work`;
  },
};
