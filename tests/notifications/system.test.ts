import { describe, test, expect } from "bun:test";
import { isQuietHours, parseHour } from "../../src/notifications/channels/system";

describe("parseHour", () => {
  test("parses HH:MM to hour number", () => {
    expect(parseHour("22:00")).toBe(22);
    expect(parseHour("07:30")).toBe(7);
    expect(parseHour("0:00")).toBe(0);
  });
});

describe("isQuietHours", () => {
  test("returns false when no quiet hours configured", () => {
    expect(isQuietHours(undefined)).toBe(false);
  });

  test("same-day range: within quiet hours", () => {
    // 9:00 to 17:00, current hour = 12
    expect(isQuietHours({ start: "09:00", end: "17:00" }, 12)).toBe(true);
  });

  test("same-day range: outside quiet hours", () => {
    expect(isQuietHours({ start: "09:00", end: "17:00" }, 20)).toBe(false);
  });

  test("midnight-crossing range: within quiet hours (late night)", () => {
    // 22:00 to 07:00, current hour = 23
    expect(isQuietHours({ start: "22:00", end: "07:00" }, 23)).toBe(true);
  });

  test("midnight-crossing range: within quiet hours (early morning)", () => {
    expect(isQuietHours({ start: "22:00", end: "07:00" }, 3)).toBe(true);
  });

  test("midnight-crossing range: outside quiet hours", () => {
    expect(isQuietHours({ start: "22:00", end: "07:00" }, 12)).toBe(false);
  });

  test("boundary: at start hour is quiet", () => {
    expect(isQuietHours({ start: "22:00", end: "07:00" }, 22)).toBe(true);
  });

  test("boundary: at end hour is not quiet", () => {
    expect(isQuietHours({ start: "22:00", end: "07:00" }, 7)).toBe(false);
  });
});
