import { and, eq, inArray } from "drizzle-orm";
import { workflowRuns, type Db } from "@paperclipai/db";
import { WORKFLOW_RUN_ACTIVE_STATUSES } from "@paperclipai/shared";
import { conflict } from "../errors.js";

export const WORKFLOW_RUN_OWNS_CASE_CODE = "workflow_run_owns_case";

/**
 * Refuses a handoff on a case whose active workflow run did not request it.
 * The run decides every transfer of its case; agents complete steps instead.
 * @param tx Open handoff transaction
 * @param companyId Company of the case
 * @param caseId Case being handed off
 * @param workflowRunId The run requesting the handoff, set only by the workflow run service
 */
export async function assertWorkflowRunAllowsHandoff(tx: Db, companyId: string, caseId: string, workflowRunId?: string) {
  const [active] = await tx.select({ id: workflowRuns.id }).from(workflowRuns).where(and(
    eq(workflowRuns.companyId, companyId),
    eq(workflowRuns.caseId, caseId),
    inArray(workflowRuns.status, [...WORKFLOW_RUN_ACTIVE_STATUSES]),
  )).limit(1);
  if (!active || active.id === workflowRunId) return;
  throw conflict("This case is driven by an active workflow run; finish the current step with POST /api/workflow-runs/{id}/steps/{stepKey}/complete instead of handing it off", {
    code: WORKFLOW_RUN_OWNS_CASE_CODE,
    workflowRunId: active.id,
  });
}
