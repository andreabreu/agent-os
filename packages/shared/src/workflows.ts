import { z } from "zod";
import { caseWorkflowDocumentTextSchema } from "./case-handoffs.js";
import { workflowSpecSchema } from "./workflow-spec.js";

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(200),
  prompt: caseWorkflowDocumentTextSchema,
}).strict();
export const updateWorkflowSchema = createWorkflowSchema.partial().refine(
  value => value.name !== undefined || value.prompt !== undefined, "Provide name or prompt",
);
export const listWorkflowsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).strict();
export const readWorkflowQuerySchema = z.object({
  snapshot: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const publishWorkflowVersionSchema = z.object({
  spec: workflowSpecSchema,
}).strict();
export const listWorkflowVersionsSchema = listWorkflowsSchema;
export const readWorkflowVersionQuerySchema = readWorkflowQuerySchema;
export const setRoutineWorkflowTargetSchema = z.object({
  workflowId: z.string().guid(),
}).strict();
export const workflowVersionParamsSchema = z.object({
  id: z.string().guid(),
  version: z.coerce.number().int().positive(),
}).strict();
