import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { workflows } from "./workflows.js";

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    specHash: text("spec_hash").notNull(),
    publishedByAgentId: uuid("published_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    publishedByUserId: text("published_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowVersionUq: uniqueIndex("workflow_versions_workflow_version_uq").on(table.workflowId, table.version),
    companyWorkflowCreatedIdx: index("workflow_versions_company_workflow_created_idx").on(
      table.companyId,
      table.workflowId,
      table.createdAt,
    ),
  }),
);
