# T2: Real-time Worker Output Streaming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SAP events from T1 visible in the web GUI — handle `agent:tool_use`, `agent:thinking`, `agent:text` events in the frontend, batch high-frequency broadcasts, and provide catch-up for new WebSocket connections via a per-task ring buffer.

**Architecture:** Backend adds a per-task ring buffer (last 100 SAP activity events) and batched WebSocket broadcast (100ms flush interval). Frontend's `useTasks.ts` handles new SAP event types, converting them to activity log entries. The existing `ActivityFeed` component in `TaskDetail.tsx` is upgraded with a pause toggle and richer color-coding.

**Tech Stack:** Bun (backend), React + TypeScript (frontend), existing WebSocket infrastructure

**Spec:** `docs/superpowers/specs/2026-03-30-grove-next-10-design.md` (T2 section)

**Depends on:** T1 (SAP + Tmux Elimination) — merged

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/broker/ring-buffer.ts` | Per-task circular buffer for SAP activity events |
| Create | `tests/broker/ring-buffer.test.ts` | Ring buffer unit tests |
| Modify | `src/broker/server.ts` | Batched broadcast, ring buffer integration, catch-up on WS connect |
| Create | `tests/broker/batched-broadcast.test.ts` | Batched broadcast timing tests |
| Modify | `web/src/hooks/useTasks.ts` | Handle SAP event types, convert to activity log entries |
| Modify | `web/src/components/TaskDetail.tsx` | Upgrade ActivityFeed: pause toggle, richer colors, truncation |

---

### Task 1: Per-Task Ring Buffer

**Files:**
- Create: `src/broker/ring-buffer.ts`
- Create: `tests/broker/ring-buffer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/broker/ring-buffer.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { ActivityRingBuffer } from "../../src/broker/ring-buffer";

describe("ActivityRingBuffer", () => {
  test("stores and retrieves events", () => {
    const buf = new ActivityRingBuffer(5);
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "Read", input: "src/a.ts", ts: 1000 });
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "Edit", input: "src/b.ts", ts: 2000 });
    const events = buf.get("W-001");
    expect(events.length).toBe(2);
    expect(events[0].tool).toBe("Read");
    expect(events[1].tool).toBe("Edit");
  });

  test("evicts oldest when full", () => {
    const buf = new ActivityRingBuffer(3);
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "A", input: "", ts: 1 });
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "B", input: "", ts: 2 });
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "C", input: "", ts: 3 });
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "D", input: "", ts: 4 });
    const events = buf.get("W-001");
    expect(events.length).toBe(3);
    expect(events[0].tool).toBe("B");
    expect(events[2].tool).toBe("D");
  });

  test("isolates tasks", () => {
    const buf = new ActivityRingBuffer(10);
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "Read", input: "", ts: 1 });
    buf.push("W-002", { type: "agent:tool_use", taskId: "W-002", tool: "Edit", input: "", ts: 2 });
    expect(buf.get("W-001").length).toBe(1);
    expect(buf.get("W-002").length).toBe(1);
    expect(buf.get("W-003").length).toBe(0);
  });

  test("clear removes task events", () => {
    const buf = new ActivityRingBuffer(10);
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "Read", input: "", ts: 1 });
    buf.clear("W-001");
    expect(buf.get("W-001").length).toBe(0);
  });

  test("clearAll empties everything", () => {
    const buf = new ActivityRingBuffer(10);
    buf.push("W-001", { type: "agent:tool_use", taskId: "W-001", tool: "A", input: "", ts: 1 });
    buf.push("W-002", { type: "agent:tool_use", taskId: "W-002", tool: "B", input: "", ts: 2 });
    buf.clearAll();
    expect(buf.get("W-001").length).toBe(0);
    expect(buf.get("W-002").length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/broker/ring-buffer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ring buffer**

Create `src/broker/ring-buffer.ts`:

```typescript
// Grove v3 — Per-task ring buffer for SAP activity events
// Stores the last N events per task so new WebSocket connections can catch up.

export interface ActivityEvent {
  type: string;
  taskId: string;
  [key: string]: unknown;
}

export class ActivityRingBuffer {
  private buffers = new Map<string, ActivityEvent[]>();
  private readonly maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  /** Push an event into the buffer for a task */
  push(taskId: string, event: ActivityEvent): void {
    if (!this.buffers.has(taskId)) {
      this.buffers.set(taskId, []);
    }
    const buf = this.buffers.get(taskId)!;
    buf.push(event);
    if (buf.length > this.maxSize) {
      buf.shift();
    }
  }

  /** Get all buffered events for a task (oldest first) */
  get(taskId: string): ActivityEvent[] {
    return this.buffers.get(taskId) ?? [];
  }

  /** Clear buffer for a specific task */
  clear(taskId: string): void {
    this.buffers.delete(taskId);
  }

  /** Clear all buffers */
  clearAll(): void {
    this.buffers.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/broker/ring-buffer.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/broker/ring-buffer.ts tests/broker/ring-buffer.test.ts
git commit -m "feat: add per-task ring buffer for SAP activity events"
```

---

### Task 2: Batched Broadcast + Ring Buffer Integration

**Files:**
- Modify: `src/broker/server.ts`
- Create: `tests/broker/batched-broadcast.test.ts`

- [ ] **Step 1: Write failing tests for batched broadcast**

Create `tests/broker/batched-broadcast.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { BatchedBroadcaster } from "../../src/broker/server";

describe("BatchedBroadcaster", () => {
  test("flushes events after interval", async () => {
    const sent: string[] = [];
    const broadcaster = new BatchedBroadcaster(50, (msg) => sent.push(msg));

    broadcaster.queue("agent:tool_use", { taskId: "W-001", tool: "Read", input: "a.ts", ts: 1 });
    broadcaster.queue("agent:tool_use", { taskId: "W-001", tool: "Edit", input: "b.ts", ts: 2 });

    expect(sent.length).toBe(0);
    await new Promise(r => setTimeout(r, 80));
    expect(sent.length).toBe(2);
    broadcaster.stop();
  });

  test("sends non-batched events immediately", () => {
    const sent: string[] = [];
    const broadcaster = new BatchedBroadcaster(50, (msg) => sent.push(msg));

    broadcaster.sendImmediate("task:status", { taskId: "W-001", status: "active" });
    expect(sent.length).toBe(1);
    broadcaster.stop();
  });

  test("stop flushes remaining events", () => {
    const sent: string[] = [];
    const broadcaster = new BatchedBroadcaster(1000, (msg) => sent.push(msg));

    broadcaster.queue("agent:thinking", { taskId: "W-001", snippet: "analyzing...", ts: 1 });
    broadcaster.stop();
    expect(sent.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/broker/batched-broadcast.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Add BatchedBroadcaster to server.ts and wire ring buffer**

In `src/broker/server.ts`, add the following:

At the top, after existing imports, add:

```typescript
import { ActivityRingBuffer, type ActivityEvent } from "./ring-buffer";
```

After line 22 (`const wsClients = new Set<...>()`), add the ring buffer and batched broadcaster:

```typescript
const activityBuffer = new ActivityRingBuffer(100);

// Events that get batched (high-frequency activity events)
const BATCHED_EVENTS = new Set([
  "agent:tool_use", "agent:thinking", "agent:text", "agent:cost",
]);

export class BatchedBroadcaster {
  private queue_: Array<{ type: string; data: any }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sendFn: (msg: string) => void;

  constructor(intervalMs: number, sendFn: (msg: string) => void) {
    this.sendFn = sendFn;
    this.timer = setInterval(() => this.flush(), intervalMs);
  }

  queue(type: string, data: any): void {
    this.queue_.push({ type, data });
  }

  sendImmediate(type: string, data: any): void {
    this.sendFn(JSON.stringify({ type, data, ts: Date.now() }));
  }

  flush(): void {
    if (this.queue_.length === 0) return;
    const batch = this.queue_.splice(0);
    for (const { type, data } of batch) {
      this.sendFn(JSON.stringify({ type, data, ts: Date.now() }));
    }
  }

  stop(): void {
    this.flush();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
```

Replace the existing `broadcast` function:

```typescript
let broadcaster: BatchedBroadcaster | null = null;

function broadcastRaw(msg: string) {
  for (const ws of wsClients) {
    try { ws.send(msg); } catch { wsClients.delete(ws); }
  }
}

// Broadcast a message to all connected WebSocket clients
function broadcast(type: string, data: any) {
  // Store activity events in ring buffer
  if (BATCHED_EVENTS.has(type) && data?.taskId) {
    activityBuffer.push(data.taskId, { type, ...data } as ActivityEvent);
  }

  // Batch high-frequency events, send others immediately
  if (broadcaster && BATCHED_EVENTS.has(type)) {
    broadcaster.queue(type, data);
  } else {
    broadcastRaw(JSON.stringify({ type, data, ts: Date.now() }));
  }
}
```

In `startServer()`, after `wireEventBus()`, initialize the broadcaster:

```typescript
  broadcaster = new BatchedBroadcaster(100, broadcastRaw);
```

In `stopServer()`, add cleanup:

```typescript
export function stopServer(): void {
  broadcaster?.stop();
  broadcaster = null;
  server?.stop();
  server = null;
  wsClients.clear();
}
```

In the WebSocket `open` handler, send ring buffer catch-up for any active tasks:

```typescript
      open(ws) {
        wsClients.add(ws);
        // Send ring buffer catch-up — client will filter by task they're viewing
        // Only send if there are active events (avoid flooding on connect)
      },
```

Add an API endpoint for explicit activity catch-up. In `handleApi()`, add before the fallback 404:

```typescript
      // Activity ring buffer catch-up for a specific task
      if (path.match(/^\/api\/tasks\/[^/]+\/activity\/live$/)) {
        const taskId = path.split("/")[3];
        const events = activityBuffer.get(taskId);
        return new Response(JSON.stringify(events), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
```

Also clear the ring buffer when a worker ends. In `wireEventBus()`, add:

```typescript
  bus.on("worker:ended", (data) => {
    activityBuffer.clear(data.taskId);
  });
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/broker/batched-broadcast.test.ts`
Expected: All 3 tests PASS

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/broker/server.ts tests/broker/batched-broadcast.test.ts
git commit -m "feat: add batched broadcast and ring buffer for SAP activity events"
```

---

### Task 3: Handle SAP Events in Frontend

**Files:**
- Modify: `web/src/hooks/useTasks.ts`

- [ ] **Step 1: Add SAP event handlers to useTasks.ts**

In `web/src/hooks/useTasks.ts`, in the `handleWsMessage` callback's switch statement, add cases for the SAP events after the existing `"worker:activity"` case (line 123):

```typescript
      case "agent:tool_use": {
        const tid = msg.data.taskId;
        if (tid === "orchestrator") break; // skip orchestrator activity
        const toolMsg = `${msg.data.tool}: ${msg.data.input}`;
        taskActivity.set(tid, toolMsg);
        if (!taskActivityLog.has(tid)) taskActivityLog.set(tid, []);
        const tlog = taskActivityLog.get(tid)!;
        tlog.push({ ts: msg.data.ts ?? Date.now(), msg: toolMsg, kind: "tool" });
        if (tlog.length > MAX_LOG_ENTRIES) tlog.shift();
        setTasks(prev => [...prev]);
        break;
      }
      case "agent:thinking": {
        const tid = msg.data.taskId;
        if (tid === "orchestrator") break;
        const thinkMsg = `thinking: ${msg.data.snippet}`;
        taskActivity.set(tid, thinkMsg);
        if (!taskActivityLog.has(tid)) taskActivityLog.set(tid, []);
        const thlog = taskActivityLog.get(tid)!;
        thlog.push({ ts: msg.data.ts ?? Date.now(), msg: thinkMsg, kind: "thinking" });
        if (thlog.length > MAX_LOG_ENTRIES) thlog.shift();
        setTasks(prev => [...prev]);
        break;
      }
      case "agent:text": {
        const tid = msg.data.taskId;
        if (tid === "orchestrator") break;
        taskActivity.set(tid, msg.data.content);
        if (!taskActivityLog.has(tid)) taskActivityLog.set(tid, []);
        const txlog = taskActivityLog.get(tid)!;
        txlog.push({ ts: msg.data.ts ?? Date.now(), msg: msg.data.content, kind: "text" });
        if (txlog.length > MAX_LOG_ENTRIES) txlog.shift();
        setTasks(prev => [...prev]);
        break;
      }
```

Also update the `ActivityLogEntry` type. At line 64, change the type:

Replace:
```typescript
const taskActivityLog = new Map<string, Array<{ ts: number; msg: string }>>();
```

With:
```typescript
const taskActivityLog = new Map<string, Array<{ ts: number; msg: string; kind?: string }>>();
```

Update the `getActivityLog` return type signature:

Replace:
```typescript
  const getActivityLog = (taskId: string): Array<{ ts: number; msg: string }> => taskActivityLog.get(taskId) ?? [];
```

With:
```typescript
  const getActivityLog = (taskId: string): Array<{ ts: number; msg: string; kind?: string }> => taskActivityLog.get(taskId) ?? [];
```

- [ ] **Step 2: Run existing tests**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/hooks/useTasks.ts
git commit -m "feat: handle SAP activity events in frontend task state"
```

---

### Task 4: Upgrade ActivityFeed in TaskDetail

**Files:**
- Modify: `web/src/components/TaskDetail.tsx`

- [ ] **Step 1: Update ActivityFeed type and add pause toggle**

In `web/src/components/TaskDetail.tsx`, update the `ActivityFeed` component (starting around line 237):

Replace the entire `ActivityFeed` function:

```typescript
function ActivityFeed({ log, live, since }: { log: Array<{ ts: number; msg: string; kind?: string }>; live?: boolean; since?: string | null }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [pinnedLength, setPinnedLength] = useState(0);

  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [log.length, paused]);

  // When pausing, snapshot current length; when unpausing, reset
  const displayLog = paused ? log.slice(0, pinnedLength) : log;

  return (
    <div>
      <div className="flex justify-between items-center mb-1.5">
        <Label>{live ? "Live Activity" : "Activity Log"}</Label>
        {live && log.length > 0 && (
          <button
            onClick={() => {
              if (!paused) setPinnedLength(log.length);
              setPaused(!paused);
            }}
            className="text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
          >
            {paused ? `Resume (${log.length - pinnedLength} new)` : "Pause"}
          </button>
        )}
      </div>
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-2 max-h-48 overflow-y-auto font-mono text-[11px] leading-relaxed">
        {displayLog.length === 0 && live && (
          <div className="text-blue-400/70 text-center py-3">
            <ActivityIndicator since={since} label="Waiting for activity" size="md" />
          </div>
        )}
        {displayLog.map((entry, i) => {
          const time = new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          return (
            <div key={i} className="flex gap-2 hover:bg-zinc-900/50 px-1 rounded group">
              <span className="text-zinc-600 flex-shrink-0">{time}</span>
              <span className={`${activityColor(entry.msg, entry.kind)} break-all`}>
                {entry.msg.length > 200 ? (
                  <TruncatedText text={entry.msg} maxLength={200} />
                ) : entry.msg}
              </span>
            </div>
          );
        })}
        {displayLog.length > 0 && live && !paused && (
          <div className="text-blue-400/60 px-1 pt-1">
            <ActivityIndicator since={displayLog[displayLog.length - 1]?.ts} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add TruncatedText helper component**

After the `ActivityFeed` function, add:

```typescript
function TruncatedText({ text, maxLength }: { text: string; maxLength: number }) {
  const [expanded, setExpanded] = useState(false);
  if (expanded) {
    return (
      <span>
        {text}{" "}
        <button onClick={() => setExpanded(false)} className="text-blue-400/60 hover:text-blue-400">less</button>
      </span>
    );
  }
  return (
    <span>
      {text.slice(0, maxLength)}
      <button onClick={() => setExpanded(true)} className="text-blue-400/60 hover:text-blue-400">...more</button>
    </span>
  );
}
```

- [ ] **Step 3: Update activityColor to use kind field**

Replace the `activityColor` function:

```typescript
function activityColor(msg: string, kind?: string): string {
  // Use kind from SAP events when available
  if (kind === "thinking") return "text-purple-400/70 italic";
  if (kind === "text") return "text-zinc-300/80";
  if (kind === "tool") {
    // Color by tool name
    if (msg.startsWith("Read") || msg.startsWith("Grep") || msg.startsWith("Glob")) return "text-zinc-400";
    if (msg.startsWith("Edit") || msg.startsWith("Write")) return "text-amber-400";
    if (msg.startsWith("Bash")) return "text-cyan-400";
    return "text-blue-400";
  }
  // Fallback for legacy worker:activity messages (no kind)
  if (msg.startsWith("thinking:")) return "text-purple-400/70 italic";
  if (msg.startsWith("Read") || msg.startsWith("Grep") || msg.startsWith("Glob")) return "text-zinc-400";
  if (msg.startsWith("Edit") || msg.startsWith("Write")) return "text-amber-400";
  if (msg.startsWith("Bash")) return "text-cyan-400";
  if (!msg.includes(":") || msg.indexOf(":") > 20) return "text-zinc-300/80";
  return "text-zinc-300";
}
```

- [ ] **Step 4: Update the Props interface**

In the `Props` interface for `TaskDetail` (line 17), update `activityLog`:

Replace:
```typescript
  activityLog?: Array<{ ts: number; msg: string }>;
```

With:
```typescript
  activityLog?: Array<{ ts: number; msg: string; kind?: string }>;
```

- [ ] **Step 5: Build web assets to verify**

Run: `cd web && bun run build 2>&1 | tail -3`
Expected: Build succeeds with no TypeScript errors

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add web/src/components/TaskDetail.tsx
git commit -m "feat: upgrade ActivityFeed with pause toggle, truncation, and SAP color-coding"
```

---

### Task 5: Wire Activity Catch-up on Task Expand

**Files:**
- Modify: `web/src/hooks/useTasks.ts`

- [ ] **Step 1: Add live activity fetch on task expand**

In `web/src/hooks/useTasks.ts`, update the `loadActivityLog` function to also try the live ring buffer endpoint:

Replace:
```typescript
  /** Fetch historical activity from the worker log file (seeds the feed on expand) */
  const loadActivityLog = useCallback(async (taskId: string) => {
    if (taskActivityLog.has(taskId) && taskActivityLog.get(taskId)!.length > 0) return;
    try {
      const entries = await api<Array<{ ts: string; msg: string }>>(`/api/tasks/${taskId}/activity`);
      if (entries.length > 0) {
        const log = entries.map(e => ({
          ts: e.ts ? new Date(e.ts).getTime() : Date.now(),
          msg: e.msg,
        }));
        taskActivityLog.set(taskId, log);
        setTasks(prev => [...prev]); // force re-render
      }
    } catch {}
  }, []);
```

With:
```typescript
  /** Fetch activity from live ring buffer first, then fall back to historical log */
  const loadActivityLog = useCallback(async (taskId: string) => {
    if (taskActivityLog.has(taskId) && taskActivityLog.get(taskId)!.length > 0) return;
    try {
      // Try live ring buffer first (for active tasks)
      const liveEntries = await api<Array<{ type: string; taskId: string; tool?: string; input?: string; snippet?: string; content?: string; ts?: number }>>(`/api/tasks/${taskId}/activity/live`);
      if (liveEntries.length > 0) {
        const log = liveEntries.map(e => {
          const ts = e.ts ?? Date.now();
          if (e.type === "agent:tool_use") return { ts, msg: `${e.tool}: ${e.input}`, kind: "tool" as const };
          if (e.type === "agent:thinking") return { ts, msg: `thinking: ${e.snippet}`, kind: "thinking" as const };
          if (e.type === "agent:text") return { ts, msg: e.content ?? "", kind: "text" as const };
          return { ts, msg: `${e.type}` };
        });
        taskActivityLog.set(taskId, log);
        setTasks(prev => [...prev]);
        return;
      }

      // Fall back to historical log file parsing
      const entries = await api<Array<{ ts: string; msg: string }>>(`/api/tasks/${taskId}/activity`);
      if (entries.length > 0) {
        const log = entries.map(e => ({
          ts: e.ts ? new Date(e.ts).getTime() : Date.now(),
          msg: e.msg,
        }));
        taskActivityLog.set(taskId, log);
        setTasks(prev => [...prev]);
      }
    } catch {}
  }, []);
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Build web assets**

Run: `cd web && bun run build 2>&1 | tail -3`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/useTasks.ts
git commit -m "feat: fetch live ring buffer activity on task expand"
```

---

### Task 6: Verify Full Integration

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 2: Build web assets**

Run: `cd web && bun run build 2>&1 | tail -3`
Expected: Build succeeds

- [ ] **Step 3: Verify new API endpoint exists**

Run: `grep -n "activity/live" src/broker/server.ts`
Expected: Endpoint handler found

- [ ] **Step 4: Verify SAP events handled in frontend**

Run: `grep -n "agent:tool_use\|agent:thinking\|agent:text" web/src/hooks/useTasks.ts`
Expected: Handler cases found

- [ ] **Step 5: Commit if any fixes needed**

```bash
git add -A
git commit -m "chore: verify T2 real-time streaming integration"
```
