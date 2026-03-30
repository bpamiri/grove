import { describe, test, expect } from "bun:test";
import { extractGroveEvents, stripGroveEvents } from "../../src/agents/orchestrator-events";

describe("extractGroveEvents", () => {
  test("extracts a single event from text", () => {
    const text = 'I will create a task for that.\n<grove-event>{"type":"spawn_worker","tree":"titan","task":"W-001","prompt":"Fix auth bug"}</grove-event>\nLet me know if you need anything else.';
    const events = extractGroveEvents(text);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("spawn_worker");
    expect(events[0].tree).toBe("titan");
    expect(events[0].task).toBe("W-001");
    expect(events[0].prompt).toBe("Fix auth bug");
  });

  test("extracts multiple events from text", () => {
    const text = '<grove-event>{"type":"spawn_worker","tree":"a","task":"W-001","prompt":"task 1"}</grove-event>\nSome text\n<grove-event>{"type":"task_update","task":"W-002","field":"status","value":"queued"}</grove-event>';
    const events = extractGroveEvents(text);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("spawn_worker");
    expect(events[1].type).toBe("task_update");
  });

  test("returns empty array when no events", () => {
    const text = "Just a normal response with no events.";
    expect(extractGroveEvents(text)).toEqual([]);
  });

  test("skips malformed JSON inside tags", () => {
    const text = '<grove-event>not valid json</grove-event>\n<grove-event>{"type":"task_update","task":"W-001","field":"status","value":"done"}</grove-event>';
    const events = extractGroveEvents(text);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("task_update");
  });

  test("skips events without a type field", () => {
    const text = '<grove-event>{"foo":"bar"}</grove-event>';
    expect(extractGroveEvents(text)).toEqual([]);
  });

  test("handles multiline event tags", () => {
    const text = '<grove-event>{"type":"spawn_worker","tree":"t","task":"W-001","prompt":"a long prompt that spans"}</grove-event>';
    const events = extractGroveEvents(text);
    expect(events.length).toBe(1);
  });
});

describe("stripGroveEvents", () => {
  test("removes event tags, keeps surrounding text", () => {
    const text = 'Hello.\n<grove-event>{"type":"spawn_worker","tree":"t","task":"W-001","prompt":"x"}</grove-event>\nGoodbye.';
    const stripped = stripGroveEvents(text);
    expect(stripped).toBe("Hello.\n\nGoodbye.");
  });

  test("returns original text when no events", () => {
    const text = "No events here.";
    expect(stripGroveEvents(text)).toBe("No events here.");
  });

  test("trims extra whitespace from removal", () => {
    const text = '<grove-event>{"type":"task_update","task":"W-001","field":"status","value":"done"}</grove-event>';
    const stripped = stripGroveEvents(text);
    expect(stripped.trim()).toBe("");
  });
});
