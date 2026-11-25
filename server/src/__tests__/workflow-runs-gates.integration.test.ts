import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  caseAccessSources,
  caseEvents,
  caseHandoffs,
  caseIssueLinks,
  cases,
  companies,
  companyMemberships,
  createDb,
  decisions,
  decisionTargetIssues,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  workflowRunEvents,
  workflowRunSteps,
  workflowRuns,
  workflowVersions,
  workflows,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { workflowRunRoutes } from "../routes/workflow-runs.js";
import { assignWorkflowHumanStepAfterRelease } from "../services/workflow-run-human.js";
import { recoverWorkflowRuns } from "../services/workflow-run-control.js";
import { caseHandoffService } from "../services/case-handoffs.js";
import { caseHandoffDeliveryService } from "../services/case-handoff-delivery.js";
import { documentService } from "../services/documents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { workflowService } from "../services/workflows.js";
import { workflowVersionService } from "../services/workflow-versions.js";
import { decisionService } from "../services/decisions.js";

const board = { type: "board" as const, source: "local_implicit" as const };

describe("workflow runs with approval gates", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("workflow-runs-gates-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(workflowRunEvents);
    await db.delete(workflowRunSteps);
    await db.delete(workflowRuns);
    await db.delete(decisionTargetIssues);
    await db.delete(decisions);
    await db.delete(caseHandoffs);
    await db.delete(caseEvents);
    await db.delete(caseAccessSources);
    await db.delete(caseIssueLinks);
    await db.delete(cases);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(workflowVersions);
    await db.delete(workflows);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function deliverHandoffs() {
    const wakeup = vi.fn(async (agentId: string, options: { durableCaseHandoffRequest: { wakeupRequestId: string };
      source: string; reason: string; payload: Record<string, unknown>; idempotencyKey: string }) => {
      const receipt = options.durableCaseHandoffRequest;
      const [agent] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, agentId));
      await db.insert(agentWakeupRequests).values({ id: receipt.wakeupRequestId, companyId: agent!.companyId, agentId,
        source: options.source, status: "queued", reason: options.reason, payload: options.payload,
        idempotencyKey: options.idempotencyKey }).onConflictDoNothing();
      return { id: receipt.wakeupRequestId };
    });
    await caseHandoffDeliveryService(db, { heartbeat: { wakeup } as never, now: () => new Date(Date.now() + 60_000) }).sweepPending();
  }

  const decisionsSvc = () => decisionService(db, { wakeOriginAgent: async () => undefined });

  async function fixture(options: { timeoutSec?: number; variant?: "gate" | "human" | "gateThenHuman" | "form" } = {}) {
    await instanceSettingsService(db).updateExperimental({ enableCases: true, enableWorkflowVersions: true });
    const companyId = randomUUID(), triage = randomUUID(), researcher = randomUUID(), publisher = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Studio", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: triage, companyId, name: "Triage", role: "ceo", status: "active", adapterType: "process" },
      { id: researcher, companyId, name: "Researcher", role: "engineer", status: "active", adapterType: "process", reportsTo: triage },
      { id: publisher, companyId, name: "Publisher", role: "engineer", status: "active", adapterType: "process", reportsTo: triage },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: "editor-user", status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: "intern-user", status: "active", membershipRole: "viewer" },
      { companyId, principalType: "user", principalId: "owner-user", status: "active", membershipRole: "owner" },
    ]);
    const kickoff = await caseHandoffService(db).handoff(companyId, board, {
      idempotencyKey: randomUUID(),
      case: { create: { caseType: "content", title: "Launch post", summary: "Announce the launch" } },
      toAgentId: triage, phase: "intake", instructions: "Hold until the workflow starts",
      workflow_document_text: "# Publishing",
    });
    await deliverHandoffs();
    const workflow = await workflowService(db).write(companyId, board, { name: "Publishing", prompt: "Publish carefully." });
    const spec = {
      specVersion: 1,
      start: "research",
      steps: [
        { key: "research", name: "Research", type: "agent_task", owner: { kind: "agent", ref: researcher },
          outputs: ["notes"], limits: { maxAttempts: 3 }, outcomes: [{ key: "done", to: "approval" }] },
        { key: "approval", name: "Approval", type: "approval_gate", owner: { kind: "user", ref: "editor-user" },
          limits: { maxReviewRounds: 2, ...(options.timeoutSec ? { timeoutSec: options.timeoutSec } : {}) },
          outcomes: [{ key: "approved", to: "publish" }, { key: "changes_requested", to: "research" }, { key: "rejected", to: "end" }] },
        { key: "publish", name: "Publish", type: "agent_task", owner: { kind: "agent", ref: publisher }, externalEffect: true,
          outcomes: [{ key: "done", to: "end" }] },
      ],
    };
    const humanReview = { key: "review", name: "Review", type: "human_task", owner: { kind: "user", ref: "editor-user" },
      outcomes: [{ key: "done", to: "publish" }] };
    if (options.variant === "human") {
      spec.steps = [{ ...spec.steps[0]!, outcomes: [{ key: "done", to: "review" }] }, humanReview, spec.steps[2]!] as typeof spec.steps;
      spec.steps[2] = { ...spec.steps[2]!, externalEffect: false } as (typeof spec.steps)[number];
    }
    if (options.variant === "form") {
      const brief = { key: "brief", name: "Brief", type: "input_form", owner: { kind: "user", ref: "editor-user" },
        outputs: ["brief"], outcomes: [{ key: "submitted", to: "publish" }],
        ...(options.timeoutSec ? { limits: { timeoutSec: options.timeoutSec } } : {}),
        questions: [
          { id: "audience", label: "Who is the audience?", kind: "text", required: true },
          { id: "tone", label: "Tone", kind: "single_choice", required: true, options: ["formal", "casual"] },
        ] };
      spec.steps = [{ ...spec.steps[0]!, outcomes: [{ key: "done", to: "brief" }] }, brief,
        { ...spec.steps[2]!, externalEffect: false }] as typeof spec.steps;
    }
    if (options.variant === "gateThenHuman") {
      spec.steps[1] = { ...spec.steps[1]!, outcomes: [{ key: "approved", to: "review" }, { key: "changes_requested", to: "research" },
        { key: "rejected", to: "end" }] } as (typeof spec.steps)[number];
      spec.steps.push(humanReview as (typeof spec.steps)[number]);
      spec.steps[2] = { ...spec.steps[2]!, externalEffect: false } as (typeof spec.steps)[number];
    }
    await workflowVersionService(db).publish(companyId, workflow.id, board, { spec });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { actor?: unknown }).actor = board; next(); });
    app.use("/api", workflowRunRoutes(db));
    app.use(errorHandler);
    const run = (await request(app).post(`/api/companies/${companyId}/workflow-runs`)
      .send({ workflowId: workflow.id, caseId: kickoff.caseId }).expect(201)).body as { id: string };
    await deliverHandoffs();
    return { companyId, researcher, publisher, taskId: kickoff.taskId, caseId: kickoff.caseId, runId: run.id, app };
  }

  async function finishResearchAsAgent(f: Awaited<ReturnType<typeof fixture>>) {
    await documentService(db).upsertIssueDocument({ issueId: f.taskId, key: "notes", title: "notes", format: "markdown",
      body: `Findings ${randomUUID()}`, baseRevisionId: (await documentService(db).getIssueDocumentByKey(f.taskId, "notes"))?.latestRevisionId ?? null,
      createdByUserId: "board-user", createdByAgentId: null, createdByRunId: null, lockedDocumentStrategy: "conflict" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.researcher, status: "running", runtimeMode: "legacy",
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: f.taskId } });
    await db.update(issues).set({ status: "in_progress", executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, f.taskId));
    const researcherActor = { type: "agent" as const, agentId: f.researcher, companyId: f.companyId, runId, source: "agent_jwt" as const };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { actor?: unknown }).actor = researcherActor; next(); });
    app.use("/api", workflowRunRoutes(db));
    app.use(errorHandler);
    await request(app).post(`/api/workflow-runs/${f.runId}/steps/research/complete`).send({ outcome: "done" }).expect(200);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, f.taskId));
    return runId;
  }

  function appAs(actor: unknown) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { actor?: unknown }).actor = actor; next(); });
    app.use("/api", workflowRunRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function stepRow(runId: string, stepKey: string) {
    const [row] = await db.select().from(workflowRunSteps)
      .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.stepKey, stepKey)))
      .orderBy(desc(workflowRunSteps.attempt)).limit(1);
    return row!;
  }

  async function taskRow(taskId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, taskId));
    return row!;
  }

  async function gateDecision(runId: string) {
    const [step] = await db.select().from(workflowRunSteps)
      .where(and(eq(workflowRunSteps.runId, runId), eq(workflowRunSteps.stepKey, "approval")))
      .orderBy(desc(workflowRunSteps.attempt)).limit(1);
    const [decision] = step?.decisionId ? await db.select().from(decisions).where(eq(decisions.id, step.decisionId)) : [];
    return { step, decision };
  }

  async function runRow(runId: string) {
    const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    return row!;
  }

  function userActor(companyId: string, userId: string, membershipRole: string) {
    return { type: "board" as const, userId, companyIds: [companyId], source: "session" as const,
      memberships: [{ companyId, membershipRole, status: "active" }] };
  }

  it("opens a decision with one option per outcome and waits for a person", async () => {
    const f = await fixture();
    await finishResearchAsAgent(f);

    const { step, decision } = await gateDecision(f.runId);

    expect(step).toMatchObject({ status: "awaiting_approval", attempt: 1 });
    expect(decision!.options.map((option) => option.id)).toEqual(["approved", "changes_requested", "rejected"]);
    expect(decision!.originAgentId).toBe(f.researcher);
    expect(await runRow(f.runId)).toMatchObject({ status: "waiting_human", currentStepKey: "approval" });
  });

  it("accepts the declared decider and management, and refuses anyone else", async () => {
    const f = await fixture();
    await finishResearchAsAgent(f);
    const { decision } = await gateDecision(f.runId);
    const decide = (userId: string, role: string, optionId: string, comment?: string) => decisionsSvc().decide({
      id: decision!.id, optionId, decidedByUserId: userId, userActor: userActor(f.companyId, userId, role),
      inputValues: comment ? { comment } : {},
    });

    await expect(decide("intern-user", "viewer", "rejected", "No")).rejects.toMatchObject({ status: 403 });
    await expect(decide("editor-user", "operator", "rejected", "Not on brand")).resolves.toMatchObject({ status: "decided" });
  });

  it("requires a comment to send work back or reject, but not to approve", async () => {
    const f = await fixture();
    await finishResearchAsAgent(f);
    const { decision } = await gateDecision(f.runId);

    await expect(decisionsSvc().decide({ id: decision!.id, optionId: "changes_requested", decidedByUserId: "local-implicit-board",
      userActor: board })).rejects.toMatchObject({ status: 422 });
    await expect(decisionsSvc().decide({ id: decision!.id, optionId: "approved", decidedByUserId: "local-implicit-board",
      userActor: board })).resolves.toMatchObject({ status: "decided" });
  });

  it("follows the approved outcome to the next agent step", async () => {
    const f = await fixture();
    await finishResearchAsAgent(f);
    const { decision } = await gateDecision(f.runId);

    await decisionsSvc().decide({ id: decision!.id, optionId: "approved", decidedByUserId: "local-implicit-board", userActor: board });

    expect(await runRow(f.runId)).toMatchObject({ status: "running", currentStepKey: "publish" });
    const { step } = await gateDecision(f.runId);
    expect(step).toMatchObject({ status: "completed", outcome: "approved" });
    const [task] = await db.select().from(issues).where(eq(issues.id, f.taskId));
    expect(task!.assigneeAgentId).toBe(f.publisher);
  });

  it("sends the work back with the comment and ends the run on rejection", async () => {
    const f = await fixture();
    await finishResearchAsAgent(f);
    const first = await gateDecision(f.runId);

    await decisionsSvc().decide({ id: first.decision!.id, optionId: "changes_requested", decidedByUserId: "local-implicit-board",
      userActor: board, inputValues: { comment: "Add a second source" } });
    await deliverHandoffs();

    expect(await runRow(f.runId)).toMatchObject({ status: "running", currentStepKey: "research" });
    const [handoff] = await db.select().from(caseHandoffs).where(eq(caseHandoffs.caseId, f.caseId))
      .orderBy(desc(caseHandoffs.version)).limit(1);
    expect(handoff).toMatchObject({ phase: "research", toAgentId: f.researcher });
    expect(handoff!.instructions).toContain("Add a second source");

    await finishResearchAsAgent(f);
    const second = await gateDecision(f.runId);
    expect(second.step).toMatchObject({ attempt: 2, status: "awaiting_approval" });
    await decisionsSvc().decide({ id: second.decision!.id, optionId: "rejected", decidedByUserId: "local-implicit-board",
      userActor: board, inputValues: { comment: "Not this quarter" } });

    expect(await runRow(f.runId)).toMatchObject({ status: "completed" });
  });

  it("reopens a gate that expires without a declared timeout, and never decides it", async () => {
    const f = await fixture();
    await finishResearchAsAgent(f);
    const first = await gateDecision(f.runId);
    await db.update(decisions).set({ expiresAt: new Date(Date.now() - 1_000 * 3) }).where(eq(decisions.id, first.decision!.id));

    await decisionsSvc().sweepTtlExpiry(new Date());

    const reopened = await gateDecision(f.runId);
    expect(reopened.decision!.id).not.toBe(first.decision!.id);
    expect(reopened.decision!.status).toBe("open");
    expect(await runRow(f.runId)).toMatchObject({ status: "waiting_human", currentStepKey: "approval" });
  });

  it("escalates a gate whose declared timeout passes, and never decides it", async () => {
    const f = await fixture({ timeoutSec: 3_600 });
    await finishResearchAsAgent(f);
    const first = await gateDecision(f.runId);
    await db.update(decisions).set({ expiresAt: new Date(Date.now() - 1_000 * 3) }).where(eq(decisions.id, first.decision!.id));

    await decisionsSvc().sweepTtlExpiry(new Date());

    const after = await runRow(f.runId);
    expect(after.status).toBe("waiting_human");
    expect(after.statusReason).toMatch(/timed out/i);
    expect((await gateDecision(f.runId)).decision!.status).toBe("expired");
  });

  it("gives a human step to its person when the agent's run releases the task, and hands it on afterwards", async () => {
    const f = await fixture({ variant: "human" });
    const researcherRun = await finishResearchAsAgent(f);

    expect(await stepRow(f.runId, "review")).toMatchObject({ status: "ready", assigneeUserId: "editor-user", assigneeAgentId: f.researcher });
    await assignWorkflowHumanStepAfterRelease(db, researcherRun);

    expect(await taskRow(f.taskId)).toMatchObject({ assigneeUserId: "editor-user", assigneeAgentId: null });
    expect(await stepRow(f.runId, "review")).toMatchObject({ status: "running" });
    expect(await runRow(f.runId)).toMatchObject({ status: "waiting_human", currentStepKey: "review" });

    await request(appAs(userActor(f.companyId, "intern-user", "viewer"))).post(`/api/workflow-runs/${f.runId}/steps/review/complete`)
      .send({ outcome: "done" }).expect(403);
    await request(appAs(board)).post(`/api/workflow-runs/${f.runId}/steps/review/complete`)
      .send({ outcome: "done", summary: "Reads well" }).expect(200);
    await deliverHandoffs();

    expect(await taskRow(f.taskId)).toMatchObject({ assigneeUserId: null, assigneeAgentId: f.publisher });
    expect(await runRow(f.runId)).toMatchObject({ status: "running", currentStepKey: "publish" });
  });

  it("gives a human step straight to its person when no run holds the task", async () => {
    const f = await fixture({ variant: "gateThenHuman" });
    await finishResearchAsAgent(f);
    const { decision } = await gateDecision(f.runId);

    await decisionsSvc().decide({ id: decision!.id, optionId: "approved", decidedByUserId: "local-implicit-board", userActor: board });

    expect(await stepRow(f.runId, "review")).toMatchObject({ status: "running", assigneeUserId: "editor-user" });
    expect(await taskRow(f.taskId)).toMatchObject({ assigneeUserId: "editor-user", assigneeAgentId: null });
    expect(await runRow(f.runId)).toMatchObject({ status: "waiting_human", currentStepKey: "review" });
  });

  it("waits for answers on a form step and moves on once a person submits them", async () => {
    const f = await fixture({ variant: "form" });
    await finishResearchAsAgent(f);
    const submit = (actor: unknown, answers: Record<string, unknown>) => request(appAs(actor))
      .post(`/api/workflow-runs/${f.runId}/steps/brief/submit-form`).send({ answers });

    expect(await stepRow(f.runId, "brief")).toMatchObject({ status: "awaiting_input", assigneeUserId: "editor-user" });
    expect(await runRow(f.runId)).toMatchObject({ status: "waiting_human", currentStepKey: "brief" });

    const incomplete = await submit(board, { audience: "Founders" }).expect(422);
    await submit(userActor(f.companyId, "intern-user", "viewer"), { audience: "Founders", tone: "formal" }).expect(403);
    await submit(board, { audience: "Founders", tone: "formal" }).expect(200);
    await submit(board, { audience: "Founders", tone: "formal" }).expect(409);
    await deliverHandoffs();

    expect(incomplete.body.details).toMatchObject({ code: "invalid_answers", missingRequired: ["tone"] });
    const document = await documentService(db).getIssueDocumentByKey(f.taskId, "brief");
    expect(document!.body).toContain("Founders");
    expect(await stepRow(f.runId, "brief")).toMatchObject({ status: "completed", outcome: "submitted" });
    expect(await runRow(f.runId)).toMatchObject({ status: "running", currentStepKey: "publish" });
    expect(await taskRow(f.taskId)).toMatchObject({ assigneeAgentId: f.publisher });
  });

  it("waits for a person, once, when a form passes its timeout unanswered", async () => {
    const f = await fixture({ variant: "form", timeoutSec: 3_600 });
    await finishResearchAsAgent(f);
    expect((await stepRow(f.runId, "brief")).dueAt).not.toBeNull();
    await db.update(workflowRunSteps).set({ dueAt: new Date(Date.now() - 1_000) })
      .where(and(eq(workflowRunSteps.runId, f.runId), eq(workflowRunSteps.stepKey, "brief")));

    await recoverWorkflowRuns(db);
    await recoverWorkflowRuns(db);

    const after = await runRow(f.runId);
    expect(after.statusReason).toMatch(/timed out without answers/);
    const escalations = await db.select().from(workflowRunEvents)
      .where(and(eq(workflowRunEvents.runId, f.runId), eq(workflowRunEvents.kind, "escalated")));
    expect(escalations).toHaveLength(1);
    expect(await documentService(db).getIssueDocumentByKey(f.taskId, "brief")).toBeNull();
  });

  it("counts a second answer to the same gate only once", async () => {
    const f = await fixture();
    await finishResearchAsAgent(f);
    const { decision } = await gateDecision(f.runId);
    const answer = () => decisionsSvc().decide({ id: decision!.id, optionId: "rejected", decidedByUserId: "local-implicit-board",
      userActor: board, inputValues: { comment: "No" } });

    await answer();
    await answer();

    const completed = await db.select().from(workflowRunEvents)
      .where(and(eq(workflowRunEvents.runId, f.runId), eq(workflowRunEvents.kind, "gate_decided")));
    expect(completed).toHaveLength(1);
  });
});
