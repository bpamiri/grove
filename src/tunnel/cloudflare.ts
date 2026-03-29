// Grove v3 — Cloudflare quick tunnel provider
// Spawns `cloudflared tunnel --url http://localhost:{port}` and parses the assigned URL.
import type { TunnelProvider } from "./provider";

export class CloudflareTunnel implements TunnelProvider {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private url: string | null = null;
  private pid: number | null = null;

  async start(localPort: number): Promise<string> {
    if (this.proc && this.isRunning()) {
      return this.url!;
    }

    // Check if cloudflared is available
    const which = Bun.spawnSync(["which", "cloudflared"]);
    if (which.exitCode !== 0) {
      throw new Error(
        "cloudflared is not installed. Install it with:\n" +
        "  brew install cloudflared\n" +
        "Or download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
      );
    }

    return new Promise<string>((resolve, reject) => {
      const proc = Bun.spawn(
        ["cloudflared", "tunnel", "--url", `http://localhost:${localPort}`],
        { stdout: "pipe", stderr: "pipe" },
      );

      this.proc = proc;
      this.pid = proc.pid;

      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for cloudflared to assign a URL (30s)"));
      }, 30_000);

      this.readStderrForUrl(proc, (url) => {
        clearTimeout(timeout);
        this.url = url;
        resolve(url);
      }, (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async readStderrForUrl(
    proc: ReturnType<typeof Bun.spawn>,
    onUrl: (url: string) => void,
    onError: (err: Error) => void,
  ) {
    const stderr = proc.stderr;
    if (!stderr || typeof stderr === "number") {
      onError(new Error("No stderr stream from cloudflared"));
      return;
    }

    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    let buffer = "";
    let found = false;

    try {
      while (!found) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += new TextDecoder().decode(value);

        const urlMatch = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (urlMatch) {
          found = true;
          onUrl(urlMatch[0]);
        }
      }

      if (!found) {
        onError(new Error("cloudflared exited without providing a URL"));
      }
    } catch (err) {
      if (!found) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  async stop(): Promise<void> {
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
      this.pid = null;
      this.url = null;
    }
  }

  getUrl(): string | null {
    return this.url;
  }

  isRunning(): boolean {
    if (!this.pid) return false;
    try {
      process.kill(this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
