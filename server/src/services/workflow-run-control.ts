import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { agents, cases, companies, companyMemberships, decisions, issueRecoveryActions, issues, workflowRunEvents, workflowRunSteps, workflowRuns, type Db } from "@paperclipai/db";
import { WORKFLOW_RUN_ACTIVE_STATUSES } from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { decisionService } from "./decisions.js";
import { persistActivity } from "./activity-log.js";
import type { AuthorizationActor } from "./authorization.js";
import { requireWorkflowVersionsEnabled } from "./workflow-versions.js";
import { findStep, loadRun, loadRunSpec, readRunView, runActivityActor, writeWithActivity } from "./workflow-runs.js";
import { escalateRun } from "./workflow-run-advance.js";
import { gateReopenCount, onWorkflowGateResolved, openGate } from "./workflow-run-gates.js";
import { assignReadyHumanSteps } from "./workflow-run-human.js";

const MANAGEMENT_ROLES: readonly string[] = ["owner", "admin"];
const OPEN_STEP_STATUSES = ["pending", "ready", "running", "awaiting_review", "awaiting_approval", "awaiting_input"];
const WAITING_STEP_STATUSES: readonly string[] = ["ready", "awaiting_review", "awaiting_approval", "awaiting_input"];
const BUDGET_PAUSE_PREFIX = "Paused for budget";
const RECOVERY_BATCH = 100;
const SYSTEM_ACTOR = { actorType: "system", actorId: "workflow-run" } as const;

type RunRow = typeof workflowRuns.$inferSelect;

/** The run's responsible person, the company's owners and admins, or the local board may control a run. */
async function assertRunController(db: Db, run: RunRow, actor: AuthorizationActor) {
  if (actor.type !== "board") throw forbidden("Only a person can cancel or resume a workflow run");
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return;
  if (actor.userId && actor.userId === run.responsibleUserId) return;
  const userId = actor.userId;
  const [membership] = userId ? await db.select({ role: companyMemberships.membershipRole }).from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, run.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))) : [];
  if (membership?.role && MANAGEMENT_ROLES.includes(membership.role)) return;
  throw forbidden("Only the run's responsible person or the company's owners and admins can control it");
}

async function currentStep(db: Db, run: RunRow) {
  if (!run.currentStepKey) return null;
  const [step] = await db.select().from(workflowRunSteps)
    .where(and(eq(workflowRunSteps.runId, run.id), eq(workflowRunSteps.stepKey, run.currentStepKey)))
    .orderBy(desc(workflowRunSteps.attempt)).limit(1);
  return step ?? null;
}

function decisionsFor(db: Db) {
  return decisionService(db, { wakeOriginAgent: async () => undefined });
}

export async function cancelWorkflowRun(db: Db, companyId: string, runId: string, actor: AuthorizationActor, reason?: string) {
  await requireWorkflowVersionsEnabled(db);
  const run = await loadRun(db, companyId, runId);
  if (!(WORKFLOW_RUN_ACTIVE_STATUSES as readonly string[]).includes(run.status)) {
    throw conflict(`Workflow run is already ${run.status}`, { code: "workflow_run_not_active" });
  }
  await assertRunController(db, run, actor);
  const openGates = await writeWithActivity(db, async (tx, publications) => {
    const now = new Date();
    await tx.update(workflowRuns).set({ status: "cancelled", statusReason: reason ?? "Cancelled", completedAt: now, updatedAt: now })
      .where(eq(workflowRuns.id, runId));
    const closed = await tx.update(workflowRunSteps).set({ status: "cancelled", closedAt: now })
      .where(and(eq(workflowRunSteps.runId, runId), inArray(workflowRunSteps.status, OPEN_STEP_STATUSES)))
      .returning({ decisionId: workflowRunSteps.decisionId });
    await tx.insert(workflowRunEvents).values({ runId, companyId, eventKey: "cancelled", kind: "cancelled",
      actorType: "user", actorId: actor.type === "board" ? actor.userId ?? "board" : null, payload: { reason: reason ?? null } });
    publications.push((await persistActivity(tx, {
      companyId, ...runActivityActor(actor), runId: null, action: "workflow_run.cancelled", entityType: "workflow_run", entityId: runId,
      details: { reason: reason ?? null },
    })).publication);
    return closed.map((row) => row.decisionId).filter((id): id is string => Boolean(id));
  });
  for (const decisionId of openGates) {
    const [decision] = await db.select({ status: decisions.status }).from(decisions).where(eq(decisions.id, decisionId));
    if (decision?.status !== "open") continue;
    await decisionsFor(db).cancel(decisionId, { actorType: "user", actorId: actor.type === "board" ? actor.userId ?? "board" : "board" },
      { reason: reason ?? "The workflow run was cancelled" });
  }
  return readRunView(db, await loadRun(db, companyId, runId));
}

/**
 * Continues a run that waits for a person: a gate whose decision closed without an answer gets a new decision,
 * a decided gate the run never processed is processed with the resumer's authority, and an open step's state is restored.
 */
export async function resumeWorkflowRun(db: Db, companyId: string, runId: string, actor: AuthorizationActor) {
  await requireWorkflowVersionsEnabled(db);
  const run = await loadRun(db, companyId, runId);
  const budgetPaused = run.status === "paused" && (run.statusReason ?? "").startsWith(BUDGET_PAUSE_PREFIX);
  const step = await currentStep(db, run);
  const resumable = (run.status === "waiting_human" || (run.status === "paused" && !budgetPaused))
    && step && OPEN_STEP_STATUSES.includes(step.status);
  if (!resumable) {
    throw conflict("This run has nothing to resume; it is not waiting on an open step", { code: "workflow_run_nothing_to_resume" });
  }
  await assertRunController(db, run, actor);
  const [decision] = step.decisionId ? await db.select().from(decisions).where(eq(decisions.id, step.decisionId)) : [];
  if (step.status === "awaiting_approval" && decision?.status === "decided") {
    await onWorkflowGateResolved(db, decision.id, actor);
    return readRunView(db, await loadRun(db, companyId, runId));
  }
  if (step.status === "awaiting_approval" && decision?.status !== "open") {
    const spec = await loadRunSpec(db, run);
    const reopened = await openGate(db, { companyId, run, spec, step: findStep(spec, step.stepKey), attempt: step.attempt,
      originAgentId: decision?.originAgentId ?? null, summary: null, reopenCount: await gateReopenCount(db, run.id, step.stepKey, step.attempt) });
    if (reopened.kind !== "gate") throw conflict(reopened.kind === "blocked" ? reopened.reason : "The gate could not reopen");
    await writeWithActivity(db, async (tx, publications) => {
      await tx.update(workflowRunSteps).set({ decisionId: reopened.decisionId }).where(eq(workflowRunSteps.id, step.id));
      await tx.update(workflowRuns).set({ status: "waiting_human", statusReason: `Waiting for a decision on "${step.stepKey}"`,
        updatedAt: new Date() }).where(eq(workflowRuns.id, runId));
      await tx.insert(workflowRunEvents).values({ runId, companyId, eventKey: `gate_opened:${reopened.decisionId}`, kind: "gate_opened",
        ...SYSTEM_ACTOR, payload: { stepKey: step.stepKey, attempt: step.attempt, decisionId: reopened.decisionId, resumed: true } });
      publications.push((await persistActivity(tx, { companyId, ...runActivityActor(actor), runId: null,
        action: "workflow_run.resumed", entityType: "workflow_run", entityId: runId, details: { stepKey: step.stepKey } })).publication);
    });
    return readRunView(db, await loadRun(db, companyId, runId));
  }
  await writeWithActivity(db, async (tx, publications) => {
    const waiting = WAITING_STEP_STATUSES.includes(step.status) || Boolean(step.assigneeUserId);
    await tx.update(workflowRuns).set({ status: waiting ? "waiting_human" : "running", statusReason: null, updatedAt: new Date() })
      .where(eq(workflowRuns.id, runId));
    publications.push((await persistActivity(tx, { companyId, ...runActivityActor(actor), runId: null,
      action: "workflow_run.resumed", entityType: "workflow_run", entityId: runId, details: { stepKey: step.stepKey } })).publication);
  });
  return readRunView(db, await loadRun(db, companyId, runId));
}

async function budgetPausedScopes(db: Db, run: RunRow, step: typeof workflowRunSteps.$inferSelect | null) {
  const [company] = await db.select({ pauseReason: companies.pauseReason, status: companies.status }).from(companies)
    .where(eq(companies.id, run.companyId));
  if (company?.status === "paused" && company.pauseReason === "budget") return `${BUDGET_PAUSE_PREFIX}: company`;
  if (step?.assigneeAgentId && !step.assigneeUserId) {
    const [agent] = await db.select({ pauseReason: agents.pauseReason }).from(agents).where(eq(agents.id, step.assigneeAgentId));
    if (agent?.pauseReason === "budget") return `${BUDGET_PAUSE_PREFIX}: agent`;
  }
  return null;
}

async function syncBudgetPause(db: Db, run: RunRow) {
  const step = await currentStep(db, run);
  const pausedFor = await budgetPausedScopes(db, run, step);
  const pausedByBudget = run.status === "paused" && (run.statusReason ?? "").startsWith(BUDGET_PAUSE_PREFIX);
  if (pausedFor && run.status !== "paused") {
    await db.transaction(async (tx) => {
      await tx.update(workflowRuns).set({ status: "paused", statusReason: pausedFor, updatedAt: new Date() })
        .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.status, run.status)));
      await tx.insert(workflowRunEvents).values({ runId: run.id, companyId: run.companyId, eventKey: `paused:${Date.now()}`,
        kind: "paused", ...SYSTEM_ACTOR, payload: { reason: pausedFor, previousStatus: run.status, previousReason: run.statusReason } });
    });
    return;
  }
  if (!pausedFor && pausedByBudget) {
    const [paused] = await db.select({ payload: workflowRunEvents.payload }).from(workflowRunEvents)
      .where(and(eq(workflowRunEvents.runId, run.id), eq(workflowRunEvents.kind, "paused")))
      .orderBy(desc(workflowRunEvents.createdAt)).limit(1);
    const previousStatus = typeof paused?.payload.previousStatus === "string" ? paused.payload.previousStatus : "running";
    const previousReason = typeof paused?.payload.previousReason === "string" ? paused.payload.previousReason : null;
    await db.transaction(async (tx) => {
      await tx.update(workflowRuns).set({ status: previousStatus, statusReason: previousReason, updatedAt: new Date() })
        .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.status, "paused")));
      await tx.insert(workflowRunEvents).values({ runId: run.id, companyId: run.companyId, eventKey: `resumed:${Date.now()}`,
        kind: "resumed", ...SYSTEM_ACTOR, payload: { restoredStatus: previousStatus } });
    });
  }
}

const HUMAN_RECOVERY_OWNERS = ["user", "board"];
const OPEN_RECOVERY_STATUSES = ["active", "escalated"];

async function stuckAgentReason(db: Db, step: typeof workflowRunSteps.$inferSelect, task: typeof issues.$inferSelect) {
  const [agent] = await db.select({ status: agents.status }).from(agents).where(eq(agents.id, step.assigneeAgentId!));
  if (!agent || agent.status === "terminated") return `The agent of step "${step.stepKey}" is no longer active`;
  if (task.status !== "blocked") return null;
  const [action] = await db.select({ cause: issueRecoveryActions.cause, nextAction: issueRecoveryActions.nextAction })
    .from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, task.id),
      inArray(issueRecoveryActions.status, OPEN_RECOVERY_STATUSES), inArray(issueRecoveryActions.ownerType, HUMAN_RECOVERY_OWNERS)))
    .orderBy(desc(issueRecoveryActions.createdAt)).limit(1);
  return action ? `Agent work on step "${step.stepKey}" needs a person: ${action.cause}. ${action.nextAction}` : null;
}

/**
 * Lets the run wait for a person when the platform has given up on its current agent step: the task is blocked
 * with a recovery action owned by a person or the board, or the step's agent is no longer active. The platform
 * already retries failed runs with its own limits, so the run does not retry them again.
 */
async function escalateStuckAgentSteps(db: Db) {
  const running = await db.select({ run: workflowRuns, step: workflowRunSteps, task: issues }).from(workflowRuns)
    .innerJoin(workflowRunSteps, and(eq(workflowRunSteps.runId, workflowRuns.id), eq(workflowRunSteps.stepKey, workflowRuns.currentStepKey),
      eq(workflowRunSteps.status, "running")))
    .innerJoin(cases, eq(cases.id, workflowRuns.caseId))
    .innerJoin(issues, eq(issues.id, cases.workIssueId))
    .where(and(eq(workflowRuns.status, "running"), sql`${workflowRunSteps.assigneeAgentId} is not null`,
      sql`${workflowRunSteps.assigneeUserId} is null`))
    .limit(RECOVERY_BATCH);
  for (const { run, step, task } of running) {
    const reason = await stuckAgentReason(db, step, task);
    if (!reason) continue;
    await writeWithActivity(db, async (tx, publications) => {
      const [locked] = await tx.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, run.id)).for("update");
      if (locked?.status !== "running") return;
      await escalateRun(tx, { companyId: run.companyId, runId: run.id, reason, actor: SYSTEM_ACTOR });
      publications.push((await persistActivity(tx, { companyId: run.companyId, actorType: "system", actorId: "workflow-run",
        runId: null, action: "workflow_run.escalated", entityType: "workflow_run", entityId: run.id,
        details: { stepKey: step.stepKey, attempt: step.attempt, reason } })).publication);
    });
  }
}

/**
 * The run's recovery pass, run at startup and whenever budget pauses change or a task enters Blocked.
 * It mirrors budget pauses on runs, processes gate decisions a run was never told about without deciding for
 * anyone, gives waiting human steps to their person once no run holds the task, and lets a run wait for a person
 * when the platform gives up on its agent step. Each step is bounded and idempotent.
 */
export async function recoverWorkflowRuns(db: Db) {
  const active = await db.select().from(workflowRuns)
    .where(inArray(workflowRuns.status, [...WORKFLOW_RUN_ACTIVE_STATUSES])).limit(RECOVERY_BATCH);
  for (const run of active) {
    try { await syncBudgetPause(db, run); } catch (error) {
      logger.warn({ err: error, runId: run.id }, "workflow run budget pause sync failed");
    }
  }
  const unprocessedGates = await db.select({ decisionId: decisions.id }).from(workflowRunSteps)
    .innerJoin(decisions, eq(decisions.id, workflowRunSteps.decisionId))
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowRunSteps.runId))
    .where(and(eq(workflowRunSteps.status, "awaiting_approval"), ne(decisions.status, "open"),
      inArray(workflowRuns.status, ["running", "waiting_human"]), sql`not exists (
        select 1 from ${workflowRunEvents} where ${workflowRunEvents.runId} = ${workflowRuns.id}
          and ${workflowRunEvents.kind} = 'escalated' and ${workflowRunEvents.payload} ->> 'decisionId' = ${decisions.id}::text)`))
    .limit(RECOVERY_BATCH);
  for (const { decisionId } of unprocessedGates) {
    try { await onWorkflowGateResolved(db, decisionId, null); } catch (error) {
      logger.warn({ err: error, decisionId }, "workflow gate recovery failed");
    }
  }
  await assignReadyHumanSteps(db, RECOVERY_BATCH);
  await escalateStuckAgentSteps(db);
}

