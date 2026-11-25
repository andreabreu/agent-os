import { and, desc, eq, sql } from "drizzle-orm";
import { cases, decisions, heartbeatRuns, workflowRunEvents, workflowRunSteps, workflowRuns, type Db } from "@paperclipai/db";
import { isRunActive, planStepOutcome, type WorkflowSpec, type WorkflowStep } from "@paperclipai/shared";
import { decisionService } from "./decisions.js";
import { summarizeAttemptChanges } from "./workflow-run-diff.js";
import { persistActivity } from "./activity-log.js";
import type { AuthorizationActor } from "./authorization.js";
import { readWorkflowGate, type WorkflowGateMetadata } from "./workflow-run-gate-hooks.js";
import { applyPlan, escalateRun, prepareNextStep, type PreparedNextStep } from "./workflow-run-advance.js";
import { findStep, loadRunSpec, runActivityActor, writeWithActivity } from "./workflow-runs.js";

const DAY_MS = 86_400_000;
const GATE_MAX_TTL_MS = 30 * DAY_MS - 60_000;
const COMMENT_INPUT_ID = "comment";
const COMMENT_MAX_LENGTH = 8_000;
const SYSTEM_ACTOR = { actorType: "system", actorId: "workflow-run" } as const;

type RunRow = typeof workflowRuns.$inferSelect;

function decisionsFor(db: Db) {
  // Gate decisions never wake their origin agent: the run advances itself when they resolve.
  return decisionService(db, { wakeOriginAgent: async () => undefined });
}

/** Outcomes that need a comment: the declared list, otherwise every outcome but the first. */
export function outcomesRequiringComment(step: WorkflowStep) {
  return step.commentRequiredOn ?? step.outcomes.slice(1).map((outcome) => outcome.key);
}

async function originRun(db: Db, companyId: string, taskId: string, agentId: string | null) {
  if (!agentId) return null;
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${taskId}`,
  )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  return run ?? null;
}

async function lastAgentOfRun(db: Db, runId: string) {
  const [step] = await db.select({ agentId: workflowRunSteps.assigneeAgentId }).from(workflowRunSteps).where(and(
    eq(workflowRunSteps.runId, runId), sql`${workflowRunSteps.assigneeAgentId} is not null`,
  )).orderBy(desc(workflowRunSteps.openedAt)).limit(1);
  return step?.agentId ?? null;
}

/**
 * Opens the decision a person answers for an approval gate.
 * The decision's origin is the last agent that held the case, through its latest run on the task,
 * because a decision must come from an agent run. Without one the run waits for a person instead.
 */
export async function openGate(db: Db, input: {
  companyId: string;
  run: RunRow;
  spec: WorkflowSpec;
  step: WorkflowStep;
  attempt: number;
  originAgentId: string | null;
  summary: string | null;
  reopenCount?: number;
  latestOutputs?: Record<string, string>;
}): Promise<PreparedNextStep> {
  const [caseRow] = await db.select({ workIssueId: cases.workIssueId }).from(cases).where(eq(cases.id, input.run.caseId));
  const agentId = input.originAgentId ?? await lastAgentOfRun(db, input.run.id);
  const origin = await originRun(db, input.companyId, caseRow!.workIssueId!, agentId);
  if (!agentId || !origin) {
    return { kind: "blocked", reason: `Approval gate "${input.step.key}" needs an agent run on this task to open its decision` };
  }
  const timeoutMs = input.step.limits.timeoutSec ? input.step.limits.timeoutSec * 1_000 : null;
  const changes = input.attempt > 1 ? await summarizeAttemptChanges(db, { runId: input.run.id, taskId: caseRow!.workIssueId!, latestOutputs: input.latestOutputs }) : null;
  const requiringComment = new Set(outcomesRequiringComment(input.step));
  const gate: WorkflowGateMetadata = {
    runId: input.run.id,
    stepKey: input.step.key,
    attempt: input.attempt,
    deciderUserIds: input.step.owner.kind === "user" ? [input.step.owner.ref] : [],
    deciderRoles: input.step.owner.kind === "role" ? [input.step.owner.ref] : [],
    timeoutDeclared: timeoutMs !== null,
  };
  const decision = await decisionsFor(db).create({
    companyId: input.companyId,
    actor: { type: "agent", agentId, companyId: input.companyId, runId: origin.id, source: "agent_jwt" },
    agentId,
    runId: origin.id,
    title: `Decide "${input.step.name}"`,
    body: [
      `Workflow step "${input.step.name}" (${input.step.key})${input.attempt > 1 ? `, round ${input.attempt}` : ""} needs your decision.`,
      input.summary ? `Summary from the previous step: ${input.summary}` : null,
      changes ? `Changes since the last round:\n\n${changes}` : null,
    ].filter(Boolean).join("\n\n"),
    options: input.step.outcomes.map((outcome) => ({
      id: outcome.key,
      label: outcome.key.replaceAll("_", " "),
      effects: [],
      ...(requiringComment.has(outcome.key) ? { requiredInputIds: [COMMENT_INPUT_ID] } : {}),
    })),
    inputs: [{ id: COMMENT_INPUT_ID, label: "Comment", required: false, maxLength: COMMENT_MAX_LENGTH }],
    expiresAt: new Date(Date.now() + Math.min(timeoutMs ?? GATE_MAX_TTL_MS, GATE_MAX_TTL_MS)),
    idempotencyKey: `workflow-run:${input.run.id}:${input.step.key}:${input.attempt}:gate:${input.reopenCount ?? 0}`,
    continuationPolicy: "none",
    metadata: { workflowGate: gate },
  });
  return { kind: "gate", decisionId: decision.id };
}

async function gateStep(db: Db, decisionId: string) {
  const [step] = await db.select().from(workflowRunSteps).where(eq(workflowRunSteps.decisionId, decisionId));
  return step ?? null;
}

export async function gateReopenCount(db: Db, runId: string, stepKey: string, attempt: number) {
  const rows = await db.select({ id: workflowRunEvents.id }).from(workflowRunEvents).where(and(
    eq(workflowRunEvents.runId, runId), eq(workflowRunEvents.kind, "gate_opened"),
    sql`${workflowRunEvents.payload} ->> 'stepKey' = ${stepKey}`,
    sql`(${workflowRunEvents.payload} ->> 'attempt')::int = ${attempt}`,
  ));
  return rows.length;
}

/**
 * Moves a run on after its gate decision resolves.
 * A decided gate follows the chosen outcome. An expired gate escalates when it declared a timeout and
 * is otherwise reopened with a new decision, so nobody's answer is ever assumed. A cancelled decision escalates.
 * Repeated notifications for the same decision change nothing.
 */
export async function onWorkflowGateResolved(db: Db, decisionId: string, actor: AuthorizationActor | null) {
  const [decision] = await db.select().from(decisions).where(eq(decisions.id, decisionId));
  const gate = decision ? readWorkflowGate(decision.metadata) : null;
  const step = await gateStep(db, decisionId);
  if (!decision || !gate || !step || step.status !== "awaiting_approval") return;
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, gate.runId));
  if (!run || !isRunActive(run.status) || run.status === "paused") return;
  const spec = await loadRunSpec(db, run);
  const gateDefinition = findStep(spec, step.stepKey);

  if (decision.status === "expired" && !gate.timeoutDeclared) {
    const reopened = await openGate(db, { companyId: run.companyId, run, spec, step: gateDefinition, attempt: step.attempt,
      originAgentId: decision.originAgentId, summary: null, reopenCount: await gateReopenCount(db, run.id, step.stepKey, step.attempt) });
    await writeWithActivity(db, async (tx) => {
      const [current] = await tx.select().from(workflowRunSteps).where(eq(workflowRunSteps.id, step.id)).for("update");
      if (!current || current.decisionId !== decisionId) return;
      if (reopened.kind !== "gate") {
        await escalateRun(tx, { companyId: run.companyId, runId: run.id, reason: reopened.kind === "blocked" ? reopened.reason : "Gate could not reopen", actor: SYSTEM_ACTOR });
        return;
      }
      await tx.update(workflowRunSteps).set({ decisionId: reopened.decisionId }).where(eq(workflowRunSteps.id, step.id));
      await tx.insert(workflowRunEvents).values({ runId: run.id, companyId: run.companyId, eventKey: `gate_opened:${reopened.decisionId}`,
        kind: "gate_opened", ...SYSTEM_ACTOR, payload: { stepKey: step.stepKey, attempt: step.attempt, decisionId: reopened.decisionId, reopenedFrom: decisionId } });
    });
    return;
  }

  if (decision.status !== "decided") {
    const reason = decision.status === "expired"
      ? `Decision on "${gateDefinition.name}" timed out without an answer`
      : `Decision on "${gateDefinition.name}" was withdrawn`;
    await writeWithActivity(db, async (tx) => {
      const [current] = await tx.select().from(workflowRunSteps).where(eq(workflowRunSteps.id, step.id)).for("update");
      if (!current || current.decisionId !== decisionId || current.status !== "awaiting_approval") return;
      await escalateRun(tx, { companyId: run.companyId, runId: run.id, reason, actor: SYSTEM_ACTOR, decisionId });
    });
    return;
  }

  const outcome = decision.chosenOptionId!;
  const comment = decision.inputValues?.[COMMENT_INPUT_ID]?.trim() || null;
  const attempts = await db.select({ stepKey: workflowRunSteps.stepKey, attempt: workflowRunSteps.attempt })
    .from(workflowRunSteps).where(eq(workflowRunSteps.runId, run.id));
  const attemptsByStep: Record<string, number> = {};
  for (const row of attempts) attemptsByStep[row.stepKey] = Math.max(attemptsByStep[row.stepKey] ?? 0, row.attempt);
  const plan = planStepOutcome(spec, { stepKey: step.stepKey, outcome, attemptsByStep });
  if (plan.kind === "invalid_outcome") return;
  if (!actor) {
    await writeWithActivity(db, async (tx) => {
      await escalateRun(tx, { companyId: run.companyId, runId: run.id, actor: SYSTEM_ACTOR, decisionId,
        reason: `Decision "${outcome}" on "${gateDefinition.name}" needs a person to resume the run` });
    });
    return;
  }
  const transferActor: AuthorizationActor = actor;
  const prepared = plan.kind === "advance"
    ? await prepareNextStep(db, { companyId: run.companyId, run, spec, plan, actor: transferActor,
      summary: comment ? `Decision "${outcome}" on "${gateDefinition.name}": ${comment}` : null,
      originAgentId: decision.originAgentId, escalateHandoffFailure: true })
    : null;

  await writeWithActivity(db, async (tx, publications) => {
    const [current] = await tx.select().from(workflowRunSteps).where(eq(workflowRunSteps.id, step.id)).for("update");
    if (!current || current.decisionId !== decisionId || current.status !== "awaiting_approval") return;
    const inserted = await tx.insert(workflowRunEvents).values({ runId: run.id, companyId: run.companyId, eventKey: `gate:${decisionId}`,
      kind: "gate_decided", actorType: "user", actorId: decision.decidedByUserId,
      payload: { stepKey: step.stepKey, attempt: step.attempt, outcome, comment,
        waitedMs: decision.decidedAt ? decision.decidedAt.getTime() - current.openedAt.getTime() : null } })
      .onConflictDoNothing().returning({ id: workflowRunEvents.id });
    if (inserted.length === 0) return;
    await tx.update(workflowRunSteps).set({ status: "completed", outcome, comment, closedAt: new Date() })
      .where(eq(workflowRunSteps.id, step.id));
    await applyPlan(tx, { companyId: run.companyId, runId: run.id, spec, plan, prepared, actor: transferActor });
    publications.push((await persistActivity(tx, {
      companyId: run.companyId, ...runActivityActor(transferActor), runId: null,
      action: "workflow_run.gate_decided", entityType: "workflow_run", entityId: run.id,
      details: { stepKey: step.stepKey, attempt: step.attempt, outcome, decisionId,
        decidedByUserId: decision.decidedByUserId, ...(plan.kind === "advance" ? { nextStepKey: plan.stepKey } : {}) },
    })).publication);
  });
}
