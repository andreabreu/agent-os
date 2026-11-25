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
    expect([...WORKFLOW_STEP_TYPES]).toEqual(["agent_task", "human_task", "approval_gate"]);
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
