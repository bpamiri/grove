# Troubleshooting

## Broker won't start

### Port conflict

**Cause:** `server.port` is set to a fixed value that's already in use.
**Fix:** Set `server.port: auto` in `~/.grove/grove.yaml`, or free the port:
```bash
lsof -ti :49152 | xargs kill -9
grove up
```

### Stale `broker.json` after crash

**Cause:** Grove crashed without cleaning up `~/.grove/broker.json`. `grove up` sees the file, reports "Grove is already running", and exits — even though the PID is dead.
**Fix:** `grove down` detects the dead PID and removes the file automatically:
```bash
grove down   # prints "Broker process is dead. Cleaning up..."
grove up
```
Or manually: `rm ~/.grove/broker.json && grove up`

---

## Worker stalls

### No activity for N minutes

**Cause:** The health monitor (15s interval) checks each running worker's log file mtime. If it hasn't changed for `stall_timeout_minutes` (default: 30), a `monitor:stall` event is emitted. The worker process is still alive but has stopped making progress. A checkpoint is saved before the stall is recorded.
**Fix:**
1. Check the log: `tail -f ~/.grove/logs/<session-id>.jsonl`
2. Cancel the task from the GUI → Tasks panel → Cancel, then re-queue.
3. Tune the timeout in `grove.yaml`:
   ```yaml
   settings:
     stall_timeout_minutes: 60
   ```

---

## Worktree creation fails

### Not a git repository

**Cause:** The tree's `path` in `grove.yaml` doesn't have a `.git` directory.
**Fix:** `git -C /your/repo status` — confirm it's a valid repo root.

### Branch conflict / stale worktree

**Cause:** A previous worktree wasn't cleaned up and the branch exists in a broken state.
**Fix:**
```bash
cd /your/repo
git worktree list
git worktree remove --force .grove/worktrees/<task-id>
git worktree prune
git branch -d grove/<task-id>-<slug>
```

### Disk full or permissions

**Cause:** `git worktree add` fails due to no disk space or write permissions on the repo directory.
**Fix:**
```bash
df -h                                      # check space
ls -la /your/repo/.grove/worktrees/       # check ownership
chown -R $(whoami) /your/repo/.grove/
```

---

## Tunnel fails to connect

### `cloudflared` not installed

**Cause:** Grove can't find `cloudflared` on `PATH`.
**Fix:** `brew install cloudflared` (or download from the Cloudflare docs), then `grove up`.

### Timed out after 30s

**Cause:** `cloudflared` started but didn't emit a `trycloudflare.com` URL within 30 seconds — usually a firewall blocking outbound port 7844/443.
**Fix:** Allow outbound traffic to Cloudflare's edge, or disable the tunnel:
```yaml
# grove.yaml — remove or comment out:
# tunnel:
#   provider: cloudflare
```
Tunnel failure is non-fatal — Grove continues and is still accessible at `http://localhost:<port>`.

---

## Cost budget exceeded mid-task

### New tasks stop dispatching

**Cause:** The cost monitor (30s interval) compares daily/weekly spend to `budgets.per_day` / `budgets.per_week`. When a ceiling is hit, `isSpawningPaused` is set to `true` and no new workers are spawned. In-flight workers continue until their per-task limit is reached.
**Fix — raise limits:**
```yaml
# ~/.grove/grove.yaml
budgets:
  per_task: 10.00
  per_day: 50.00
  per_week: 200.00
```
Then `grove down && grove up`.

**Fix — wait:** Daily budget resets at UTC midnight, weekly on Monday. Spawning resumes automatically once spend drops below both ceilings.

---

## Unclean shutdown / grove up after crash

### Tasks stuck in `active` after restart

**Cause:** After a hard kill, active task sessions are left as `running` in the DB. On next startup, `recoverOrphanedTasks` runs before dispatch:
1. All `running` sessions are closed as `crashed`.
2. `active` tasks are re-queued (up to `max_retries + 2` attempts).
3. Tasks that crashed within the last 5 minutes are also re-queued.

No manual action needed for standard recovery. The event log will show `auto_recovered`.

**If a task is permanently stuck:**
```bash
grove down && grove up          # re-runs startup recovery
# or cancel from the GUI and re-submit
```

**Orphaned claude processes after hard kill:**
```bash
pgrep -fl "claude"
kill <pid>
```

---

## Evaluator failures

### Rebase conflict loop

**Cause:** The evaluator rebases the worktree branch onto `origin/main` before running gates. If conflicts can't be auto-resolved, rebase is aborted. After **3 consecutive** rebase failures the task is marked fatally failed.
**Fix:** Resolve manually:
```bash
cd /your/repo/.grove/worktrees/<task-id>
git fetch origin
git rebase origin/main    # resolve conflicts
git rebase --continue
```
Then re-queue from the GUI.

### Hard gate failure (commits, tests)

**Cause:** `commits` gate fails when no commits exist on the branch. `tests` gate fails when `test_command` exits non-zero. Both are `hard` tier — they block the PR.
**Fix:** Hard gate failures feed back to the worker with the failure detail, and it retries automatically up to `max_retries`. If tests keep failing, check the command:
```yaml
trees:
  my-repo:
    quality_gates:
      test_command: "bun test"
      test_timeout: 120
```

### Retry budget exhausted

**Cause:** `recovery_exhausted` event — the task exceeded `max_retries + 2` total attempts.
**Fix:** Check the event log for the root cause, fix the environment or gate config, then re-submit the task.

---

## SQLite database locked

### `SqliteError: database is locked`

**Cause:** Grove uses WAL mode (`PRAGMA journal_mode=WAL`) which allows concurrent readers but only one writer. This error means two Grove processes are writing to the same `~/.grove/grove.db`.
**Fix:**
```bash
grove down
pgrep -fl "grove"    # find and kill any stray processes
grove up
```

If the lock persists after all processes stop, the WAL files may be stuck:
```bash
# Only run this when no Grove process is running:
rm -f ~/.grove/grove.db-wal ~/.grove/grove.db-shm
grove up
```

Do **not** delete `grove.db` — it contains all task history.

---

## Getting help

File issues at **https://github.com/bpamiri/grove/issues**. Include:
- `grove --version`
- `bun --version`
- Relevant log lines from `~/.grove/logs/` and the GUI event log
