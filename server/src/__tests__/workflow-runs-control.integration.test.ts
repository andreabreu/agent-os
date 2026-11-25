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
  issueRecoveryActions,
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
import { recoverWorkflowRuns } from "../services/workflow-run-control.js";
import { caseHandoffService } from "../services/case-handoffs.js";
import { caseHandoffDeliveryService } from "../services/case-handoff-delivery.js";
import { documentService } from "../services/documents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { workflowService } from "../services/workflows.js";
import { workflowVersionService } from "../services/workflow-versions.js";
import { decisionService } from "../services/decisions.js";

const board = { type: "board" as const, source: "local_implicit" as const };

describe("workflow run control", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("workflow-runs-control-");
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
    await db.delete(issueRecoveryActions);
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

  async function fixture(options: { timeoutSec?: number; variant?: "gate" | "human" | "gateThenHuman" } = {}) {
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

  it("cancels a run and its open gate for the responsible person or management, keeping the task", async () => {
    const f = await fixture();
    await finishResearchAsAgent(f);
    const { decision } = await gateDecision(f.runId);
    const researcher = { type: "agent" as const, agentId: f.researcher, companyId: f.companyId, source: "agent_key" as const };

    await request(appAs(userActor(f.companyId, "intern-user", "viewer"))).post(`/api/workflow-runs/${f.runId}/cancel`).send({}).expect(403);
    await request(appAs(researcher)).post(`/api/workflow-runs/${f.runId}/cancel`).send({}).expect(403);
    await request(appAs(userActor(f.companyId, "owner-user", "owner"))).post(`/api/workflow-runs/${f.runId}/cancel`)
      .send({ reason: "Launch postponed" }).expect(200);

    expect(await runRow(f.runId)).toMatchObject({ status: "cancelled", statusReason: "Launch postponed" });
    const [closed] = await db.select().from(decisions).where(eq(decisions.id, decision!.id));
    expect(closed!.status).toBe("cancelled");
    expect(await taskRow(f.taskId)).toMatchObject({ id: f.taskId });
    expect((await stepRow(f.runId, "approval")).status).toBe("cancelled");
  });

  it("pauses the run while its company is paused for budget, refuses to advance it, and restores it after", async () => {
    const f = await fixture();
    await db.update(companies).set({ status: "paused", pauseReason: "budget", pausedAt: new Date() }).where(eq(companies.id, f.companyId));

    await recoverWorkflowRuns(db);

    expect(await runRow(f.runId)).toMatchObject({ status: "paused" });
    await request(appAs(board)).post(`/api/workflow-runs/${f.runId}/steps/research/complete`).send({ outcome: "done" }).expect(409);

    await db.update(companies).set({ status: "active", pauseReason: null, pausedAt: null }).where(eq(companies.id, f.companyId));
    await recoverWorkflowRuns(db);

    expect(await runRow(f.runId)).toMatchObject({ status: "running", statusReason: null, currentStepKey: "research" });
  });

  it("recovers a gate decision whose run was never told, without deciding for anyone", async () => {
    const f = await fixture();
    await finishResearchAsAgent(f);
    const { decision } = await gateDecision(f.runId);
    await db.update(decisions).set({ status: "decided", chosenOptionId: "approved", decidedByUserId: "editor-user", decidedAt: new Date() })
      .where(eq(decisions.id, decision!.id));

    await recoverWorkflowRuns(db);

    const after = await runRow(f.runId);
    expect(after.status).toBe("waiting_human");
    expect(after.statusReason).toMatch(/needs a person to resume/);
  });

  it("resumes a run whose gate timed out by opening a new decision", async () => {
    const f = await fixture({ timeoutSec: 3_600 });
    await finishResearchAsAgent(f);
    const first = await gateDecision(f.runId);
    await db.update(decisions).set({ expiresAt: new Date(Date.now() - 3_000) }).where(eq(decisions.id, first.decision!.id));
    await decisionsSvc().sweepTtlExpiry(new Date());

    await request(appAs(userActor(f.companyId, "intern-user", "viewer"))).post(`/api/workflow-runs/${f.runId}/resume`).send({}).expect(403);
    await request(appAs(board)).post(`/api/workflow-runs/${f.runId}/resume`).send({}).expect(200);

    const reopened = await gateDecision(f.runId);
    expect(reopened.decision!.id).not.toBe(first.decision!.id);
    expect(reopened.decision!.status).toBe("open");
    expect(await runRow(f.runId)).toMatchObject({ status: "waiting_human", currentStepKey: "approval" });
  });

  it("waits for a person when the platform gives up on the agent's work, and resumes after", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.taskId));
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.taskId, kind: "run_recovery",
      status: "active", ownerType: "board", cause: "native_session_retry_exhausted", fingerprint: `stall:${f.taskId}`,
      nextAction: "Retry or reassign" });

    await recoverWorkflowRuns(db);

    const stuck = await runRow(f.runId);
    expect(stuck.status).toBe("waiting_human");
    expect(stuck.statusReason).toMatch(/native_session_retry_exhausted/);

    await recoverWorkflowRuns(db);
    const escalations = await db.select().from(workflowRunEvents)
      .where(and(eq(workflowRunEvents.runId, f.runId), eq(workflowRunEvents.kind, "escalated")));
    expect(escalations).toHaveLength(1);

    await request(appAs(board)).post(`/api/workflow-runs/${f.runId}/resume`).send({}).expect(200);
    expect(await runRow(f.runId)).toMatchObject({ status: "running", currentStepKey: "research" });
  });

  it("keeps running while the task is blocked only by a dependency", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.taskId));

    await recoverWorkflowRuns(db);

    expect(await runRow(f.runId)).toMatchObject({ status: "running" });
  });

  it("waits for a person when the current step's agent was terminated", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.researcher));

    await recoverWorkflowRuns(db);

    const stuck = await runRow(f.runId);
    expect(stuck.status).toBe("waiting_human");
    expect(stuck.statusReason).toMatch(/no longer active/);
  });

  it("refuses to resume a run that is not waiting", async () => {
    const f = await fixture();

    await request(appAs(board)).post(`/api/workflow-runs/${f.runId}/resume`).send({}).expect(409);
  });
});
