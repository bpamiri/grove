// Grove v3 — Per-task ring buffer for SAP activity events
// Stores the last N events per task so new WebSocket connections can catch up.

export interface ActivityEvent {
  type: string;
  taskId: string;
  [key: string]: unknown;
}

export class ActivityRingBuffer {
  private buffers = new Map<string, ActivityEvent[]>();
  private readonly maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  push(taskId: string, event: ActivityEvent): void {
    if (!this.buffers.has(taskId)) {
      this.buffers.set(taskId, []);
    }
    const buf = this.buffers.get(taskId)!;
    buf.push(event);
    if (buf.length > this.maxSize) {
      buf.shift();
    }
  }

  get(taskId: string): ActivityEvent[] {
    return this.buffers.get(taskId) ?? [];
  }

  clear(taskId: string): void {
    this.buffers.delete(taskId);
  }

  clearAll(): void {
    this.buffers.clear();
  }
}
