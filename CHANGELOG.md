# Changelog


## v0.1.18

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.17...v0.1.18)

### 🚀 Enhancements

- Add SAP event protocol types and validators ([06bbb26](https://github.com/bpamiri/grove/commit/06bbb26))
- Add SAP event types to EventBusMap, remove tmux_pane from Session type ([c08a908](https://github.com/bpamiri/grove/commit/c08a908))
- Emit SAP events from worker alongside existing events ([50a79e8](https://github.com/bpamiri/grove/commit/50a79e8))
- Emit SAP events from reviewer alongside existing events ([10ff84e](https://github.com/bpamiri/grove/commit/10ff84e))
- Emit SAP events from orchestrator alongside existing events ([7d29ff5](https://github.com/bpamiri/grove/commit/7d29ff5))
- Forward SAP events over WebSocket ([5ef2f47](https://github.com/bpamiri/grove/commit/5ef2f47))
- Rewrite seed-session from tmux to --resume subprocess pattern ([ed0d0c1](https://github.com/bpamiri/grove/commit/ed0d0c1))
- Delete tmux.ts, remove all tmux references from broker and CLI ([255101d](https://github.com/bpamiri/grove/commit/255101d))

### 📖 Documentation

- Grove Next 10 roadmap spec — 10 agent-ready task definitions ([2f9e407](https://github.com/bpamiri/grove/commit/2f9e407))
- T1 implementation plan — SAP protocol + tmux elimination ([1fcf6c1](https://github.com/bpamiri/grove/commit/1fcf6c1))

### 🏡 Chore

- Remove stale tmux references from CLI help and chat commands ([70649d4](https://github.com/bpamiri/grove/commit/70649d4))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.17

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.16...v0.1.17)

### 🚀 Enhancements

- (W-038) add adversarial review step type for plan-review loops ([7f00a4a](https://github.com/bpamiri/grove/commit/7f00a4a))
- (W-039) full task creation form with edit, dependencies, and batch import ([fbd89e3](https://github.com/bpamiri/grove/commit/fbd89e3))
- (W-039) two-way GitHub sync, issue labels, and dependency chain preview ([edc78b4](https://github.com/bpamiri/grove/commit/edc78b4))
- (W-040) per-tree default path with override in task creation ([cc7a817](https://github.com/bpamiri/grove/commit/cc7a817))
- (W-040) validate default_path in grove.yaml config ([1fea52d](https://github.com/bpamiri/grove/commit/1fea52d))
- (W-041) add verdict step type and source_pr column ([6aeb6f9](https://github.com/bpamiri/grove/commit/6aeb6f9))
- (W-041) implement verdict step execution in step engine ([77b7797](https://github.com/bpamiri/grove/commit/77b7797))
- (W-041) add gh PR view, review, close, and checkout helpers ([3b02340](https://github.com/bpamiri/grove/commit/3b02340))
- (W-041) add PR poller with filtering and auto-import ([2c8e06a](https://github.com/bpamiri/grove/commit/2c8e06a))
- (W-041) add verdict API and import-prs endpoint ([a377b7a](https://github.com/bpamiri/grove/commit/a377b7a))
- (W-041) add verdict panel UI, Import PRs button, and PR badge ([c10a9f0](https://github.com/bpamiri/grove/commit/c10a9f0))
- (W-041) wire PR poller to broker, add pr-review path, update changelog ([2881b64](https://github.com/bpamiri/grove/commit/2881b64))

### 🩹 Fixes

- (W-042) correct 7 doc inaccuracies found via code review ([6897c61](https://github.com/bpamiri/grove/commit/6897c61))
- (W-041) add source_pr to web Task type, fix paths description type ([34d52f9](https://github.com/bpamiri/grove/commit/34d52f9))

### 📖 Documentation

- (W-042) add comprehensive documentation for recent features ([f91c633](https://github.com/bpamiri/grove/commit/f91c633))
- (W-042) add orchestrator and batch analysis deep dives, expand CLI/config/GitHub docs ([d443935](https://github.com/bpamiri/grove/commit/d443935))
- (W-042) add API reference, fix config gaps, correct inaccuracies ([feb0784](https://github.com/bpamiri/grove/commit/feb0784))
- (W-042) update session summary for session 4 ([2c5388d](https://github.com/bpamiri/grove/commit/2c5388d))
- Add PR import and review design spec ([cbb57c5](https://github.com/bpamiri/grove/commit/cbb57c5))
- Add PR import and review implementation plan ([7e8aa70](https://github.com/bpamiri/grove/commit/7e8aa70))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.16

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.15...v0.1.16)

### 🚀 Enhancements

- (W-028) add Failed filter tab to task list ([ee9df75](https://github.com/bpamiri/grove/commit/ee9df75))
- (W-025) persist filter and tree selection across state changes ([b0c95b9](https://github.com/bpamiri/grove/commit/b0c95b9))
- (W-027) rename All Tasks to The Grove, add filter-aware task count badges ([ee6d715](https://github.com/bpamiri/grove/commit/ee6d715))
- (W-026) persist status filter and improve cross-filter empty state ([5e63efe](https://github.com/bpamiri/grove/commit/5e63efe))
- (W-032) resume task at specific pipeline step ([6933c1d](https://github.com/bpamiri/grove/commit/6933c1d))
- (W-033) batch planner analysis engine with overlap matrix and wave derivation ([d914b72](https://github.com/bpamiri/grove/commit/d914b72))
- (W-033) add grove batch CLI command and API endpoints ([5cf73c1](https://github.com/bpamiri/grove/commit/5cf73c1))
- (W-033) add batch planner GUI component with overlap matrix and wave visualization ([9d75a86](https://github.com/bpamiri/grove/commit/9d75a86))

### 🩹 Fixes

- (W-031) wire cancel/pause buttons to WebSocket action handler ([9c13bca](https://github.com/bpamiri/grove/commit/9c13bca))
- (W-030) break evaluator rebase-conflict infinite loop ([416f38d](https://github.com/bpamiri/grove/commit/416f38d))
- (W-032) resolve closed-database error in resumePipeline tests ([ff3fa47](https://github.com/bpamiri/grove/commit/ff3fa47))
- (W-032) use wireStepEngine instead of startPipeline in test setup ([fb8de59](https://github.com/bpamiri/grove/commit/fb8de59))
- (W-032) add _setDb test helper to avoid async leaks in test setup ([c5ac40e](https://github.com/bpamiri/grove/commit/c5ac40e))
- (W-032) flush async microtasks before closing test DBs ([ea89e37](https://github.com/bpamiri/grove/commit/ea89e37))
- (W-033) increase async flush delay for CI timing sensitivity ([62a7f39](https://github.com/bpamiri/grove/commit/62a7f39))

### 📖 Documentation

- (W-033) add changelog entry and session summary ([2258b16](https://github.com/bpamiri/grove/commit/2258b16))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## Unreleased

### Added
- **PR Import and Review** — import contributed PRs for agent-assisted review
  - New `pr-review` pipeline path: CI gate → agent review → maintainer verdict
  - New `verdict` step type: pauses pipeline for human decision (merge/request changes/close/defer)
  - PR auto-import via polling (configurable per tree in `grove.yaml`)
  - Manual import via API, CLI, and GUI ("Import PRs" button)
  - Verdict panel in task detail with action buttons and review report display
  - New `source_pr` column on tasks to track contributed PR number
  - GitHub helpers: `ghPrView`, `ghPrReview`, `ghPrClose`, `ghPrCheckout`

### 🚀 Enhancements

- (W-033) batch planner — analyze draft tasks, predict file overlap, build dependency graph, dispatch in execution waves (`grove batch`, API, GUI)
- (W-032) resume task at specific pipeline step — `POST /api/tasks/:id/resume`, `resume_task` WS action, UI controls

## v0.1.15

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.14...v0.1.15)

### 🚀 Enhancements

- (W-029) auto-create GitHub issues when tasks are created ([d0866d3](https://github.com/bpamiri/grove/commit/d0866d3))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.14

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.13...v0.1.14)

### 🚀 Enhancements

- (W-022) add guidance, task context, and thinking indicator to seed panel ([26c6af6](https://github.com/bpamiri/grove/commit/26c6af6))
- (W-023) auto-populate task description as initial seed prompt ([25952e6](https://github.com/bpamiri/grove/commit/25952e6))

### 🩹 Fixes

- Sort imported GitHub issues by number ascending ([1e459cf](https://github.com/bpamiri/grove/commit/1e459cf))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.13

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.12...v0.1.13)

### 🩹 Fixes

- Gate steps default on_failure to preceding worker, not $fail ([3e7f708](https://github.com/bpamiri/grove/commit/3e7f708))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.12

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.11...v0.1.12)

### 🩹 Fixes

- Use --dangerously-skip-permissions for orchestrator (matches workers) ([e139957](https://github.com/bpamiri/grove/commit/e139957))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.11

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.10...v0.1.11)

### 🩹 Fixes

- Use semver comparison for update check, not string inequality ([055ed6f](https://github.com/bpamiri/grove/commit/055ed6f))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.10

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.9...v0.1.10)

### 🚀 Enhancements

- **orchestrator:** Add grove-event tag extractor ([#23](https://github.com/bpamiri/grove/pull/23))
- **orchestrator:** Rewrite from tmux to subprocess pattern ([#23](https://github.com/bpamiri/grove/pull/23))
- **server:** Add /api/orchestrator/reset endpoint ([#23](https://github.com/bpamiri/grove/pull/23))
- **gui:** Add New Session button to Chat panel ([#23](https://github.com/bpamiri/grove/pull/23))

### 💅 Refactors

- **broker:** Remove tmux from startup, make orchestrator lazy ([#23](https://github.com/bpamiri/grove/pull/23))
- **cli:** Remove tmux references from up and status commands ([#23](https://github.com/bpamiri/grove/pull/23))

### 📖 Documentation

- Add orchestrator rewrite design spec ([#23](https://github.com/bpamiri/grove/pull/23))
- Add orchestrator rewrite implementation plan ([#23](https://github.com/bpamiri/grove/pull/23))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.9

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.8...v0.1.9)

### 🚀 Enhancements

- Show version in grove up output ([b9e1147](https://github.com/bpamiri/grove/commit/b9e1147))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.8

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.7...v0.1.8)

### 🚀 Enhancements

- Show grove version in CLI status, API, and web sidebar ([#40](https://github.com/bpamiri/grove/pull/40))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.7

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.6...v0.1.7)

### 🚀 Enhancements

- **analytics:** Add costByTree, costDaily, costTopTasks DB methods ([#40](https://github.com/bpamiri/grove/pull/40))
- **analytics:** Add gateAnalytics, retryStats, taskTimeline DB methods ([#40](https://github.com/bpamiri/grove/pull/40))
- **analytics:** Add /api/analytics/cost, gates, timeline endpoints ([#40](https://github.com/bpamiri/grove/pull/40))
- **analytics:** Add useAnalytics hook with live/static refresh ([#40](https://github.com/bpamiri/grove/pull/40))
- **analytics:** Add Dashboard component with tabs, KPIs, Gantt, charts ([#40](https://github.com/bpamiri/grove/pull/40))
- **analytics:** Integrate Dashboard into App routing and Sidebar ([#40](https://github.com/bpamiri/grove/pull/40))

### 📖 Documentation

- Add analytics dashboard design spec ([#40](https://github.com/bpamiri/grove/pull/40))
- Add analytics dashboard implementation plan ([#40](https://github.com/bpamiri/grove/pull/40))
- Update architecture and quick-start with dashboard view ([#40](https://github.com/bpamiri/grove/pull/40))

### 🏡 Chore

- Add web package-lock.json ([711c65e](https://github.com/bpamiri/grove/commit/711c65e))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.6

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.5...v0.1.6)

### 🩹 Fixes

- Spread real module exports in mock.module to prevent global leaks ([f50e55b](https://github.com/bpamiri/grove/commit/f50e55b))
- Minimize mock.module scope to only config and worker ([b8d475c](https://github.com/bpamiri/grove/commit/b8d475c))

### 💅 Refactors

- Export cost monitor internals for testing ([f72eb7f](https://github.com/bpamiri/grove/commit/f72eb7f))
- Export evaluator internals for testing ([f49e22e](https://github.com/bpamiri/grove/commit/f49e22e))

### 📖 Documentation

- Add integration test suite design spec for #39 ([#39](https://github.com/bpamiri/grove/issues/39))
- Add integration test suite implementation plan ([2e7b7e0](https://github.com/bpamiri/grove/commit/2e7b7e0))

### ✅ Tests

- Add shared test helpers (createTestDb, createFixtureRepo) ([701b98d](https://github.com/bpamiri/grove/commit/701b98d))
- Add stream parser tests (27 tests) ([75600bd](https://github.com/bpamiri/grove/commit/75600bd))
- Add cost monitor tests (15 tests) ([9399db2](https://github.com/bpamiri/grove/commit/9399db2))
- Add evaluator gate tests (~36 tests) ([e2329f2](https://github.com/bpamiri/grove/commit/e2329f2))
- Add step engine tests (~22 tests) ([a409ea4](https://github.com/bpamiri/grove/commit/a409ea4))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.5

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.4...v0.1.5)

### 🚀 Enhancements

- Add notification system with Slack, system, and webhook channels ([b5a5c0b](https://github.com/bpamiri/grove/commit/b5a5c0b))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.4

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.0...v0.1.4)

### 🚀 Enhancements

- Homebrew tap with auto-bump on release ([#37](https://github.com/bpamiri/grove/pull/37))

### 🩹 Fixes

- Re-tag after amending release commit to include synced version ([e7a3108](https://github.com/bpamiri/grove/commit/e7a3108))

### 📖 Documentation

- Full documentation set + README refresh ([0db69ce](https://github.com/bpamiri/grove/commit/0db69ce))
- Homebrew tap design spec ([#37](https://github.com/bpamiri/grove/pull/37))

### 🏡 Chore

- **release:** V0.1.2 ([8bf7f62](https://github.com/bpamiri/grove/commit/8bf7f62))
- **release:** V0.1.3 ([ea827bc](https://github.com/bpamiri/grove/commit/ea827bc))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.3

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.0...v0.1.3)

### 🚀 Enhancements

- Homebrew tap with auto-bump on release ([#37](https://github.com/bpamiri/grove/pull/37))

### 📖 Documentation

- Full documentation set + README refresh ([0db69ce](https://github.com/bpamiri/grove/commit/0db69ce))
- Homebrew tap design spec ([#37](https://github.com/bpamiri/grove/pull/37))

### 🏡 Chore

- **release:** V0.1.2 ([8bf7f62](https://github.com/bpamiri/grove/commit/8bf7f62))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.2

[compare changes](https://github.com/bpamiri/grove/compare/v0.1.0...v0.1.2)

### 🚀 Enhancements

- Homebrew tap with auto-bump on release ([#37](https://github.com/bpamiri/grove/pull/37))

### 📖 Documentation

- Full documentation set + README refresh ([0db69ce](https://github.com/bpamiri/grove/commit/0db69ce))
- Homebrew tap design spec ([#37](https://github.com/bpamiri/grove/pull/37))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v0.1.1

[compare changes](https://github.com/bpamiri/grove/compare/v3.0.0-alpha.0...v0.1.1)

### 🚀 Enhancements

- Fix web UI serving, orchestrator chat, and add GUI improvements ([d3a51f9](https://github.com/bpamiri/grove/commit/d3a51f9))
- Smart retry for failed/stuck tasks ([222ace9](https://github.com/bpamiri/grove/commit/222ace9))
- Show Cloudflare tunnel URL in sidebar ([8bfd9c0](https://github.com/bpamiri/grove/commit/8bfd9c0))
- Per-tree default_branch for worktree creation and evaluation ([15ddb8b](https://github.com/bpamiri/grove/commit/15ddb8b))
- Responsive mobile layout with tab navigation ([269720a](https://github.com/bpamiri/grove/commit/269720a))
- CI failure → worker fix loop for continuous PR improvement ([26d44be](https://github.com/bpamiri/grove/commit/26d44be))
- Show thinking and text in activity feed ([c12b68f](https://github.com/bpamiri/grove/commit/c12b68f))
- Add PipelineStep type and update TaskStatus enum to 5 lifecycle values ([d469fa4](https://github.com/bpamiri/grove/commit/d469fa4))
- Add path normalization — expands YAML shorthand to full PipelineStep arrays ([ff22c25](https://github.com/bpamiri/grove/commit/ff22c25))
- Add configNormalizedPaths for resolved pipeline step configs ([ab24aa1](https://github.com/bpamiri/grove/commit/ab24aa1))
- Add current_step, step_index, paused columns with migration for existing data ([52271d9](https://github.com/bpamiri/grove/commit/52271d9))
- Add step engine — configurable pipeline replaces hardcoded event wiring ([d13ec0a](https://github.com/bpamiri/grove/commit/d13ec0a))
- Worker uses step engine callbacks and accepts step prompts ([bb6cfad](https://github.com/bpamiri/grove/commit/bb6cfad))
- Merge manager delegates status transitions to step engine ([5aa1a5f](https://github.com/bpamiri/grove/commit/5aa1a5f))
- Add GET /api/paths endpoint, update status values across API ([7e987f1](https://github.com/bpamiri/grove/commit/7e987f1))
- Rewrite Pipeline component — data-driven from path config and task state ([0e4fbf6](https://github.com/bpamiri/grove/commit/0e4fbf6))
- UseTasks hook fetches paths and handles step change events ([3b24a02](https://github.com/bpamiri/grove/commit/3b24a02))
- Update frontend status values, Pipeline gets data-driven props ([15290f4](https://github.com/bpamiri/grove/commit/15290f4))
- GitHub issue picker in task form, post-merge cleanup, gitDeleteBranch ([384e4ea](https://github.com/bpamiri/grove/commit/384e4ea))
- Scaffold grove.cloud Cloudflare Worker with registration + proxy ([656bcf1](https://github.com/bpamiri/grove/commit/656bcf1))
- Add generateSecret for registry ownership ([ce111f3](https://github.com/bpamiri/grove/commit/ce111f3))
- Add grove.cloud registry client with heartbeat ([da44f0a](https://github.com/bpamiri/grove/commit/da44f0a))
- CLI shows both tunnel and remote URLs ([91b576b](https://github.com/bpamiri/grove/commit/91b576b))
- Rotate-credentials deregisters old subdomain from grove.cloud ([f280a95](https://github.com/bpamiri/grove/commit/f280a95))
- Wire registry into broker startup/shutdown with heartbeat ([837dac2](https://github.com/bpamiri/grove/commit/837dac2))
- Deploy grove.cloud Worker with KV namespace ([aa680a9](https://github.com/bpamiri/grove/commit/aa680a9))
- Add seeds table and CRUD methods for brainstorming artifacts ([f213fbc](https://github.com/bpamiri/grove/commit/f213fbc))
- Seed session manager — tmux-based interactive brainstorming ([480983f](https://github.com/bpamiri/grove/commit/480983f))
- Wire seed sessions into WebSocket and REST API ([67c953c](https://github.com/bpamiri/grove/commit/67c953c))
- Inject seed into workers, skip plan step, enhance evaluator ([bea5d04](https://github.com/bpamiri/grove/commit/bea5d04))
- Seed frontend — useSeed hook, SeedChat, SeedBadge, SeedFrame CSS ([24e6912](https://github.com/bpamiri/grove/commit/24e6912))
- Integrate seed into TaskDetail, TaskList, and App ([fb815bb](https://github.com/bpamiri/grove/commit/fb815bb))
- (W-020) add activity indicators for AI agent processing ([6b7425b](https://github.com/bpamiri/grove/commit/6b7425b))
- (W-019) persist UI state across page refresh via localStorage ([22ec15f](https://github.com/bpamiri/grove/commit/22ec15f))
- (W-020) add activity indicators to web UI ([e9b4639](https://github.com/bpamiri/grove/commit/e9b4639))
- (W-021) handle merge conflicts with auto-rebase and escalation ([f0ae3c4](https://github.com/bpamiri/grove/commit/f0ae3c4))
- (W-021) configurable default branch, trivial conflict auto-resolution, retry merge UI ([3e2b06c](https://github.com/bpamiri/grove/commit/3e2b06c))
- (W-024) auto-close linked GitHub issues on PR merge ([be452a9](https://github.com/bpamiri/grove/commit/be452a9))
- (W-024) auto-close linked GitHub issues on PR merge ([01d695c](https://github.com/bpamiri/grove/commit/01d695c))
- Rewrite orchestrator to pipe-based JSONL communication ([#23](https://github.com/bpamiri/grove/pull/23))
- Notification dispatcher with rate limiting and event routing ([#24](https://github.com/bpamiri/grove/pull/24))
- Slack notification channel with Block Kit formatting ([#24](https://github.com/bpamiri/grove/pull/24))
- System notification channel — macOS + Linux support with quiet hours ([#24](https://github.com/bpamiri/grove/pull/24))
- Webhook notification channel with HMAC-SHA256 signing ([#24](https://github.com/bpamiri/grove/pull/24))
- Wire notification system into event bus and broker startup ([#24](https://github.com/bpamiri/grove/pull/24))
- Analytics API — cost breakdown, gate stats, timeline endpoints ([#25](https://github.com/bpamiri/grove/pull/25))
- Analytics dashboard — timeline, cost charts, gate analytics ([#25](https://github.com/bpamiri/grove/pull/25))
- Install script for curl-pipe installation ([#26](https://github.com/bpamiri/grove/pull/26))
- Grove.cloud landing page with install instructions ([#26](https://github.com/bpamiri/grove/pull/26))
- Restore full-stack Grove (backend + web) to main ([bad5aeb](https://github.com/bpamiri/grove/commit/bad5aeb))
- Add version sync script ([#36](https://github.com/bpamiri/grove/pull/36))
- Add manual-dispatch release workflow ([#36](https://github.com/bpamiri/grove/pull/36))
- Add platform detection and GitHub release fetch ([#35](https://github.com/bpamiri/grove/pull/35))
- Add cached update check ([#35](https://github.com/bpamiri/grove/pull/35))
- Add grove upgrade command ([#35](https://github.com/bpamiri/grove/pull/35))
- Register upgrade command, wire update check to grove up ([#35](https://github.com/bpamiri/grove/pull/35))

### 🩹 Fixes

- Activity log, duplicate pipeline, and stream-json parsing ([4a7995b](https://github.com/bpamiri/grove/commit/4a7995b))
- Add --dangerously-skip-permissions to worker claude sessions ([2889b4e](https://github.com/bpamiri/grove/commit/2889b4e))
- Evaluator uses project conventions instead of guessing ([b7ba1ef](https://github.com/bpamiri/grove/commit/b7ba1ef))
- Show Retry button for evaluating (stuck) tasks ([1f08f2b](https://github.com/bpamiri/grove/commit/1f08f2b))
- PR creation — remove invalid --json flag, add --base branch ([8af2dd8](https://github.com/bpamiri/grove/commit/8af2dd8))
- Use conventional commit format for PR titles and commit messages ([3ddf1e4](https://github.com/bpamiri/grove/commit/3ddf1e4))
- Actionable CI failure instructions for workers ([43d5329](https://github.com/bpamiri/grove/commit/43d5329))
- Use scopeless conventional commits (feat:, fix:, not feat(W-001):) ([1d430bf](https://github.com/bpamiri/grove/commit/1d430bf))
- Include task ID in commit subject — feat: (W-001) description ([b14c0d9](https://github.com/bpamiri/grove/commit/b14c0d9))
- Gh pr checks uses state field, not conclusion ([c3b9add](https://github.com/bpamiri/grove/commit/c3b9add))
- Evaluator no longer sets status directly — step engine handles transitions ([24db9bf](https://github.com/bpamiri/grove/commit/24db9bf))
- Dispatch uses queued status and delegates to step engine ([d9968da](https://github.com/bpamiri/grove/commit/d9968da))
- Add post-merge cleanup (worktree + branch deletion) to merge manager ([d3feb61](https://github.com/bpamiri/grove/commit/d3feb61))
- Remove worktree from index, add to gitignore ([f776860](https://github.com/bpamiri/grove/commit/f776860))
- (W-016) skip tasks in terminal states during broker processing ([ca8b3bb](https://github.com/bpamiri/grove/commit/ca8b3bb))
- (W-018) persist resizable pane widths in localStorage ([75c34d0](https://github.com/bpamiri/grove/commit/75c34d0))
- (W-017) preserve tree filter during pipeline step transitions ([023f6e4](https://github.com/bpamiri/grove/commit/023f6e4))
- Add missing build:embed step to CI build workflow ([8bfa31d](https://github.com/bpamiri/grove/commit/8bfa31d))
- Commit missing recoverOrphanedTasks in health monitor ([43a7d5e](https://github.com/bpamiri/grove/commit/43a7d5e))
- Commit remaining uncommitted features referenced by merged code ([42f01b0](https://github.com/bpamiri/grove/commit/42f01b0))
- Align tests with implementation — resolve 11 pre-existing failures ([37138a1](https://github.com/bpamiri/grove/commit/37138a1))
- Sidebar TypeScript error + build workflow missing embed step ([c9fa37f](https://github.com/bpamiri/grove/commit/c9fa37f))
- Remove release job from build.yml, add embed step ([#36](https://github.com/bpamiri/grove/pull/36))
- Use RELEASE_PAT to bypass branch protection in release workflow ([481d32e](https://github.com/bpamiri/grove/commit/481d32e))
- Replace macos-13 with cross-compilation on macos-14 ([480d5c0](https://github.com/bpamiri/grove/commit/480d5c0))

### 💅 Refactors

- TunnelConfig — replace name with secret, remove named-tunnel field ([a02b540](https://github.com/bpamiri/grove/commit/a02b540))
- Simplify tunnel to quick-tunnels only, remove named-tunnel code ([e6aee5d](https://github.com/bpamiri/grove/commit/e6aee5d))
- Extract orchestrator event parsing into reusable module ([#23](https://github.com/bpamiri/grove/pull/23))

### 📖 Documentation

- Configurable pipeline state machine design spec ([53b417b](https://github.com/bpamiri/grove/commit/53b417b))
- Configurable pipeline implementation plan (14 tasks) ([bcea19c](https://github.com/bpamiri/grove/commit/bcea19c))
- Update tunnel config example for grove.cloud Worker proxy ([1c5897f](https://github.com/bpamiri/grove/commit/1c5897f))
- Plant a Seed design spec — interactive brainstorming for tasks ([a7c9dc3](https://github.com/bpamiri/grove/commit/a7c9dc3))
- Plant a Seed implementation plan ([2493696](https://github.com/bpamiri/grove/commit/2493696))
- Grove.cloud Worker proxy spec and plan ([6ed0914](https://github.com/bpamiri/grove/commit/6ed0914))
- Update README with all new features — notifications, dashboard, distribution, JSONL orchestrator ([3962c5f](https://github.com/bpamiri/grove/commit/3962c5f))
- Release automation design spec ([#36](https://github.com/bpamiri/grove/pull/36))
- Release automation implementation plan ([#36](https://github.com/bpamiri/grove/pull/36))
- Release automation design spec ([#36](https://github.com/bpamiri/grove/pull/36))
- Release automation implementation plan ([#36](https://github.com/bpamiri/grove/pull/36))
- Grove upgrade design spec ([#35](https://github.com/bpamiri/grove/pull/35))
- Grove upgrade implementation plan ([#35](https://github.com/bpamiri/grove/pull/35))

### 🏡 Chore

- Commit build artifact and implementation plan doc ([cf30ce4](https://github.com/bpamiri/grove/commit/cf30ce4))
- Gitignore tsbuildinfo build artifacts ([b5a7ff2](https://github.com/bpamiri/grove/commit/b5a7ff2))
- Gitignore tsbuildinfo build artifacts ([eb8e7b5](https://github.com/bpamiri/grove/commit/eb8e7b5))
- Add changelogen dev dependency ([#36](https://github.com/bpamiri/grove/pull/36))
- **release:** V3.0.0 ([77c21f3](https://github.com/bpamiri/grove/commit/77c21f3))
- **release:** V3.0.1 ([f72bfda](https://github.com/bpamiri/grove/commit/f72bfda))
- Reset version to 0.1.0 ([861e3b0](https://github.com/bpamiri/grove/commit/861e3b0))

### ✅ Tests

- Add test fixture helpers — db, repo, tree, task factories ([#27](https://github.com/bpamiri/grove/pull/27))
- Evaluator gate unit tests — commits, diff_size, missing worktree, retry prompt ([#27](https://github.com/bpamiri/grove/pull/27))
- Step engine tests — path normalization, transitions, retry state ([#27](https://github.com/bpamiri/grove/pull/27))
- Dispatch tests — dependencies, blocking, task filtering ([#27](https://github.com/bpamiri/grove/pull/27))
- Cost monitor tests — per-task budget, daily/weekly aggregation ([#27](https://github.com/bpamiri/grove/pull/27))
- Stream parser tests — cost parsing, line formatting, broker events, PID liveness ([#27](https://github.com/bpamiri/grove/pull/27))

### 🤖 CI

- Add GitHub Actions test workflow — runs bun test on push and PR ([#27](https://github.com/bpamiri/grove/pull/27))
- Multi-platform release workflow — macOS arm64/x64, Linux x64 ([#26](https://github.com/bpamiri/grove/pull/26))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v3.0.1

[compare changes](https://github.com/bpamiri/grove/compare/v3.0.0-alpha.0...v3.0.1)

### 🚀 Enhancements

- Fix web UI serving, orchestrator chat, and add GUI improvements ([d3a51f9](https://github.com/bpamiri/grove/commit/d3a51f9))
- Smart retry for failed/stuck tasks ([222ace9](https://github.com/bpamiri/grove/commit/222ace9))
- Show Cloudflare tunnel URL in sidebar ([8bfd9c0](https://github.com/bpamiri/grove/commit/8bfd9c0))
- Per-tree default_branch for worktree creation and evaluation ([15ddb8b](https://github.com/bpamiri/grove/commit/15ddb8b))
- Responsive mobile layout with tab navigation ([269720a](https://github.com/bpamiri/grove/commit/269720a))
- CI failure → worker fix loop for continuous PR improvement ([26d44be](https://github.com/bpamiri/grove/commit/26d44be))
- Show thinking and text in activity feed ([c12b68f](https://github.com/bpamiri/grove/commit/c12b68f))
- Add PipelineStep type and update TaskStatus enum to 5 lifecycle values ([d469fa4](https://github.com/bpamiri/grove/commit/d469fa4))
- Add path normalization — expands YAML shorthand to full PipelineStep arrays ([ff22c25](https://github.com/bpamiri/grove/commit/ff22c25))
- Add configNormalizedPaths for resolved pipeline step configs ([ab24aa1](https://github.com/bpamiri/grove/commit/ab24aa1))
- Add current_step, step_index, paused columns with migration for existing data ([52271d9](https://github.com/bpamiri/grove/commit/52271d9))
- Add step engine — configurable pipeline replaces hardcoded event wiring ([d13ec0a](https://github.com/bpamiri/grove/commit/d13ec0a))
- Worker uses step engine callbacks and accepts step prompts ([bb6cfad](https://github.com/bpamiri/grove/commit/bb6cfad))
- Merge manager delegates status transitions to step engine ([5aa1a5f](https://github.com/bpamiri/grove/commit/5aa1a5f))
- Add GET /api/paths endpoint, update status values across API ([7e987f1](https://github.com/bpamiri/grove/commit/7e987f1))
- Rewrite Pipeline component — data-driven from path config and task state ([0e4fbf6](https://github.com/bpamiri/grove/commit/0e4fbf6))
- UseTasks hook fetches paths and handles step change events ([3b24a02](https://github.com/bpamiri/grove/commit/3b24a02))
- Update frontend status values, Pipeline gets data-driven props ([15290f4](https://github.com/bpamiri/grove/commit/15290f4))
- GitHub issue picker in task form, post-merge cleanup, gitDeleteBranch ([384e4ea](https://github.com/bpamiri/grove/commit/384e4ea))
- Scaffold grove.cloud Cloudflare Worker with registration + proxy ([656bcf1](https://github.com/bpamiri/grove/commit/656bcf1))
- Add generateSecret for registry ownership ([ce111f3](https://github.com/bpamiri/grove/commit/ce111f3))
- Add grove.cloud registry client with heartbeat ([da44f0a](https://github.com/bpamiri/grove/commit/da44f0a))
- CLI shows both tunnel and remote URLs ([91b576b](https://github.com/bpamiri/grove/commit/91b576b))
- Rotate-credentials deregisters old subdomain from grove.cloud ([f280a95](https://github.com/bpamiri/grove/commit/f280a95))
- Wire registry into broker startup/shutdown with heartbeat ([837dac2](https://github.com/bpamiri/grove/commit/837dac2))
- Deploy grove.cloud Worker with KV namespace ([aa680a9](https://github.com/bpamiri/grove/commit/aa680a9))
- Add seeds table and CRUD methods for brainstorming artifacts ([f213fbc](https://github.com/bpamiri/grove/commit/f213fbc))
- Seed session manager — tmux-based interactive brainstorming ([480983f](https://github.com/bpamiri/grove/commit/480983f))
- Wire seed sessions into WebSocket and REST API ([67c953c](https://github.com/bpamiri/grove/commit/67c953c))
- Inject seed into workers, skip plan step, enhance evaluator ([bea5d04](https://github.com/bpamiri/grove/commit/bea5d04))
- Seed frontend — useSeed hook, SeedChat, SeedBadge, SeedFrame CSS ([24e6912](https://github.com/bpamiri/grove/commit/24e6912))
- Integrate seed into TaskDetail, TaskList, and App ([fb815bb](https://github.com/bpamiri/grove/commit/fb815bb))
- (W-020) add activity indicators for AI agent processing ([6b7425b](https://github.com/bpamiri/grove/commit/6b7425b))
- (W-019) persist UI state across page refresh via localStorage ([22ec15f](https://github.com/bpamiri/grove/commit/22ec15f))
- (W-020) add activity indicators to web UI ([e9b4639](https://github.com/bpamiri/grove/commit/e9b4639))
- (W-021) handle merge conflicts with auto-rebase and escalation ([f0ae3c4](https://github.com/bpamiri/grove/commit/f0ae3c4))
- (W-021) configurable default branch, trivial conflict auto-resolution, retry merge UI ([3e2b06c](https://github.com/bpamiri/grove/commit/3e2b06c))
- (W-024) auto-close linked GitHub issues on PR merge ([be452a9](https://github.com/bpamiri/grove/commit/be452a9))
- (W-024) auto-close linked GitHub issues on PR merge ([01d695c](https://github.com/bpamiri/grove/commit/01d695c))
- Rewrite orchestrator to pipe-based JSONL communication ([#23](https://github.com/bpamiri/grove/pull/23))
- Notification dispatcher with rate limiting and event routing ([#24](https://github.com/bpamiri/grove/pull/24))
- Slack notification channel with Block Kit formatting ([#24](https://github.com/bpamiri/grove/pull/24))
- System notification channel — macOS + Linux support with quiet hours ([#24](https://github.com/bpamiri/grove/pull/24))
- Webhook notification channel with HMAC-SHA256 signing ([#24](https://github.com/bpamiri/grove/pull/24))
- Wire notification system into event bus and broker startup ([#24](https://github.com/bpamiri/grove/pull/24))
- Analytics API — cost breakdown, gate stats, timeline endpoints ([#25](https://github.com/bpamiri/grove/pull/25))
- Analytics dashboard — timeline, cost charts, gate analytics ([#25](https://github.com/bpamiri/grove/pull/25))
- Install script for curl-pipe installation ([#26](https://github.com/bpamiri/grove/pull/26))
- Grove.cloud landing page with install instructions ([#26](https://github.com/bpamiri/grove/pull/26))
- Restore full-stack Grove (backend + web) to main ([bad5aeb](https://github.com/bpamiri/grove/commit/bad5aeb))
- Add version sync script ([#36](https://github.com/bpamiri/grove/pull/36))
- Add manual-dispatch release workflow ([#36](https://github.com/bpamiri/grove/pull/36))
- Add platform detection and GitHub release fetch ([#35](https://github.com/bpamiri/grove/pull/35))
- Add cached update check ([#35](https://github.com/bpamiri/grove/pull/35))
- Add grove upgrade command ([#35](https://github.com/bpamiri/grove/pull/35))
- Register upgrade command, wire update check to grove up ([#35](https://github.com/bpamiri/grove/pull/35))

### 🩹 Fixes

- Activity log, duplicate pipeline, and stream-json parsing ([4a7995b](https://github.com/bpamiri/grove/commit/4a7995b))
- Add --dangerously-skip-permissions to worker claude sessions ([2889b4e](https://github.com/bpamiri/grove/commit/2889b4e))
- Evaluator uses project conventions instead of guessing ([b7ba1ef](https://github.com/bpamiri/grove/commit/b7ba1ef))
- Show Retry button for evaluating (stuck) tasks ([1f08f2b](https://github.com/bpamiri/grove/commit/1f08f2b))
- PR creation — remove invalid --json flag, add --base branch ([8af2dd8](https://github.com/bpamiri/grove/commit/8af2dd8))
- Use conventional commit format for PR titles and commit messages ([3ddf1e4](https://github.com/bpamiri/grove/commit/3ddf1e4))
- Actionable CI failure instructions for workers ([43d5329](https://github.com/bpamiri/grove/commit/43d5329))
- Use scopeless conventional commits (feat:, fix:, not feat(W-001):) ([1d430bf](https://github.com/bpamiri/grove/commit/1d430bf))
- Include task ID in commit subject — feat: (W-001) description ([b14c0d9](https://github.com/bpamiri/grove/commit/b14c0d9))
- Gh pr checks uses state field, not conclusion ([c3b9add](https://github.com/bpamiri/grove/commit/c3b9add))
- Evaluator no longer sets status directly — step engine handles transitions ([24db9bf](https://github.com/bpamiri/grove/commit/24db9bf))
- Dispatch uses queued status and delegates to step engine ([d9968da](https://github.com/bpamiri/grove/commit/d9968da))
- Add post-merge cleanup (worktree + branch deletion) to merge manager ([d3feb61](https://github.com/bpamiri/grove/commit/d3feb61))
- Remove worktree from index, add to gitignore ([f776860](https://github.com/bpamiri/grove/commit/f776860))
- (W-016) skip tasks in terminal states during broker processing ([ca8b3bb](https://github.com/bpamiri/grove/commit/ca8b3bb))
- (W-018) persist resizable pane widths in localStorage ([75c34d0](https://github.com/bpamiri/grove/commit/75c34d0))
- (W-017) preserve tree filter during pipeline step transitions ([023f6e4](https://github.com/bpamiri/grove/commit/023f6e4))
- Add missing build:embed step to CI build workflow ([8bfa31d](https://github.com/bpamiri/grove/commit/8bfa31d))
- Commit missing recoverOrphanedTasks in health monitor ([43a7d5e](https://github.com/bpamiri/grove/commit/43a7d5e))
- Commit remaining uncommitted features referenced by merged code ([42f01b0](https://github.com/bpamiri/grove/commit/42f01b0))
- Align tests with implementation — resolve 11 pre-existing failures ([37138a1](https://github.com/bpamiri/grove/commit/37138a1))
- Sidebar TypeScript error + build workflow missing embed step ([c9fa37f](https://github.com/bpamiri/grove/commit/c9fa37f))
- Remove release job from build.yml, add embed step ([#36](https://github.com/bpamiri/grove/pull/36))
- Use RELEASE_PAT to bypass branch protection in release workflow ([481d32e](https://github.com/bpamiri/grove/commit/481d32e))
- Replace macos-13 with cross-compilation on macos-14 ([480d5c0](https://github.com/bpamiri/grove/commit/480d5c0))

### 💅 Refactors

- TunnelConfig — replace name with secret, remove named-tunnel field ([a02b540](https://github.com/bpamiri/grove/commit/a02b540))
- Simplify tunnel to quick-tunnels only, remove named-tunnel code ([e6aee5d](https://github.com/bpamiri/grove/commit/e6aee5d))
- Extract orchestrator event parsing into reusable module ([#23](https://github.com/bpamiri/grove/pull/23))

### 📖 Documentation

- Configurable pipeline state machine design spec ([53b417b](https://github.com/bpamiri/grove/commit/53b417b))
- Configurable pipeline implementation plan (14 tasks) ([bcea19c](https://github.com/bpamiri/grove/commit/bcea19c))
- Update tunnel config example for grove.cloud Worker proxy ([1c5897f](https://github.com/bpamiri/grove/commit/1c5897f))
- Plant a Seed design spec — interactive brainstorming for tasks ([a7c9dc3](https://github.com/bpamiri/grove/commit/a7c9dc3))
- Plant a Seed implementation plan ([2493696](https://github.com/bpamiri/grove/commit/2493696))
- Grove.cloud Worker proxy spec and plan ([6ed0914](https://github.com/bpamiri/grove/commit/6ed0914))
- Update README with all new features — notifications, dashboard, distribution, JSONL orchestrator ([3962c5f](https://github.com/bpamiri/grove/commit/3962c5f))
- Release automation design spec ([#36](https://github.com/bpamiri/grove/pull/36))
- Release automation implementation plan ([#36](https://github.com/bpamiri/grove/pull/36))
- Release automation design spec ([#36](https://github.com/bpamiri/grove/pull/36))
- Release automation implementation plan ([#36](https://github.com/bpamiri/grove/pull/36))
- Grove upgrade design spec ([#35](https://github.com/bpamiri/grove/pull/35))
- Grove upgrade implementation plan ([#35](https://github.com/bpamiri/grove/pull/35))

### 🏡 Chore

- Commit build artifact and implementation plan doc ([cf30ce4](https://github.com/bpamiri/grove/commit/cf30ce4))
- Gitignore tsbuildinfo build artifacts ([b5a7ff2](https://github.com/bpamiri/grove/commit/b5a7ff2))
- Gitignore tsbuildinfo build artifacts ([eb8e7b5](https://github.com/bpamiri/grove/commit/eb8e7b5))
- Add changelogen dev dependency ([#36](https://github.com/bpamiri/grove/pull/36))
- **release:** V3.0.0 ([77c21f3](https://github.com/bpamiri/grove/commit/77c21f3))

### ✅ Tests

- Add test fixture helpers — db, repo, tree, task factories ([#27](https://github.com/bpamiri/grove/pull/27))
- Evaluator gate unit tests — commits, diff_size, missing worktree, retry prompt ([#27](https://github.com/bpamiri/grove/pull/27))
- Step engine tests — path normalization, transitions, retry state ([#27](https://github.com/bpamiri/grove/pull/27))
- Dispatch tests — dependencies, blocking, task filtering ([#27](https://github.com/bpamiri/grove/pull/27))
- Cost monitor tests — per-task budget, daily/weekly aggregation ([#27](https://github.com/bpamiri/grove/pull/27))
- Stream parser tests — cost parsing, line formatting, broker events, PID liveness ([#27](https://github.com/bpamiri/grove/pull/27))

### 🤖 CI

- Add GitHub Actions test workflow — runs bun test on push and PR ([#27](https://github.com/bpamiri/grove/pull/27))
- Multi-platform release workflow — macOS arm64/x64, Linux x64 ([#26](https://github.com/bpamiri/grove/pull/26))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

## v3.0.0

[compare changes](https://github.com/bpamiri/grove/compare/v3.0.0-alpha.0...v3.0.0)

### 🚀 Enhancements

- Fix web UI serving, orchestrator chat, and add GUI improvements ([d3a51f9](https://github.com/bpamiri/grove/commit/d3a51f9))
- Smart retry for failed/stuck tasks ([222ace9](https://github.com/bpamiri/grove/commit/222ace9))
- Show Cloudflare tunnel URL in sidebar ([8bfd9c0](https://github.com/bpamiri/grove/commit/8bfd9c0))
- Per-tree default_branch for worktree creation and evaluation ([15ddb8b](https://github.com/bpamiri/grove/commit/15ddb8b))
- Responsive mobile layout with tab navigation ([269720a](https://github.com/bpamiri/grove/commit/269720a))
- CI failure → worker fix loop for continuous PR improvement ([26d44be](https://github.com/bpamiri/grove/commit/26d44be))
- Show thinking and text in activity feed ([c12b68f](https://github.com/bpamiri/grove/commit/c12b68f))
- Add PipelineStep type and update TaskStatus enum to 5 lifecycle values ([d469fa4](https://github.com/bpamiri/grove/commit/d469fa4))
- Add path normalization — expands YAML shorthand to full PipelineStep arrays ([ff22c25](https://github.com/bpamiri/grove/commit/ff22c25))
- Add configNormalizedPaths for resolved pipeline step configs ([ab24aa1](https://github.com/bpamiri/grove/commit/ab24aa1))
- Add current_step, step_index, paused columns with migration for existing data ([52271d9](https://github.com/bpamiri/grove/commit/52271d9))
- Add step engine — configurable pipeline replaces hardcoded event wiring ([d13ec0a](https://github.com/bpamiri/grove/commit/d13ec0a))
- Worker uses step engine callbacks and accepts step prompts ([bb6cfad](https://github.com/bpamiri/grove/commit/bb6cfad))
- Merge manager delegates status transitions to step engine ([5aa1a5f](https://github.com/bpamiri/grove/commit/5aa1a5f))
- Add GET /api/paths endpoint, update status values across API ([7e987f1](https://github.com/bpamiri/grove/commit/7e987f1))
- Rewrite Pipeline component — data-driven from path config and task state ([0e4fbf6](https://github.com/bpamiri/grove/commit/0e4fbf6))
- UseTasks hook fetches paths and handles step change events ([3b24a02](https://github.com/bpamiri/grove/commit/3b24a02))
- Update frontend status values, Pipeline gets data-driven props ([15290f4](https://github.com/bpamiri/grove/commit/15290f4))
- GitHub issue picker in task form, post-merge cleanup, gitDeleteBranch ([384e4ea](https://github.com/bpamiri/grove/commit/384e4ea))
- Scaffold grove.cloud Cloudflare Worker with registration + proxy ([656bcf1](https://github.com/bpamiri/grove/commit/656bcf1))
- Add generateSecret for registry ownership ([ce111f3](https://github.com/bpamiri/grove/commit/ce111f3))
- Add grove.cloud registry client with heartbeat ([da44f0a](https://github.com/bpamiri/grove/commit/da44f0a))
- CLI shows both tunnel and remote URLs ([91b576b](https://github.com/bpamiri/grove/commit/91b576b))
- Rotate-credentials deregisters old subdomain from grove.cloud ([f280a95](https://github.com/bpamiri/grove/commit/f280a95))
- Wire registry into broker startup/shutdown with heartbeat ([837dac2](https://github.com/bpamiri/grove/commit/837dac2))
- Deploy grove.cloud Worker with KV namespace ([aa680a9](https://github.com/bpamiri/grove/commit/aa680a9))
- Add seeds table and CRUD methods for brainstorming artifacts ([f213fbc](https://github.com/bpamiri/grove/commit/f213fbc))
- Seed session manager — tmux-based interactive brainstorming ([480983f](https://github.com/bpamiri/grove/commit/480983f))
- Wire seed sessions into WebSocket and REST API ([67c953c](https://github.com/bpamiri/grove/commit/67c953c))
- Inject seed into workers, skip plan step, enhance evaluator ([bea5d04](https://github.com/bpamiri/grove/commit/bea5d04))
- Seed frontend — useSeed hook, SeedChat, SeedBadge, SeedFrame CSS ([24e6912](https://github.com/bpamiri/grove/commit/24e6912))
- Integrate seed into TaskDetail, TaskList, and App ([fb815bb](https://github.com/bpamiri/grove/commit/fb815bb))
- (W-020) add activity indicators for AI agent processing ([6b7425b](https://github.com/bpamiri/grove/commit/6b7425b))
- (W-019) persist UI state across page refresh via localStorage ([22ec15f](https://github.com/bpamiri/grove/commit/22ec15f))
- (W-020) add activity indicators to web UI ([e9b4639](https://github.com/bpamiri/grove/commit/e9b4639))
- (W-021) handle merge conflicts with auto-rebase and escalation ([f0ae3c4](https://github.com/bpamiri/grove/commit/f0ae3c4))
- (W-021) configurable default branch, trivial conflict auto-resolution, retry merge UI ([3e2b06c](https://github.com/bpamiri/grove/commit/3e2b06c))
- (W-024) auto-close linked GitHub issues on PR merge ([be452a9](https://github.com/bpamiri/grove/commit/be452a9))
- (W-024) auto-close linked GitHub issues on PR merge ([01d695c](https://github.com/bpamiri/grove/commit/01d695c))
- Rewrite orchestrator to pipe-based JSONL communication ([#23](https://github.com/bpamiri/grove/pull/23))
- Notification dispatcher with rate limiting and event routing ([#24](https://github.com/bpamiri/grove/pull/24))
- Slack notification channel with Block Kit formatting ([#24](https://github.com/bpamiri/grove/pull/24))
- System notification channel — macOS + Linux support with quiet hours ([#24](https://github.com/bpamiri/grove/pull/24))
- Webhook notification channel with HMAC-SHA256 signing ([#24](https://github.com/bpamiri/grove/pull/24))
- Wire notification system into event bus and broker startup ([#24](https://github.com/bpamiri/grove/pull/24))
- Analytics API — cost breakdown, gate stats, timeline endpoints ([#25](https://github.com/bpamiri/grove/pull/25))
- Analytics dashboard — timeline, cost charts, gate analytics ([#25](https://github.com/bpamiri/grove/pull/25))
- Install script for curl-pipe installation ([#26](https://github.com/bpamiri/grove/pull/26))
- Grove.cloud landing page with install instructions ([#26](https://github.com/bpamiri/grove/pull/26))
- Restore full-stack Grove (backend + web) to main ([bad5aeb](https://github.com/bpamiri/grove/commit/bad5aeb))
- Add version sync script ([#36](https://github.com/bpamiri/grove/pull/36))
- Add manual-dispatch release workflow ([#36](https://github.com/bpamiri/grove/pull/36))
- Add platform detection and GitHub release fetch ([#35](https://github.com/bpamiri/grove/pull/35))
- Add cached update check ([#35](https://github.com/bpamiri/grove/pull/35))
- Add grove upgrade command ([#35](https://github.com/bpamiri/grove/pull/35))
- Register upgrade command, wire update check to grove up ([#35](https://github.com/bpamiri/grove/pull/35))

### 🩹 Fixes

- Activity log, duplicate pipeline, and stream-json parsing ([4a7995b](https://github.com/bpamiri/grove/commit/4a7995b))
- Add --dangerously-skip-permissions to worker claude sessions ([2889b4e](https://github.com/bpamiri/grove/commit/2889b4e))
- Evaluator uses project conventions instead of guessing ([b7ba1ef](https://github.com/bpamiri/grove/commit/b7ba1ef))
- Show Retry button for evaluating (stuck) tasks ([1f08f2b](https://github.com/bpamiri/grove/commit/1f08f2b))
- PR creation — remove invalid --json flag, add --base branch ([8af2dd8](https://github.com/bpamiri/grove/commit/8af2dd8))
- Use conventional commit format for PR titles and commit messages ([3ddf1e4](https://github.com/bpamiri/grove/commit/3ddf1e4))
- Actionable CI failure instructions for workers ([43d5329](https://github.com/bpamiri/grove/commit/43d5329))
- Use scopeless conventional commits (feat:, fix:, not feat(W-001):) ([1d430bf](https://github.com/bpamiri/grove/commit/1d430bf))
- Include task ID in commit subject — feat: (W-001) description ([b14c0d9](https://github.com/bpamiri/grove/commit/b14c0d9))
- Gh pr checks uses state field, not conclusion ([c3b9add](https://github.com/bpamiri/grove/commit/c3b9add))
- Evaluator no longer sets status directly — step engine handles transitions ([24db9bf](https://github.com/bpamiri/grove/commit/24db9bf))
- Dispatch uses queued status and delegates to step engine ([d9968da](https://github.com/bpamiri/grove/commit/d9968da))
- Add post-merge cleanup (worktree + branch deletion) to merge manager ([d3feb61](https://github.com/bpamiri/grove/commit/d3feb61))
- Remove worktree from index, add to gitignore ([f776860](https://github.com/bpamiri/grove/commit/f776860))
- (W-016) skip tasks in terminal states during broker processing ([ca8b3bb](https://github.com/bpamiri/grove/commit/ca8b3bb))
- (W-018) persist resizable pane widths in localStorage ([75c34d0](https://github.com/bpamiri/grove/commit/75c34d0))
- (W-017) preserve tree filter during pipeline step transitions ([023f6e4](https://github.com/bpamiri/grove/commit/023f6e4))
- Add missing build:embed step to CI build workflow ([8bfa31d](https://github.com/bpamiri/grove/commit/8bfa31d))
- Commit missing recoverOrphanedTasks in health monitor ([43a7d5e](https://github.com/bpamiri/grove/commit/43a7d5e))
- Commit remaining uncommitted features referenced by merged code ([42f01b0](https://github.com/bpamiri/grove/commit/42f01b0))
- Align tests with implementation — resolve 11 pre-existing failures ([37138a1](https://github.com/bpamiri/grove/commit/37138a1))
- Sidebar TypeScript error + build workflow missing embed step ([c9fa37f](https://github.com/bpamiri/grove/commit/c9fa37f))
- Remove release job from build.yml, add embed step ([#36](https://github.com/bpamiri/grove/pull/36))
- Use RELEASE_PAT to bypass branch protection in release workflow ([481d32e](https://github.com/bpamiri/grove/commit/481d32e))

### 💅 Refactors

- TunnelConfig — replace name with secret, remove named-tunnel field ([a02b540](https://github.com/bpamiri/grove/commit/a02b540))
- Simplify tunnel to quick-tunnels only, remove named-tunnel code ([e6aee5d](https://github.com/bpamiri/grove/commit/e6aee5d))
- Extract orchestrator event parsing into reusable module ([#23](https://github.com/bpamiri/grove/pull/23))

### 📖 Documentation

- Configurable pipeline state machine design spec ([53b417b](https://github.com/bpamiri/grove/commit/53b417b))
- Configurable pipeline implementation plan (14 tasks) ([bcea19c](https://github.com/bpamiri/grove/commit/bcea19c))
- Update tunnel config example for grove.cloud Worker proxy ([1c5897f](https://github.com/bpamiri/grove/commit/1c5897f))
- Plant a Seed design spec — interactive brainstorming for tasks ([a7c9dc3](https://github.com/bpamiri/grove/commit/a7c9dc3))
- Plant a Seed implementation plan ([2493696](https://github.com/bpamiri/grove/commit/2493696))
- Grove.cloud Worker proxy spec and plan ([6ed0914](https://github.com/bpamiri/grove/commit/6ed0914))
- Update README with all new features — notifications, dashboard, distribution, JSONL orchestrator ([3962c5f](https://github.com/bpamiri/grove/commit/3962c5f))
- Release automation design spec ([#36](https://github.com/bpamiri/grove/pull/36))
- Release automation implementation plan ([#36](https://github.com/bpamiri/grove/pull/36))
- Release automation design spec ([#36](https://github.com/bpamiri/grove/pull/36))
- Release automation implementation plan ([#36](https://github.com/bpamiri/grove/pull/36))
- Grove upgrade design spec ([#35](https://github.com/bpamiri/grove/pull/35))
- Grove upgrade implementation plan ([#35](https://github.com/bpamiri/grove/pull/35))

### 🏡 Chore

- Commit build artifact and implementation plan doc ([cf30ce4](https://github.com/bpamiri/grove/commit/cf30ce4))
- Gitignore tsbuildinfo build artifacts ([b5a7ff2](https://github.com/bpamiri/grove/commit/b5a7ff2))
- Gitignore tsbuildinfo build artifacts ([eb8e7b5](https://github.com/bpamiri/grove/commit/eb8e7b5))
- Add changelogen dev dependency ([#36](https://github.com/bpamiri/grove/pull/36))

### ✅ Tests

- Add test fixture helpers — db, repo, tree, task factories ([#27](https://github.com/bpamiri/grove/pull/27))
- Evaluator gate unit tests — commits, diff_size, missing worktree, retry prompt ([#27](https://github.com/bpamiri/grove/pull/27))
- Step engine tests — path normalization, transitions, retry state ([#27](https://github.com/bpamiri/grove/pull/27))
- Dispatch tests — dependencies, blocking, task filtering ([#27](https://github.com/bpamiri/grove/pull/27))
- Cost monitor tests — per-task budget, daily/weekly aggregation ([#27](https://github.com/bpamiri/grove/pull/27))
- Stream parser tests — cost parsing, line formatting, broker events, PID liveness ([#27](https://github.com/bpamiri/grove/pull/27))

### 🤖 CI

- Add GitHub Actions test workflow — runs bun test on push and PR ([#27](https://github.com/bpamiri/grove/pull/27))
- Multi-platform release workflow — macOS arm64/x64, Linux x64 ([#26](https://github.com/bpamiri/grove/pull/26))

### ❤️ Contributors

- Peter Amiri ([@bpamiri](https://github.com/bpamiri))

