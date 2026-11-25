import { z } from "zod";

export const WORKFLOW_SPEC_VERSION = 1 as const;
export const WORKFLOW_STEP_TYPES = ["agent_task", "human_task", "approval_gate"] as const;
export const WORKFLOW_STEP_OWNER_KINDS = ["agent", "user", "role"] as const;
export const WORKFLOW_END_DESTINATION = "end" as const;

const MAX_STEPS = 100;
const MAX_STEP_LINKS = 50;
const MAX_OUTCOMES = 20;
const MAX_TIMEOUT_SECONDS = 2_592_000;
const STEP_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

const stepKeySchema = z.string().regex(STEP_KEY_PATTERN, "Use lowercase letters, digits, _ or -, starting with a letter");
const positiveCountSchema = z.number().int().positive().max(1000);

const stepTypeSchema = z.string().superRefine((value, ctx) => {
  if ((WORKFLOW_STEP_TYPES as readonly string[]).includes(value)) return;
  ctx.addIssue({
    code: "custom",
    message: `Step type "${value}" is not supported; use ${WORKFLOW_STEP_TYPES.join(", ")}`,
    params: { code: "unsupported_step_type" },
  });
}).transform((value) => value as WorkflowStepType);

export const workflowStepOutcomeSchema = z.object({
  key: stepKeySchema,
  to: z.union([stepKeySchema, z.literal(WORKFLOW_END_DESTINATION)]),
}).strict();

export const workflowStepLimitsSchema = z.object({
  maxAttempts: positiveCountSchema.optional(),
  maxReviewRounds: positiveCountSchema.optional(),
  timeoutSec: z.number().int().positive().max(MAX_TIMEOUT_SECONDS).optional(),
}).strict();

export const workflowStepSchema = z.object({
  key: stepKeySchema,
  name: z.string().trim().min(1).max(200),
  type: stepTypeSchema,
  owner: z.object({
    kind: z.enum(WORKFLOW_STEP_OWNER_KINDS),
    ref: z.string().trim().min(1).max(200),
  }).strict(),
  inputs: z.array(stepKeySchema).max(MAX_STEP_LINKS).default([]),
  outcomes: z.array(workflowStepOutcomeSchema).max(MAX_OUTCOMES).default([]),
  limits: workflowStepLimitsSchema.default({}),
}).strict();

export const workflowSpecSchema = z.object({
  specVersion: z.literal(WORKFLOW_SPEC_VERSION),
  start: stepKeySchema,
  steps: z.array(workflowStepSchema).min(1).max(MAX_STEPS),
}).strict();

export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowSpec = z.infer<typeof workflowSpecSchema>;

export const WORKFLOW_GRAPH_ISSUE_CODES = [
  "duplicate_step_key",
  "start_not_found",
  "unknown_destination",
  "unknown_input",
  "unreachable_step",
  "no_path_to_end",
  "unbounded_cycle",
] as const;

export type WorkflowGraphIssueCode = (typeof WORKFLOW_GRAPH_ISSUE_CODES)[number];

export interface WorkflowGraphIssue {
  code: WorkflowGraphIssueCode;
  stepKey: string;
  outcomeKey?: string;
  message: string;
}

type Graph = Map<string, string[]>;

function isBounded(step: WorkflowStep) {
  return step.limits.maxAttempts !== undefined || step.limits.maxReviewRounds !== undefined;
}

function reachableFrom(origin: string, graph: Graph) {
  const seen = new Set<string>();
  const pending = [origin];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current) || !graph.has(current)) continue;
    seen.add(current);
    pending.push(...graph.get(current)!);
  }
  return seen;
}

function stepsThatReachEnd(steps: WorkflowStep[], graph: Graph) {
  const reaching = new Set(steps
    .filter((step) => step.outcomes.some((outcome) => outcome.to === WORKFLOW_END_DESTINATION))
    .map((step) => step.key));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [key, destinations] of graph) {
      if (!reaching.has(key) && destinations.some((destination) => reaching.has(destination))) {
        reaching.add(key);
        grew = true;
      }
    }
  }
  return reaching;
}

// Tarjan's algorithm. A step is in a cycle when its strongly connected
// component has more than one step or the step points at itself.
function stepsInCycles(graph: Graph) {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cyclic = new Set<string>();
  let counter = 0;

  function connect(key: string) {
    index.set(key, counter);
    lowLink.set(key, counter);
    counter += 1;
    stack.push(key);
    onStack.add(key);
    for (const next of graph.get(key) ?? []) {
      if (!index.has(next)) {
        connect(next);
        lowLink.set(key, Math.min(lowLink.get(key)!, lowLink.get(next)!));
      } else if (onStack.has(next)) {
        lowLink.set(key, Math.min(lowLink.get(key)!, index.get(next)!));
      }
    }
    if (lowLink.get(key) !== index.get(key)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== key);
    const selfLoop = component.length === 1 && (graph.get(key) ?? []).includes(key);
    if (component.length > 1 || selfLoop) component.forEach((step) => cyclic.add(step));
  }

  for (const key of graph.keys()) if (!index.has(key)) connect(key);
  return cyclic;
}

/**
 * Validates a workflow's structure before it is published.
 * A loop is accepted when one of its steps declares `maxAttempts` or `maxReviewRounds`:
 * the graph made of only the unbounded steps must have no cycle.
 * @param spec A definition that already passed the schema
 * @returns The problems found; empty when the graph is valid
 */
export function validateWorkflowGraph(spec: WorkflowSpec): WorkflowGraphIssue[] {
  const issues: WorkflowGraphIssue[] = [];
  const byKey = new Map<string, WorkflowStep>();
  for (const step of spec.steps) {
    if (byKey.has(step.key)) {
      issues.push({ code: "duplicate_step_key", stepKey: step.key, message: `Step "${step.key}" is declared more than once` });
    } else {
      byKey.set(step.key, step);
    }
  }
  if (!byKey.has(spec.start)) {
    issues.push({ code: "start_not_found", stepKey: spec.start, message: `Start step "${spec.start}" does not exist` });
  }

  const graph: Graph = new Map();
  for (const step of byKey.values()) {
    const destinations: string[] = [];
    for (const outcome of step.outcomes) {
      if (outcome.to === WORKFLOW_END_DESTINATION) continue;
      if (byKey.has(outcome.to)) {
        destinations.push(outcome.to);
      } else {
        issues.push({ code: "unknown_destination", stepKey: step.key, outcomeKey: outcome.key,
          message: `Outcome "${outcome.key}" of step "${step.key}" goes to unknown step "${outcome.to}"` });
      }
    }
    for (const input of step.inputs) {
      if (!byKey.has(input)) {
        issues.push({ code: "unknown_input", stepKey: step.key,
          message: `Step "${step.key}" reads input from unknown step "${input}"` });
      }
    }
    graph.set(step.key, destinations);
  }
  if (!byKey.has(spec.start)) return issues;

  const reachable = reachableFrom(spec.start, graph);
  for (const key of byKey.keys()) {
    if (!reachable.has(key)) {
      issues.push({ code: "unreachable_step", stepKey: key, message: `Step "${key}" cannot be reached from "${spec.start}"` });
    }
  }

  const reachingEnd = stepsThatReachEnd([...byKey.values()], graph);
  for (const key of reachable) {
    if (!reachingEnd.has(key)) {
      issues.push({ code: "no_path_to_end", stepKey: key, message: `Step "${key}" has no path to the end of the workflow` });
    }
  }

  const unboundedGraph: Graph = new Map([...graph]
    .filter(([key]) => !isBounded(byKey.get(key)!))
    .map(([key, destinations]) => [key, destinations.filter((destination) => !isBounded(byKey.get(destination)!))]));
  for (const key of stepsInCycles(unboundedGraph)) {
    issues.push({ code: "unbounded_cycle", stepKey: key,
      message: `Step "${key}" is in a loop where no step declares maxAttempts or maxReviewRounds` });
  }
  return issues;
}
