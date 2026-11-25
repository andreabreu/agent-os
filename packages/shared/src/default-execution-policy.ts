import { z } from "zod";
import { issueExecutionPolicySchema } from "./validators/issue.js";

export const defaultExecutionPolicySchema = issueExecutionPolicySchema.superRefine((policy, ctx) => {
  if (policy.monitor) {
    ctx.addIssue({
      code: "custom",
      path: ["monitor"],
      message: "A default execution policy cannot schedule a monitor; set monitors on individual tasks",
    });
  }
});

export const putDefaultExecutionPolicySchema = z.object({
  defaultExecutionPolicy: defaultExecutionPolicySchema.nullable(),
}).strict();

export type PutDefaultExecutionPolicy = z.infer<typeof putDefaultExecutionPolicySchema>;
