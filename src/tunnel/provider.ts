// Grove v3 — Tunnel provider interface

export interface TunnelProvider {
  /** Start the tunnel, return the remote URL */
  start(localPort: number): Promise<string>;
  /** Stop the tunnel */
  stop(): Promise<void>;
  /** Get the current remote URL (null if not running) */
  getUrl(): string | null;
  /** Check if the tunnel process is alive */
  isRunning(): boolean;
}
