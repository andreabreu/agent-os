import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { cases } from "./cases.js";
import { companies } from "./companies.js";
import { routineRuns } from "./routines.js";
import { workflowVersions } from "./workflow_versions.js";
import { workflows } from "./workflows.js";

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "restrict" }),
    versionId: uuid("version_id").notNull().references(() => workflowVersions.id, { onDelete: "restrict" }),
    caseId: uuid("case_id").notNull().references(() => cases.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    statusReason: text("status_reason"),
    responsibleUserId: text("responsible_user_id"),
    startedByAgentId: uuid("started_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    startedByUserId: text("started_by_user_id"),
    origin: text("origin").notNull(),
    routineRunId: uuid("routine_run_id").references(() => routineRuns.id, { onDelete: "set null" }),
    currentStepKey: text("current_step_key"),
    stateVersion: integer("state_version").notNull().default(1),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeCaseUq: uniqueIndex("workflow_runs_active_case_uq").on(table.caseId)
      .where(sql`${table.status} in ('running', 'waiting_human', 'paused')`),
    companyStatusIdx: index("workflow_runs_company_status_idx").on(table.companyId, table.status),
    companyWorkflowCreatedIdx: index("workflow_runs_company_workflow_created_idx").on(table.companyId, table.workflowId, table.createdAt),
  }),
);
