// Grove v3 — Slack notification channel unit tests
import { describe, test, expect } from "bun:test";
import { formatSlackPayload } from "../../src/notifications/channels/slack";
import type { Notification } from "../../src/notifications/types";

const base: Notification = {
  event: "task_failed",
  title: "Task Failed",
  body: "Something went wrong",
  severity: "error",
};

describe("formatSlackPayload", () => {
  test("error notification → red color (#B60205) and title in block text", () => {
    const payload = formatSlackPayload({ ...base, severity: "error" });
    const attachment = payload.attachments[0];
    expect(attachment.color).toBe("#B60205");
    expect(attachment.blocks[0].text.text).toContain("Task Failed");
  });

  test("info notification → green color (#0E8A16)", () => {
    const payload = formatSlackPayload({ ...base, severity: "info" });
    expect(payload.attachments[0].color).toBe("#0E8A16");
  });

  test("warning notification → yellow color (#FBCA04)", () => {
    const payload = formatSlackPayload({ ...base, severity: "warning" });
    expect(payload.attachments[0].color).toBe("#FBCA04");
  });

  test("notification with taskId → context block contains task ID", () => {
    const payload = formatSlackPayload({ ...base, taskId: "W-007" });
    const context = payload.attachments[0].blocks[1];
    expect(context.elements[0].text).toContain("W-007");
    expect(context.elements[0].text).toContain("*Task:*");
  });

  test("notification without taskId → context block does not contain 'Task:'", () => {
    const payload = formatSlackPayload({ ...base });
    const context = payload.attachments[0].blocks[1];
    expect(context.elements[0].text).not.toContain("Task:");
  });
});
