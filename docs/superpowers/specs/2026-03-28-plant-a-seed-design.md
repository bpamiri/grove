# Plant a Seed — Interactive Brainstorming for Grove Tasks

**Date:** 2026-03-28
**Status:** Approved

## Problem

Grove's development path (plan → implement → evaluate → merge) is fully automated — workers get a task title and description, then execute. There's no structured design phase where the user and AI collaborate to explore requirements, consider approaches, and produce a spec before implementation begins. This leads to workers making assumptions that may not match the user's intent, especially for complex or ambiguous tasks.

## Solution

"Plant a Seed" — a toggle on any draft task that opens an inline interactive brainstorming session within the task detail panel. The AI asks clarifying questions one at a time, proposes approaches with trade-offs, shows visual mockups rendered inline, and produces a **seed** (a structured design artifact) attached to the task. When the task is dispatched, workers receive the seed as implementation context. Multiple tasks can be brainstormed concurrently.

## Core Concepts

- **Seed** — a structured design artifact produced by a brainstorming session, containing a summary and full spec. Stored in the DB, attached to a task.
- **Seed session** — an interactive Claude Code process (in tmux) that conducts the brainstorming conversation for a specific task.
- **Seed chat** — the inline UI panel within the task detail where the brainstorming conversation happens.
- Each task can have at most one seed.
- Multiple tasks can be brainstormed concurrently (independent sessions).
- Seeds are viewable/collapsible after brainstorming ends.
- Users can re-seed (discard and start over) but not edit a seed directly.

## UI/UX

### Task List

Tasks with completed seeds show a small seed icon next to their title, visually distinguishing designed tasks from raw drafts.

### Task Detail — Three States

**State 1: Unseeded draft**

The "Plant a Seed" toggle button appears below the task description. Clicking it starts a brainstorming session and expands the seed chat inline.

**State 2: Active brainstorming**

The seed chat panel expands inline within the task detail, showing:
- A header with "Seeding..." status and a close button
- The conversation thread (AI messages, user messages, rendered HTML fragments)
- A text input at the bottom for user messages

Visual mockups from the AI render inline as sandboxed HTML within the chat. Clickable options (`data-choice` attributes) send selections back through WebSocket.

**State 3: Seeded (complete)**

The seed chat collapses to a summary line with an expand toggle. Shows the 1-2 line summary. A "Re-seed" button allows discarding and starting over. The seed icon appears on the task in the task list.

### Parallel Brainstorming

Users can click "Plant a Seed" on multiple tasks. Each task has its own independent seed chat. Navigating between tasks in the task list shows each task's seed chat state — active session with full history, or completed seed. Sessions continue running in the background when the user navigates away.

## Backend Architecture

### Session Management

Each seed session runs as an interactive Claude Code process in its own tmux window:

```
tmux session "grove"
  ├─ window: orchestrator       (existing)
  ├─ window: seed-W-003         (brainstorming for task W-003)
  ├─ window: seed-W-004         (brainstorming for task W-004)
  └─ window: worker-W-005       (existing worker pattern)
```

The broker manages seed session lifecycle:
- Spawns on "Plant a Seed" toggle (creates tmux window, starts Claude Code)
- Routes messages between WebSocket and tmux
- Captures responses by polling tmux pane output (same pattern as orchestrator)
- Kills on close, completion, or re-seed

### WebSocket Protocol

New message types for seed communication:

```typescript
// User → Broker: send message to seed session
{ type: "seed", taskId: "W-003", text: "JWT with refresh tokens" }

// User → Broker: visual choice selection
{ type: "seed", taskId: "W-003", action: "choice", value: "option-a" }

// User → Broker: start/stop seed session
{ type: "seed_start", taskId: "W-003" }
{ type: "seed_stop", taskId: "W-003" }

// Broker → Client: seed session messages
{ type: "seed:message", taskId: "W-003", source: "ai", content: "What auth method?" }
{ type: "seed:message", taskId: "W-003", source: "ai", content: "...", html: "<div>...</div>" }
{ type: "seed:message", taskId: "W-003", source: "user", content: "JWT" }

// Broker → Client: seed session lifecycle
{ type: "seed:started", taskId: "W-003" }
{ type: "seed:complete", taskId: "W-003", seed: { summary: "...", spec: "..." } }
{ type: "seed:stopped", taskId: "W-003" }
```

### Communication with Claude

Same pattern as the orchestrator:
1. User types in seed chat → WebSocket to broker → `tmux send-keys` to the `seed-{taskId}` window
2. Claude responds in tmux → broker polls pane output → parses responses → broadcasts via WebSocket
3. When Claude emits `{"type":"seed_complete","summary":"...","spec":"..."}`, the broker stores the seed and kills the session

### Database Schema

New `seeds` table:

```sql
CREATE TABLE seeds (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  summary TEXT,              -- populated on completion
  spec TEXT,                 -- populated on completion
  conversation TEXT,         -- JSON array, updated during session
  status TEXT DEFAULT 'active',  -- active | completed | discarded
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);
```

### Seed Lifecycle

1. User toggles "Plant a Seed" → creates seed row (status: active), spawns tmux session
2. User and AI chat → messages stored in conversation column (JSON array)
3. AI emits seed_complete event → summary + spec populated, status → completed, session killed
4. User clicks "Re-seed" → old seed set to discarded, new one created
5. Task dispatched → workers get `seed.spec` injected into CLAUDE.md context

## Brainstorming System Prompt

The seed session gets a CLAUDE.md that guides the brainstorming flow:

```
You are a Grove seed session — an interactive design collaborator.

## Task
Title: {task.title}
Description: {task.description}

## Tree
{tree.name}: {tree.path}

## Your Role
- Help the user brainstorm and design before implementation begins
- Ask clarifying questions ONE AT A TIME
- Propose approaches with trade-offs
- Present design incrementally, getting approval at each stage
- When the design is complete, emit a structured seed artifact

## Process
1. Explore the codebase to understand relevant context
2. Ask clarifying questions (one per message, prefer multiple choice)
3. Propose 2-3 approaches with trade-offs and your recommendation
4. Present the design section by section
5. When approved, emit the seed artifact

## Visual Mockups
When a question would benefit from visual treatment (layout comparisons,
architecture diagrams, UI mockups), generate an HTML fragment:

{"type":"seed_html","html":"<div class='options'>...</div>"}

Rules for HTML fragments:
- Content only — no DOCTYPE, html, head, body tags
- Use data-choice="option-id" on clickable options
- Use classes: .options, .cards, .split, .pros-cons for layout
- Keep it minimal — the frame provides theming
- The user's click comes back as their next message

## Completing the Seed
When the user approves the final design, emit:

{"type":"seed_complete","summary":"1-2 line summary","spec":"full markdown spec"}

The spec should contain everything a developer needs to implement:
architecture, components, data flow, key decisions, and constraints.

## Guidelines
- You have READ-ONLY access to the codebase — explore freely
- Do NOT write code or make changes
- Do NOT skip questions to rush to a design
- If the user says "looks good" to a section, move to the next
- If unsure about scope, ask
```

## Visual Mockup Rendering

### HTML Fragment Protocol

The AI generates HTML content fragments (no DOCTYPE/html/body wrappers). The frontend renders these inline in the seed chat within a sandboxed container.

### Frame CSS

The frontend provides pre-built CSS classes available to all fragments:

```css
.options { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
.cards [data-choice] { cursor: pointer; border: 1px solid var(--border); border-radius: 8px; padding: 1rem; transition: border-color 0.15s; }
.cards [data-choice]:hover { border-color: #34d399; }
.cards [data-choice].selected { border-color: #34d399; background: rgba(52,211,153,0.1); }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.pros-cons { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
```

### Interaction Flow

1. AI sends `{"type":"seed_html","html":"..."}` → broker parses, broadcasts as `seed:message` with `html` field
2. Frontend renders HTML in a sandboxed container (shadow DOM or sandboxed iframe)
3. User clicks element with `data-choice="option-a"` → frontend sends `{ type: "seed", taskId, action: "choice", value: "option-a" }`
4. Broker relays to tmux as text: `"Selected: option-a"`
5. AI receives selection and continues

## Pipeline Integration

### Seed Injection into Workers

The `deploySandbox` function (which builds the worker's CLAUDE.md overlay) looks up the seed from DB and injects it:

```
## Task
Title: {task.title}
Description: {task.description}

## Seed (Design Spec)
{seed.spec}

## Current Step: {step.id}
{step.prompt}
```

This happens at every worker spawn — first run, retry, or re-dispatch after evaluator failure. The seed is always pulled fresh from DB, not from the worktree filesystem.

### Plan Step Optimization

When a seeded task enters the pipeline and the first step is `plan` (type: worker), the step engine skips it and advances to the next step. The seed already covers what the plan step would produce. If the user has a custom path where the plan step does something different, it still runs.

### Evaluator Enhancement

The evaluator gate receives the seed spec as context, giving it concrete acceptance criteria:

```
## Evaluation Context
Seed spec: {seed.spec}

Evaluate whether the implementation satisfies the design in the seed spec.
```

## Files Changed

### New

- `src/broker/seed-session.ts` — seed session manager (spawn, route messages, poll responses, lifecycle)
- `src/broker/schema-seeds.sql` — seeds table DDL (embedded into schema)
- `web/src/components/SeedChat.tsx` — inline seed chat component with HTML rendering
- `web/src/components/SeedBadge.tsx` — seed indicator icon for task list
- `web/src/hooks/useSeed.ts` — seed state management, WebSocket message handling
- `web/src/components/SeedFrame.css` — frame CSS classes for visual mockup rendering

### Modified

- `src/broker/db.ts` — add seed CRUD methods (seedCreate, seedGet, seedUpdate, seedDelete)
- `src/broker/schema.sql` — add seeds table
- `src/broker/server.ts` — handle seed WebSocket messages, add seed API endpoints
- `src/shared/sandbox.ts` — inject seed spec into worker CLAUDE.md overlay (`deploySandbox`)
- `src/engine/step-engine.ts` — skip plan step when seed exists
- `src/agents/evaluator.ts` — include seed spec in evaluation context
- `web/src/components/TaskDetail.tsx` — add Plant a Seed toggle, render SeedChat
- `web/src/components/TaskList.tsx` — show seed badge on seeded tasks

### API Endpoints

- `GET /api/tasks/:id/seed` — get seed for a task
- `POST /api/tasks/:id/seed/start` — start a seed session
- `POST /api/tasks/:id/seed/stop` — stop a seed session
- `DELETE /api/tasks/:id/seed` — discard a seed (for re-seed)

## Security

- Seed sessions run with `--dangerously-skip-permissions` like workers (automated agent)
- Seeds are read-only after completion — no direct editing
- Seed sessions have read-only codebase access (enforced by the system prompt, not technically restricted)
- Concurrent seed sessions are independent — no shared state

## What We're NOT Building

- Superpowers plugin integration (Grove-native only)
- Seed editing after completion (re-seed to start over)
- Seed templates or reusable patterns
- Seed sharing across tasks
- File-based visual protocol (we use WebSocket directly)
