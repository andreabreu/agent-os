import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
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
  createDb,
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
import { caseHandoffService } from "../services/case-handoffs.js";
import { caseHandoffDeliveryService } from "../services/case-handoff-delivery.js";
import { documentService } from "../services/documents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { workflowService } from "../services/workflows.js";
import { workflowVersionService } from "../services/workflow-versions.js";
import { workflowRunService } from "../services/workflow-runs.js";
import { runnerApiCatalog } from "../services/native-runtime/runner-api-catalog.js";

const board = { type: "board" as const, source: "local_implicit" as const };

describe("workflow runs with agent steps", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("workflow-runs-advance-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(workflowRunEvents);
    await db.delete(workflowRunSteps);
    await db.delete(workflowRuns);
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

  async function enableFlags(enableWorkflowVersions = true) {
    await instanceSettingsService(db).updateExperimental({ enableCases: true, enableWorkflowVersions });
  }

  async function fixture() {
    const companyId = randomUUID(), triage = randomUUID(), researcher = randomUUID(), writer = randomUUID(), editor = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Studio", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: triage, companyId, name: "Triage", role: "ceo", status: "active", adapterType: "process" },
      { id: researcher, companyId, name: "Researcher", role: "engineer", status: "active", adapterType: "process", reportsTo: triage },
      { id: writer, companyId, name: "Writer", role: "engineer", status: "active", adapterType: "process", reportsTo: triage },
      { id: editor, companyId, name: "Editor", role: "engineer", status: "active", adapterType: "process", reportsTo: triage },
    ]);
    const kickoff = await caseHandoffService(db).handoff(companyId, board, {
      idempotencyKey: randomUUID(),
      case: { create: { caseType: "content", title: "Launch post", summary: "Announce the launch" } },
      toAgentId: triage, phase: "intake", instructions: "Hold until the workflow starts",
      workflow_document_text: "# Publishing\nResearch, write, edit.",
    });
    await deliverHandoffs();
    const workflow = await workflowService(db).write(companyId, board, { name: "Publishing", prompt: "Research, write and edit carefully." });
    const spec = {
      specVersion: 1,
      start: "research",
      steps: [
        { key: "research", name: "Research", type: "agent_task", owner: { kind: "agent", ref: researcher },
          outputs: ["notes"], outcomes: [{ key: "done", to: "write" }] },
        { key: "write", name: "Write", type: "agent_task", owner: { kind: "agent", ref: writer },
          inputs: ["research"], outputs: ["draft"], limits: { maxAttempts: 3 }, outcomes: [{ key: "done", to: "edit" }] },
        { key: "edit", name: "Edit", type: "agent_task", owner: { kind: "agent", ref: editor },
          inputs: ["write"], limits: { maxReviewRounds: 2 },
          outcomes: [{ key: "approved", to: "end" }, { key: "changes_requested", to: "write" }] },
      ],
    };
    const version = await workflowVersionService(db).publish(companyId, workflow.id, board, { spec });
    return { companyId, triage, researcher, writer, editor, caseId: kickoff.caseId, taskId: kickoff.taskId,
      workflowId: workflow.id, version, spec };
  }

  function appFor(actor: unknown = board) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { actor?: unknown }).actor = actor; next(); });
    app.use("/api", workflowRunRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function saveDocument(taskId: string, key: string, body: string) {
    return documentService(db).upsertIssueDocument({ issueId: taskId, key, title: key, format: "markdown", body,
      baseRevisionId: (await documentService(db).getIssueDocumentByKey(taskId, key))?.latestRevisionId ?? null,
      createdByUserId: "board-user", createdByAgentId: null, createdByRunId: null, lockedDocumentStrategy: "conflict" });
  }

  async function task(taskId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, taskId));
    return row!;
  }

  async function start(f: Awaited<ReturnType<typeof fixture>>) {
    const run = (await request(appFor()).post(`/api/companies/${f.companyId}/workflow-runs`)
      .send({ workflowId: f.workflowId, caseId: f.caseId }).expect(201)).body;
    await deliverHandoffs();
    return run;
  }

  async function runningAgentActor(f: { companyId: string; taskId: string }, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId, status: "running", runtimeMode: "legacy",
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: f.taskId } });
    await db.update(issues).set({ status: "in_progress", executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, f.taskId));
    return { type: "agent" as const, agentId, companyId: f.companyId, runId, source: "agent_jwt" as const };
  }

  it("starts a run pinned to the latest version and hands the case to the first step's agent", async () => {
    await enableFlags();
    const f = await fixture();

    const run = await start(f);

    expect(run).toMatchObject({ status: "running", currentStepKey: "research", versionId: f.version.id, caseId: f.caseId });
    expect((await task(f.taskId)).assigneeAgentId).toBe(f.researcher);
    const [step] = await db.select().from(workflowRunSteps).where(eq(workflowRunSteps.runId, run.id));
    expect(step).toMatchObject({ stepKey: "research", attempt: 1, status: "running", assigneeAgentId: f.researcher });
    const started = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, run.id), eq(activityLog.action, "workflow_run.started")));
    expect(started).toHaveLength(1);
  });

  it("allows one active run per case and a new run after the previous one ends", async () => {
    await enableFlags();
    const f = await fixture();
    const first = await start(f);

    await request(appFor()).post(`/api/companies/${f.companyId}/workflow-runs`)
      .send({ workflowId: f.workflowId, caseId: f.caseId }).expect(409);
    await db.update(workflowRuns).set({ status: "completed" }).where(eq(workflowRuns.id, first.id));
    const second = await start(f);

    expect(second.id).not.toBe(first.id);
  });

  it("refuses to complete a step until its declared outputs exist", async () => {
    await enableFlags();
    const f = await fixture();
    const run = await start(f);

    const refused = await request(appFor()).post(`/api/workflow-runs/${run.id}/steps/research/complete`)
      .send({ outcome: "done" }).expect(422);

    expect(refused.body.details).toMatchObject({ code: "missing_outputs", missingOutputs: ["notes"] });
    expect((await task(f.taskId)).assigneeAgentId).toBe(f.researcher);
  });

  it("refuses an outcome the step does not declare and a step that is not current", async () => {
    await enableFlags();
    const f = await fixture();
    const run = await start(f);
    await saveDocument(f.taskId, "notes", "Findings");

    const badOutcome = await request(appFor()).post(`/api/workflow-runs/${run.id}/steps/research/complete`)
      .send({ outcome: "approved" }).expect(422);
    await request(appFor()).post(`/api/workflow-runs/${run.id}/steps/write/complete`).send({ outcome: "done" }).expect(409);

    expect(badOutcome.body.details).toMatchObject({ code: "invalid_outcome", allowedOutcomes: ["done"] });
  });

  it("hands the case to the next step's agent with references to its inputs", async () => {
    await enableFlags();
    const f = await fixture();
    const run = await start(f);
    await saveDocument(f.taskId, "notes", "Findings");

    await request(appFor()).post(`/api/workflow-runs/${run.id}/steps/research/complete`)
      .send({ outcome: "done", summary: "Three sources confirmed" }).expect(200);

    expect((await task(f.taskId)).assigneeAgentId).toBe(f.writer);
    const [handoff] = await db.select().from(caseHandoffs)
      .where(and(eq(caseHandoffs.caseId, f.caseId), eq(caseHandoffs.phase, "write")));
    expect(handoff!.instructions).toContain("notes");
    expect(handoff!.instructions).toContain("draft");
    expect(handoff!.instructions).toContain("Three sources confirmed");
    const steps = await db.select().from(workflowRunSteps).where(eq(workflowRunSteps.runId, run.id));
    expect(steps.find((step) => step.stepKey === "research")).toMatchObject({ status: "completed", outcome: "done" });
    expect(steps.find((step) => step.stepKey === "research")!.outputRevisionIds).toHaveProperty("notes");
    expect(steps.find((step) => step.stepKey === "write")).toMatchObject({ status: "running", attempt: 1 });
  });

  it("lets the step's agent complete it from its run, leaving the transfer to the handoff release", async () => {
    await enableFlags();
    const f = await fixture();
    const run = await start(f);
    await saveDocument(f.taskId, "notes", "Findings");
    const researcher = await runningAgentActor(f, f.researcher);
    const writer = { ...researcher, agentId: f.writer };

    await request(appFor(writer)).post(`/api/workflow-runs/${run.id}/steps/research/complete`).send({ outcome: "done" }).expect(403);
    await request(appFor(researcher)).post(`/api/workflow-runs/${run.id}/steps/research/complete`).send({ outcome: "done" }).expect(200);

    const [handoff] = await db.select().from(caseHandoffs)
      .where(and(eq(caseHandoffs.caseId, f.caseId), eq(caseHandoffs.phase, "write")));
    expect(handoff).toMatchObject({ toAgentId: f.writer, state: "awaiting_release" });
  });

  it("returns to an earlier step for changes and completes the run at the end", async () => {
    await enableFlags();
    const f = await fixture();
    const run = await start(f);
    const complete = async (step: string, outcome: string) => {
      const response = await request(appFor()).post(`/api/workflow-runs/${run.id}/steps/${step}/complete`).send({ outcome }).expect(200);
      await deliverHandoffs();
      return response;
    };
    await saveDocument(f.taskId, "notes", "Findings");
    await complete("research", "done");
    await saveDocument(f.taskId, "draft", "First draft");
    await complete("write", "done");
    await complete("edit", "changes_requested");
    await saveDocument(f.taskId, "draft", "Second draft");
    await complete("write", "done");
    const finished = (await complete("edit", "approved")).body;

    expect(finished).toMatchObject({ status: "completed", currentStepKey: null });
    const writes = (await db.select().from(workflowRunSteps).where(and(eq(workflowRunSteps.runId, run.id),
      eq(workflowRunSteps.stepKey, "write")))).map((step) => step.attempt).sort();
    expect(writes).toEqual([1, 2]);
  });

  it("escalates to a person instead of looping past the review rounds", async () => {
    await enableFlags();
    const f = await fixture();
    const run = await start(f);
    const complete = async (step: string, outcome: string) => {
      const response = await request(appFor()).post(`/api/workflow-runs/${run.id}/steps/${step}/complete`).send({ outcome }).expect(200);
      await deliverHandoffs();
      return response;
    };
    await saveDocument(f.taskId, "notes", "Findings");
    await complete("research", "done");
    for (let round = 1; round <= 2; round += 1) {
      await saveDocument(f.taskId, "draft", `Draft ${round}`);
      await complete("write", "done");
      await complete("edit", "changes_requested");
    }

    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    expect(stored).toMatchObject({ status: "waiting_human" });
    expect(stored!.statusReason).toMatch(/review rounds/);
  });

  it("is idempotent when the same completion arrives twice", async () => {
    await enableFlags();
    const f = await fixture();
    const run = await start(f);
    await saveDocument(f.taskId, "notes", "Findings");
    const send = () => request(appFor()).post(`/api/workflow-runs/${run.id}/steps/research/complete`)
      .send({ outcome: "done", idempotencyKey: "complete-research-once" });

    await send().expect(200);
    await send().expect(200);

    expect(await db.select().from(workflowRunSteps).where(eq(workflowRunSteps.runId, run.id))).toHaveLength(2);
    expect(await db.select().from(caseHandoffs).where(and(eq(caseHandoffs.caseId, f.caseId), eq(caseHandoffs.phase, "write"))))
      .toHaveLength(1);
  });

  it("keeps the run on the version it started with", async () => {
    await enableFlags();
    const f = await fixture();
    const run = await start(f);
    await workflowVersionService(db).publish(f.companyId, f.workflowId, board, { spec: { ...f.spec, steps: f.spec.steps.map((step) => ({ ...step, name: `${step.name} v2` })) } });
    await saveDocument(f.taskId, "notes", "Findings");

    const advanced = (await request(appFor()).post(`/api/workflow-runs/${run.id}/steps/research/complete`)
      .send({ outcome: "done" }).expect(200)).body;

    expect(advanced).toMatchObject({ versionId: f.version.id, currentStepKey: "write" });
  });

  it("refuses a free handoff on a case with an active run", async () => {
    await enableFlags();
    const f = await fixture();
    await start(f);
    const [caseRow] = await db.select().from(cases).where(eq(cases.id, f.caseId));

    await expect(caseHandoffService(db).handoff(f.companyId, board, {
      idempotencyKey: randomUUID(), case: { id: f.caseId }, expectedHandoffVersion: caseRow!.handoffVersion,
      toAgentId: f.editor, phase: "skip-ahead", instructions: "Skip the workflow",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("reads and lists runs within the company only, and refuses everything while the flag is off", async () => {
    await enableFlags();
    const f = await fixture();
    const other = await fixture();
    const run = await start(f);
    const outsider = { type: "agent" as const, agentId: other.triage, companyId: other.companyId, source: "agent_key" as const };

    const read = await request(appFor()).get(`/api/workflow-runs/${run.id}`).expect(200);
    const list = await request(appFor()).get(`/api/companies/${f.companyId}/workflow-runs`).expect(200);
    await request(appFor(outsider)).get(`/api/workflow-runs/${run.id}`).expect(404);
    await enableFlags(false);
    await request(appFor()).get(`/api/workflow-runs/${run.id}`).expect(403);

    expect(read.body.steps).toEqual([expect.objectContaining({ stepKey: "research" })]);
    expect(list.body.map((row: { id: string }) => row.id)).toEqual([run.id]);
  });

  it("refuses an unknown state version with a permanent code", async () => {
    await enableFlags();
    const f = await fixture();
    const run = await start(f);
    await db.update(workflowRuns).set({ stateVersion: 99 }).where(eq(workflowRuns.id, run.id));

    const refused = await request(appFor()).get(`/api/workflow-runs/${run.id}`).expect(409);

    expect(refused.body.details?.code).toBe("workflow_run_state_unsupported");
  });

  it("refuses a version whose steps this phase cannot run", async () => {
    await enableFlags();
    const f = await fixture();
    const humanFirst = { ...f.spec, start: "brief", steps: [
      { key: "brief", name: "Brief", type: "human_task", owner: { kind: "user", ref: "board-user" },
        outcomes: [{ key: "done", to: "research" }] },
      ...f.spec.steps,
    ] };
    await workflowVersionService(db).publish(f.companyId, f.workflowId, board, { spec: humanFirst });

    const refused = await request(appFor()).post(`/api/companies/${f.companyId}/workflow-runs`)
      .send({ workflowId: f.workflowId, caseId: f.caseId }).expect(422);

    expect(refused.body.details?.code).toBe("workflow_not_executable");
  });

  it("refuses to run a version saved before the external-effect rule existed", async () => {
    await enableFlags();
    const f = await fixture();
    const unsafe = { ...f.spec, steps: f.spec.steps.map((step) => step.key === "write" ? { ...step, externalEffect: true } : step) };
    const [legacy] = await db.insert(workflowVersions).values({ companyId: f.companyId, workflowId: f.workflowId, version: 2,
      spec: unsafe, specHash: "legacy-version-before-the-rule" }).returning();
    await db.update(workflows).set({ latestVersionId: legacy!.id, latestVersionNumber: 2 }).where(eq(workflows.id, f.workflowId));

    const refused = await request(appFor()).post(`/api/companies/${f.companyId}/workflow-runs`)
      .send({ workflowId: f.workflowId, caseId: f.caseId }).expect(422);

    expect(refused.body.details).toMatchObject({ code: "workflow_not_executable" });
    expect(refused.body.details.issues).toEqual([expect.objectContaining({ code: "external_effect_without_gate", stepKey: "write" })]);
    expect(await db.select().from(workflowRuns)).toHaveLength(0);
  });

  it("lets agents find the run routes through the generic API tools", () => {
    const operations = runnerApiCatalog().map((operation) => `${operation.method.toUpperCase()} ${operation.path}`);

    expect(operations).toEqual(expect.arrayContaining([
      "POST /api/companies/{companyId}/workflow-runs",
      "GET /api/workflow-runs/{id}",
      "POST /api/workflow-runs/{id}/steps/{stepKey}/complete",
    ]));
  });
});
