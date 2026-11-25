import { and, desc, eq } from "drizzle-orm";
import { cases, workflowRunEvents, workflowRunSteps, workflowRuns, workflowVersions, workflows, type Db } from "@paperclipai/db";
import { planStepOutcome, type CompleteWorkflowStep, type StepOutcomePlan } from "@paperclipai/shared";
import { conflict, unprocessable } from "../errors.js";
import { documentService } from "./documents.js";
import { caseHandoffService } from "./case-handoffs.js";
import { requireWorkflowVersionsEnabled } from "./workflow-versions.js";
import { persistActivity } from "./activity-log.js";
import type { AuthorizationActor } from "./authorization.js";
import {
  assertStepActor,
  buildStepInstructions,
  caseHandoffExpectations,
  eventActor,
  findStep,
  loadRun,
  loadRunSpec,
  readRunView,
  runActivityActor,
  writeWithActivity,
} from "./workflow-runs.js";

const OPEN_STEP_STATUSES: readonly string[] = ["ready", "running"];

async function stepAttempts(db: Db, runId: string) {
  const rows = await db.select({ stepKey: workflowRunSteps.stepKey, attempt: workflowRunSteps.attempt })
    .from(workflowRunSteps).where(eq(workflowRunSteps.runId, runId));
  const attempts: Record<string, number> = {};
  for (const row of rows) attempts[row.stepKey] = Math.max(attempts[row.stepKey] ?? 0, row.attempt);
  return attempts;
}

async function openStep(db: Db, runId: string, stepKey: string) {
  const [step] = await db.select().from(workflowRunSteps)
    .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.stepKey, stepKey)))
    .orderBy(desc(workflowRunSteps.attempt)).limit(1);
  return step && OPEN_STEP_STATUSES.includes(step.status) ? step : null;
}

async function collectOutputs(db: Db, taskId: string, outputKeys: string[]) {
  const revisions: Record<string, string> = {};
  const missing: string[] = [];
  for (const key of outputKeys) {
    const document = await documentService(db).getIssueDocumentByKey(taskId, key);
    if (document?.latestRevisionId) revisions[key] = document.latestRevisionId;
    else missing.push(key);
  }
  return { revisions, missing };
}

function completionEventKey(stepKey: string, attempt: number, idempotencyKey?: string) {
  return idempotencyKey ? `complete:${idempotencyKey}` : `complete:${stepKey}:${attempt}`;
}

/**
 * Finishes the current step of a run with one of its declared outcomes.
 * The external transfer runs first and is idempotent by key, so a retry after a failed local
 * write reuses the same handoff; the run's own state is then written in one transaction.
 * @param db Database
 * @param companyId Company of the run
 * @param runId Run to advance
 * @param stepKey Step being finished; must be the run's current step
 * @param actor The step's owner or a board user
 * @param input Outcome, optional summary for the next step, optional idempotency key
 */
export async function completeWorkflowStep(db: Db, companyId: string, runId: string, stepKey: string,
  actor: AuthorizationActor, input: CompleteWorkflowStep) {
  await requireWorkflowVersionsEnabled(db);
  const run = await loadRun(db, companyId, runId);
  if (input.idempotencyKey) {
    const [replayed] = await db.select({ id: workflowRunEvents.id }).from(workflowRunEvents).where(and(
      eq(workflowRunEvents.runId, runId), eq(workflowRunEvents.eventKey, completionEventKey(stepKey, 0, input.idempotencyKey))));
    if (replayed) return readRunView(db, await loadRun(db, companyId, runId));
  }
  if (run.status !== "running") throw conflict(`Workflow run is ${run.status}`, { code: "workflow_run_not_running" });
  if (run.currentStepKey !== stepKey) {
    throw conflict(`Step "${stepKey}" is not the current step`, { code: "workflow_step_not_current", currentStepKey: run.currentStepKey });
  }
  const current = await openStep(db, runId, stepKey);
  if (!current) throw conflict(`Step "${stepKey}" is not open`, { code: "workflow_step_not_current" });
  const spec = await loadRunSpec(db, run);
  const step = findStep(spec, stepKey);
  assertStepActor(actor, step);

  const [caseRow] = await db.select({ workIssueId: cases.workIssueId }).from(cases).where(eq(cases.id, run.caseId));
  const outputs = await collectOutputs(db, caseRow!.workIssueId!, step.outputs);
  if (outputs.missing.length > 0) {
    throw unprocessable(`Step "${stepKey}" is missing its outputs: ${outputs.missing.join(", ")}`, {
      code: "missing_outputs", missingOutputs: outputs.missing,
    });
  }
  const plan = planStepOutcome(spec, { stepKey, outcome: input.outcome, attemptsByStep: await stepAttempts(db, runId) });
  if (plan.kind === "invalid_outcome") {
    throw unprocessable(`Outcome "${input.outcome}" is not declared by step "${stepKey}"`, {
      code: "invalid_outcome", allowedOutcomes: plan.allowed,
    });
  }

  const handoffId = plan.kind === "advance"
    ? await handOffToNextStep(db, { companyId, run, spec, plan, actor, summary: input.summary ?? null })
    : null;

  await writeWithActivity(db, async (tx, publications) => {
    const [locked] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).for("update");
    const stillOpen = await openStep(tx, runId, stepKey);
    if (!locked || locked.status !== "running" || locked.currentStepKey !== stepKey || stillOpen?.id !== current.id) return;
    await tx.insert(workflowRunEvents).values({ runId, companyId, kind: "step_completed",
      eventKey: completionEventKey(stepKey, current.attempt, input.idempotencyKey), ...eventActor(actor),
      payload: { stepKey, attempt: current.attempt, outcome: input.outcome, summary: input.summary ?? null } });
    await tx.update(workflowRunSteps).set({ status: "completed", outcome: input.outcome, outputRevisionIds: outputs.revisions,
      closedAt: new Date() }).where(eq(workflowRunSteps.id, current.id));
    await applyPlan(tx, { companyId, runId, spec, plan, handoffId, actor });
    publications.push((await persistActivity(tx, {
      companyId, ...runActivityActor(actor), runId: actor.runId ?? null,
      action: planActivity(plan), entityType: "workflow_run", entityId: runId,
      details: { stepKey, attempt: current.attempt, outcome: input.outcome,
        ...(plan.kind === "advance" ? { nextStepKey: plan.stepKey, nextAttempt: plan.attempt } : {}),
        ...(plan.kind === "escalate" ? { reason: plan.reason } : {}) },
    })).publication);
  });
  return readRunView(db, await loadRun(db, companyId, runId));
}

function planActivity(plan: Exclude<StepOutcomePlan, { kind: "invalid_outcome" }>) {
  if (plan.kind === "complete") return "workflow_run.completed";
  if (plan.kind === "escalate") return "workflow_run.escalated";
  return "workflow_run.step_completed";
}

async function handOffToNextStep(db: Db, input: {
  companyId: string;
  run: typeof workflowRuns.$inferSelect;
  spec: Awaited<ReturnType<typeof loadRunSpec>>;
  plan: Extract<StepOutcomePlan, { kind: "advance" }>;
  actor: AuthorizationActor;
  summary: string | null;
}) {
  const next = findStep(input.spec, input.plan.stepKey);
  const [workflow] = await db.select({ name: workflows.name }).from(workflows).where(eq(workflows.id, input.run.workflowId));
  const [version] = await db.select({ version: workflowVersions.version }).from(workflowVersions)
    .where(eq(workflowVersions.id, input.run.versionId));
  const handoff = await caseHandoffService(db).handoff(input.companyId, input.actor, {
    idempotencyKey: `workflow-run:${input.run.id}:${next.key}:${input.plan.attempt}`,
    case: { id: input.run.caseId },
    ...await caseHandoffExpectations(db, input.run.caseId),
    toAgentId: next.owner.ref,
    phase: next.key,
    instructions: buildStepInstructions({ workflowName: workflow!.name, version: version!.version, runId: input.run.id,
      spec: input.spec, step: next, attempt: input.plan.attempt, previousSummary: input.summary }),
  }, { workflowRunId: input.run.id });
  return handoff.handoffId;
}

async function applyPlan(tx: Db, input: {
  companyId: string;
  runId: string;
  spec: Awaited<ReturnType<typeof loadRunSpec>>;
  plan: Exclude<StepOutcomePlan, { kind: "invalid_outcome" }>;
  handoffId: string | null;
  actor: AuthorizationActor;
}) {
  const now = new Date();
  if (input.plan.kind === "advance") {
    const next = findStep(input.spec, input.plan.stepKey);
    await tx.insert(workflowRunSteps).values({ runId: input.runId, companyId: input.companyId, stepKey: next.key,
      attempt: input.plan.attempt, status: "running", assigneeAgentId: next.owner.ref, handoffId: input.handoffId });
    await tx.update(workflowRuns).set({ currentStepKey: next.key, updatedAt: now }).where(eq(workflowRuns.id, input.runId));
    return;
  }
  if (input.plan.kind === "complete") {
    await tx.update(workflowRuns).set({ status: "completed", currentStepKey: null, completedAt: now, updatedAt: now })
      .where(eq(workflowRuns.id, input.runId));
    await tx.insert(workflowRunEvents).values({ runId: input.runId, companyId: input.companyId, eventKey: "completed",
      kind: "completed", ...eventActor(input.actor), payload: {} });
    return;
  }
  await tx.update(workflowRuns).set({ status: "waiting_human", statusReason: input.plan.reason, updatedAt: now })
    .where(eq(workflowRuns.id, input.runId));
  await tx.insert(workflowRunEvents).values({ runId: input.runId, companyId: input.companyId,
    eventKey: `escalated:${now.toISOString()}`, kind: "escalated", ...eventActor(input.actor), payload: { reason: input.plan.reason } });
}
