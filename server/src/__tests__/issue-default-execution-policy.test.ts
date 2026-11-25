import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, issues, projects } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { defaultExecutionPolicyRoutes } from "../routes/default-execution-policy.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";

const board = { type: "board" as const, source: "local_implicit" as const };
const reviewByUser = { stages: [{ type: "review", participants: [{ type: "user", userId: "company-reviewer" }] }] };
const approvalByUser = { stages: [{ type: "approval", participants: [{ type: "user", userId: "project-approver" }] }] };

type StoredPolicy = { stages: { type: string; id?: string; participants: { userId?: string; id?: string }[] }[] } | null;

describe("default execution policies", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("default-execution-policy-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function enableFlags(enableWorkflowVersions = true) {
    await instanceSettingsService(db).updateExperimental({ enableCases: true, enableWorkflowVersions });
  }

  async function fixture() {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Studio", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Launch" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Writer", role: "engineer", status: "active", adapterType: "process" });
    return { companyId, projectId, agentId };
  }

  function appFor(actor: unknown = board) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as { actor?: unknown }).actor = actor; next(); });
    app.use("/api", defaultExecutionPolicyRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function setDefaults(f: { companyId: string; projectId: string }, project = true) {
    await request(appFor()).put(`/api/companies/${f.companyId}/default-execution-policy`)
      .send({ defaultExecutionPolicy: reviewByUser }).expect(200);
    if (project) {
      await request(appFor()).put(`/api/projects/${f.projectId}/default-execution-policy`)
        .send({ defaultExecutionPolicy: approvalByUser }).expect(200);
    }
  }

  async function createdPolicy(companyId: string, input: Record<string, unknown>) {
    const created = await issueService(db).create(companyId, { title: "New task", ...input });
    const [row] = await db.select({ executionPolicy: issues.executionPolicy }).from(issues).where(eq(issues.id, created.id));
    return row!.executionPolicy as StoredPolicy;
  }

  it("gives a new project task the project's default over the company's", async () => {
    await enableFlags();
    const f = await fixture();
    await setDefaults(f);

    const policy = await createdPolicy(f.companyId, { projectId: f.projectId, createdByUserId: "user-1" });

    expect(policy?.stages).toEqual([expect.objectContaining({ type: "approval",
      participants: [expect.objectContaining({ userId: "project-approver" })] })]);
  });

  it("gives a task outside any project the company's default, for people and agents", async () => {
    await enableFlags();
    const f = await fixture();
    await setDefaults(f);

    const byPerson = await createdPolicy(f.companyId, { createdByUserId: "user-1" });
    const byAgent = await createdPolicy(f.companyId, { createdByAgentId: f.agentId });

    for (const policy of [byPerson, byAgent]) {
      expect(policy?.stages).toEqual([expect.objectContaining({ type: "review",
        participants: [expect.objectContaining({ userId: "company-reviewer" })] })]);
    }
  });

  it("gives each new task fresh stage ids instead of the template's", async () => {
    await enableFlags();
    const f = await fixture();
    await setDefaults(f, false);

    const first = await createdPolicy(f.companyId, { createdByUserId: "user-1" });
    const second = await createdPolicy(f.companyId, { createdByUserId: "user-1" });

    expect(first?.stages[0]?.id).toBeTruthy();
    expect(first?.stages[0]?.id).not.toBe(second?.stages[0]?.id);
  });

  it("keeps a policy declared at creation, including an explicit empty one", async () => {
    await enableFlags();
    const f = await fixture();
    await setDefaults(f);

    const declared = await createdPolicy(f.companyId, { projectId: f.projectId, executionPolicy: reviewByUser });
    const explicitNone = await createdPolicy(f.companyId, { projectId: f.projectId, executionPolicy: null });

    expect(declared?.stages[0]?.participants[0]?.userId).toBe("company-reviewer");
    expect(explicitNone).toBeNull();
  });

  it("does not apply defaults to routine tasks or conversations", async () => {
    await enableFlags();
    const f = await fixture();
    await setDefaults(f);

    const routineTask = await createdPolicy(f.companyId, { originKind: "routine_execution", originId: randomUUID() });
    const conversation = await createdPolicy(f.companyId, { conversationAgentId: f.agentId, conversationUserId: "user-1", conversationState: "active", assigneeAgentId: f.agentId });

    expect(routineTask).toBeNull();
    expect(conversation).toBeNull();
  });

  it("keeps today's behavior when no default is set or the flag is off", async () => {
    await enableFlags();
    const f = await fixture();

    expect(await createdPolicy(f.companyId, { createdByUserId: "user-1" })).toBeNull();

    await setDefaults(f);
    await enableFlags(false);
    expect(await createdPolicy(f.companyId, { createdByUserId: "user-1" })).toBeNull();
  });

  it("reads, clears and logs the company default", async () => {
    await enableFlags();
    const f = await fixture();
    await setDefaults(f, false);

    const read = await request(appFor()).get(`/api/companies/${f.companyId}/default-execution-policy`).expect(200);
    await request(appFor()).put(`/api/companies/${f.companyId}/default-execution-policy`)
      .send({ defaultExecutionPolicy: null }).expect(200);
    const cleared = await request(appFor()).get(`/api/companies/${f.companyId}/default-execution-policy`).expect(200);

    expect(read.body.defaultExecutionPolicy.stages[0]).toMatchObject({ type: "review" });
    expect(cleared.body.defaultExecutionPolicy).toBeNull();
    const logged = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.companyId),
      eq(activityLog.action, "company.default_execution_policy_updated")));
    expect(logged).toHaveLength(2);
  });

  it("refuses malformed policies and policies with a monitor, storing nothing", async () => {
    await enableFlags();
    const f = await fixture();
    const monitored = { ...reviewByUser, monitor: { nextCheckAt: new Date(Date.now() + 60_000).toISOString() } };

    await request(appFor()).put(`/api/companies/${f.companyId}/default-execution-policy`)
      .send({ defaultExecutionPolicy: { stages: [{ type: "unknown_stage" }] } }).expect(400);
    await request(appFor()).put(`/api/projects/${f.projectId}/default-execution-policy`)
      .send({ defaultExecutionPolicy: monitored }).expect(400);

    const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
    const [project] = await db.select().from(projects).where(eq(projects.id, f.projectId));
    expect(company!.defaultExecutionPolicy).toBeNull();
    expect(project!.defaultExecutionPolicy).toBeNull();
  });

  it("lets agents read but not write defaults, and hides other companies", async () => {
    await enableFlags();
    const f = await fixture();
    const other = await fixture();
    await setDefaults(f);
    const agent = { type: "agent" as const, agentId: f.agentId, companyId: f.companyId, source: "agent_key" as const };

    await request(appFor(agent)).get(`/api/companies/${f.companyId}/default-execution-policy`).expect(200);
    await request(appFor(agent)).put(`/api/companies/${f.companyId}/default-execution-policy`)
      .send({ defaultExecutionPolicy: null }).expect(403);
    await request(appFor(agent)).put(`/api/projects/${f.projectId}/default-execution-policy`)
      .send({ defaultExecutionPolicy: null }).expect(403);
    await request(appFor(agent)).get(`/api/companies/${other.companyId}/default-execution-policy`).expect(403);
    await request(appFor(agent)).get(`/api/projects/${other.projectId}/default-execution-policy`).expect(404);
  });

  it("refuses the routes while the flag is off", async () => {
    await enableFlags(false);
    const f = await fixture();

    const refused = await request(appFor()).put(`/api/companies/${f.companyId}/default-execution-policy`)
      .send({ defaultExecutionPolicy: reviewByUser }).expect(403);

    expect(refused.body.details?.code ?? refused.body.code).toBe("workflow_versions_disabled");
  });
});
