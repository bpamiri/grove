import type { PathConfig, PipelineStep, NormalizedPathConfig } from "../shared/types";

const TYPE_INFERENCE: Record<string, PipelineStep["type"]> = {
  verdict: "verdict",
};

const VALID_TYPES = new Set<string>(["worker", "verdict"]);

function coerceType(t: string | undefined, fallback: PipelineStep["type"]): PipelineStep["type"] {
  if (t && VALID_TYPES.has(t)) return t as PipelineStep["type"];
  return fallback;
}

export function normalizePath(config: PathConfig): NormalizedPathConfig {
  const rawSteps = config.steps;
  const steps: PipelineStep[] = [];

  for (let i = 0; i < rawSteps.length; i++) {
    const raw = rawSteps[i];
    let step: PipelineStep;

    if (typeof raw === "string") {
      step = {
        id: raw,
        type: TYPE_INFERENCE[raw] ?? "worker",
        on_success: "",
        on_failure: "",
        sandbox: "read-write",
      };
    } else if (typeof raw === "object" && raw !== null) {
      let id: string;
      let props: Record<string, any>;

      if ("id" in raw && typeof raw.id === "string") {
        id = raw.id;
        props = raw;
      } else {
        const keys = Object.keys(raw);
        id = keys[0];
        const val = raw[id];
        props = typeof val === "object" && val !== null ? { ...val } : {};
      }

      step = {
        id,
        type: coerceType(props.type, TYPE_INFERENCE[id] ?? "worker"),
        on_success: props.on_success ?? "",
        on_failure: props.on_failure ?? "",
        prompt: props.prompt,
        skills: props.skills,
        sandbox: props.sandbox ?? "read-write",
        result_file: props.result_file,
        result_key: props.result_key,
        max_retries: props.max_retries,
        label: props.label,
      };
    } else {
      continue;
    }

    if (!step.on_success) {
      step.on_success = i < rawSteps.length - 1 ? "" : "$done";
    }

    if (!step.label) {
      step.label = step.id.charAt(0).toUpperCase() + step.id.slice(1);
    }

    steps.push(step);
  }

  for (let i = 0; i < steps.length; i++) {
    if (steps[i].on_success === "") {
      steps[i].on_success = i < steps.length - 1 ? steps[i + 1].id : "$done";
    }
  }

  // Read-only steps without explicit on_failure loop back to the nearest preceding non-read-only step.
  // All other steps default to $fail.
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].on_failure === "") {
      if (steps[i].sandbox === "read-only") {
        for (let j = i - 1; j >= 0; j--) {
          if (steps[j].sandbox !== "read-only") {
            steps[i].on_failure = steps[j].id;
            break;
          }
        }
      }
      if (steps[i].on_failure === "") {
        steps[i].on_failure = "$fail";
      }
    }
  }

  return { description: config.description, steps };
}

export function normalizeAllPaths(paths: Record<string, PathConfig>): Record<string, NormalizedPathConfig> {
  const result: Record<string, NormalizedPathConfig> = {};
  for (const [name, config] of Object.entries(paths)) {
    result[name] = normalizePath(config);
  }
  return result;
}

export function validatePathConfig(config: { description: string; steps: Array<Record<string, any>> }): string[] {
  const errors: string[] = [];

  if (!config.description?.trim()) errors.push("description is required");
  if (!config.steps || config.steps.length === 0) {
    errors.push("at least one step is required");
    return errors;
  }

  const ids = new Set<string>();
  const TERMINAL = new Set(["$done", "$fail"]);

  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i];
    const prefix = `step[${i}]`;

    if (!step.id?.trim()) {
      errors.push(`${prefix}: id is required`);
      continue;
    }

    if (ids.has(step.id)) {
      errors.push(`${prefix}: duplicate id "${step.id}"`);
    }
    ids.add(step.id);

    if (step.type && !VALID_TYPES.has(step.type)) {
      errors.push(`${prefix}: invalid type "${step.type}" (must be worker or verdict)`);
    }
  }

  // Second pass: validate step references after collecting all ids
  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i];
    if (step.on_success && !TERMINAL.has(step.on_success) && !ids.has(step.on_success)) {
      errors.push(`step[${i}]: on_success references nonexistent step "${step.on_success}"`);
    }
    if (step.on_failure && !TERMINAL.has(step.on_failure) && !ids.has(step.on_failure)) {
      errors.push(`step[${i}]: on_failure references nonexistent step "${step.on_failure}"`);
    }
  }

  return errors;
}

export function stripPrompts(paths: Record<string, NormalizedPathConfig>): Record<string, NormalizedPathConfig> {
  const result: Record<string, NormalizedPathConfig> = {};
  for (const [name, path] of Object.entries(paths)) {
    result[name] = {
      description: path.description,
      steps: path.steps.map(({ prompt, ...rest }) => rest),
    };
  }
  return result;
}
