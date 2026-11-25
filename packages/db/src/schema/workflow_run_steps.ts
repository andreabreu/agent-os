import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { caseHandoffs } from "./cases.js";
import { companies } from "./companies.js";
import { decisions } from "./decisions.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";
import { workflowRuns } from "./workflow_runs.js";

export const workflowRunSteps = pgTable(
  "workflow_run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    stepKey: text("step_key").notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: text("status").notNull().default("pending"),
    outcome: text("outcome"),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    assigneeUserId: text("assignee_user_id"),
    handoffId: uuid("handoff_id").references(() => caseHandoffs.id, { onDelete: "set null" }),
    decisionId: uuid("decision_id").references(() => decisions.id, { onDelete: "set null" }),
    interactionId: uuid("interaction_id").references(() => issueThreadInteractions.id, { onDelete: "set null" }),
    outputRevisionIds: jsonb("output_revision_ids").$type<Record<string, string>>().notNull().default({}),
    comment: text("comment"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => ({
    runStepAttemptUq: uniqueIndex("workflow_run_steps_run_step_attempt_uq").on(table.runId, table.stepKey, table.attempt),
    companyRunIdx: index("workflow_run_steps_company_run_idx").on(table.companyId, table.runId),
    decisionIdx: index("workflow_run_steps_decision_idx").on(table.decisionId).where(sql`${table.decisionId} is not null`),
    interactionIdx: index("workflow_run_steps_interaction_idx").on(table.interactionId).where(sql`${table.interactionId} is not null`),
  }),
);
