// grove upgrade — Download and install latest Grove binary
import pc from "picocolors";
import { GROVE_VERSION } from "../../shared/types";
import { fetchLatestVersion, getPlatformAssetName } from "../update-check";
import { mkdtempSync, writeFileSync, unlinkSync, renameSync, copyFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Verify SHA256 checksum of data against a checksum file line */
export function verifyChecksum(data: Uint8Array, checksumLine: string): boolean {
  const expected = checksumLine.trim().split(/\s+/)[0];
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  const actual = hasher.digest("hex");
  return actual === expected;
}

export async function run(_args: string[]) {
  console.log("Checking for updates...");

  let release;
  try {
    release = await fetchLatestVersion();
  } catch (err: any) {
    console.error(`${pc.red("Failed to check for updates:")} ${err.message}`);
    process.exit(1);
  }

  if (release.version === GROVE_VERSION) {
    console.log(`Already on latest version (${pc.green("v" + GROVE_VERSION)})`);
    return;
  }

  console.log(`Downloading Grove ${pc.green("v" + release.version)}...`);

  // Download tarball
  let tarballBytes: Uint8Array;
  try {
    const resp = await fetch(release.tarballUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    tarballBytes = new Uint8Array(await resp.arrayBuffer());
  } catch (err: any) {
    console.error(`${pc.red("Download failed:")} ${err.message}`);
    process.exit(1);
  }

  // Download and verify checksum
  try {
    const resp = await fetch(release.checksumUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const checksumLine = await resp.text();

    if (!verifyChecksum(tarballBytes, checksumLine)) {
      console.error(`${pc.red("Checksum verification failed.")} The download may be corrupted.`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`${pc.red("Checksum verification failed:")} ${err.message}`);
    process.exit(1);
  }

  // Extract to temp dir
  const tempDir = mkdtempSync(join(tmpdir(), "grove-upgrade-"));
  const tarballPath = join(tempDir, "grove.tar.gz");
  writeFileSync(tarballPath, tarballBytes);

  const tar = Bun.spawnSync(["tar", "-xzf", tarballPath, "-C", tempDir]);
  if (tar.exitCode !== 0) {
    console.error(`${pc.red("Failed to extract archive:")} ${tar.stderr.toString()}`);
    process.exit(1);
  }

  const newBinary = join(tempDir, "grove");
  const currentBinary = process.execPath;

  // Replace binary
  try {
    try {
      unlinkSync(currentBinary);
      renameSync(newBinary, currentBinary);
    } catch (err: any) {
      if (err.code === "EXDEV") {
        copyFileSync(newBinary, currentBinary);
      } else {
        throw err;
      }
    }
    chmodSync(currentBinary, 0o755);
  } catch (err: any) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      console.error(`${pc.red("Permission denied.")} Try: ${pc.bold("sudo grove upgrade")}`);
    } else {
      console.error(`${pc.red("Failed to replace binary:")} ${err.message}`);
    }
    process.exit(1);
  }

  console.log(`${pc.green("✓")} Upgraded grove from v${GROVE_VERSION} to ${pc.bold("v" + release.version)}`);
}
