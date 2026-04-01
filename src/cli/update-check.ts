// Grove v3 — Update checking and platform detection
import { GROVE_VERSION } from "../shared/types";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { groveHome } from "../shared/platform";

const GITHUB_REPO = "bpamiri/grove";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/** Map current platform + arch to the release asset name */
export function getPlatformAssetName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") return "grove-darwin-arm64";
  if (platform === "darwin" && arch === "x64")   return "grove-darwin-x64";
  if (platform === "linux"  && arch === "x64")   return "grove-linux-x64";
  if (platform === "win32"  && arch === "x64")   return "grove-windows-x64";

  throw new Error(`Unsupported platform: ${platform}-${arch}. Grove supports darwin-arm64, darwin-x64, linux-x64, and windows-x64.`);
}

export interface LatestRelease {
  version: string;
  tarballUrl: string;
  checksumUrl: string;
}

/** Fetch latest release info from GitHub */
export async function fetchLatestVersion(): Promise<LatestRelease> {
  const resp = await fetch(GITHUB_API, {
    headers: { "Accept": "application/vnd.github.v3+json" },
  });

  if (!resp.ok) {
    throw new Error(`GitHub API returned ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json() as { tag_name: string };
  const version = data.tag_name.replace(/^v/, "");
  const asset = getPlatformAssetName();
  const base = `https://github.com/${GITHUB_REPO}/releases/download/v${version}`;

  return {
    version,
    tarballUrl: `${base}/${asset}.tar.gz`,
    checksumUrl: `${base}/${asset}.tar.gz.sha256`,
  };
}

interface UpdateCache {
  checked_at: string;
  latest_version: string;
}

function getCachePath(): string {
  return join(groveHome(), "update-check.json");
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Compare semver strings: returns true if `a` is newer than `b` */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return false;
}

/** Non-blocking update check — call from `grove up`. Silently swallows all errors. */
export async function checkForUpdate(): Promise<void> {
  try {
    if (process.env.GROVE_NO_UPDATE_CHECK === "1") return;

    const cachePath = getCachePath();
    let latestVersion: string | null = null;

    // Check cache
    if (existsSync(cachePath)) {
      const cache: UpdateCache = JSON.parse(readFileSync(cachePath, "utf-8"));
      const age = Date.now() - new Date(cache.checked_at).getTime();
      if (age < CACHE_TTL_MS) {
        latestVersion = cache.latest_version;
      }
    }

    // Fetch if cache miss or stale
    if (!latestVersion) {
      const release = await fetchLatestVersion();
      latestVersion = release.version;

      const groveDir = groveHome();
      if (!existsSync(groveDir)) mkdirSync(groveDir, { recursive: true });

      writeFileSync(cachePath, JSON.stringify({
        checked_at: new Date().toISOString(),
        latest_version: latestVersion,
      } satisfies UpdateCache));
    }

    // Only print to TTY, and only if the latest version is actually newer
    if (process.stdout.isTTY && isNewer(latestVersion, GROVE_VERSION)) {
      console.log(
        `\n  ${pc.yellow("Grove v" + latestVersion + " available.")} Run ${pc.bold("grove upgrade")} to update.`
      );
    }
  } catch {
    // Silent — never block startup
  }
}
