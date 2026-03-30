// Grove v3 — Extract and parse <grove-event> tags from orchestrator text output
import type { BrokerEvent } from "../shared/types";

const GROVE_EVENT_REGEX = /<grove-event>(.*?)<\/grove-event>/gs;

/**
 * Extract all valid BrokerEvent objects from text containing <grove-event> tags.
 * Skips malformed JSON and objects without a `type` field.
 */
export function extractGroveEvents(text: string): BrokerEvent[] {
  const events: BrokerEvent[] = [];
  for (const match of text.matchAll(GROVE_EVENT_REGEX)) {
    try {
      const obj = JSON.parse(match[1]);
      if (obj.type && typeof obj.type === "string") {
        events.push(obj as BrokerEvent);
      }
    } catch {
      // Malformed JSON — skip
    }
  }
  return events;
}

/**
 * Remove all <grove-event>...</grove-event> tags from text, returning
 * only the human-readable content for display in the GUI.
 */
export function stripGroveEvents(text: string): string {
  return text.replace(GROVE_EVENT_REGEX, "").replace(/\n{3,}/g, "\n\n");
}
