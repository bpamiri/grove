// Grove v3 — Update checking and platform detection
import { GROVE_VERSION } from "../shared/types";

const GITHUB_REPO = "bpamiri/grove";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/** Map current platform + arch to the release asset name */
export function getPlatformAssetName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") return "grove-darwin-arm64";
  if (platform === "darwin" && arch === "x64")   return "grove-darwin-x64";
  if (platform === "linux"  && arch === "x64")   return "grove-linux-x64";

  throw new Error(`Unsupported platform: ${platform}-${arch}. Grove supports darwin-arm64, darwin-x64, and linux-x64.`);
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
