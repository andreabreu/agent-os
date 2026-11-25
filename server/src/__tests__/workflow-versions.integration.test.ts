import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, workflowVersions, workflows } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { workflowRoutes } from "../routes/workflows.js";
import { workflowVersionRoutes } from "../routes/workflow-versions.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { workflowService } from "../services/workflows.js";
import { workflowVersionService } from "../services/workflow-versions.js";

const board = { type: "board" as const, source: "local_implicit" as const };

function specWith(stepName = "Research") {
  return {
    specVersion: 1,
    start: "research",
    steps: [
      { key: "research", name: stepName, type: "agent_task", owner: { kind: "agent", ref: "researcher" },
        outcomes: [{ key: "done", to: "approval" }] },
      { key: "approval", name: "Approval", type: "approval_gate", owner: { kind: "role", ref: "editor" },
        outcomes: [{ key: "approved", to: "end" }, { key: "changes_requested", to: "research" }],
        limits: { maxAttempts: 3, maxReviewRounds: 3 } },
    ],
  };
}

describe("workflow versions", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("workflow-versions-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(workflowVersions);
    await db.delete(workflows);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function enableFlags(enableWorkflowVersions = true) {
    await instanceSettingsService(db).updateExperimental({ enableCases: true, enableWorkflowVersions });
  }

  async function companyWithWorkflow() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Studio", issuePrefix: `S${companyId.slice(0, 6)}` });
    const workflow = await workflowService(db).write(companyId, board, { name: "Publishing", prompt: "Publish carefully." });
    return { companyId, workflowId: workflow.id };
  }

  function appFor(actor: unknown = board) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { actor?: unknown }).actor = actor; next(); });
    app.use("/api", workflowRoutes(db));
    app.use("/api", workflowVersionRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("numbers published versions sequentially and points the workflow at the latest", async () => {
    await enableFlags();
    const { workflowId } = await companyWithWorkflow();
    const app = appFor();

    const first = await request(app).post(`/api/workflows/${workflowId}/versions`).send({ spec: specWith() }).expect(201);
    const second = await request(app).post(`/api/workflows/${workflowId}/versions`).send({ spec: specWith("Deep research") }).expect(201);

    expect(first.body).toMatchObject({ workflowId, version: 1 });
    expect(second.body).toMatchObject({ workflowId, version: 2 });
    expect(first.body.specHash).toMatch(/^[a-f0-9]{64}$/);
    const [workflow] = await db.select().from(workflows).where(eq(workflows.id, workflowId));
    expect(workflow).toMatchObject({ latestVersionNumber: 2, latestVersionId: second.body.id, status: "active" });
    const published = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, workflowId), eq(activityLog.action, "workflow.version_published")));
    expect(published).toHaveLength(2);
  });

  it("gives concurrent publications distinct numbers without gaps", async () => {
    await enableFlags();
    const { companyId, workflowId } = await companyWithWorkflow();
    const service = workflowVersionService(db);

    const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
      service.publish(companyId, workflowId, board, { spec: specWith(`Research ${index}`) })));

    expect(results.map((row) => row.version).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("reads a version with its spec and lists versions without the spec", async () => {
    await enableFlags();
    const { workflowId } = await companyWithWorkflow();
    const app = appFor();
    await request(app).post(`/api/workflows/${workflowId}/versions`).send({ spec: specWith() }).expect(201);

    const read = await request(app).get(`/api/workflows/${workflowId}/versions/1`).expect(200);
    const list = await request(app).get(`/api/workflows/${workflowId}/versions`).expect(200);

    expect(read.body.spec).toMatchObject({ specVersion: 1, start: "research" });
    expect(read.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).not.toHaveProperty("spec");
  });

  it("offers no way to change or delete a published version", async () => {
    await enableFlags();
    const { workflowId } = await companyWithWorkflow();
    const app = appFor();
    await request(app).post(`/api/workflows/${workflowId}/versions`).send({ spec: specWith() }).expect(201);

    await request(app).patch(`/api/workflows/${workflowId}/versions/1`).send({ spec: specWith("Changed") }).expect(404);
    await request(app).put(`/api/workflows/${workflowId}/versions/1`).send({ spec: specWith("Changed") }).expect(404);
    await request(app).delete(`/api/workflows/${workflowId}/versions/1`).expect(404);

    const [version] = await db.select().from(workflowVersions).where(eq(workflowVersions.workflowId, workflowId));
    expect(version!.spec).toMatchObject({ steps: [{ name: "Research" }, { name: "Approval" }] });
    expect(Object.keys(workflowVersionService(db))).not.toEqual(expect.arrayContaining(["update", "delete", "remove"]));
  });

  it("hides another company's versions", async () => {
    await enableFlags();
    const { workflowId } = await companyWithWorkflow();
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: otherAgentId, companyId: otherCompanyId, name: "Outsider", role: "engineer", status: "active", adapterType: "process" });
    const outsider = { type: "agent" as const, agentId: otherAgentId, companyId: otherCompanyId, source: "agent_key" as const };
    await request(appFor()).post(`/api/workflows/${workflowId}/versions`).send({ spec: specWith() }).expect(201);

    await request(appFor(outsider)).get(`/api/workflows/${workflowId}/versions`).expect(404);
    await request(appFor(outsider)).get(`/api/workflows/${workflowId}/versions/1`).expect(404);
    await request(appFor(outsider)).post(`/api/workflows/${workflowId}/versions`).send({ spec: specWith() }).expect(404);
  });

  it("refuses every version route while the flag is off and keeps prompt-only workflows working", async () => {
    await enableFlags(false);
    const { workflowId } = await companyWithWorkflow();
    const app = appFor();

    const refused = await request(app).post(`/api/workflows/${workflowId}/versions`).send({ spec: specWith() }).expect(403);
    await request(app).get(`/api/workflows/${workflowId}/versions`).expect(403);
    const promptOnly = await request(app).get(`/api/workflows/${workflowId}`).expect(200);

    expect(refused.body.details?.code ?? refused.body.code).toBe("workflow_versions_disabled");
    expect(promptOnly.body).toMatchObject({ prompt: "Publish carefully.", latestVersionNumber: 0, status: "active" });
    expect(await db.select().from(workflowVersions)).toHaveLength(0);
  });

  it("archives a workflow and refuses new versions for it", async () => {
    await enableFlags();
    const { workflowId } = await companyWithWorkflow();
    const app = appFor();

    const archived = await request(app).post(`/api/workflows/${workflowId}/archive`).expect(200);
    await request(app).post(`/api/workflows/${workflowId}/versions`).send({ spec: specWith() }).expect(409);

    expect(archived.body).toMatchObject({ id: workflowId, status: "archived" });
    const logged = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, workflowId), eq(activityLog.action, "workflow.archived")));
    expect(logged).toHaveLength(1);
  });

  it("rejects a malformed spec before storing anything", async () => {
    await enableFlags();
    const { workflowId } = await companyWithWorkflow();

    await request(appFor()).post(`/api/workflows/${workflowId}/versions`)
      .send({ spec: { ...specWith(), specVersion: 2 } }).expect(400);

    expect(await db.select().from(workflowVersions)).toHaveLength(0);
  });
});
