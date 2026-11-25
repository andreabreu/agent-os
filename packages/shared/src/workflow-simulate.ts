import { planStepOutcome } from "./workflow-run-transitions.js";
import type { WorkflowSpec, WorkflowStepType } from "./workflow-spec.js";

/** The outcomes each step returns on its successive visits; the last one repeats once the list runs out. */
export type WorkflowSimulationScript = Record<string, string[]>;

export interface SimulatedStep {
  stepKey: string;
  type: WorkflowStepType;
  attempt: number;
  outcome: string;
}

export type WorkflowSimulation =
  | { ok: true; final: "completed"; path: SimulatedStep[] }
  | { ok: true; final: "escalated"; reason: string; path: SimulatedStep[] }
  | { ok: false; code: "script_incomplete"; stepKey: string }
  | { ok: false; code: "invalid_outcome"; stepKey: string; allowed: string[] };

const MAX_SIMULATED_VISITS = 10_000;

/**
 * Walks a workflow with scripted outcomes for agents, people and gates, using the same rules as a real run,
 * without touching any task, decision or run. Loops end at their review-round or attempt limits.
 * @param spec The definition to try
 * @param script The outcomes each step returns, in order of its visits
 */
export function simulateWorkflow(spec: WorkflowSpec, script: WorkflowSimulationScript): WorkflowSimulation {
  const path: SimulatedStep[] = [];
  const attemptsByStep: Record<string, number> = {};
  let stepKey = spec.start;
  let attempt = 1;
  for (let visit = 0; visit < MAX_SIMULATED_VISITS; visit += 1) {
    const step = spec.steps.find((candidate) => candidate.key === stepKey)!;
    const outcomes = script[stepKey];
    if (!outcomes?.length) return { ok: false, code: "script_incomplete", stepKey };
    const outcome = outcomes[Math.min(attempt - 1, outcomes.length - 1)]!;
    attemptsByStep[stepKey] = attempt;
    const plan = planStepOutcome(spec, { stepKey, outcome, attemptsByStep });
    if (plan.kind === "invalid_outcome") return { ok: false, code: "invalid_outcome", stepKey, allowed: plan.allowed };
    path.push({ stepKey, type: step.type, attempt, outcome });
    if (plan.kind === "complete") return { ok: true, final: "completed", path };
    if (plan.kind === "escalate") return { ok: true, final: "escalated", reason: plan.reason, path };
    stepKey = plan.stepKey;
    attempt = plan.attempt;
  }
  return { ok: true, final: "escalated", reason: `Stopped after ${MAX_SIMULATED_VISITS} visits`, path };
}
