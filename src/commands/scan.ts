// grove scan — Auto-discover work from repos
import { existsSync } from "node:fs";
import { getDb } from "../core/db";
import { configRepoDetail } from "../core/config";
import * as ui from "../core/ui";
import { SourceType, EventType } from "../types";
import type { Command } from "../types";
import type { Database } from "../core/db";
import { scanMarkers, scanSignals, scanDeep } from "../lib/scanner";
import type { Finding } from "../lib/scanner";

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderDryRun(findingsByRepo: Map<string, Finding[]>): void {
  ui.header("Scan — Dry Run");

  let total = 0;
  for (const [repoName, findings] of findingsByRepo) {
    console.log(`\n  ${ui.bold(repoName)} (${findings.length} finding(s))`);
    for (const f of findings) {
      const loc = f.line != null ? `${f.file}:${f.line}` : f.file;
      console.log(`    ${f.type.padEnd(10)} ${loc}  ${ui.dim(ui.truncate(f.title, 50))}`);
    }
    total += findings.length;
  }

  const repoCount = findingsByRepo.size;
  console.log(`\nTotal: ${total} finding(s) across ${repoCount} repo(s)`);
  console.log("Run with --apply to create tasks, or --interactive to triage.");
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function applyFindings(findings: Finding[], db: Database): void {
  for (const f of findings) {
    const prefix = f.repo.charAt(0).toUpperCase();
    const taskId = db.nextTaskId(prefix);
    db.exec(
      "INSERT INTO tasks (id, repo, source_type, source_ref, title, description, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [taskId, f.repo, SourceType.Scan, f.sourceRef, f.title, f.description, "ingested", f.priority],
    );
    db.addEvent(taskId, EventType.Created, "Discovered by grove scan");
    console.log(`  ${ui.bold(taskId)}  ${f.title}`);
  }
  ui.success(`Scan complete: ${findings.length} task(s) created.`);
}

// ---------------------------------------------------------------------------
// Interactive triage (requires readline)
// ---------------------------------------------------------------------------

async function triageFindings(findings: Finding[], db: Database): Promise<void> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  let created = 0;
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const loc = f.line != null ? `${f.file}:${f.line}` : f.file;
    console.log(`\n[${i + 1}/${findings.length}] ${f.type} ${loc}`);
    console.log(`  ${f.title}`);
    if (f.description) console.log(`  ${ui.dim(f.description)}`);

    const answer = await ask("  [a]ccept [s]kip [e]dit [q]uit > ");
    const choice = answer.trim().toLowerCase();

    if (choice === "a") {
      applyFindings([f], db);
      created++;
    } else if (choice === "e") {
      const newTitle = await ask("  New title: ");
      if (newTitle.trim()) f.title = newTitle.trim();
      applyFindings([f], db);
      created++;
    } else if (choice === "q") {
      break;
    }
    // "s" or anything else -> skip
  }

  rl.close();
  if (created > 0) {
    ui.success(`Triage complete: ${created} task(s) created.`);
  } else {
    console.log("No tasks created.");
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function help(): string {
  return [
    "Usage: grove scan [OPTIONS]",
    "",
    "Auto-discover work from code markers, signals, and deep analysis.",
    "",
    "Tiers:",
    "  Markers   TODO, FIXME, HACK, XXX, DEPRECATED comments",
    "  Signals   Outdated deps, missing configs, stale branches",
    "  Deep      AI-powered analysis (--deep)",
    "",
    "Modes:",
    "  (default)       Dry-run -- preview findings without creating tasks",
    "  --apply         Create tasks for all findings",
    "  --interactive   Triage each finding one by one",
    "  --dry-run       Explicitly preview (same as default)",
    "",
    "Options:",
    "  --repo NAME     Scan only the named repo",
    "  --limit N       Max findings per repo (default: 50)",
    "  --deep          Run deep AI analysis (smells + tests)",
    "  --deep=CATS     Deep categories (comma-separated: smells,tests)",
    "  -h, --help      Show this help",
    "",
    "Examples:",
    "  grove scan                       # dry-run all repos",
    "  grove scan --apply               # create tasks from findings",
    "  grove scan --repo wheels         # scan only wheels repo",
    "  grove scan --limit 10 --apply    # cap at 10 findings per repo",
    "  grove scan --interactive         # triage findings one by one",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const scanCommand: Command = {
  name: "scan",
  description: "Auto-discover work from code markers, signals, and deep analysis",

  async run(args: string[]) {
    // Help check
    if (args.includes("-h") || args.includes("--help")) {
      console.log(help());
      return;
    }

    // Parse flags
    let filterRepo: string | null = null;
    let mode: "dry-run" | "apply" | "interactive" = "dry-run";
    let limit = 50;
    let wantDeep = false;
    let deepCategories: string[] = ["smells", "tests"];

    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--repo" && i + 1 < args.length) {
        filterRepo = args[i + 1]; i += 2;
      } else if (arg.startsWith("--repo=")) {
        filterRepo = arg.slice("--repo=".length); i++;
      } else if (arg === "--apply") {
        mode = "apply"; i++;
      } else if (arg === "--interactive") {
        mode = "interactive"; i++;
      } else if (arg === "--dry-run") {
        i++; // explicit dry-run, mode stays default
      } else if (arg === "--deep") {
        wantDeep = true; i++;
      } else if (arg.startsWith("--deep=")) {
        wantDeep = true;
        deepCategories = arg.slice("--deep=".length).split(",");
        i++;
      } else if (arg === "--limit" && i + 1 < args.length) {
        limit = parseInt(args[i + 1], 10); i += 2;
      } else if (arg.startsWith("--limit=")) {
        limit = parseInt(arg.slice("--limit=".length), 10); i++;
      } else if (arg === "--limit") {
        return ui.die("--limit requires a value");
      } else {
        return ui.die(`Unknown flag: ${arg}`);
      }
    }

    if (isNaN(limit) || limit < 1) return ui.die("--limit must be a positive integer");

    // Get repo configs
    const repoConfigs = configRepoDetail();
    let repos = Object.entries(repoConfigs);

    // Filter by --repo if specified
    if (filterRepo) {
      repos = repos.filter(([name]) => name === filterRepo);
    }

    if (repos.length === 0) {
      return ui.die("No repos configured.");
    }

    // Cost guard for deep scanning
    if (wantDeep) {
      const repoCount = repos.filter(([, rc]) => existsSync(rc.path)).length;
      ui.info(`Deep analysis will scan ${repoCount} repo(s). This uses Claude API credits.`);

      if (mode !== "apply") {
        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) =>
          rl.question("  Continue with deep scan? [y/N] ", resolve),
        );
        rl.close();
        if (answer.trim().toLowerCase() !== "y") {
          console.log("Deep scan cancelled.");
          return;
        }
      }
    }

    // Scan each repo
    const findingsByRepo = new Map<string, Finding[]>();
    const allFindings: Finding[] = [];

    for (const [repoName, rc] of repos) {
      const repoPath = rc.path;
      if (!existsSync(repoPath)) {
        ui.warn(`Repo path not found, skipping: ${repoPath}`);
        continue;
      }

      const markers = scanMarkers(repoPath, repoName, limit);
      const signals = scanSignals(repoPath, repoName, limit);
      const repoFindings = [...markers, ...signals];

      if (wantDeep) {
        const deepFindings = scanDeep(repoPath, repoName, deepCategories, limit);
        repoFindings.push(...deepFindings);
      }

      findingsByRepo.set(repoName, repoFindings.slice(0, limit));
      allFindings.push(...repoFindings.slice(0, limit));
    }

    // Dedup: filter out findings whose source_ref already exists in DB
    const db = getDb();
    const newFindings = allFindings.filter(
      (f) => !db.get("SELECT 1 FROM tasks WHERE source_ref = ?", [f.sourceRef]),
    );

    // Rebuild findingsByRepo from deduped newFindings so dry-run matches apply
    const dedupedByRepo = new Map<string, Finding[]>();
    for (const f of newFindings) {
      const arr = dedupedByRepo.get(f.repo);
      if (arr) arr.push(f);
      else dedupedByRepo.set(f.repo, [f]);
    }

    // Dispatch
    if (mode === "dry-run") {
      renderDryRun(dedupedByRepo);
    } else if (mode === "apply") {
      applyFindings(newFindings, db);
    } else if (mode === "interactive") {
      await triageFindings(newFindings, db);
    }
  },

  help,
};
