import { describe, expect, it } from "vitest";
import { canTransitionRun, isRunActive, planStepOutcome } from "./workflow-run-transitions.js";
import { workflowSpecSchema } from "./workflow-spec.js";

const spec = workflowSpecSchema.parse({
  specVersion: 1,
  start: "draft",
  steps: [
    { key: "draft", name: "Draft", type: "agent_task", owner: { kind: "agent", ref: "writer" }, limits: { maxAttempts: 3 },
      outcomes: [{ key: "done", to: "review" }] },
    { key: "review", name: "Review", type: "agent_task", owner: { kind: "agent", ref: "editor" }, limits: { maxReviewRounds: 2 },
      outcomes: [{ key: "approved", to: "end" }, { key: "changes_requested", to: "draft" }] },
  ],
});

describe("planStepOutcome", () => {
  it("advances to the next step with its first attempt", () => {
    expect(planStepOutcome(spec, { stepKey: "draft", outcome: "done", attemptsByStep: { draft: 1 } }))
      .toEqual({ kind: "advance", stepKey: "review", attempt: 1 });
  });

  it("completes the run when the outcome goes to the end", () => {
    expect(planStepOutcome(spec, { stepKey: "review", outcome: "approved", attemptsByStep: { draft: 1, review: 1 } }))
      .toEqual({ kind: "complete" });
  });

  it("returns to an earlier step with the next attempt number", () => {
    expect(planStepOutcome(spec, { stepKey: "review", outcome: "changes_requested", attemptsByStep: { draft: 1, review: 1 } }))
      .toEqual({ kind: "advance", stepKey: "draft", attempt: 2 });
  });

  it("escalates when the review rounds of the deciding step are used up", () => {
    const result = planStepOutcome(spec, { stepKey: "review", outcome: "changes_requested", attemptsByStep: { draft: 3, review: 2 } });

    expect(result).toMatchObject({ kind: "escalate" });
    expect(result.kind === "escalate" && result.reason).toMatch(/review/);
  });

  it("escalates when the target step would exceed its attempts", () => {
    const tight = workflowSpecSchema.parse({ ...spec, steps: [
      { ...spec.steps[0], limits: { maxAttempts: 1 } }, { ...spec.steps[1], limits: {} },
    ] });

    expect(planStepOutcome(tight, { stepKey: "review", outcome: "changes_requested", attemptsByStep: { draft: 1, review: 1 } }))
      .toMatchObject({ kind: "escalate" });
  });

  it("reports an outcome the step does not declare", () => {
    expect(planStepOutcome(spec, { stepKey: "draft", outcome: "approved", attemptsByStep: { draft: 1 } }))
      .toEqual({ kind: "invalid_outcome", allowed: ["done"] });
  });

  it("reports a step that is not in the spec", () => {
    expect(planStepOutcome(spec, { stepKey: "ghost", outcome: "done", attemptsByStep: {} }))
      .toEqual({ kind: "invalid_outcome", allowed: [] });
  });
});

describe("run status transitions", () => {
  it.each([
    ["running", "waiting_human"],
    ["waiting_human", "running"],
    ["running", "paused"],
    ["paused", "running"],
    ["running", "completed"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["waiting_human", "cancelled"],
    ["paused", "cancelled"],
  ] as const)("allows %s to %s", (from, to) => {
    expect(canTransitionRun(from, to)).toBe(true);
  });

  it.each([
    ["completed", "running"],
    ["cancelled", "running"],
    ["failed", "waiting_human"],
    ["paused", "completed"],
  ] as const)("refuses %s to %s", (from, to) => {
    expect(canTransitionRun(from, to)).toBe(false);
  });

  it("counts only running, waiting and paused runs as active", () => {
    expect(["running", "waiting_human", "paused"].every(isRunActive)).toBe(true);
    expect(["completed", "failed", "cancelled"].some(isRunActive)).toBe(false);
  });
});
