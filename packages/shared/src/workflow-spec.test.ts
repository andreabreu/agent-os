import { describe, expect, it } from "vitest";
import { workflowSpecSchema, WORKFLOW_STEP_TYPES } from "./workflow-spec.js";

const validSpec = {
  specVersion: 1,
  start: "research",
  steps: [
    {
      key: "research",
      name: "Research",
      type: "agent_task",
      owner: { kind: "agent", ref: "researcher" },
      outcomes: [{ key: "done", to: "approval" }],
    },
    {
      key: "approval",
      name: "Approval",
      type: "approval_gate",
      owner: { kind: "role", ref: "editor" },
      inputs: ["research"],
      outcomes: [
        { key: "approved", to: "end" },
        { key: "changes_requested", to: "research" },
      ],
      limits: { maxReviewRounds: 3 },
    },
    {
      key: "handover",
      name: "Handover",
      type: "human_task",
      owner: { kind: "user", ref: "user-1" },
      outcomes: [{ key: "done", to: "end" }],
    },
  ],
};

function issueCodes(input: unknown): string[] {
  const parsed = workflowSpecSchema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => String((issue as { params?: { code?: string } }).params?.code ?? issue.code));
}

describe("workflowSpecSchema", () => {
  it("accepts a spec with the supported step types", () => {
    const parsed = workflowSpecSchema.safeParse(validSpec);

    expect(parsed.success).toBe(true);
  });

  it("fills empty inputs, outcomes and limits with defaults", () => {
    const parsed = workflowSpecSchema.parse({
      specVersion: 1,
      start: "only",
      steps: [{ key: "only", name: "Only", type: "agent_task", owner: { kind: "agent", ref: "a" } }],
    });

    expect(parsed.steps[0]).toMatchObject({ inputs: [], outcomes: [], limits: {} });
  });

  it("lists exactly the step types supported in this phase", () => {
    expect([...WORKFLOW_STEP_TYPES]).toEqual(["agent_task", "human_task", "approval_gate", "input_form"]);
  });

  it("accepts the execution fields of a step", () => {
    const spec = structuredClone(validSpec) as Record<string, unknown> & { steps: Record<string, unknown>[] };
    spec.steps[0] = { ...spec.steps[0], outputs: ["research-notes"], externalEffect: false };
    spec.steps[1] = { ...spec.steps[1], limits: { maxReviewRounds: 3, timeoutSec: 86_400 }, reminderAfterSec: 3_600,
      commentRequiredOn: ["changes_requested"] };

    const parsed = workflowSpecSchema.parse(spec);

    expect(parsed.steps[0]).toMatchObject({ outputs: ["research-notes"], externalEffect: false });
    expect(parsed.steps[1]).toMatchObject({ reminderAfterSec: 3_600, commentRequiredOn: ["changes_requested"] });
  });

  it("defaults outputs to none and external effect to false", () => {
    const parsed = workflowSpecSchema.parse(validSpec);

    expect(parsed.steps[0]).toMatchObject({ outputs: [], externalEffect: false });
  });

  it("accepts a form step with typed questions", () => {
    const spec = structuredClone(validSpec) as Record<string, unknown> & { steps: Record<string, unknown>[] };
    spec.steps.push({ key: "brief", name: "Brief", type: "input_form", owner: { kind: "user", ref: "user-1" },
      outputs: ["brief"], outcomes: [{ key: "submitted", to: "end" }],
      questions: [
        { id: "audience", label: "Who is the audience?", kind: "text", required: true },
        { id: "tone", label: "Tone", kind: "single_choice", required: false, options: ["formal", "casual"] },
        { id: "channels", label: "Channels", kind: "multi_choice", options: ["blog", "email"] },
        { id: "words", label: "Word count", kind: "number" },
        { id: "due", label: "Due date", kind: "date" },
      ] });

    expect(workflowSpecSchema.safeParse(spec).success).toBe(true);
  });

  it("rejects malformed output keys, question kinds and choice questions without options", () => {
    const badOutput = structuredClone(validSpec) as Record<string, unknown> & { steps: Record<string, unknown>[] };
    badOutput.steps[0] = { ...badOutput.steps[0], outputs: ["Not A Key"] };
    const badKind = structuredClone(validSpec) as Record<string, unknown> & { steps: Record<string, unknown>[] };
    badKind.steps[0] = { ...badKind.steps[0], type: "input_form", questions: [{ id: "q", label: "Q", kind: "file" }] };
    const noOptions = structuredClone(validSpec) as Record<string, unknown> & { steps: Record<string, unknown>[] };
    noOptions.steps[0] = { ...noOptions.steps[0], type: "input_form", questions: [{ id: "q", label: "Q", kind: "single_choice" }] };

    for (const spec of [badOutput, badKind, noOptions]) expect(workflowSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects a reminder or timeout out of range", () => {
    const spec = structuredClone(validSpec) as Record<string, unknown> & { steps: Record<string, unknown>[] };
    spec.steps[1] = { ...spec.steps[1], reminderAfterSec: 10 };

    expect(workflowSpecSchema.safeParse(spec).success).toBe(false);
  });

  it.each(["router", "parallel", "join", "wait"])("rejects the %s step type as unsupported", (type) => {
    const spec = structuredClone(validSpec);
    spec.steps[0]!.type = type;

    expect(issueCodes(spec)).toContain("unsupported_step_type");
  });

  it("rejects a spec version other than 1", () => {
    const parsed = workflowSpecSchema.safeParse({ ...validSpec, specVersion: 2 });

    expect(parsed.success).toBe(false);
  });

  it("rejects malformed step keys", () => {
    const spec = structuredClone(validSpec);
    spec.steps[0]!.key = "Not A Key";

    expect(workflowSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects non-positive limits", () => {
    const spec = structuredClone(validSpec);
    spec.steps[1]!.limits = { maxReviewRounds: 0 };

    expect(workflowSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    const parsed = workflowSpecSchema.safeParse({ ...validSpec, extra: true });

    expect(parsed.success).toBe(false);
  });
});
