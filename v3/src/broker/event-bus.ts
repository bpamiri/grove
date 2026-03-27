// Grove v3 — Typed in-process event bus
import type { EventBusMap } from "../shared/types";

type EventHandler<T> = (data: T) => void;

class EventBus {
  private handlers = new Map<string, Set<EventHandler<any>>>();

  on<K extends keyof EventBusMap>(event: K, handler: EventHandler<EventBusMap[K]>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  emit<K extends keyof EventBusMap>(event: K, data: EventBusMap[K]): void {
    const handlers = this.handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        console.error(`EventBus handler error for "${event}":`, err);
      }
    }
  }

  off<K extends keyof EventBusMap>(event: K, handler: EventHandler<EventBusMap[K]>): void {
    this.handlers.get(event)?.delete(handler);
  }

  removeAll(event?: keyof EventBusMap): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }

  listenerCount(event: keyof EventBusMap): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

// Singleton
export const bus = new EventBus();
