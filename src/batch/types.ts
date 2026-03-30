// Grove v3 — Batch planner types

/** Predicted files a task will modify, with confidence */
export interface TaskAnalysis {
  taskId: string;
  title: string;
  predictedFiles: string[];
  confidence: "high" | "medium" | "low";
}

/** A pair of tasks that share predicted file modifications */
export interface OverlapEntry {
  taskA: string;
  taskB: string;
  sharedFiles: string[];
}

/** A group of tasks that can safely run in parallel */
export interface ExecutionWave {
  wave: number; // 1-indexed
  taskIds: string[];
}

/** Complete batch analysis result */
export interface BatchPlan {
  treeId: string;
  tasks: TaskAnalysis[];
  overlaps: OverlapEntry[];
  waves: ExecutionWave[];
}
