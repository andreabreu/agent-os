import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  issues,
  routineRevisions,
  routineRuns,
  routineTriggers,
  routineWorkflowTargets,
  routines,
  workflowVersions,
  workflows,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { routineWorkflowTargetRoutes } from "../routes/routine-workflow-target.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { routineService } from "../services/routines.js";
import { workflowService } from "../services/workflows.js";
import { workflowVersionService } from "../services/workflow-versions.js";
import { workflowRoutineTargetService } from "../services/workflow-routine-targets.js";

const board = { type: "board" as const, source: "local_implicit" as const };
const spec = {
  specVersion: 1,
  start: "draft",
  steps: [{ key: "draft", name: "Draft", type: "agent_task", owner: { kind: "agent", ref: "writer" },
    outcomes: [{ key: "done", to: "end" }] }],
};

describe("routines that start a workflow", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    temporary = await startEmbeddedPostgresTestDatabase("routine-workflow-target-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { vi.unstubAllEnvs(); await temporary?.cleanup(); });
  afterEach(async () => {
    await db.delete(activityLog);
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(routineWorkflowTargets);
    await db.delete(routineRuns);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(routineTriggers);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(routineRevisions);
    await db.delete(routines);
    await db.delete(workflowVersions);
    await db.delete(workflows);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function enableFlags(enableWorkflowVersions = true) {
    await instanceSettingsService(db).updateExperimental({ enableCases: true, enableWorkflowVersions });
  }

  async function fixture(options: { publish?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Studio", issuePrefix: `S${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: randomUUID(), requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "engineer", status: "active",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const svc = routineService(db, { heartbeat: { wakeup: async () => null } });
    const routine = await svc.create(companyId, {
      projectId: null, goalId: null, parentIssueId: null, title: "Weekly post", description: "Write the weekly post",
      assigneeAgentId: agentId, priority: "medium", status: "active", concurrencyPolicy: "always_enqueue",
      catchUpPolicy: "skip_missed", variables: [],
    }, {});
    const workflow = await workflowService(db).write(companyId, board, { name: "Publishing", prompt: "Publish carefully." });
    const version = options.publish === false ? null
      : await workflowVersionService(db).publish(companyId, workflow.id, board, { spec });
    return { companyId, agentId, svc, routine, workflowId: workflow.id, version };
  }

  function appFor(actor: unknown = board) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { actor?: unknown }).actor = actor; next(); });
    app.use("/api", routineWorkflowTargetRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function runOf(runId: string) {
    const [run] = await db.select().from(routineRuns).where(eq(routineRuns.id, runId));
    return run!;
  }

  async function issueOf(issueId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return issue!;
  }

  it("sets, reads and removes a routine's workflow target, logging each change", async () => {
    await enableFlags();
    const f = await fixture();
    const app = appFor();

    await request(app).put(`/api/routines/${f.routine.id}/workflow-target`).send({ workflowId: f.workflowId }).expect(200);
    const read = await request(app).get(`/api/routines/${f.routine.id}/workflow-target`).expect(200);
    await request(app).delete(`/api/routines/${f.routine.id}/workflow-target`).expect(204);
    await request(app).get(`/api/routines/${f.routine.id}/workflow-target`).expect(404);

    expect(read.body).toMatchObject({ routineId: f.routine.id, workflowId: f.workflowId });
    const actions = (await db.select({ action: activityLog.action }).from(activityLog)
      .where(eq(activityLog.entityId, f.routine.id))).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["routine.workflow_target_set", "routine.workflow_target_removed"]));
  });

  it("refuses a workflow from another company and an archived workflow as targets", async () => {
    await enableFlags();
    const f = await fixture();
    const other = await fixture();
    await workflowVersionService(db).archive(f.companyId, f.workflowId, board);

    await request(appFor()).put(`/api/routines/${f.routine.id}/workflow-target`).send({ workflowId: other.workflowId }).expect(404);
    await request(appFor()).put(`/api/routines/${f.routine.id}/workflow-target`).send({ workflowId: f.workflowId }).expect(409);
    const outsider = { type: "agent" as const, agentId: other.agentId, companyId: other.companyId, source: "agent_key" as const };
    await request(appFor(outsider)).get(`/api/routines/${f.routine.id}/workflow-target`).expect(404);

    expect(await db.select().from(routineWorkflowTargets)).toHaveLength(0);
  });

  it("starts the workflow on a manual or API run and records the version used", async () => {
    await enableFlags();
    const f = await fixture();
    await workflowRoutineTargetService(db).setTarget(f.companyId, f.routine.id, f.workflowId, board);

    const manual = await f.svc.runRoutine(f.routine.id, { source: "manual" }, { userId: "board-user" });
    const api = await f.svc.runRoutine(f.routine.id, { source: "api", idempotencyKey: "weekly-1" }, {});

    for (const run of [manual, api]) {
      const stored = await runOf(run.id);
      expect(stored).toMatchObject({ status: "issue_created" });
      expect(stored.triggerPayload).toMatchObject({ workflowId: f.workflowId, workflowVersionId: f.version!.id, workflowVersion: 1 });
      const issue = await issueOf(stored.linkedIssueId!);
      expect(issue.description).toContain("Write the weekly post");
      expect(issue.description).toContain("Publishing");
      expect(issue.description).toContain(f.version!.id);
    }
  });

  it("creates a single task for a repeated API delivery", async () => {
    await enableFlags();
    const f = await fixture();
    await workflowRoutineTargetService(db).setTarget(f.companyId, f.routine.id, f.workflowId, board);

    const first = await f.svc.runRoutine(f.routine.id, { source: "api", idempotencyKey: "same-delivery" }, {});
    const second = await f.svc.runRoutine(f.routine.id, { source: "api", idempotencyKey: "same-delivery" }, {});

    expect(second.id).toBe(first.id);
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(1);
  });

  it("starts the workflow from an unsigned webhook delivery", async () => {
    await enableFlags();
    const f = await fixture();
    await workflowRoutineTargetService(db).setTarget(f.companyId, f.routine.id, f.workflowId, board);
    const created = await f.svc.createTrigger(f.routine.id, { kind: "webhook", enabled: true, signingMode: "none",
      replayWindowSec: 300 }, { userId: "board-user" });

    const fired = await f.svc.firePublicTrigger(created.trigger.publicId!, { payload: { event: "post.requested" } });

    const stored = await runOf((fired as { id: string }).id);
    expect(stored.triggerPayload).toMatchObject({ event: "post.requested", workflowVersionId: f.version!.id });
  });

  it("starts the workflow from a scheduled trigger", async () => {
    await enableFlags();
    const f = await fixture();
    await workflowRoutineTargetService(db).setTarget(f.companyId, f.routine.id, f.workflowId, board);
    await f.svc.createTrigger(f.routine.id, { kind: "schedule", enabled: true, cronExpression: "* * * * *", timezone: "UTC" },
      { userId: "board-user" });

    await f.svc.tickScheduledTriggers(new Date(Date.now() + 5 * 60_000));

    const runs = await db.select().from(routineRuns).where(and(eq(routineRuns.routineId, f.routine.id), eq(routineRuns.source, "schedule")));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]!.triggerPayload).toMatchObject({ workflowVersionId: f.version!.id });
  });

  it("fails the run with a clear reason and no task when the workflow has no version or is archived", async () => {
    await enableFlags();
    const unpublished = await fixture({ publish: false });
    await workflowRoutineTargetService(db).setTarget(unpublished.companyId, unpublished.routine.id, unpublished.workflowId, board);
    const archived = await fixture();
    await workflowRoutineTargetService(db).setTarget(archived.companyId, archived.routine.id, archived.workflowId, board);
    await workflowVersionService(db).archive(archived.companyId, archived.workflowId, board);

    const noVersion = await unpublished.svc.runRoutine(unpublished.routine.id, { source: "manual" }, { userId: "board-user" });
    const wasArchived = await archived.svc.runRoutine(archived.routine.id, { source: "manual" }, { userId: "board-user" });

    expect(await runOf(noVersion.id)).toMatchObject({ status: "failed", linkedIssueId: null });
    expect((await runOf(noVersion.id)).failureReason).toMatch(/no published version/i);
    expect(await runOf(wasArchived.id)).toMatchObject({ status: "failed", linkedIssueId: null });
    expect((await runOf(wasArchived.id)).failureReason).toMatch(/archived/i);
    expect(await db.select().from(issues)).toHaveLength(0);
  });

  it("keeps the current behavior for routines without a target and while the flag is off", async () => {
    await enableFlags();
    const plain = await fixture();
    const flagged = await fixture();
    await workflowRoutineTargetService(db).setTarget(flagged.companyId, flagged.routine.id, flagged.workflowId, board);
    await enableFlags(false);

    const plainRun = await plain.svc.runRoutine(plain.routine.id, { source: "manual" }, { userId: "board-user" });
    const flaggedRun = await flagged.svc.runRoutine(flagged.routine.id, { source: "manual" }, { userId: "board-user" });

    for (const run of [plainRun, flaggedRun]) {
      const stored = await runOf(run.id);
      expect(stored.status).toBe("issue_created");
      expect(stored.triggerPayload ?? {}).not.toHaveProperty("workflowVersionId");
      expect((await issueOf(stored.linkedIssueId!)).description).toBe("Write the weekly post");
    }
    await request(appFor()).get(`/api/routines/${flagged.routine.id}/workflow-target`).expect(403);
  });
});
