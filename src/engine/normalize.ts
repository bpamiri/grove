import type { PathConfig, PipelineStep, NormalizedPathConfig } from "../shared/types";

const TYPE_INFERENCE: Record<string, PipelineStep["type"]> = {
  merge: "merge",
  evaluate: "gate",
};

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
        type: props.type ?? TYPE_INFERENCE[id] ?? "worker",
        on_success: props.on_success ?? "",
        on_failure: props.on_failure ?? "",
        prompt: props.prompt,
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

  // Gate steps without explicit on_failure loop back to the nearest preceding worker.
  // All other steps default to $fail.
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].on_failure === "") {
      if (steps[i].type === "gate") {
        for (let j = i - 1; j >= 0; j--) {
          if (steps[j].type === "worker") {
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
