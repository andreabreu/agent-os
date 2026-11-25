import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { workflowVersions, workflows, type Db } from "@paperclipai/db";
import type { WorkflowSpec } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { casesDisabledError } from "./cases-disabled.js";
import { instanceSettingsService } from "./instance-settings.js";
import { authorizeCaseCreation } from "./case-mutation-authorization.js";
import type { AuthorizationActor } from "./authorization.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

export const WORKFLOW_VERSIONS_DISABLED_CODE = "workflow_versions_disabled";

export function workflowVersionsDisabledError() {
  return forbidden("Workflow versions are disabled", {
    code: WORKFLOW_VERSIONS_DISABLED_CODE,
    remediation: "Workflow versions are an experimental feature that is turned off on this instance. "
      + "An instance admin turns it on with Workflow versions in Experimental settings; it also requires Cases.",
  });
}

export async function requireWorkflowVersionsEnabled(db: Db) {
  const settings = await instanceSettingsService(db).getExperimental();
  if (!settings.enableCases) throw casesDisabledError();
  if (!settings.enableWorkflowVersions) throw workflowVersionsDisabledError();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function workflowSpecHash(spec: WorkflowSpec) {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}

function activityActor(actor: AuthorizationActor) {
  return actor.type === "agent"
    ? { actorType: "agent" as const, actorId: actor.agentId!, agentId: actor.agentId! }
    : { actorType: "user" as const, actorId: actor.userId ?? "board" };
}

async function lockWorkflow(tx: Db, companyId: string, workflowId: string) {
  const [row] = await tx.select().from(workflows)
    .where(and(eq(workflows.companyId, companyId), eq(workflows.id, workflowId))).for("update");
  if (!row) throw notFound("Workflow not found");
  return row;
}

const versionMetadata = {
  id: workflowVersions.id,
  companyId: workflowVersions.companyId,
  workflowId: workflowVersions.workflowId,
  version: workflowVersions.version,
  specHash: workflowVersions.specHash,
  publishedByAgentId: workflowVersions.publishedByAgentId,
  publishedByUserId: workflowVersions.publishedByUserId,
  createdAt: workflowVersions.createdAt,
};

export function workflowVersionService(db: Db) {
  async function mutate<T>(work: (tx: Db, publications: ActivityPublication[]) => Promise<T>) {
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async (transaction) => work(transaction as unknown as Db, publications));
    publications.forEach(publishActivity);
    return result;
  }

  return {
    async publish(companyId: string, workflowId: string, actor: AuthorizationActor, input: { spec: WorkflowSpec }) {
      return mutate(async (tx, publications) => {
        await requireWorkflowVersionsEnabled(tx);
        await authorizeCaseCreation(tx, actor, { companyId });
        const workflow = await lockWorkflow(tx, companyId, workflowId);
        if (workflow.status === "archived") throw conflict("Workflow is archived; it cannot receive new versions");
        const [numbered] = await tx.update(workflows)
          .set({ latestVersionNumber: sql`${workflows.latestVersionNumber} + 1`, updatedAt: new Date() })
          .where(eq(workflows.id, workflowId)).returning({ version: workflows.latestVersionNumber });
        const specHash = workflowSpecHash(input.spec);
        const [version] = await tx.insert(workflowVersions).values({
          companyId, workflowId, version: numbered!.version, spec: input.spec, specHash,
          publishedByAgentId: actor.type === "agent" ? actor.agentId : null,
          publishedByUserId: actor.type === "board" ? actor.userId ?? null : null,
        }).returning(versionMetadata);
        await tx.update(workflows).set({ latestVersionId: version!.id }).where(eq(workflows.id, workflowId));
        publications.push((await persistActivity(tx, {
          companyId, ...activityActor(actor), runId: actor.runId ?? null,
          action: "workflow.version_published", entityType: "workflow", entityId: workflowId,
          details: { version: version!.version, versionId: version!.id, specHash },
        })).publication);
        return version!;
      });
    },

    async list(companyId: string, workflowId: string, options: { limit: number; offset: number }) {
      await requireWorkflowVersionsEnabled(db);
      return db.select(versionMetadata).from(workflowVersions)
        .where(and(eq(workflowVersions.companyId, companyId), eq(workflowVersions.workflowId, workflowId)))
        .orderBy(asc(workflowVersions.version)).limit(options.limit).offset(options.offset);
    },

    async read(companyId: string, workflowId: string, version: number, expectedSnapshot?: string) {
      await requireWorkflowVersionsEnabled(db);
      const [row] = await db.select().from(workflowVersions).where(and(
        eq(workflowVersions.companyId, companyId),
        eq(workflowVersions.workflowId, workflowId),
        eq(workflowVersions.version, version),
      ));
      if (!row) throw notFound("Workflow version not found");
      if (expectedSnapshot && expectedSnapshot !== row.specHash) {
        throw conflict("Workflow version changed; restart read_workflow_version at offset zero without snapshot");
      }
      return { version: row, snapshot: row.specHash };
    },

    async archive(companyId: string, workflowId: string, actor: AuthorizationActor) {
      return mutate(async (tx, publications) => {
        await requireWorkflowVersionsEnabled(tx);
        await authorizeCaseCreation(tx, actor, { companyId });
        const workflow = await lockWorkflow(tx, companyId, workflowId);
        if (workflow.status === "archived") return workflow;
        const [archived] = await tx.update(workflows).set({ status: "archived", updatedAt: new Date() })
          .where(eq(workflows.id, workflowId)).returning();
        publications.push((await persistActivity(tx, {
          companyId, ...activityActor(actor), runId: actor.runId ?? null,
          action: "workflow.archived", entityType: "workflow", entityId: workflowId,
          details: { name: archived!.name, latestVersionNumber: archived!.latestVersionNumber },
        })).publication);
        return archived!;
      });
    },
  };
}
