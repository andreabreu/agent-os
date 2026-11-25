import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companies, companyMemberships, createDb, heartbeatRuns, issueExecutionDecisions, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueStageReassignRoutes } from "../routes/issue-stage-reassign.js";
import { instanceSettingsService } from "../services/instance-settings.js";

const board = { type: "board" as const, source: "local_implicit" as const };

describe("reassigning a pending execution stage", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("issue-stage-reassign-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueExecutionDecisions);
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  async function enableFlags(enableWorkflowVersions = true) {
    await instanceSettingsService(db).updateExperimental({ enableCases: true, enableWorkflowVersions });
  }

  async function fixture(options: { pending?: boolean } = {}) {
    const companyId = randomUUID(), implementer = randomUUID(), reviewer = randomUUID(), backupReviewer = randomUUID(), outsider = randomUUID();
    const issueId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Studio", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values([implementer, reviewer, backupReviewer, outsider].map((id, index) => ({
      id, companyId, name: `Agent ${index}`, role: "engineer", status: "active", adapterType: "process",
    })));
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "human-reviewer", status: "active" });
    const executionPolicy = {
      mode: "normal", commentRequired: true,
      stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [
        { id: randomUUID(), type: "agent", agentId: reviewer, userId: null },
        { id: randomUUID(), type: "agent", agentId: backupReviewer, userId: null },
        { id: randomUUID(), type: "user", agentId: null, userId: "human-reviewer" },
      ] }],
    };
    const executionState = options.pending === false ? null : {
      status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewer, userId: null },
      returnAssignee: { type: "agent", agentId: implementer, userId: null },
      reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      changesRequestedCount: 2,
    };
    await db.insert(issues).values({ id: issueId, companyId, title: "Draft the launch post", status: "in_review",
      assigneeAgentId: reviewer, executionPolicy, executionState });
    return { companyId, implementer, reviewer, backupReviewer, outsider, issueId, stageId };
  }

  function appFor(actor: unknown, heartbeat = { wakeup: vi.fn(async () => ({ id: randomUUID() })) }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { actor?: unknown }).actor = actor; next(); });
    app.use("/api", issueStageReassignRoutes(db, { heartbeat }));
    app.use(errorHandler);
    return { app, heartbeat };
  }

  function agentActor(f: { companyId: string }, agentId: string) {
    return { type: "agent" as const, agentId, companyId: f.companyId, source: "agent_key" as const };
  }

  async function issueRow(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  it("lets the active reviewer hand the stage to a configured person", async () => {
    await enableFlags();
    const f = await fixture();
    const { app } = appFor(agentActor(f, f.reviewer));

    await request(app).post(`/api/issues/${f.issueId}/execution-policy/reassign`)
      .send({ toParticipant: { type: "user", userId: "human-reviewer" }, comment: "A person must sign off on launch copy." })
      .expect(200);

    const row = await issueRow(f.issueId);
    expect(row).toMatchObject({ assigneeAgentId: null, assigneeUserId: "human-reviewer", status: "in_review" });
    expect(row.executionState).toMatchObject({
      status: "pending", currentStageId: f.stageId, changesRequestedCount: 2, lastDecisionOutcome: "reassigned",
      currentParticipant: { type: "user", userId: "human-reviewer" },
      lastReassignment: { fromParticipant: { type: "agent", agentId: f.reviewer },
        toParticipant: { type: "user", userId: "human-reviewer" }, comment: "A person must sign off on launch copy." },
    });
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId));
    expect(decisions).toEqual([expect.objectContaining({ outcome: "reassigned", stageId: f.stageId })]);
    const logged = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, f.issueId), eq(activityLog.action, "issue.execution_policy_reassigned")));
    expect(logged).toHaveLength(1);
  });

  it("lets a board user hand the stage to another agent and wakes that agent", async () => {
    await enableFlags();
    const f = await fixture();
    const { app, heartbeat } = appFor(board);

    await request(app).post(`/api/issues/${f.issueId}/execution-policy/reassign`)
      .send({ toParticipant: { type: "agent", agentId: f.backupReviewer }, comment: "Primary reviewer is out today." })
      .expect(200);

    expect((await issueRow(f.issueId)).assigneeAgentId).toBe(f.backupReviewer);
    expect(heartbeat.wakeup).toHaveBeenCalledWith(f.backupReviewer, expect.objectContaining({ reason: "execution_review_requested" }));
  });

  it("treats a reassignment to the current participant as a no-op", async () => {
    await enableFlags();
    const f = await fixture();
    const before = await issueRow(f.issueId);

    await request(appFor(board).app).post(`/api/issues/${f.issueId}/execution-policy/reassign`)
      .send({ toParticipant: { type: "agent", agentId: f.reviewer }, comment: "Keep it." }).expect(200);

    expect((await issueRow(f.issueId)).executionState).toEqual(before.executionState);
    expect(await db.select().from(issueExecutionDecisions)).toHaveLength(0);
  });

  it("refuses targets outside the stage, the executor under review, and a missing comment", async () => {
    await enableFlags();
    const f = await fixture();
    const { app } = appFor(board);
    const path = `/api/issues/${f.issueId}/execution-policy/reassign`;

    await request(app).post(path).send({ toParticipant: { type: "agent", agentId: f.outsider }, comment: "Try." }).expect(422);
    await request(app).post(path).send({ toParticipant: { type: "agent", agentId: f.implementer }, comment: "Try." }).expect(422);
    await request(app).post(path).send({ toParticipant: { type: "agent", agentId: f.backupReviewer } }).expect(422);

    expect((await issueRow(f.issueId)).assigneeAgentId).toBe(f.reviewer);
  });

  it("refuses when no stage is pending", async () => {
    await enableFlags();
    const f = await fixture({ pending: false });

    await request(appFor(board).app).post(`/api/issues/${f.issueId}/execution-policy/reassign`)
      .send({ toParticipant: { type: "agent", agentId: f.backupReviewer }, comment: "Try." }).expect(422);
  });

  it("refuses actors who are neither the active participant nor a board user", async () => {
    await enableFlags();
    const f = await fixture();
    const other = await fixture();

    await request(appFor(agentActor(f, f.backupReviewer)).app).post(`/api/issues/${f.issueId}/execution-policy/reassign`)
      .send({ toParticipant: { type: "user", userId: "human-reviewer" }, comment: "Mine now." }).expect(403);
    await request(appFor(agentActor(other, other.reviewer)).app).post(`/api/issues/${f.issueId}/execution-policy/reassign`)
      .send({ toParticipant: { type: "user", userId: "human-reviewer" }, comment: "Mine now." }).expect(404);
  });

  it("refuses while a run is executing the task", async () => {
    await enableFlags();
    const f = await fixture();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.reviewer, status: "running",
      runtimeMode: "legacy", invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));

    const refused = await request(appFor(board).app).post(`/api/issues/${f.issueId}/execution-policy/reassign`)
      .send({ toParticipant: { type: "user", userId: "human-reviewer" }, comment: "Hand it over." }).expect(409);

    expect(refused.body.details?.code ?? refused.body.code).toBe("execution_stage_participant_running");
    expect((await issueRow(f.issueId)).assigneeAgentId).toBe(f.reviewer);
  });

  it("refuses the route while the flag is off", async () => {
    await enableFlags(false);
    const f = await fixture();

    await request(appFor(board).app).post(`/api/issues/${f.issueId}/execution-policy/reassign`)
      .send({ toParticipant: { type: "user", userId: "human-reviewer" }, comment: "Hand it over." }).expect(403);
  });
});
