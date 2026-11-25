import { and, asc, desc, eq } from "drizzle-orm";
import { agents, cases, issues, workflowRunEvents, workflowRunSteps, workflowRuns, workflowVersions, workflows, type Db } from "@paperclipai/db";
import {
  WORKFLOW_RUN_STATE_UNSUPPORTED_CODE,
  WORKFLOW_RUN_STATE_VERSION,
  isExecutableWorkflowSpec,
  validateWorkflowGraph,
  workflowSpecSchema,
  type WorkflowRunOrigin,
  type WorkflowSpec,
  type WorkflowStep,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { requireWorkflowVersionsEnabled } from "./workflow-versions.js";
import { authorizeCaseMutation } from "./case-mutation-authorization.js";
import { caseHandoffService } from "./case-handoffs.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import type { AuthorizationActor } from "./authorization.js";

export const WORKFLOW_NOT_EXECUTABLE_CODE = "workflow_not_executable";
const STEP_TYPES_RUNNABLE_NOW: readonly string[] = ["agent_task"];
const RECENT_EVENT_LIMIT = 50;
const ACTIVE_RUN_UNIQUE_INDEX = "workflow_runs_active_case_uq";

type WorkflowRunRow = typeof workflowRuns.$inferSelect;

export function runActivityActor(actor: AuthorizationActor) {
  return actor.type === "agent"
    ? { actorType: "agent" as const, actorId: actor.agentId!, agentId: actor.agentId! }
    : { actorType: "user" as const, actorId: actor.userId ?? "board" };
}

export async function writeWithActivity<T>(db: Db, work: (tx: Db, publications: ActivityPublication[]) => Promise<T>) {
  const publications: ActivityPublication[] = [];
  const result = await db.transaction(async (transaction) => work(transaction as unknown as Db, publications));
  publications.forEach(publishActivity);
  return result;
}

export function assertSupportedRunState(run: Pick<WorkflowRunRow, "id" | "stateVersion">) {
  if (run.stateVersion !== WORKFLOW_RUN_STATE_VERSION) {
    throw conflict(`Workflow run ${run.id} was saved by an incompatible release (state version ${run.stateVersion})`, {
      code: WORKFLOW_RUN_STATE_UNSUPPORTED_CODE,
    });
  }
}

export async function loadRun(db: Db, companyId: string, runId: string) {
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.id, runId)));
  if (!run) throw notFound("Workflow run not found");
  assertSupportedRunState(run);
  return run;
}

export async function loadRunSpec(db: Db, run: Pick<WorkflowRunRow, "versionId">): Promise<WorkflowSpec> {
  const [version] = await db.select({ spec: workflowVersions.spec }).from(workflowVersions).where(eq(workflowVersions.id, run.versionId));
  return workflowSpecSchema.parse(version!.spec);
}

export function findStep(spec: WorkflowSpec, stepKey: string): WorkflowStep {
  const step = spec.steps.find((candidate) => candidate.key === stepKey);
  if (!step) throw notFound(`Step "${stepKey}" is not part of this workflow version`);
  return step;
}

export function inputDocumentKeys(spec: WorkflowSpec, step: WorkflowStep) {
  return step.inputs.flatMap((inputKey) => spec.steps.find((candidate) => candidate.key === inputKey)?.outputs ?? []);
}

/**
 * The handoff instructions an agent receives when a step starts.
 * Inputs are named by document key on the case's task; their content is not copied.
 */
export function buildStepInstructions(input: {
  workflowName: string;
  version: number;
  runId: string;
  spec: WorkflowSpec;
  step: WorkflowStep;
  attempt: number;
  previousSummary?: string | null;
}) {
  const { step } = input;
  const inputs = inputDocumentKeys(input.spec, step);
  return [
    `Workflow "${input.workflowName}" version ${input.version}, step "${step.name}" (${step.key})`
      + (input.attempt > 1 ? `, attempt ${input.attempt}.` : "."),
    input.previousSummary ? `Previous step summary: ${input.previousSummary}` : null,
    inputs.length ? `Read these documents on this task first: ${inputs.join(", ")}.` : null,
    step.outputs.length ? `Save these documents on this task before finishing: ${step.outputs.join(", ")}.` : null,
    `Finish with POST /api/workflow-runs/${input.runId}/steps/${step.key}/complete and one outcome: `
      + `${step.outcomes.map((outcome) => outcome.key).join(", ")}. Do not hand the case off yourself.`,
  ].filter((line): line is string => Boolean(line)).join("\n\n");
}

async function assertRunnable(db: Db, companyId: string, spec: WorkflowSpec) {
  const unsupported = spec.steps.filter((step) => !STEP_TYPES_RUNNABLE_NOW.includes(step.type) || step.owner.kind !== "agent");
  const graphIssues = isExecutableWorkflowSpec(spec) ? [] : validateWorkflowGraph(spec);
  if (unsupported.length > 0 || graphIssues.length > 0) {
    throw unprocessable("This workflow version cannot run yet", {
      code: WORKFLOW_NOT_EXECUTABLE_CODE,
      unsupportedSteps: unsupported.map((step) => ({ stepKey: step.key, type: step.type, ownerKind: step.owner.kind })),
      issues: graphIssues,
    });
  }
  const ownerIds = [...new Set(spec.steps.map((step) => step.owner.ref))];
  const known = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId));
  const knownIds = new Set(known.map((agent) => agent.id));
  const missing = ownerIds.filter((id) => !knownIds.has(id));
  if (missing.length > 0) {
    throw unprocessable("Some step owners are not agents of this company", { code: WORKFLOW_NOT_EXECUTABLE_CODE, missingAgents: missing });
  }
}

function isActiveRunConflict(error: unknown) {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (!candidate || typeof candidate !== "object") continue;
    const { code, constraint_name: constraintName, constraint } = candidate as {
      code?: string; constraint_name?: string; constraint?: string;
    };
    if (code === "23505" && (constraintName ?? constraint) === ACTIVE_RUN_UNIQUE_INDEX) return true;
  }
  return false;
}

export async function readRunView(db: Db, run: WorkflowRunRow) {
  const steps = await db.select().from(workflowRunSteps).where(eq(workflowRunSteps.runId, run.id))
    .orderBy(asc(workflowRunSteps.openedAt), asc(workflowRunSteps.attempt));
  const events = await db.select().from(workflowRunEvents).where(eq(workflowRunEvents.runId, run.id))
    .orderBy(desc(workflowRunEvents.createdAt)).limit(RECENT_EVENT_LIMIT);
  return { ...run, steps, events };
}

/** The optimistic-concurrency versions a handoff on an existing case must name. */
export async function caseHandoffExpectations(db: Db, caseId: string) {
  const [row] = await db.select({ handoffVersion: cases.handoffVersion, issueStatusVersion: issues.statusVersion })
    .from(cases).innerJoin(issues, eq(issues.id, cases.workIssueId)).where(eq(cases.id, caseId));
  return { expectedHandoffVersion: row!.handoffVersion, expectedIssueStatusVersion: row!.issueStatusVersion };
}

export function workflowRunService(db: Db) {
  return {
    async start(companyId: string, actor: AuthorizationActor, input: { workflowId: string; caseId: string },
      options: { origin?: WorkflowRunOrigin; routineRunId?: string | null; responsibleUserId?: string | null } = {}) {
      await requireWorkflowVersionsEnabled(db);
      const [caseRow] = await db.select().from(cases).where(and(eq(cases.companyId, companyId), eq(cases.id, input.caseId)));
      if (!caseRow) throw notFound("Case not found");
      if (!caseRow.workIssueId) throw unprocessable("The case has no primary task to run a workflow on", { code: "case_without_task" });
      const [workflow] = await db.select().from(workflows).where(and(eq(workflows.companyId, companyId), eq(workflows.id, input.workflowId)));
      if (!workflow) throw notFound("Workflow not found");
      if (workflow.status === "archived") throw conflict("Workflow is archived");
      if (!workflow.latestVersionId) throw unprocessable("Workflow has no published version", { code: WORKFLOW_NOT_EXECUTABLE_CODE });
      const [version] = await db.select().from(workflowVersions).where(eq(workflowVersions.id, workflow.latestVersionId));
      const spec = workflowSpecSchema.parse(version!.spec);
      await assertRunnable(db, companyId, spec);
      const firstStep = findStep(spec, spec.start);
      const origin: WorkflowRunOrigin = options.origin ?? (actor.type === "agent" ? "agent" : "manual");

      let run: WorkflowRunRow;
      try {
        run = await writeWithActivity(db, async (tx, publications) => {
          await authorizeCaseMutation(tx, actor, caseRow.id, companyId);
          const [created] = await tx.insert(workflowRuns).values({
            companyId, workflowId: workflow.id, versionId: version!.id, caseId: caseRow.id, status: "running",
            responsibleUserId: options.responsibleUserId ?? (actor.type === "board" ? actor.userId ?? null : actor.onBehalfOfUserId ?? null),
            startedByAgentId: actor.type === "agent" ? actor.agentId : null,
            startedByUserId: actor.type === "board" ? actor.userId ?? null : null,
            origin, routineRunId: options.routineRunId ?? null, currentStepKey: firstStep.key,
          }).returning();
          await tx.insert(workflowRunSteps).values({ runId: created!.id, companyId, stepKey: firstStep.key, attempt: 1,
            status: "ready", assigneeAgentId: firstStep.owner.ref });
          await tx.insert(workflowRunEvents).values({ runId: created!.id, companyId, eventKey: "started", kind: "started",
            ...eventActor(actor), payload: { versionId: version!.id, version: version!.version } });
          publications.push((await persistActivity(tx, {
            companyId, ...runActivityActor(actor), runId: actor.runId ?? null,
            action: "workflow_run.started", entityType: "workflow_run", entityId: created!.id,
            details: { workflowId: workflow.id, versionId: version!.id, caseId: caseRow.id, origin },
          })).publication);
          return created!;
        });
      } catch (error) {
        if (isActiveRunConflict(error)) throw conflict("This case already has an active workflow run", { code: "workflow_run_active" });
        throw error;
      }

      try {
        const handoff = await caseHandoffService(db).handoff(companyId, actor, {
          idempotencyKey: `workflow-run:${run.id}:${firstStep.key}:1`,
          case: { id: caseRow.id },
          ...await caseHandoffExpectations(db, caseRow.id),
          toAgentId: firstStep.owner.ref,
          phase: firstStep.key,
          instructions: buildStepInstructions({ workflowName: workflow.name, version: version!.version, runId: run.id,
            spec, step: firstStep, attempt: 1 }),
          workflowId: workflow.id,
        }, { workflowRunId: run.id });
        await db.update(workflowRunSteps).set({ status: "running", handoffId: handoff.handoffId })
          .where(and(eq(workflowRunSteps.runId, run.id), eq(workflowRunSteps.stepKey, firstStep.key), eq(workflowRunSteps.attempt, 1)));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await db.update(workflowRuns).set({ status: "failed", statusReason: `Could not hand the case to the first step: ${reason}`,
          completedAt: new Date(), updatedAt: new Date() }).where(eq(workflowRuns.id, run.id));
        throw error;
      }
      return readRunView(db, await loadRun(db, companyId, run.id));
    },

    async read(companyId: string, runId: string) {
      await requireWorkflowVersionsEnabled(db);
      return readRunView(db, await loadRun(db, companyId, runId));
    },

    async list(companyId: string, filters: { status?: string; caseId?: string; limit: number; offset: number }) {
      await requireWorkflowVersionsEnabled(db);
      return db.select().from(workflowRuns).where(and(
        eq(workflowRuns.companyId, companyId),
        filters.status ? eq(workflowRuns.status, filters.status) : undefined,
        filters.caseId ? eq(workflowRuns.caseId, filters.caseId) : undefined,
      )).orderBy(desc(workflowRuns.createdAt)).limit(filters.limit).offset(filters.offset);
    },
  };
}

export function eventActor(actor: AuthorizationActor) {
  return actor.type === "agent"
    ? { actorType: "agent", actorId: actor.agentId ?? null }
    : { actorType: "user", actorId: actor.userId ?? "board" };
}

export function assertStepActor(actor: AuthorizationActor, step: WorkflowStep) {
  if (actor.type === "board") return;
  if (actor.type === "agent" && step.owner.kind === "agent" && actor.agentId === step.owner.ref) return;
  throw forbidden(`Only the owner of step "${step.key}" or a board user can finish it`);
}
