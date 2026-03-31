// Grove v3 — Embedded schema SQL
// This file is the schema as a string constant so it works in compiled binaries.
export const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS trees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  github TEXT,
  branch_prefix TEXT DEFAULT 'grove/',
  config TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  tree_id TEXT REFERENCES trees(id),
  parent_task_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  path_name TEXT DEFAULT 'development',
  priority INTEGER DEFAULT 0,
  depends_on TEXT,
  branch TEXT,
  worktree_path TEXT,
  github_issue INTEGER,
  labels TEXT,
  pr_url TEXT,
  pr_number INTEGER,
  cost_usd REAL DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  gate_results TEXT,
  session_summary TEXT,
  files_modified TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 2,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  current_step TEXT,
  step_index INTEGER DEFAULT 0,
  paused INTEGER DEFAULT 0,
  source_pr INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  role TEXT NOT NULL,
  pid INTEGER,
  tmux_pane TEXT,
  cost_usd REAL DEFAULT 0,
  tokens_used INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  log_path TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  session_id TEXT,
  event_type TEXT NOT NULL,
  summary TEXT,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  channel TEXT DEFAULT 'main',
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS seeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  summary TEXT,
  spec TEXT,
  conversation TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_tree ON tasks(tree_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_sessions_role ON sessions(role);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_seeds_task ON seeds(task_id);
`;
