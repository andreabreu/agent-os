import { and, eq } from "drizzle-orm";
import { companies, projects, type Db } from "@paperclipai/db";
import { isPluginOperationIssueOriginKind, type IssueExecutionPolicy } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import type { AuthorizationActor } from "./authorization.js";

type IssueCreateDefaults = {
  executionPolicy?: Record<string, unknown> | null;
  projectId?: string | null;
  originKind?: string | null;
  conversationAgentId?: string | null;
  conversationUserId?: string | null;
  status?: string | null;
};

function withoutIds(policy: IssueExecutionPolicy): Record<string, unknown> {
  return {
    ...policy,
    stages: policy.stages.map(({ id: _stageId, participants, ...stage }) => ({
      ...stage,
      participants: participants.map(({ id: _participantId, ...participant }) => participant),
    })),
  };
}

function toTemplate(input: unknown): Record<string, unknown> | null {
  const normalized = normalizeIssueExecutionPolicy(input);
  return normalized ? withoutIds(normalized) : null;
}

function isExcludedFromDefaults(issue: IssueCreateDefaults) {
  const routineTask = issue.originKind === "routine_execution" || isPluginOperationIssueOriginKind(issue.originKind);
  const conversation = Boolean(issue.conversationAgentId && issue.conversationUserId) || issue.originKind === "chat_channel";
  return routineTask || conversation || issue.status === "done";
}

async function storedDefault(db: Db, companyId: string, projectId: string | null | undefined) {
  if (projectId) {
    const [project] = await db.select({ policy: projects.defaultExecutionPolicy }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)));
    if (project?.policy) return project.policy;
  }
  const [company] = await db.select({ policy: companies.defaultExecutionPolicy }).from(companies)
    .where(eq(companies.id, companyId));
  return company?.policy ?? null;
}

/**
 * Resolves the execution policy a new task is created with.
 * A policy declared at creation, including an explicit null, always wins.
 * Otherwise the project's default applies, then the company's. Routine tasks,
 * conversations and tasks created as done never receive a default.
 * @param db Database or open transaction
 * @param companyId Company that owns the task
 * @param issue Creation input fields that decide whether a default applies
 * @returns The policy to store on the new task
 */
export async function withDefaultIssueExecutionPolicy(db: Db, companyId: string, issue: IssueCreateDefaults) {
  if (issue.executionPolicy !== undefined || isExcludedFromDefaults(issue)) return issue.executionPolicy;
  const template = await storedDefault(db, companyId, issue.projectId);
  if (!template) return issue.executionPolicy;
  const settings = await instanceSettingsService(db).getExperimental();
  if (!settings.enableCases || !settings.enableWorkflowVersions) return issue.executionPolicy;
  return normalizeIssueExecutionPolicy(template) as unknown as Record<string, unknown> | null;
}

function activityActor(actor: AuthorizationActor) {
  return actor.type === "agent"
    ? { actorType: "agent" as const, actorId: actor.agentId!, agentId: actor.agentId! }
    : { actorType: "user" as const, actorId: actor.userId ?? "board" };
}

export function defaultExecutionPolicyService(db: Db) {
  async function write<T>(work: (tx: Db, publications: ActivityPublication[]) => Promise<T>) {
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async (transaction) => work(transaction as unknown as Db, publications));
    publications.forEach(publishActivity);
    return result;
  }

  return {
    async readCompany(companyId: string) {
      const [row] = await db.select({ policy: companies.defaultExecutionPolicy }).from(companies).where(eq(companies.id, companyId));
      if (!row) throw notFound("Company not found");
      return normalizeIssueExecutionPolicy(row.policy);
    },

    async readProject(projectId: string) {
      const [row] = await db.select({ policy: projects.defaultExecutionPolicy }).from(projects).where(eq(projects.id, projectId));
      if (!row) throw notFound("Project not found");
      return normalizeIssueExecutionPolicy(row.policy);
    },

    async setCompany(companyId: string, actor: AuthorizationActor, policy: unknown) {
      return write(async (tx, publications) => {
        const template = toTemplate(policy);
        const [row] = await tx.update(companies).set({ defaultExecutionPolicy: template, updatedAt: new Date() })
          .where(eq(companies.id, companyId)).returning({ id: companies.id });
        if (!row) throw notFound("Company not found");
        publications.push((await persistActivity(tx, {
          companyId, ...activityActor(actor), runId: actor.runId ?? null,
          action: "company.default_execution_policy_updated", entityType: "company", entityId: companyId,
          details: { cleared: template === null, stageTypes: (template?.stages as { type: string }[] | undefined)?.map((stage) => stage.type) ?? [] },
        })).publication);
        return normalizeIssueExecutionPolicy(template);
      });
    },

    async setProject(companyId: string, projectId: string, actor: AuthorizationActor, policy: unknown) {
      return write(async (tx, publications) => {
        const template = toTemplate(policy);
        const [row] = await tx.update(projects).set({ defaultExecutionPolicy: template, updatedAt: new Date() })
          .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId))).returning({ id: projects.id });
        if (!row) throw notFound("Project not found");
        publications.push((await persistActivity(tx, {
          companyId, ...activityActor(actor), runId: actor.runId ?? null,
          action: "project.default_execution_policy_updated", entityType: "project", entityId: projectId,
          details: { cleared: template === null, stageTypes: (template?.stages as { type: string }[] | undefined)?.map((stage) => stage.type) ?? [] },
        })).publication);
        return normalizeIssueExecutionPolicy(template);
      });
    },
  };
}
