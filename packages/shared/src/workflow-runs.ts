import { z } from "zod";

export const WORKFLOW_RUN_STATUSES = ["running", "waiting_human", "paused", "completed", "failed", "cancelled"] as const;
export const WORKFLOW_RUN_ACTIVE_STATUSES = ["running", "waiting_human", "paused"] as const;
export const WORKFLOW_RUN_STEP_STATUSES = [
  "pending", "ready", "running", "awaiting_review", "awaiting_approval", "awaiting_input",
  "completed", "changes_requested", "skipped", "failed", "cancelled",
] as const;
export const WORKFLOW_RUN_EVENT_KINDS = [
  "started", "step_ready", "step_completed", "gate_opened", "gate_decided", "gate_reminder",
  "input_requested", "input_submitted", "changes_requested", "escalated", "paused", "resumed",
  "cancelled", "completed", "failed",
] as const;
export const WORKFLOW_RUN_ORIGINS = ["manual", "agent", "routine"] as const;
export const WORKFLOW_RUN_STATE_VERSION = 1;
export const WORKFLOW_RUN_STATE_UNSUPPORTED_CODE = "workflow_run_state_unsupported";

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];
export type WorkflowRunStepStatus = (typeof WORKFLOW_RUN_STEP_STATUSES)[number];
export type WorkflowRunEventKind = (typeof WORKFLOW_RUN_EVENT_KINDS)[number];
export type WorkflowRunOrigin = (typeof WORKFLOW_RUN_ORIGINS)[number];

const idempotencyKeySchema = z.string().trim().min(1).max(240);

export const startWorkflowRunSchema = z.object({
  workflowId: z.string().guid(),
  caseId: z.string().guid(),
}).strict();

export const completeWorkflowStepSchema = z.object({
  outcome: z.string().trim().min(1).max(64),
  summary: z.string().trim().min(1).max(8_000).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict();

export const submitWorkflowFormSchema = z.object({
  answers: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])),
}).strict();

export const cancelWorkflowRunSchema = z.object({
  reason: z.string().trim().min(1).max(2_000).optional(),
}).strict();

export const listWorkflowRunsSchema = z.object({
  status: z.enum(WORKFLOW_RUN_STATUSES).optional(),
  caseId: z.string().guid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();

export type StartWorkflowRun = z.infer<typeof startWorkflowRunSchema>;
export type CompleteWorkflowStep = z.infer<typeof completeWorkflowStepSchema>;
