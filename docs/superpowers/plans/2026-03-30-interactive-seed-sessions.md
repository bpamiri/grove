# T10: Interactive Seed Sessions (SAP-Native) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance seed sessions with real-time response streaming, conversation branching, stage detection, and a richer GUI — all built on the SAP protocol from T1.

**Architecture:** The seed session monitor emits `seed:chunk` events as Claude generates text (not waiting for process exit). The frontend SeedChat component renders streaming text with a typewriter effect. Conversation branching creates new Claude sessions from a divergence point. Stage detection heuristics track the brainstorming phase.

**Tech Stack:** Bun, TypeScript, React

**Spec:** `docs/superpowers/specs/2026-03-30-grove-next-10-design.md` (T10 section)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/broker/seed-session.ts` | Add streaming chunks, stage detection, branch support |
| Modify | `src/shared/protocol.ts` | Add seed:chunk SAP event type |
| Modify | `src/shared/types.ts` | Add seed:chunk to EventBusMap |
| Create | `tests/broker/seed-streaming.test.ts` | Streaming + stage detection tests |
| Modify | `src/broker/server.ts` | Forward seed:chunk, handle branch WS actions |
| Modify | `web/src/components/SeedChat.tsx` | Streaming text, stage indicator, branch UI, cost display |
| Modify | `web/src/hooks/useSeed.ts` | Handle seed:chunk events, branch state |

---

### Task 1: SAP seed:chunk Event + Stage Detection

**Files:** Modify `src/shared/protocol.ts`, `src/shared/types.ts`, Modify `src/broker/seed-session.ts`, Create `tests/broker/seed-streaming.test.ts`

- [ ] **Step 1: Add seed:chunk to protocol**

In `src/shared/protocol.ts`, add to the SapEvent union:
```typescript
  | SapSeedChunk
```

Add the interface:
```typescript
export interface SapSeedChunk extends SapBase { type: "seed:chunk"; taskId: string; content: string }
```

Add "seed:chunk" to the SAP_EVENT_TYPES set.

- [ ] **Step 2: Add seed:chunk to EventBusMap**

In `src/shared/types.ts`, add to EventBusMap:
```typescript
  "seed:chunk": { taskId: string; content: string; ts: number };
```

- [ ] **Step 3: Write tests for stage detection**

Create `tests/broker/seed-streaming.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { detectSeedStage } from "../../src/broker/seed-session";

describe("detectSeedStage", () => {
  test("detects exploring stage", () => {
    expect(detectSeedStage("Let me explore the codebase to understand")).toBe("exploring");
    expect(detectSeedStage("I'll read the relevant files")).toBe("exploring");
  });

  test("detects clarifying stage", () => {
    expect(detectSeedStage("I have a question about the requirements")).toBe("clarifying");
    expect(detectSeedStage("Which option would you prefer?\nA) JWT\nB) Sessions")).toBe("clarifying");
  });

  test("detects proposing stage", () => {
    expect(detectSeedStage("Here are 2-3 approaches we could take")).toBe("proposing");
    expect(detectSeedStage("I'd recommend Option A because")).toBe("proposing");
  });

  test("detects designing stage", () => {
    expect(detectSeedStage("Here's my recommended design for the auth module")).toBe("designing");
    expect(detectSeedStage("## Architecture\nThe system will use")).toBe("designing");
  });

  test("returns null for ambiguous text", () => {
    expect(detectSeedStage("OK")).toBeNull();
    expect(detectSeedStage("Got it, I understand")).toBeNull();
  });
});
```

- [ ] **Step 4: Implement streaming + stage detection in seed-session.ts**

In `src/broker/seed-session.ts`, add the exported stage detector:

```typescript
/** Detect the brainstorming stage from Claude's response text */
export function detectSeedStage(text: string): "exploring" | "clarifying" | "proposing" | "designing" | null {
  const lower = text.toLowerCase();
  if (lower.includes("explore") || lower.includes("read the") || lower.includes("survey") || lower.includes("look at the")) return "exploring";
  if (lower.includes("question") || lower.includes("which option") || lower.includes("would you prefer") || lower.includes("a)") || lower.includes("b)")) return "clarifying";
  if (lower.includes("approaches") || lower.includes("options") || lower.includes("recommend") || lower.includes("trade-off") || lower.includes("tradeoff")) return "proposing";
  if (lower.includes("design") || lower.includes("architecture") || lower.includes("## ")) return "designing";
  return null;
}
```

In `monitorSeedSession()`, change to emit `seed:chunk` events as text arrives instead of only on process exit. In the assistant text parsing block, after `accumulatedText += block.text`, add:

```typescript
              // Emit streaming chunk
              bus.emit("seed:chunk", { taskId, content: block.text, ts: Date.now() });
```

Also track and broadcast stage changes. Add a variable before the monitor loop:

```typescript
  let currentStage: string | null = null;
```

After accumulating text, detect stage:

```typescript
              const stage = detectSeedStage(accumulatedText);
              if (stage && stage !== currentStage) {
                currentStage = stage;
                broadcast("seed:stage", { taskId, stage });
              }
```

- [ ] **Step 5: Forward seed:chunk in server.ts**

In `src/broker/server.ts`, in `wireEventBus()`, add:
```typescript
  forward("seed:chunk");
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/broker/seed-streaming.test.ts`
Expected: All 5 tests PASS

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/shared/protocol.ts src/shared/types.ts src/broker/seed-session.ts src/broker/server.ts tests/broker/seed-streaming.test.ts
git commit -m "feat: add seed:chunk streaming, stage detection, and SAP event"
```

---

### Task 2: Frontend Streaming + Stage Indicator

**Files:** Modify `web/src/hooks/useSeed.ts`, Modify `web/src/components/SeedChat.tsx`

- [ ] **Step 1: Handle seed:chunk in useSeed hook**

In `web/src/hooks/useSeed.ts`, add state for streaming text and stage:

Add to the hook's state:
```typescript
const [streamingText, setStreamingText] = useState("");
const [stage, setStage] = useState<string | null>(null);
```

In `handleWsMessage`, add cases:
```typescript
      case "seed:chunk": {
        if (msg.data.taskId === taskId) {
          setStreamingText(prev => prev + msg.data.content);
        }
        break;
      }
      case "seed:stage": {
        if (msg.data.taskId === taskId) {
          setStage(msg.data.stage);
        }
        break;
      }
```

When `seed:message` arrives from AI (the complete response), clear streaming text:
```typescript
      case "seed:message": {
        // ... existing handler ...
        if (msg.data.source === "ai") {
          setStreamingText(""); // Clear streaming buffer since full message arrived
        }
        break;
      }
```

Return `streamingText` and `stage` from the hook.

- [ ] **Step 2: Add streaming display + stage indicator to SeedChat**

In `web/src/components/SeedChat.tsx`, add:

**Stage indicator** at the top of the chat when active:
```tsx
{isActive && stage && (
  <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800/50 rounded text-[10px] text-zinc-400 mb-2">
    <span className={`w-1.5 h-1.5 rounded-full ${
      stage === "exploring" ? "bg-blue-400" :
      stage === "clarifying" ? "bg-amber-400" :
      stage === "proposing" ? "bg-purple-400" :
      "bg-emerald-400"
    }`} />
    <span className="capitalize">{stage}</span>
  </div>
)}
```

**Streaming text** at the bottom of the message list (before the input):
```tsx
{streamingText && (
  <div className="px-3 py-2 text-sm text-zinc-300 whitespace-pre-wrap animate-pulse">
    {streamingText}
    <span className="inline-block w-1.5 h-4 bg-zinc-400 ml-0.5 animate-blink" />
  </div>
)}
```

Add a simple blink animation in the component or via Tailwind:
```css
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
.animate-blink { animation: blink 1s infinite; }
```

- [ ] **Step 3: Build web**

Run: `cd web && bun run build 2>&1 | tail -3`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useSeed.ts web/src/components/SeedChat.tsx
git commit -m "feat: add streaming text display and stage indicator to SeedChat"
```

---

### Task 3: Conversation Branching

**Files:** Modify `src/broker/seed-session.ts`, Modify `web/src/hooks/useSeed.ts`, Modify `web/src/components/SeedChat.tsx`

- [ ] **Step 1: Add branch support to seed session backend**

In `src/broker/seed-session.ts`, extend the SeedSession interface:

```typescript
interface SeedBranch {
  id: string;
  sessionId: string;       // separate claude session for this branch
  parentMessageIndex: number;
  label?: string;
  messages: ConversationMessage[];
  isFirstMessage: boolean;
}
```

Add to SeedSession:
```typescript
  branches: Map<string, SeedBranch>;
  activeBranchId: string;  // "main" or branch ID
```

Initialize in `startSeedSession`:
```typescript
  branches: new Map(),
  activeBranchId: "main",
```

Add public API for branching:

```typescript
/** Create a branch from a specific message index */
export function createSeedBranch(taskId: string, parentMessageIndex: number, label?: string, db?: Database): string | null {
  const session = sessions.get(taskId);
  if (!session) return null;

  const branchId = `branch-${Date.now()}`;
  const branch: SeedBranch = {
    id: branchId,
    sessionId: `seed-${taskId}-${branchId}`,
    parentMessageIndex,
    label,
    messages: session.conversation.slice(0, parentMessageIndex + 1),
    isFirstMessage: true,
  };

  session.branches.set(branchId, branch);
  broadcast("seed:branch_created", { taskId, branchId, label, parentMessageIndex });
  return branchId;
}

/** Switch to a branch */
export function switchSeedBranch(taskId: string, branchId: string): boolean {
  const session = sessions.get(taskId);
  if (!session) return false;
  if (branchId !== "main" && !session.branches.has(branchId)) return false;
  session.activeBranchId = branchId;
  broadcast("seed:branch_switched", { taskId, branchId });
  return true;
}
```

When sending a message, check if we're on a branch and use that branch's sessionId for --resume.

- [ ] **Step 2: Add branch WebSocket handlers to server.ts**

In `src/broker/server.ts`, in the WebSocket message handler, add:

```typescript
          if (data.type === "seed_branch" && data.taskId) {
            const { createSeedBranch } = require("./seed-session");
            createSeedBranch(data.taskId, data.parentMessageIndex, data.label);
            return;
          }

          if (data.type === "seed_switch_branch" && data.taskId) {
            const { switchSeedBranch } = require("./seed-session");
            switchSeedBranch(data.taskId, data.branchId);
            return;
          }
```

- [ ] **Step 3: Add branch UI to SeedChat**

In `web/src/components/SeedChat.tsx`:

Add a "Fork" button next to each AI message:
```tsx
<button
  onClick={() => send({ type: "seed_branch", taskId, parentMessageIndex: i, label: `Branch ${branches.length + 1}` })}
  className="opacity-0 group-hover:opacity-100 text-[10px] text-zinc-500 hover:text-blue-400 ml-2"
  title="Explore alternative direction"
>
  Fork
</button>
```

Add a branch selector dropdown when branches exist:
```tsx
{branches.length > 0 && (
  <select
    value={activeBranch}
    onChange={e => send({ type: "seed_switch_branch", taskId, branchId: e.target.value })}
    className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[10px] text-zinc-300"
  >
    <option value="main">Main</option>
    {branches.map(b => (
      <option key={b.id} value={b.id}>{b.label ?? b.id}</option>
    ))}
  </select>
)}
```

- [ ] **Step 4: Build web**

Run: `cd web && bun run build 2>&1 | tail -3`

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/broker/seed-session.ts src/broker/server.ts web/src/components/SeedChat.tsx web/src/hooks/useSeed.ts
git commit -m "feat: add conversation branching to seed sessions"
```

---

### Task 4: Verify Integration

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 2: Build web**

Run: `cd web && bun run build 2>&1 | tail -3`
Expected: Build succeeds

- [ ] **Step 3: Verify streaming events wired**

Run: `grep -n "seed:chunk" src/broker/seed-session.ts src/broker/server.ts src/shared/protocol.ts src/shared/types.ts`
Expected: Hits in all four files

- [ ] **Step 4: Commit if any fixes needed**

```bash
git add -A
git commit -m "chore: verify T10 interactive seed sessions integration"
```
