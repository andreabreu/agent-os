import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { cases, companyMemberships, workflowRunEvents, workflowRunSteps, workflowRuns, type Db } from "@paperclipai/db";
import { formAnswersMarkdown, planStepOutcome, validateFormAnswers, type WorkflowStep } from "@paperclipai/shared";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { documentService } from "./documents.js";
import { persistActivity } from "./activity-log.js";
import type { AuthorizationActor } from "./authorization.js";
import { requireWorkflowVersionsEnabled } from "./workflow-versions.js";
import { findStep, loadRun, loadRunSpec, readRunView, runActivityActor, writeWithActivity } from "./workflow-runs.js";
import { applyPlan, escalateRun, prepareNextStep } from "./workflow-run-advance.js";

const MANAGEMENT_ROLES: readonly string[] = ["owner", "admin"];
const SYSTEM_ACTOR = { actorType: "system", actorId: "workflow-run" } as const;
const TIMEOUT_BATCH = 100;

/** The form's declared person, someone with its declared role, or the company's owners and admins may answer it. */
async function assertFormRespondent(db: Db, companyId: string, actor: AuthorizationActor, step: WorkflowStep) {
  if (actor.type !== "board") throw forbidden(`Only a person can answer form step "${step.key}"`);
  if (actor.source === "local_implicit" || actor.isInstanceAdmin) return;
  if (step.owner.kind === "user" && actor.userId === step.owner.ref) return;
  const userId = actor.userId;
  const [membership] = userId ? await db.select({ role: companyMemberships.membershipRole }).from(companyMemberships)
    .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))) : [];
  const role = membership?.role ?? null;
  if (role && (MANAGEMENT_ROLES.includes(role) || (step.owner.kind === "role" && step.owner.ref === role))) return;
  throw forbidden(`Only the person or role of form step "${step.key}", or the company's owners and admins, can answer it`);
}

/** The document key a form step's answers are saved under. */
export function formDocumentKey(step: WorkflowStep) {
  return step.outputs[0] ?? step.key;
}

/**
 * Saves a person's answers to a form step and moves the run on.
 * Answers are checked against the step's questions, saved as a document on the case's task under the step's
 * first output key, and the run follows the step's first outcome. A form is never filled in for anyone.
 */
export async function submitWorkflowForm(db: Db, companyId: string, runId: string, stepKey: string,
  actor: AuthorizationActor, answers: Record<string, unknown>) {
  await requireWorkflowVersionsEnabled(db);
  const run = await loadRun(db, companyId, runId);
  if (run.status !== "waiting_human" || run.currentStepKey !== stepKey) {
    throw conflict(`Step "${stepKey}" is not waiting for answers`, { code: "workflow_step_not_current" });
  }
  const [step] = await db.select().from(workflowRunSteps)
    .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.stepKey, stepKey)))
    .orderBy(desc(workflowRunSteps.attempt)).limit(1);
  if (!step || step.status !== "awaiting_input") throw conflict(`Step "${stepKey}" is not waiting for answers`, { code: "workflow_step_not_current" });
  const spec = await loadRunSpec(db, run);
  const definition = findStep(spec, stepKey);
  await assertFormRespondent(db, companyId, actor, definition);
  const validation = validateFormAnswers(definition.questions ?? [], answers);
  if (!validation.ok) {
    throw unprocessable(`The answers to "${definition.name}" are incomplete or invalid`, {
      code: "invalid_answers", missingRequired: validation.missingRequired, invalid: validation.invalid,
    });
  }

  const [caseRow] = await db.select({ workIssueId: cases.workIssueId }).from(cases).where(eq(cases.id, run.caseId));
  const key = formDocumentKey(definition);
  const existing = await documentService(db).getIssueDocumentByKey(caseRow!.workIssueId!, key);
  const saved = await documentService(db).upsertIssueDocument({
    issueId: caseRow!.workIssueId!, key, title: definition.name, format: "markdown",
    body: formAnswersMarkdown(definition.name, definition.questions ?? [], validation.answers),
    baseRevisionId: existing?.latestRevisionId ?? null, changeSummary: `Answers to "${definition.name}"`,
    createdByAgentId: null, createdByUserId: actor.type === "board" ? actor.userId ?? "board" : null, createdByRunId: null,
    lockedDocumentStrategy: "conflict",
  });

  const outcome = definition.outcomes[0]!.key;
  const attempts = await db.select({ stepKey: workflowRunSteps.stepKey, attempt: workflowRunSteps.attempt })
    .from(workflowRunSteps).where(eq(workflowRunSteps.runId, runId));
  const attemptsByStep: Record<string, number> = {};
  for (const row of attempts) attemptsByStep[row.stepKey] = Math.max(attemptsByStep[row.stepKey] ?? 0, row.attempt);
  const plan = planStepOutcome(spec, { stepKey, outcome, attemptsByStep });
  if (plan.kind === "invalid_outcome") throw unprocessable(`Form step "${stepKey}" declares no outcome`);
  const prepared = plan.kind === "advance"
    ? await prepareNextStep(db, { companyId, run, spec, plan, actor, summary: null, originAgentId: null })
    : null;

  await writeWithActivity(db, async (tx, publications) => {
    const [current] = await tx.select().from(workflowRunSteps).where(eq(workflowRunSteps.id, step.id)).for("update");
    if (current?.status !== "awaiting_input") throw conflict(`Step "${stepKey}" was already answered`, { code: "workflow_step_not_current" });
    await tx.insert(workflowRunEvents).values({ runId, companyId, eventKey: `form:${step.id}`, kind: "input_submitted",
      actorType: "user", actorId: actor.type === "board" ? actor.userId ?? "board" : null,
      payload: { stepKey, attempt: step.attempt, documentKey: key, revisionId: saved.document.latestRevisionId } });
    await tx.update(workflowRunSteps).set({ status: "completed", outcome, dueAt: null, closedAt: new Date(),
      outputRevisionIds: { [key]: saved.document.latestRevisionId! } }).where(eq(workflowRunSteps.id, step.id));
    await applyPlan(tx, { companyId, runId, spec, plan, prepared, actor });
    publications.push((await persistActivity(tx, {
      companyId, ...runActivityActor(actor), runId: null, action: "workflow_run.input_submitted",
      entityType: "workflow_run", entityId: runId, details: { stepKey, attempt: step.attempt, documentKey: key },
    })).publication);
  });
  return readRunView(db, await loadRun(db, companyId, runId));
}

/** Lets a run wait for a person, once, when a form passes its declared timeout unanswered. */
export async function escalateOverdueForms(db: Db, now = new Date()) {
  const overdue = await db.select({ step: workflowRunSteps, run: workflowRuns }).from(workflowRunSteps)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowRunSteps.runId))
    .where(and(eq(workflowRunSteps.status, "awaiting_input"), lte(workflowRunSteps.dueAt, now),
      inArray(workflowRuns.status, ["waiting_human"])))
    .limit(TIMEOUT_BATCH);
  for (const { step, run } of overdue) {
    await writeWithActivity(db, async (tx) => {
      const [current] = await tx.select().from(workflowRunSteps).where(eq(workflowRunSteps.id, step.id)).for("update");
      if (current?.status !== "awaiting_input" || !current.dueAt || current.dueAt > now) return;
      await tx.update(workflowRunSteps).set({ dueAt: null }).where(eq(workflowRunSteps.id, step.id));
      await escalateRun(tx, { companyId: run.companyId, runId: run.id, actor: SYSTEM_ACTOR,
        reason: `Form "${step.stepKey}" timed out without answers` });
    });
  }
}
