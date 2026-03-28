// Grove v3 — Random subdomain generator (grove-themed)

const TREES = [
  "ash", "aspen", "birch", "cedar", "elm", "fir", "hazel", "holly",
  "ivy", "juniper", "larch", "maple", "oak", "pine", "rowan",
  "spruce", "willow", "yew", "alder", "beech", "cypress", "hemlock",
];

const FEATURES = [
  "brook", "creek", "dell", "fern", "glen", "hill", "knoll", "lake",
  "meadow", "moss", "path", "peak", "ridge", "shade", "stone",
  "vale", "wind", "bloom", "branch", "drift", "frost", "hollow",
];

/** Generate a random grove-themed subdomain like "elm-brook-7kx2" */
export function generateSubdomain(): string {
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  // 4-char random suffix for entropy (22×22×36^4 ≈ 800M combinations)
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, b => chars[b % chars.length]).join("");
  return `${pick(TREES)}-${pick(FEATURES)}-${suffix}`;
}

/** Generate a 32-char hex secret for registration ownership */
export function generateSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
