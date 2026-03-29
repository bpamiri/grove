// Grove v3 — Auth token generation and validation
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getEnv } from "./db";

const TOKEN_LENGTH = 32;

/** Generate a random auth token */
function generateToken(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  const bytes = new Uint8Array(TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  for (const b of bytes) {
    token += chars[b % chars.length];
  }
  return token;
}

/** Get or create the auth token. Creates on first call. */
export function getOrCreateToken(): string {
  const { GROVE_HOME } = getEnv();
  const tokenPath = join(GROVE_HOME, "auth.token");

  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, "utf-8").trim();
  }

  const token = generateToken();
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  return token;
}

/** Rotate the auth token — generates a new one and overwrites the old */
export function rotateToken(): string {
  const { GROVE_HOME } = getEnv();
  const tokenPath = join(GROVE_HOME, "auth.token");
  const token = generateToken();
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  return token;
}

/** Validate a token against the stored one */
export function validateToken(token: string): boolean {
  const { GROVE_HOME } = getEnv();
  const tokenPath = join(GROVE_HOME, "auth.token");
  if (!existsSync(tokenPath)) return false;
  const stored = readFileSync(tokenPath, "utf-8").trim();
  return token === stored;
}
