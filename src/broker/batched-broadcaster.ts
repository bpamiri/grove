// Grove v3 — Batched WebSocket broadcaster
// Queues high-frequency events and flushes them at a configurable interval.

export class BatchedBroadcaster {
  private pending: Array<{ type: string; data: any }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private sendFn: (msg: string) => void;

  constructor(intervalMs: number, sendFn: (msg: string) => void) {
    this.sendFn = sendFn;
    this.timer = setInterval(() => this.flush(), intervalMs);
  }

  queue(type: string, data: any): void {
    this.pending.push({ type, data });
  }

  sendImmediate(type: string, data: any): void {
    this.sendFn(JSON.stringify({ type, data, ts: Date.now() }));
  }

  flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0);
    for (const { type, data } of batch) {
      this.sendFn(JSON.stringify({ type, data, ts: Date.now() }));
    }
  }

  stop(): void {
    this.flush();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
