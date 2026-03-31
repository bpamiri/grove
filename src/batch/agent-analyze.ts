// Grove v3 — Agent-powered batch file prediction via Claude Code subprocess
import type { Task } from "../shared/types";
import type { TaskAnalysis } from "./types";

const MAX_FILES_IN_PROMPT = 500;

/** Build the prompt for Claude to predict file modifications for a batch of tasks */
export function buildAgentPrompt(tasks: Task[], repoFiles: string[]): string {
  const taskList = tasks.map((t, i) =>
    `${i + 1}. ${t.id}: "${t.title}"${t.description ? ` — ${t.description.slice(0, 300)}` : ""}`
  ).join("\n");

  let fileList: string;
  if (repoFiles.length > MAX_FILES_IN_PROMPT) {
    fileList = repoFiles.slice(0, MAX_FILES_IN_PROMPT).join("\n") +
      `\n\n(${repoFiles.length - MAX_FILES_IN_PROMPT} more files truncated)`;
  } else {
    fileList = repoFiles.join("\n");
  }

  return `You are analyzing development tasks for a codebase. For each task, predict which files will likely be modified during implementation.

Here are the tasks:

${taskList}

Here are the files in the repository:
${fileList}

For each task, return a JSON object mapping task IDs to arrays of predicted file paths. Only include files from the repository list above. Return ONLY the JSON object, no other text.

Example format:
{
  "${tasks[0]?.id ?? "W-001"}": ["path/to/file1.ts", "path/to/file2.ts"],
  "${tasks[1]?.id ?? "W-002"}": ["path/to/file3.ts"]
}`;
}

/** Parse Claude's response text into TaskAnalysis array */
export function parseAgentResponse(
  responseText: string,
  tasks: Task[],
  repoFiles: string[],
): TaskAnalysis[] {
  const repoFileSet = new Set(repoFiles);
  let parsed: Record<string, string[]> | null = null;

  // Try direct JSON parse first
  try {
    parsed = JSON.parse(responseText.trim());
  } catch {
    // Try extracting JSON from markdown code block
    const codeBlockMatch = responseText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      try {
        parsed = JSON.parse(codeBlockMatch[1].trim());
      } catch { /* fall through */ }
    }
  }

  // If still unparseable, try finding first { ... } block
  if (!parsed) {
    const braceMatch = responseText.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        parsed = JSON.parse(braceMatch[0]);
      } catch { /* fall through */ }
    }
  }

  return tasks.map(task => {
    const predicted = parsed?.[task.id];
    if (!predicted || !Array.isArray(predicted)) {
      return { taskId: task.id, title: task.title, predictedFiles: [], confidence: "low" as const };
    }

    const validFiles = predicted.filter(f => repoFileSet.has(f));

    return {
      taskId: task.id,
      title: task.title,
      predictedFiles: validFiles.sort(),
      confidence: validFiles.length > 0 ? "high" as const : "low" as const,
    };
  });
}

/** Spawn Claude Code to analyze tasks and return file predictions */
export async function agentAnalyzeBatch(
  tasks: Task[],
  repoFiles: string[],
): Promise<TaskAnalysis[]> {
  const prompt = buildAgentPrompt(tasks, repoFiles);

  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--output-format", "stream-json", "--dangerously-skip-permissions"],
    { stdout: "pipe", stderr: "pipe" },
  );

  const chunks: string[] = [];
  const reader = proc.stdout.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }

  const exitCode = await proc.exited;
  const output = chunks.join("");

  if (exitCode !== 0) {
    throw new Error(`Claude process exited with code ${exitCode}`);
  }

  // Parse stream-json output: find the last "assistant" message with text content
  let responseText = "";
  for (const line of output.split("\n")) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "assistant") {
        for (const block of obj.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            responseText = block.text;
          }
        }
      }
      if (obj.type === "result") {
        for (const block of obj.result?.content ?? obj.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            responseText = block.text;
          }
        }
      }
    } catch { /* skip non-JSON lines */ }
  }

  if (!responseText) {
    throw new Error("No text response from Claude");
  }

  return parseAgentResponse(responseText, tasks, repoFiles);
}
