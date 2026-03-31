#!/usr/bin/env bun
// Mock Claude CLI for integration tests
// Behavior controlled by MOCK_CLAUDE_BEHAVIOR env var:
//   "success"  — emit assistant message + tool_use + result with cost (default)
//   "fail"     — emit error result with exit code 1
//   "seed"     — emit seed_complete JSON event
//   "slow"     — 2s delay between events
//   "crash"    — exit mid-stream with code 1

const behavior = process.env.MOCK_CLAUDE_BEHAVIOR ?? "success";
const args = process.argv.slice(2);

// Parse -p flag for prompt
const pIdx = args.indexOf("-p");
const prompt = pIdx >= 0 ? args[pIdx + 1] ?? "" : "";

// Parse --session-id or --resume for session tracking
const sessionIdx = args.indexOf("--session-id");
const resumeIdx = args.indexOf("--resume");
const sessionId = sessionIdx >= 0 ? args[sessionIdx + 1] : (resumeIdx >= 0 ? args[resumeIdx + 1] : null);

// Store session state in /tmp for --resume support
const sessionDir = "/tmp/mock-claude-sessions";
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
mkdirSync(sessionDir, { recursive: true });

if (sessionId && resumeIdx >= 0 && existsSync(`${sessionDir}/${sessionId}.json`)) {
  const state = JSON.parse(readFileSync(`${sessionDir}/${sessionId}.json`, "utf-8"));
  state.messageCount++;
  writeFileSync(`${sessionDir}/${sessionId}.json`, JSON.stringify(state));
} else if (sessionId) {
  writeFileSync(`${sessionDir}/${sessionId}.json`, JSON.stringify({ sessionId, messageCount: 1 }));
}

function emit(obj: any) {
  console.log(JSON.stringify(obj));
}

async function run() {
  switch (behavior) {
    case "success": {
      emit({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "I'll implement this now." },
            { type: "tool_use", name: "Read", input: { file_path: "src/main.ts" } },
          ],
        },
      });
      emit({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Edit", input: { file_path: "src/main.ts" } },
            { type: "text", text: "Done. Changes committed." },
          ],
        },
      });
      emit({ type: "result", cost_usd: 0.05, usage: { input_tokens: 1000, output_tokens: 500 }, subtype: "success" });
      process.exit(0);
      break;
    }

    case "fail": {
      emit({
        type: "assistant",
        message: { content: [{ type: "text", text: "I encountered an error." }] },
      });
      emit({ type: "result", cost_usd: 0.02, usage: { input_tokens: 500, output_tokens: 100 }, subtype: "error_max_turns" });
      process.exit(1);
      break;
    }

    case "seed": {
      emit({
        type: "assistant",
        message: {
          content: [{
            type: "text",
            text: 'Let me explore the codebase.\n{"type":"seed_complete","summary":"Auth redesign with JWT","spec":"## Spec\\nUse JWT tokens with refresh."}',
          }],
        },
      });
      emit({ type: "result", cost_usd: 0.03, usage: { input_tokens: 800, output_tokens: 300 }, subtype: "success" });
      process.exit(0);
      break;
    }

    case "slow": {
      emit({ type: "assistant", message: { content: [{ type: "text", text: "Starting..." }] } });
      await new Promise(r => setTimeout(r, 2000));
      emit({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
      emit({ type: "result", cost_usd: 0.10, usage: { input_tokens: 2000, output_tokens: 1000 }, subtype: "success" });
      process.exit(0);
      break;
    }

    case "crash": {
      emit({ type: "assistant", message: { content: [{ type: "text", text: "Working..." }] } });
      process.exit(1);
      break;
    }

    default:
      emit({ type: "result", cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, subtype: "success" });
      process.exit(0);
  }
}

run();
