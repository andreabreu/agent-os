import { describe, expect, it } from "vitest";
import { isExecutableWorkflowSpec, validateWorkflowGraph, workflowSpecSchema, type WorkflowSpec } from "./workflow-spec.js";

type StepInput = {
  key: string;
  type?: string;
  outcomes?: { key: string; to: string }[];
  inputs?: string[];
  outputs?: string[];
  externalEffect?: boolean;
  questions?: { id: string; label: string; kind: string }[];
  limits?: { maxAttempts?: number; maxReviewRounds?: number; timeoutSec?: number };
};

function spec(start: string, steps: StepInput[]): WorkflowSpec {
  return workflowSpecSchema.parse({
    specVersion: 1,
    start,
    steps: steps.map((step) => ({
      name: step.key,
      type: step.type ?? "agent_task",
      owner: { kind: "agent", ref: "agent-1" },
      ...step,
    })),
  });
}

function codes(input: WorkflowSpec) {
  return validateWorkflowGraph(input).map((issue) => `${issue.code}:${issue.stepKey}${issue.outcomeKey ? `:${issue.outcomeKey}` : ""}`);
}

const gate = (key: string, approvedTo: string, extra: Partial<StepInput> = {}): StepInput => ({
  key, type: "approval_gate", limits: { maxReviewRounds: 3 },
  outcomes: [{ key: "approved", to: approvedTo }, { key: "rejected", to: "end" }], ...extra,
});

describe("validateWorkflowGraph execution rules", () => {
  it("accepts a publishing step behind an approval gate", () => {
    const valid = spec("draft", [
      { key: "draft", outcomes: [{ key: "done", to: "approval" }] },
      gate("approval", "publish"),
      { key: "publish", externalEffect: true, outcomes: [{ key: "done", to: "end" }] },
    ]);

    expect(validateWorkflowGraph(valid)).toEqual([]);
  });

  it("refuses an external-effect step that some path reaches without an approval gate", () => {
    const invalid = spec("draft", [
      { key: "draft", outcomes: [{ key: "done", to: "approval" }, { key: "skip", to: "publish" }] },
      gate("approval", "publish"),
      { key: "publish", externalEffect: true, outcomes: [{ key: "done", to: "end" }] },
    ]);

    expect(codes(invalid)).toContain("external_effect_without_gate:publish");
  });

  it("refuses an external-effect step that starts the workflow", () => {
    const invalid = spec("publish", [{ key: "publish", externalEffect: true, outcomes: [{ key: "done", to: "end" }] }]);

    expect(codes(invalid)).toContain("external_effect_without_gate:publish");
  });

  it("accepts a gate after a human review when an agent worked earlier on the path", () => {
    const valid = spec("draft", [
      { key: "draft", outcomes: [{ key: "done", to: "review" }] },
      { key: "review", type: "human_task", outcomes: [{ key: "done", to: "approval" }] },
      gate("approval", "end"),
    ]);

    expect(validateWorkflowGraph(valid)).toEqual([]);
  });

  it("refuses a gate that some path reaches without any agent step", () => {
    const invalid = spec("brief", [
      { key: "brief", type: "human_task", outcomes: [{ key: "done", to: "approval" }] },
      gate("approval", "end"),
    ]);

    expect(codes(invalid)).toContain("gate_without_agent_origin:approval");
  });

  it("refuses gate and form timeouts outside one minute to thirty days", () => {
    const invalid = spec("draft", [
      { key: "draft", outcomes: [{ key: "done", to: "approval" }] },
      gate("approval", "end", { limits: { maxReviewRounds: 3, timeoutSec: 30 } }),
    ]);

    expect(codes(invalid)).toContain("timeout_out_of_range:approval");
  });

  it("refuses a form step without questions", () => {
    const invalid = spec("brief", [{ key: "brief", type: "input_form", outputs: ["brief"], outcomes: [{ key: "done", to: "end" }] }]);

    expect(codes(invalid)).toContain("form_without_questions:brief");
  });

  it("refuses two steps that declare the same output", () => {
    const invalid = spec("draft", [
      { key: "draft", outputs: ["post"], outcomes: [{ key: "done", to: "edit" }] },
      { key: "edit", outputs: ["post"], outcomes: [{ key: "done", to: "end" }] },
    ]);

    expect(codes(invalid)).toContain("output_key_conflict:edit");
  });

  it("calls a valid spec executable and an invalid one not", () => {
    const valid = spec("draft", [{ key: "draft", outcomes: [{ key: "done", to: "end" }] }]);
    const invalid = spec("brief", [{ key: "brief", type: "input_form", outcomes: [{ key: "done", to: "end" }] }]);

    expect(isExecutableWorkflowSpec(valid)).toBe(true);
    expect(isExecutableWorkflowSpec(invalid)).toBe(false);
  });
});

describe("validateWorkflowGraph", () => {
  it("accepts a linear workflow that reaches the end", () => {
    const valid = spec("draft", [
      { key: "draft", outcomes: [{ key: "done", to: "publish" }] },
      { key: "publish", outcomes: [{ key: "done", to: "end" }] },
    ]);

    expect(validateWorkflowGraph(valid)).toEqual([]);
  });

  it("reports duplicate step keys", () => {
    const invalid = spec("draft", [
      { key: "draft", outcomes: [{ key: "done", to: "end" }] },
      { key: "draft", outcomes: [{ key: "done", to: "end" }] },
    ]);

    expect(codes(invalid)).toContain("duplicate_step_key:draft");
  });

  it("reports a start step that does not exist", () => {
    const invalid = spec("missing", [{ key: "draft", outcomes: [{ key: "done", to: "end" }] }]);

    expect(codes(invalid)).toContain("start_not_found:missing");
  });

  it("names the step and outcome whose destination does not exist", () => {
    const invalid = spec("draft", [{ key: "draft", outcomes: [{ key: "done", to: "nowhere" }] }]);

    expect(codes(invalid)).toContain("unknown_destination:draft:done");
  });

  it("names an input that refers to an unknown step", () => {
    const invalid = spec("draft", [{ key: "draft", inputs: ["ghost"], outcomes: [{ key: "done", to: "end" }] }]);

    expect(codes(invalid)).toContain("unknown_input:draft");
  });

  it("reports steps that cannot be reached from the start", () => {
    const invalid = spec("draft", [
      { key: "draft", outcomes: [{ key: "done", to: "end" }] },
      { key: "orphan", outcomes: [{ key: "done", to: "end" }] },
    ]);

    expect(codes(invalid)).toEqual(["unreachable_step:orphan"]);
  });

  it("reports reachable steps that can never reach the end", () => {
    const invalid = spec("draft", [
      { key: "draft", outcomes: [{ key: "done", to: "stuck" }] },
      { key: "stuck" },
    ]);

    expect(codes(invalid)).toEqual(expect.arrayContaining(["no_path_to_end:draft", "no_path_to_end:stuck"]));
  });

  it("rejects a return loop where no step declares a limit", () => {
    const invalid = spec("draft", [
      { key: "draft", outcomes: [{ key: "done", to: "review" }] },
      { key: "review", type: "approval_gate", outcomes: [{ key: "approved", to: "end" }, { key: "changes", to: "draft" }] },
    ]);

    expect(codes(invalid)).toEqual(expect.arrayContaining(["unbounded_cycle:draft", "unbounded_cycle:review"]));
  });

  it("accepts a return loop bounded by review rounds on one step", () => {
    const valid = spec("draft", [
      { key: "draft", outcomes: [{ key: "done", to: "review" }] },
      { key: "review", type: "approval_gate", limits: { maxReviewRounds: 3 },
        outcomes: [{ key: "approved", to: "end" }, { key: "changes", to: "draft" }] },
    ]);

    expect(validateWorkflowGraph(valid)).toEqual([]);
  });

  it("accepts a cycle where every step declares attempts", () => {
    const valid = spec("draft", [
      { key: "draft", limits: { maxAttempts: 2 }, outcomes: [{ key: "done", to: "review" }] },
      { key: "review", limits: { maxAttempts: 2 }, outcomes: [{ key: "ok", to: "end" }, { key: "again", to: "draft" }] },
    ]);

    expect(validateWorkflowGraph(valid)).toEqual([]);
  });

  it("rejects a second loop that bypasses the bounded step", () => {
    const invalid = spec("draft", [
      { key: "draft", outcomes: [{ key: "done", to: "review" }] },
      { key: "review", limits: { maxReviewRounds: 3 }, outcomes: [{ key: "ok", to: "edit" }, { key: "again", to: "draft" }] },
      { key: "edit", outcomes: [{ key: "ok", to: "end" }, { key: "polish", to: "polish" }] },
      { key: "polish", outcomes: [{ key: "back", to: "edit" }] },
    ]);

    expect(codes(invalid)).toEqual(expect.arrayContaining(["unbounded_cycle:edit", "unbounded_cycle:polish"]));
    expect(codes(invalid)).not.toContain("unbounded_cycle:draft");
  });

  it("rejects an unbounded self-loop and accepts a bounded one", () => {
    const unbounded = spec("draft", [{ key: "draft", outcomes: [{ key: "again", to: "draft" }, { key: "done", to: "end" }] }]);
    const bounded = spec("draft", [{ key: "draft", limits: { maxAttempts: 3 },
      outcomes: [{ key: "again", to: "draft" }, { key: "done", to: "end" }] }]);

    expect(codes(unbounded)).toEqual(["unbounded_cycle:draft"]);
    expect(validateWorkflowGraph(bounded)).toEqual([]);
  });

  it("returns a message that names the step for every problem", () => {
    const invalid = spec("draft", [{ key: "draft", outcomes: [{ key: "done", to: "nowhere" }] }]);

    expect(validateWorkflowGraph(invalid).every((issue) => issue.message.includes(issue.stepKey))).toBe(true);
  });
});
