import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestBroker, createTestTask, type TestBroker } from "./helpers";

let broker: TestBroker;

beforeEach(() => {
  broker = createTestBroker();
});

afterEach(() => {
  broker.cleanup();
});

describe("task lifecycle", () => {
  test("creates a task in draft status", () => {
    const taskId = createTestTask(broker.db);
    const task = broker.db.taskGet(taskId);
    expect(task).not.toBeNull();
    expect(task!.status).toBe("draft");
    expect(task!.tree_id).toBe("test");
  });

  test("task transitions from draft to queued on dispatch", () => {
    const taskId = createTestTask(broker.db);
    broker.db.taskSetStatus(taskId, "queued");
    const task = broker.db.taskGet(taskId);
    expect(task!.status).toBe("queued");
  });

  test("task with depends_on is blocked until dependency completes", () => {
    const depId = createTestTask(broker.db, { title: "Dependency" });
    const taskId = createTestTask(broker.db, { title: "Dependent" });
    broker.db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [depId, taskId]);

    expect(broker.db.isTaskBlocked(taskId)).toBe(true);

    // Complete the dependency
    broker.db.taskSetStatus(depId, "completed");
    expect(broker.db.isTaskBlocked(taskId)).toBe(false);
  });

  test("getNewlyUnblocked returns tasks when dependency completes", () => {
    const depId = createTestTask(broker.db, { title: "Dep", status: "active" });
    const waiterId = createTestTask(broker.db, { title: "Waiter", status: "queued" });
    broker.db.run("UPDATE tasks SET depends_on = ? WHERE id = ?", [depId, waiterId]);

    broker.db.taskSetStatus(depId, "completed");
    const unblocked = broker.db.getNewlyUnblocked(depId);
    expect(unblocked.map((t: any) => t.id)).toContain(waiterId);
  });

  test("task cost accumulates across sessions", () => {
    const taskId = createTestTask(broker.db, { status: "active" });
    const sid1 = `worker-${taskId}-1`;
    const sid2 = `worker-${taskId}-2`;

    broker.db.sessionCreate(sid1, taskId, "worker");
    broker.db.sessionUpdateCost(sid1, 0.50, 5000);
    broker.db.sessionEnd(sid1, "completed");
    broker.db.run("UPDATE tasks SET cost_usd = cost_usd + 0.50 WHERE id = ?", [taskId]);

    broker.db.sessionCreate(sid2, taskId, "worker");
    broker.db.sessionUpdateCost(sid2, 0.30, 3000);
    broker.db.sessionEnd(sid2, "completed");
    broker.db.run("UPDATE tasks SET cost_usd = cost_usd + 0.30 WHERE id = ?", [taskId]);

    const task = broker.db.taskGet(taskId);
    expect(task!.cost_usd).toBeCloseTo(0.80, 2);
  });

  test("retry_count increments on failure", () => {
    const taskId = createTestTask(broker.db, { status: "active" });
    broker.db.run("UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?", [taskId]);
    broker.db.run("UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?", [taskId]);
    const task = broker.db.taskGet(taskId);
    expect(task!.retry_count).toBe(2);
  });

  test("task edges work for DAG dependencies", () => {
    const a = createTestTask(broker.db, { title: "A" });
    const b = createTestTask(broker.db, { title: "B" });
    broker.db.addEdge(a, b);

    const edges = broker.db.allTaskEdges();
    expect(edges.length).toBe(1);
    expect(edges[0].from_task).toBe(a);
    expect(edges[0].to_task).toBe(b);
  });

  test("checkpoint saves and loads", () => {
    const taskId = createTestTask(broker.db);
    const checkpoint = JSON.stringify({ taskId, stepId: "implement", commitSha: "abc123" });
    broker.db.checkpointSave(taskId, checkpoint);

    const loaded = broker.db.checkpointLoad(taskId);
    expect(loaded).not.toBeNull();
    const parsed = JSON.parse(loaded!);
    expect(parsed.stepId).toBe("implement");
  });
});
