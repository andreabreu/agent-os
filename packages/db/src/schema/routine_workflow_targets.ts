import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { routines } from "./routines.js";
import { workflows } from "./workflows.js";

export const routineWorkflowTargets = pgTable(
  "routine_workflow_targets",
  {
    routineId: uuid("routine_id").primaryKey().references(() => routines.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "restrict" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWorkflowIdx: index("routine_workflow_targets_company_workflow_idx").on(table.companyId, table.workflowId),
  }),
);
