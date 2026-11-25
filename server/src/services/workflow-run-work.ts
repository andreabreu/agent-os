import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { recoverWorkflowRuns } from "./workflow-run-control.js";
import { nextFormDeadline } from "./workflow-run-forms.js";

const RECOVERY_RETRY_MS = 30_000;

/**
 * Runs the workflow run recovery pass once at startup, whenever its queue is notified (a budget pause
 * starts or ends, a task enters Blocked, a form gets a deadline) and at the next form deadline. It never polls.
 */
export function registerWorkflowRunRecoveryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  db: Db,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.workflowRunRecovery, {
    retryMs: RECOVERY_RETRY_MS,
    canRun,
    run: () => recoverWorkflowRuns(db),
    next: () => nextFormDeadline(db),
  });
}
