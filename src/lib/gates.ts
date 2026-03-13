// Grove v2 — Worker quality gates
// Validates worker output between completion and PR publishing.
import type { GateConfig, GateResult, QualityGatesConfig } from "../types";

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_GATE_CONFIG: GateConfig = {
  commits: true,
  tests: true,
  lint: false,
  diff_size: true,
  min_diff_lines: 1,
  max_diff_lines: 5000,
  test_timeout: 60,
  lint_timeout: 30,
};

// ---------------------------------------------------------------------------
// Config resolution: defaults -> global -> per-repo
// ---------------------------------------------------------------------------

export function resolveGateConfig(
  global?: QualityGatesConfig,
  repo?: QualityGatesConfig,
): GateConfig {
  return {
    ...DEFAULT_GATE_CONFIG,
    ...(global ?? {}),
    ...(repo ?? {}),
  };
}
