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
