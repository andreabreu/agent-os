import { and, eq, inArray } from "drizzle-orm";
import { cases, companyMemberships, heartbeatRuns, issues, workflowRunEvents, workflowRunSteps, workflowRuns, type Db } from "@paperclipai/db";
import { WORKFLOW_RUN_ACTIVE_STATUSES, type WorkflowStep } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { issueService } from "./issues.js";
import type { AuthorizationActor } from "./authorization.js";

const MANAGEMENT_ROLES: readonly string[] = ["owner", "admin"];
const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "interrupted", "timed_out"];
const SYSTEM_ACTOR = { actorType: "system", actorId: "workflow-run" } as const;

type TaskRow = typeof issues.$inferSelect;

async function caseTask(db: Db, caseId: string) {
  const [row] = await db.select().from(issues).innerJoin(cases, eq(cases.workIssueId, issues.id)).where(eq(cases.id, caseId));
  return row!.issues;
}

function isHeldByRun(task: Pick<TaskRow, "executionRunId" | "checkoutRunId">) {
  return Boolean(task.executionRunId || task.checkoutRunId);
}

async function assignToPerson(db: Db, task: TaskRow, userId: string) {
  await issueService(db).update(task.id, { assigneeAgentId: null, assigneeUserId: userId, status: "todo",
    executionRunId: null, checkoutRunId: null, executionAgentNameKey: null, companyGuard: task.companyId }, db);
}

/**
 * Gives the case's task to the person who owns a human step.
 * While a run still holds the task the step waits; the run's release hands it over.
 * @returns Whether the task was given to the person now
 */
export async function assignHumanStep(db: Db, input: { caseId: string; step: WorkflowStep }) {
  const task = await caseTask(db, input.caseId);
  if (isHeldByRun(task)) return { assigned: false, parkedAgentId: task.assigneeAgentId };
  await assignToPerson(db, task, input.step.owner.ref);
  return { assigned: true, parkedAgentId: task.assigneeAgentId };
}

/**
 * Called when a run has released its task: gives the task to the person of a human step that was waiting for it.
 * The caller has already verified the run's cleanup is settled.
 */
export async function assignWorkflowHumanStepAfterRelease(db: Db, runId: string) {
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  const issueId = typeof run?.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null;
  if (!run || !issueId || !TERMINAL_RUN_STATUSES.includes(run.status)) return;
  const waiting = await db.select({ step: workflowRunSteps, run: workflowRuns }).from(workflowRunSteps)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowRunSteps.runId))
    .innerJoin(cases, eq(cases.id, workflowRuns.caseId))
    .where(and(eq(cases.workIssueId, issueId), eq(workflowRunSteps.status, "ready"),
      inArray(workflowRuns.status, [...WORKFLOW_RUN_ACTIVE_STATUSES])));
  for (const { step, run: workflowRun } of waiting) {
    if (!step.assigneeUserId) continue;
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const [task] = await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
      if (!task || (task.executionRunId && task.executionRunId !== runId) || (task.checkoutRunId && task.checkoutRunId !== runId)) return;
      const [current] = await tx.select().from(workflowRunSteps).where(eq(workflowRunSteps.id, step.id)).for("update");
      if (current?.status !== "ready") return;
      await assignToPerson(tx, task, step.assigneeUserId!);
      await tx.update(workflowRunSteps).set({ status: "running" }).where(eq(workflowRunSteps.id, step.id));
      await tx.insert(workflowRunEvents).values({ runId: workflowRun.id, companyId: workflowRun.companyId,
        eventKey: `human_assigned:${step.id}`, kind: "step_ready", ...SYSTEM_ACTOR,
        payload: { stepKey: step.stepKey, attempt: step.attempt, userId: step.assigneeUserId, releasedRunId: runId } })
        .onConflictDoNothing();
    });
  }
}

/** Gives the task back to the agent that held it before a human step, so a normal handoff can move it on. */
export async function returnTaskFromPerson(db: Db, input: { caseId: string; parkedAgentId: string | null; nextAgentId: string }) {
  const task = await caseTask(db, input.caseId);
  if (!task.assigneeUserId) return;
  await issueService(db).update(task.id, { assigneeUserId: null, assigneeAgentId: input.parkedAgentId ?? input.nextAgentId,
    status: "todo", companyGuard: task.companyId }, db);
}

/** Only the step's person, or the company's owners and admins, may finish a human step. */
export async function assertHumanStepActor(db: Db, companyId: string, actor: AuthorizationActor, step: WorkflowStep) {
  if (actor.type !== "board") throw forbidden(`Only a person can finish human step "${step.key}"`);
  if (actor.source === "local_implicit" || actor.isInstanceAdmin || actor.userId === step.owner.ref) return;
  const userId = actor.userId;
  const [membership] = userId ? await db.select({ role: companyMemberships.membershipRole }).from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))) : [];
  if (membership?.role && MANAGEMENT_ROLES.includes(membership.role)) return;
  throw forbidden(`Only the owner of human step "${step.key}" or the company's owners and admins can finish it`);
}
