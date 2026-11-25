import { describe, expect, it } from "vitest";
import { simulateWorkflow } from "./workflow-simulate.js";
import { workflowSpecSchema } from "./workflow-spec.js";

const spec = workflowSpecSchema.parse({
  specVersion: 1,
  start: "draft",
  steps: [
    { key: "draft", name: "Draft", type: "agent_task", owner: { kind: "agent", ref: "writer" }, outcomes: [{ key: "done", to: "brief" }] },
    { key: "brief", name: "Brief", type: "input_form", owner: { kind: "user", ref: "editor" }, outcomes: [{ key: "submitted", to: "review" }],
      questions: [{ id: "audience", label: "Audience", kind: "text" }] },
    { key: "review", name: "Review", type: "approval_gate", owner: { kind: "user", ref: "editor" }, limits: { maxReviewRounds: 2 },
      outcomes: [{ key: "approved", to: "handover" }, { key: "changes_requested", to: "draft" }, { key: "rejected", to: "end" }] },
    { key: "handover", name: "Handover", type: "human_task", owner: { kind: "user", ref: "editor" }, outcomes: [{ key: "done", to: "end" }] },
  ],
});

describe("simulateWorkflow", () => {
  it("walks the path step by step and completes", () => {
    const result = simulateWorkflow(spec, { draft: ["done"], brief: ["submitted"], review: ["approved"], handover: ["done"] });

    expect(result).toEqual({
      ok: true,
      final: "completed",
      path: [
        { stepKey: "draft", type: "agent_task", attempt: 1, outcome: "done" },
        { stepKey: "brief", type: "input_form", attempt: 1, outcome: "submitted" },
        { stepKey: "review", type: "approval_gate", attempt: 1, outcome: "approved" },
        { stepKey: "handover", type: "human_task", attempt: 1, outcome: "done" },
      ],
    });
  });

  it("uses each step's outcomes in order across attempts", () => {
    const result = simulateWorkflow(spec, {
      draft: ["done", "done"], brief: ["submitted"], review: ["changes_requested", "approved"], handover: ["done"],
    });

    expect(result.ok && result.path.map((step) => `${step.stepKey}#${step.attempt}:${step.outcome}`)).toEqual([
      "draft#1:done", "brief#1:submitted", "review#1:changes_requested", "draft#2:done", "brief#2:submitted",
      "review#2:approved", "handover#1:done",
    ]);
  });

  it("stops at the review-round limit and reports the escalation", () => {
    const result = simulateWorkflow(spec, { draft: ["done"], brief: ["submitted"], review: ["changes_requested"], handover: ["done"] });

    expect(result).toMatchObject({ ok: true, final: "escalated" });
    expect(result.ok && result.final === "escalated" && result.reason).toMatch(/review rounds/);
  });

  it("ends the run when the outcome goes to the end", () => {
    const result = simulateWorkflow(spec, { draft: ["done"], brief: ["submitted"], review: ["rejected"] });

    expect(result).toMatchObject({ ok: true, final: "completed" });
    expect(result.ok && result.path.at(-1)).toMatchObject({ stepKey: "review", outcome: "rejected" });
  });

  it("refuses a script that does not cover a step the path reaches", () => {
    expect(simulateWorkflow(spec, { draft: ["done"] })).toEqual({ ok: false, code: "script_incomplete", stepKey: "brief" });
  });

  it("refuses a scripted outcome the step does not declare", () => {
    expect(simulateWorkflow(spec, { draft: ["finished"] }))
      .toEqual({ ok: false, code: "invalid_outcome", stepKey: "draft", allowed: ["done"] });
  });

  it("simulates twenty steps quickly", () => {
    const long = workflowSpecSchema.parse({
      specVersion: 1,
      start: "s0",
      steps: Array.from({ length: 20 }, (_, index) => ({ key: `s${index}`, name: `Step ${index}`, type: "agent_task",
        owner: { kind: "agent", ref: "a" }, outcomes: [{ key: "done", to: index === 19 ? "end" : `s${index + 1}` }] })),
    });
    const started = performance.now();

    const result = simulateWorkflow(long, Object.fromEntries(long.steps.map((step) => [step.key, ["done"]])));

    expect(result).toMatchObject({ ok: true, final: "completed" });
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
