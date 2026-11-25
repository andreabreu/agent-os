import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  caseAccessSources,
  caseEvents,
  caseHandoffs,
  caseIssueLinks,
  cases,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  routineRevisions,
  routineRuns,
  routineTriggers,
  routineWorkflowTargets,
  routines,
  workflowRunEvents,
  workflowRunSteps,
  workflowRuns,
  workflowVersions,
  workflows,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { caseHandoffDeliveryService } from "../services/case-handoff-delivery.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { routineService } from "../services/routines.js";
import { workflowService } from "../services/workflows.js";
import { workflowVersionService } from "../services/workflow-versions.js";
import { workflowRoutineTargetService } from "../services/workflow-routine-targets.js";

const board = { type: "board" as const, source: "local_implicit" as const };
const OWNER_USER = "routine-owner";

describe("routines that start workflow runs", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    temporary = await startEmbeddedPostgresTestDatabase("workflow-runs-routine-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { vi.unstubAllEnvs(); await temporary?.cleanup(); });
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
    await db.delete(issueComments);
    await db.delete(routineWorkflowTargets);
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
    await db.delete(routineRuns);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(routineTriggers);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(routineRevisions);
    await db.delete(routines);
    await db.delete(workflowVersions);
    await db.delete(workflows);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
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

  async function fixture(options: { executable?: boolean } = {}) {
    await instanceSettingsService(db).updateExperimental({ enableCases: true, enableWorkflowVersions: true });
    const companyId = randomUUID(), intake = randomUUID(), writer = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Studio", issuePrefix: `S${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: intake, companyId, name: "Intake", role: "ceo", status: "active", adapterType: "process" },
      { id: writer, companyId, name: "Writer", role: "engineer", status: "active", adapterType: "process", reportsTo: intake },
    ]);
    await db.insert(authUsers).values({ id: OWNER_USER, name: "Routine owner", email: `${companyId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: OWNER_USER, status: "active", membershipRole: "owner" },
      ...[intake, writer].map((agentId) => ({ companyId, principalType: "agent", principalId: agentId, status: "active" })),
    ]);
    const wakeup = vi.fn(async () => null);
    const svc = routineService(db, { heartbeat: { wakeup } });
    const routine = await svc.create(companyId, {
      projectId: null, goalId: null, parentIssueId: null, title: "Weekly post", description: "Write the weekly post",
      assigneeAgentId: intake, priority: "medium", status: "active", concurrencyPolicy: "always_enqueue",
      catchUpPolicy: "skip_missed", variables: [],
    }, { userId: OWNER_USER });
    const workflow = await workflowService(db).write(companyId, board, { name: "Publishing", prompt: "Publish carefully." });
    const spec = {
      specVersion: 1,
      start: "draft",
      steps: [{ key: "draft", name: "Draft", type: "agent_task",
        owner: { kind: "agent", ref: options.executable === false ? "writer" : writer }, outcomes: [{ key: "done", to: "end" }] }],
    };
    await workflowVersionService(db).publish(companyId, workflow.id, board, { spec });
    const latest = await workflowVersionService(db).publish(companyId, workflow.id, board,
      { spec: { ...spec, steps: [{ ...spec.steps[0]!, name: "Draft v2" }] } });
    await workflowRoutineTargetService(db).setTarget(companyId, routine.id, workflow.id, board);
    return { companyId, intake, writer, svc, wakeup, routine, workflowId: workflow.id, latest };
  }

  async function runFor(routineRunId: string) {
    const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.routineRunId, routineRunId));
    return run;
  }

  it("starts a case and a run on the latest version for manual, API and webhook dispatches", async () => {
    const f = await fixture();
    const created = await f.svc.createTrigger(f.routine.id, { kind: "webhook", enabled: true, signingMode: "none",
      replayWindowSec: 300 }, { userId: "board-user" });

    const dispatched = [
      await f.svc.runRoutine(f.routine.id, { source: "manual" }, { userId: OWNER_USER }),
      await f.svc.runRoutine(f.routine.id, { source: "api", idempotencyKey: "weekly-1" }, {}),
      await f.svc.firePublicTrigger(created.trigger.publicId!, { payload: { event: "post.requested" } }) as { id: string },
    ];
    await deliverHandoffs();

    for (const routineRun of dispatched) {
      const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, routineRun.id));
      const run = await runFor(routineRun.id);
      expect(run).toMatchObject({ status: "running", origin: "routine", versionId: f.latest.id,
        responsibleUserId: OWNER_USER, currentStepKey: "draft" });
      const [caseRow] = await db.select().from(cases).where(eq(cases.id, run!.caseId));
      expect(caseRow!.workIssueId).toBe(stored!.linkedIssueId);
      const [task] = await db.select().from(issues).where(eq(issues.id, stored!.linkedIssueId!));
      expect(task!.assigneeAgentId).toBe(f.writer);
    }
    expect(f.wakeup).not.toHaveBeenCalled();
    const started = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "workflow_run.started")));
    expect(started).toHaveLength(3);
  });

  it("starts a run from a scheduled trigger", async () => {
    const f = await fixture();
    await f.svc.createTrigger(f.routine.id, { kind: "schedule", enabled: true, cronExpression: "* * * * *", timezone: "UTC" },
      { userId: "board-user" });

    await f.svc.tickScheduledTriggers(new Date(Date.now() + 5 * 60_000));

    const [scheduled] = await db.select().from(routineRuns)
      .where(and(eq(routineRuns.routineId, f.routine.id), eq(routineRuns.source, "schedule")));
    expect(await runFor(scheduled!.id)).toMatchObject({ origin: "routine", versionId: f.latest.id });
  });

  it("starts a single run for a repeated API delivery", async () => {
    const f = await fixture();

    await f.svc.runRoutine(f.routine.id, { source: "api", idempotencyKey: "same-delivery" }, {});
    await f.svc.runRoutine(f.routine.id, { source: "api", idempotencyKey: "same-delivery" }, {});

    expect(await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, f.companyId))).toHaveLength(1);
  });

  it("only creates the task when the version cannot run", async () => {
    const f = await fixture({ executable: false });

    const routineRun = await f.svc.runRoutine(f.routine.id, { source: "api" }, {});

    expect(await runFor(routineRun.id)).toBeUndefined();
    expect(await db.select().from(cases)).toHaveLength(0);
    expect(f.wakeup).toHaveBeenCalledTimes(1);
  });

  it("wakes the task as before when the routine's responsible person is no longer an active member", async () => {
    const f = await fixture();
    await db.update(companyMemberships).set({ status: "suspended" })
      .where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, OWNER_USER)));

    const routineRun = await f.svc.runRoutine(f.routine.id, { source: "api" }, {});

    const [stored] = await db.select().from(routineRuns).where(eq(routineRuns.id, routineRun.id));
    expect(stored).toMatchObject({ status: "issue_created" });
    expect(await runFor(routineRun.id)).toBeUndefined();
    expect(f.wakeup).toHaveBeenCalledTimes(1);
  });
});
