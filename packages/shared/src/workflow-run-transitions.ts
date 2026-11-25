import { WORKFLOW_END_DESTINATION, type WorkflowSpec } from "./workflow-spec.js";
import { WORKFLOW_RUN_ACTIVE_STATUSES, type WorkflowRunStatus } from "./workflow-runs.js";

export type StepOutcomePlan =
  | { kind: "advance"; stepKey: string; attempt: number }
  | { kind: "complete" }
  | { kind: "escalate"; reason: string }
  | { kind: "invalid_outcome"; allowed: string[] };

const RUN_TRANSITIONS: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
  running: ["waiting_human", "paused", "completed", "failed", "cancelled"],
  waiting_human: ["running", "paused", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isRunActive(status: string): boolean {
  return (WORKFLOW_RUN_ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function canTransitionRun(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/**
 * Decides what an outcome of a step does to the run.
 * A return to a step that already ran counts as a new attempt of that step. The run escalates
 * instead of returning when the deciding step has used its maxReviewRounds or the target step
 * would exceed its maxAttempts.
 * @param spec The version the run is pinned to
 * @param input The step that finished, its outcome, and how many attempts each step has had
 */
export function planStepOutcome(spec: WorkflowSpec, input: {
  stepKey: string;
  outcome: string;
  attemptsByStep: Record<string, number>;
}): StepOutcomePlan {
  const step = spec.steps.find((candidate) => candidate.key === input.stepKey);
  if (!step) return { kind: "invalid_outcome", allowed: [] };
  const outcome = step.outcomes.find((candidate) => candidate.key === input.outcome);
  if (!outcome) return { kind: "invalid_outcome", allowed: step.outcomes.map((candidate) => candidate.key) };
  if (outcome.to === WORKFLOW_END_DESTINATION) return { kind: "complete" };

  const target = spec.steps.find((candidate) => candidate.key === outcome.to)!;
  const previousAttempts = input.attemptsByStep[target.key] ?? 0;
  const returning = previousAttempts > 0;
  const roundsUsed = input.attemptsByStep[step.key] ?? 0;
  if (returning && step.limits.maxReviewRounds !== undefined && roundsUsed >= step.limits.maxReviewRounds) {
    return { kind: "escalate", reason: `Step "${step.key}" used its ${step.limits.maxReviewRounds} review rounds` };
  }
  const attempt = previousAttempts + 1;
  if (target.limits.maxAttempts !== undefined && attempt > target.limits.maxAttempts) {
    return { kind: "escalate", reason: `Step "${target.key}" would exceed its ${target.limits.maxAttempts} attempts` };
  }
  return { kind: "advance", stepKey: target.key, attempt };
}
