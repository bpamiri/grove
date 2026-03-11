-- Grove v2 SQLite Schema
-- All tables for task tracking, sessions, events, and configuration.

PRAGMA journal_mode=WAL;  -- output suppressed by db_init
PRAGMA foreign_keys=ON;

-- The repos you work with
CREATE TABLE IF NOT EXISTS repos (
  name TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  github_full TEXT NOT NULL,
  local_path TEXT NOT NULL,
  branch_prefix TEXT DEFAULT 'grove/',
  claude_md_path TEXT,
  last_synced TEXT
);

-- Every piece of work, past and present
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  repo TEXT REFERENCES repos(name),
  source_type TEXT NOT NULL,
  source_ref TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'ingested',
  priority INTEGER DEFAULT 50,

  -- Planning
  strategy TEXT,
  strategy_config TEXT,
  estimated_cost REAL,
  estimated_files INTEGER,
  depends_on TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT NULL,

  -- Execution
  branch TEXT,
  worktree_path TEXT,
  session_id TEXT,
  pr_url TEXT,
  pr_number INTEGER,

  -- Continuity
  session_summary TEXT,
  files_modified TEXT,
  next_steps TEXT,

  -- Metrics
  cost_usd REAL DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  time_minutes REAL DEFAULT 0,

  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  paused_at TEXT,
  completed_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Every significant event, for the timeline view
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id),
  repo TEXT,
  timestamp TEXT DEFAULT (datetime('now')),
  event_type TEXT NOT NULL,
  summary TEXT,
  detail TEXT
);

-- Session records for worker tracking
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id),
  repo TEXT,
  worker_type TEXT,
  pid INTEGER,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  status TEXT,
  cost_usd REAL DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  output_log TEXT,
  summary TEXT
);

-- Sweep/audit results (for validation tasks)
CREATE TABLE IF NOT EXISTS audit_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id),
  module TEXT NOT NULL,
  status TEXT,
  completeness REAL,
  findings TEXT,
  checked_at TEXT
);

-- Cross-repo dependency declarations
CREATE TABLE IF NOT EXISTS repo_deps (
  upstream TEXT REFERENCES repos(name),
  downstream TEXT REFERENCES repos(name),
  relationship TEXT,
  PRIMARY KEY (upstream, downstream)
);

-- Key-value configuration store
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo);
CREATE INDEX IF NOT EXISTS idx_sessions_task_id ON sessions(task_id);
