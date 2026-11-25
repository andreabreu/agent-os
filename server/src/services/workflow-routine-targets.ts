import { and, eq } from "drizzle-orm";
import { routineWorkflowTargets, routines, workflowVersions, workflows, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";
import { requireWorkflowVersionsEnabled } from "./workflow-versions.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { isRunnableVersion } from "./workflow-runs.js";
import { workflowSpecSchema } from "@paperclipai/shared";
import type { AuthorizationActor } from "./authorization.js";

export type WorkflowDispatch =
  | { status: "none" }
  | { status: "error"; message: string }
  | {
    status: "ready";
    workflowId: string;
    workflowName: string;
    versionId: string;
    version: number;
    descriptionAppendix: string;
    payload: { workflowId: string; workflowVersionId: string; workflowVersion: number };
    /** The version can start a run: the routine then creates a case and a run instead of only a task. */
    executable: boolean;
  };

function activityActor(actor: AuthorizationActor) {
  return actor.type === "agent"
    ? { actorType: "agent" as const, actorId: actor.agentId!, agentId: actor.agentId! }
    : { actorType: "user" as const, actorId: actor.userId ?? "board" };
}

/**
 * Resolves the workflow a routine run starts, without throwing.
 * Routines without a target, and every routine while the feature is off, dispatch as before.
 * @param db Database
 * @param routine The routine being dispatched
 * @returns `none`, the latest published version to start, or the reason the run must fail
 */
export async function resolveWorkflowForDispatch(db: Db, routine: { id: string; companyId: string }): Promise<WorkflowDispatch> {
  const [target] = await db.select({ workflowId: routineWorkflowTargets.workflowId }).from(routineWorkflowTargets)
    .where(and(eq(routineWorkflowTargets.routineId, routine.id), eq(routineWorkflowTargets.companyId, routine.companyId)));
  if (!target) return { status: "none" };
  const settings = await instanceSettingsService(db).getExperimental();
  if (!settings.enableCases || !settings.enableWorkflowVersions) return { status: "none" };
  const [workflow] = await db.select().from(workflows)
    .where(and(eq(workflows.id, target.workflowId), eq(workflows.companyId, routine.companyId)));
  if (!workflow) return { status: "error", message: "The routine's workflow no longer exists" };
  if (workflow.status === "archived") return { status: "error", message: `Workflow "${workflow.name}" is archived` };
  if (!workflow.latestVersionId) return { status: "error", message: `Workflow "${workflow.name}" has no published version` };
  const [version] = await db.select({ id: workflowVersions.id, version: workflowVersions.version, spec: workflowVersions.spec }).from(workflowVersions)
    .where(eq(workflowVersions.id, workflow.latestVersionId));
  if (!version) return { status: "error", message: `Workflow "${workflow.name}" has no published version` };
  return {
    status: "ready",
    workflowId: workflow.id,
    workflowName: workflow.name,
    versionId: version.id,
    version: version.version,
    descriptionAppendix: `Workflow: ${workflow.name} (version ${version.version}, id ${version.id}). `
      + "Read it with GET /api/workflows/" + workflow.id + "/versions/" + version.version + ".",
    payload: { workflowId: workflow.id, workflowVersionId: version.id, workflowVersion: version.version },
    executable: await isRunnableVersion(db, routine.companyId, workflowSpecSchema.parse(version.spec)),
  };
}

export function workflowRoutineTargetService(db: Db) {
  async function write<T>(work: (tx: Db, publications: ActivityPublication[]) => Promise<T>) {
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async (transaction) => work(transaction as unknown as Db, publications));
    publications.forEach(publishActivity);
    return result;
  }

  async function routineInCompany(tx: Db, companyId: string, routineId: string) {
    const [routine] = await tx.select({ id: routines.id }).from(routines)
      .where(and(eq(routines.id, routineId), eq(routines.companyId, companyId)));
    if (!routine) throw notFound("Routine not found");
  }

  return {
    async getTarget(companyId: string, routineId: string) {
      await requireWorkflowVersionsEnabled(db);
      const [target] = await db.select().from(routineWorkflowTargets)
        .where(and(eq(routineWorkflowTargets.routineId, routineId), eq(routineWorkflowTargets.companyId, companyId)));
      if (!target) throw notFound("Routine has no workflow target");
      return target;
    },

    async setTarget(companyId: string, routineId: string, workflowId: string, actor: AuthorizationActor) {
      return write(async (tx, publications) => {
        await requireWorkflowVersionsEnabled(tx);
        await routineInCompany(tx, companyId, routineId);
        const [workflow] = await tx.select({ id: workflows.id, status: workflows.status, name: workflows.name }).from(workflows)
          .where(and(eq(workflows.id, workflowId), eq(workflows.companyId, companyId)));
        if (!workflow) throw notFound("Workflow not found");
        if (workflow.status === "archived") throw conflict("An archived workflow cannot be a routine target");
        const [target] = await tx.insert(routineWorkflowTargets).values({
          routineId, companyId, workflowId,
          createdByAgentId: actor.type === "agent" ? actor.agentId : null,
          createdByUserId: actor.type === "board" ? actor.userId ?? null : null,
        }).onConflictDoUpdate({ target: routineWorkflowTargets.routineId, set: { workflowId, updatedAt: new Date() } }).returning();
        publications.push((await persistActivity(tx, {
          companyId, ...activityActor(actor), runId: actor.runId ?? null,
          action: "routine.workflow_target_set", entityType: "routine", entityId: routineId,
          details: { workflowId, workflowName: workflow.name },
        })).publication);
        return target!;
      });
    },

    async removeTarget(companyId: string, routineId: string, actor: AuthorizationActor) {
      return write(async (tx, publications) => {
        await requireWorkflowVersionsEnabled(tx);
        const [removed] = await tx.delete(routineWorkflowTargets)
          .where(and(eq(routineWorkflowTargets.routineId, routineId), eq(routineWorkflowTargets.companyId, companyId)))
          .returning();
        if (!removed) throw notFound("Routine has no workflow target");
        publications.push((await persistActivity(tx, {
          companyId, ...activityActor(actor), runId: actor.runId ?? null,
          action: "routine.workflow_target_removed", entityType: "routine", entityId: routineId,
          details: { workflowId: removed.workflowId },
        })).publication);
      });
    },
  };
}
